import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEngine } from '../src/engine.js';
import { createUpstashStore } from '../src/store-upstash.js';
import { readBody } from '../src/api.js';

const FAST = { fast: true };

// A fake Upstash REST endpoint backed by a Map, installed over global fetch.
function fakeRedis() {
  const kv = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let m;
    if ((m = /https:\/\/fake\.upstash\.test\/get\/(.+)$/.exec(u))) {
      return new Response(JSON.stringify({ result: kv.get(decodeURIComponent(m[1])) ?? null }));
    }
    if ((m = /https:\/\/fake\.upstash\.test\/set\/(.+)$/.exec(u))) {
      kv.set(decodeURIComponent(m[1]), String(opts.body));
      return new Response(JSON.stringify({ result: 'OK' }));
    }
    return original(url, opts);
  };
  return { kv, restore: () => { globalThis.fetch = original; } };
}

test('upstash store: save is buffered, flush writes once, load round-trips', async () => {
  const { kv, restore } = fakeRedis();
  try {
    const store = createUpstashStore({ url: 'https://fake.upstash.test', token: 't', key: 'vouch:test' });
    assert.equal(await store.load(), null);

    const state = { tasks: { t1: { id: 't1', timer: 'runtime-only' } }, keys: {} };
    store.save(state);
    store.save(state); // repeated saves collapse into one write
    assert.equal(kv.size, 0, 'nothing written before flush');
    await store.flush();
    assert.equal(kv.size, 1);

    const loaded = await store.load();
    assert.equal(loaded.tasks.t1.id, 't1');
    assert.equal(loaded.tasks.t1.timer, undefined, 'runtime-only fields dropped');

    await store.flush(); // no dirty state -> no-op
  } finally {
    restore();
  }
});

test('upstash store: returns null without credentials', () => {
  assert.equal(createUpstashStore({ url: '', token: '' }), null);
});

test('engine: injected store + drain settles background work before flush', async () => {
  let saved = null;
  const engine = createEngine({
    ...FAST,
    store: { load: () => null, save: (s) => { saved = s; } },
  });
  const key = engine.createKey('serverless');
  const { task } = engine.createTask(key, {
    capability: 'math.eval', input: { expression: '2+2' },
    budget: 1, deadline_ms: 5000,
  });
  assert.equal(engine.state.tasks[task.id].status, 'dispatched');
  await engine.drain();
  assert.ok(['settled', 'refunded'].includes(engine.state.tasks[task.id].status),
    'task reached a terminal state within the invocation');
  assert.ok(saved, 'state handed to the store for flushing');
});

test('engine: recoveryGraceMs spares fresh in-flight tasks, reaps stale ones', () => {
  const snapshot = () => ({
    keys: { k1: { id: 'k1', tokenHash: 'x', name: 'n', tier: 'sandbox', createdAt: Date.now() } },
    accounts: { k1: { balance: 0, locked: 1, lockedToday: 1, history: [] } },
    providers: { p1: { id: 'p1', offers: {}, stake: 10, stakeReserved: 1, earnings: 0, track: 50, settledCount: 0, slashedCount: 0 } },
    tasks: {
      fresh: { id: 'fresh', keyId: 'k1', status: 'dispatched', createdAt: Date.now(), events: [],
        quote: { provider: 'p1', price: 1, deadline_ms: 1000, stake_reserved: 1 } },
    },
    disputes: {},
  });

  const spared = createEngine({ ...FAST, recoveryGraceMs: 10 * 60 * 1000,
    store: { load: snapshot, save: () => {} } });
  assert.equal(spared.state.tasks.fresh.status, 'dispatched', 'fresh task left running');

  const reaped = createEngine({ ...FAST,
    store: { load: snapshot, save: () => {} } });
  assert.equal(reaped.state.tasks.fresh.status, 'refunded', 'default grace 0 keeps restart recovery');
});

test('readBody: uses pre-parsed req.body when a serverless helper consumed the stream', async () => {
  assert.deepEqual(await readBody({ body: { a: 1 } }), { a: 1 });
  assert.deepEqual(await readBody({ body: '{"b":2}' }), { b: 2 });
  assert.deepEqual(await readBody({ body: Buffer.from('{"c":3}') }), { c: 3 });
  assert.deepEqual(await readBody({ body: '' }), {});
  await assert.rejects(readBody({ body: 'not json' }), /not valid JSON/);
});

// Full round-trip through the Vercel entrypoint with a fake Redis.
test('vercel handler: serves requests and persists state across invocations', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  process.env.VOUCH_FAST = '1';
  const { kv, restore } = fakeRedis();
  try {
    const { default: handler } = await import('../api/index.js');

    // The handler promise resolves only after drain + flush — await it fully.
    const invoke = async (method, path, body, headers = {}) => {
      const req = new EventEmitter();
      Object.assign(req, { method, url: path, headers });
      if (body !== undefined) req.body = body; // Vercel's helper pre-parses
      const res = {
        headers: {}, status: 0, chunks: [],
        writeHead(status, h) { this.status = status; Object.assign(this.headers, h); },
        write(c) { this.chunks.push(c); },
        end(c) { if (c) this.chunks.push(c); },
        on() {},
      };
      await handler(req, res);
      return res;
    };

    const health = await invoke('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.chunks.join('')).ok, true);
    assert.ok(kv.size >= 1, 'first invocation flushed seeded state');

    const minted = await invoke('POST', '/v1/keys', { name: 'ci' });
    assert.equal(minted.status, 201);
    const token = JSON.parse(minted.chunks.join('')).key;
    assert.ok(token.startsWith('vch_'));

    // A later, separate invocation must see the key that the previous one persisted.
    const balance = await invoke('GET', '/v1/balance', undefined, { authorization: `Bearer ${token}` });
    assert.equal(balance.status, 200, 'key persisted across invocations');
    assert.ok(JSON.parse(balance.chunks.join('')).balance > 0);
  } finally {
    restore();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.VOUCH_FAST;
  }
});
