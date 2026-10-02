import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEngine } from '../src/engine.js';
import { createUpstashStore } from '../src/store-upstash.js';
import { readBody } from '../src/api.js';

const FAST = { fast: true };

// A fake Upstash REST endpoint backed by a Map, installed over global fetch.
// Speaks the command form (POST ["GET", key] / ["EVAL", script, ...]) and
// implements the compare-and-set script's semantics.
function fakeRedis() {
  const kv = new Map();
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://fake.upstash.test')) return original(url, opts);
    const cmd = JSON.parse(String(opts.body));
    const [name, ...args] = cmd;
    if (name === 'GET') return new Response(JSON.stringify({ result: kv.get(args[0]) ?? null }));
    if (name === 'SET') { kv.set(args[0], String(args[1])); writes++; return new Response(JSON.stringify({ result: 'OK' })); }
    if (name === 'EVAL') {
      const [, , stateKey, versionKey, expected, snapshot, next] = args;
      const cur = kv.get(versionKey);
      if ((cur === undefined && expected === '0') || cur === expected) {
        kv.set(stateKey, snapshot); kv.set(versionKey, next); writes++;
        return new Response(JSON.stringify({ result: 1 }));
      }
      return new Response(JSON.stringify({ result: 0 }));
    }
    return new Response(JSON.stringify({ error: `unsupported ${name}` }), { status: 400 });
  };
  return { kv, writes: () => writes, restore: () => { globalThis.fetch = original; } };
}

test('upstash store: save is buffered, flush writes once (CAS), load round-trips', async () => {
  const { kv, writes, restore } = fakeRedis();
  try {
    const store = createUpstashStore({ url: 'https://fake.upstash.test', token: 't', key: 'vouch:test' });
    assert.equal(await store.load(), null);

    const handle = setTimeout(() => {}, 100000);
    const state = { tasks: { t1: { id: 't1', timer: handle, input: { timer: 'user data named timer' } } }, keys: {} };
    store.save(state);
    store.save(state); // repeated saves collapse into one write
    assert.equal(writes(), 0, 'nothing written before flush');
    const r = await store.flush();
    assert.equal(writes(), 1);
    assert.equal(r.version, 1);
    assert.equal(kv.get('vouch:test:version'), '1');

    const loaded = await store.load();
    assert.equal(loaded.tasks.t1.id, 't1');
    assert.equal(loaded.tasks.t1.timer, undefined, 'runtime timer handles dropped');
    assert.equal(loaded.tasks.t1.input.timer, 'user data named timer', 'user data named "timer" kept');
    assert.equal(loaded.version, 1);
    clearTimeout(handle);

    assert.equal(await store.flush(), null); // no dirty state -> no-op
  } finally {
    restore();
  }
});

test('upstash store: a concurrent writer bumps the version → flush merges and retries once', async () => {
  const { kv, restore } = fakeRedis();
  try {
    const a = createUpstashStore({ url: 'https://fake.upstash.test', token: 't', key: 'vouch:cas' });
    const b = createUpstashStore({ url: 'https://fake.upstash.test', token: 't', key: 'vouch:cas' });
    // Both invocations load the same (empty) snapshot.
    assert.equal(await a.load(), null);
    assert.equal(await b.load(), null);
    // B flushes first: version 0 → 1.
    b.save({ keys: { kb: { id: 'kb' } }, tasks: {}, insurance: { balance: 1 } });
    assert.equal((await b.flush()).version, 1);
    // A's CAS at version 0 fails; it re-loads, merges B's records under its own, retries at version 2.
    const local = { keys: { ka: { id: 'ka' } }, tasks: { t: { id: 't' } }, insurance: { balance: 7 } };
    a.save(local);
    const r = await a.flush();
    assert.equal(r.merged, true);
    assert.equal(r.version, 2);
    const stored = JSON.parse(kv.get('vouch:cas'));
    assert.deepEqual(Object.keys(stored.keys).sort(), ['ka', 'kb'], 'both invocations\' records survive');
    assert.equal(stored.insurance.balance, 7, 'pools stay with the merging invocation');
    assert.equal(kv.get('vouch:cas:version'), '2');
    // The engine object was merged in place, so the live state matches what was written.
    assert.ok(local.keys.kb);
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

// A Redis that cannot be reached must not take the site down: the handler
// answers from the in-memory app and names the reason on /v1/status.
test('vercel handler: unreachable REDIS_URL falls back to memory and reports store-error on /v1/status', async () => {
  const saved = { ...process.env };
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; delete process.env.KV_URL;
  process.env.REDIS_URL = 'redis://default:secret@127.0.0.1:1'; // nothing listens on port 1
  process.env.VOUCH_FAST = '1';
  const errors = [];
  const origError = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const { default: handler } = await import('../api/index.js');
    const invoke = async (method, path) => {
      const req = new EventEmitter(); Object.assign(req, { method, url: path, headers: {} });
      const res = { headers: {}, status: 0, chunks: [], writeHead(s, h) { this.status = s; Object.assign(this.headers, h); }, write(c) { this.chunks.push(c); }, end(c) { if (c) this.chunks.push(c); }, on() {} };
      await handler(req, res); return res;
    };
    const status = await invoke('GET', '/v1/status');
    assert.equal(status.status, 200, 'the site still answers');
    const j = JSON.parse(status.chunks.join(''));
    assert.equal(j.store, 'remote-error');
    assert.match(j.store_error, /ECONNREFUSED|failed/);
    assert.ok(!j.store_error.includes('secret'), 'no password in the reported reason');
    assert.ok(errors.some((l) => l.includes('remote state store unavailable')), 'logged for the operator');
    assert.ok(!errors.join('\n').includes('secret'), 'no password in the logs');
  } finally {
    console.error = origError;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// The request's own changes must reach Redis before the background work runs,
// so another instance polling for a new task finds it immediately.
test('vercel handler: a task is persisted before execution and again after settlement (two flushes)', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  process.env.VOUCH_FAST = '1';
  const { kv, writes, restore } = fakeRedis();
  try {
    const { default: handler } = await import('../api/index.js');
    const invoke = async (method, path, body, headers = {}) => {
      const req = new EventEmitter(); Object.assign(req, { method, url: path, headers });
      if (body !== undefined) req.body = body;
      const res = { headers: {}, status: 0, chunks: [], writeHead(s, h) { this.status = s; Object.assign(this.headers, h); }, write(c) { this.chunks.push(c); }, end(c) { if (c) this.chunks.push(c); }, on() {} };
      await handler(req, res); return res;
    };
    const token = JSON.parse((await invoke('POST', '/v1/keys', { name: 'flush' })).chunks.join('')).key;
    const before = writes();
    const posted = await invoke('POST', '/v1/tasks', {
      capability: 'math.eval', input: { expression: '6*7' },
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 0.01, deadline_ms: 5000,
    }, { authorization: `Bearer ${token}` });
    assert.equal(posted.status, 201);
    const id = JSON.parse(posted.chunks.join('')).id;
    assert.equal(writes() - before, 2, 'one flush right after the response, one after the work finished');
    const stored = JSON.parse(kv.get('vouch:state'));
    assert.equal(stored.tasks[id].status, 'settled', 'the final flush carries the outcome');
    const got = await invoke('GET', `/v1/tasks/${id}`, undefined, { authorization: `Bearer ${token}` });
    assert.equal(got.status, 200);
  } finally {
    restore();
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN; delete process.env.VOUCH_FAST;
  }
});

// While the background work runs, intermediate transitions reach Redis so a
// console polling from another instance sees the task move (dispatched →
// delivered → verifying → settled), not just the two ends.
test('vercel handler: intermediate transitions are flushed while the work runs', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  process.env.VOUCH_FAST = '1';
  process.env.VOUCH_LIVE_FLUSH_MS = '5';
  // A slow fake model (execution and the grader panel) so delivery and
  // verification are separated by real time, as they are in production.
  process.env.ANTHROPIC_API_KEY = 'sk-test'; process.env.VOUCH_EXEC_MODEL = 'exec-x'; process.env.VOUCH_GRADER_MODEL = 'grade-y';
  process.env.VOUCH_ANTHROPIC_BASE_URL = 'https://fake.model.test';
  const { kv, writes, restore } = fakeRedis();
  const withRedis = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://fake.model.test')) return withRedis(url, opts);
    await new Promise((r) => setTimeout(r, 25));
    const body = JSON.parse(String(opts.body));
    const text = body.max_tokens === 16 ? 'PASS' : 'A substantive, on-topic answer that clears the length floor for this live-view test.';
    return new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }), { status: 200 });
  };
  const CTX = Symbol.for('@vercel/request-context');
  const background = [];
  globalThis[CTX] = { get: () => ({ waitUntil: (p) => background.push(p) }) };
  try {
    const { default: handler } = await import('../api/index.js');
    const invoke = async (method, path, body, headers = {}) => {
      const req = new EventEmitter(); Object.assign(req, { method, url: path, headers });
      if (body !== undefined) req.body = body;
      const res = { headers: {}, status: 0, chunks: [], writeHead(s, h) { this.status = s; Object.assign(this.headers, h); }, write(c) { this.chunks.push(c); }, end(c) { if (c) this.chunks.push(c); }, on() {} };
      await handler(req, res); return res;
    };
    const token = JSON.parse((await invoke('POST', '/v1/keys', { name: 'live' })).chunks.join('')).key;
    await Promise.all(background.splice(0));
    const before = writes();
    const posted = await invoke('POST', '/v1/tasks', {
      capability: 'text.generate', input: { prompt: 'live view' },
      acceptance: { checks: [{ assert: 'length_between', min: 10 }], rubric: 'substantive' }, budget: 0.03, deadline_ms: 8000, min_track: 70,
    }, { authorization: `Bearer ${token}` });
    assert.equal(posted.status, 201);
    const id = JSON.parse(posted.chunks.join('')).id;
    // sample the store while the work is in flight
    const seen = new Set();
    const sampler = setInterval(() => { const s = JSON.parse(kv.get('vouch:state') || '{}'); if (s.tasks?.[id]) seen.add(s.tasks[id].status); }, 2);
    await Promise.all(background.splice(0));
    clearInterval(sampler);
    const final = JSON.parse(kv.get('vouch:state')).tasks[id];
    seen.add(final.status);
    assert.ok(writes() - before > 2, `more than two writes (${writes() - before}): intermediate states were published`);
    assert.ok(seen.has('dispatched') && seen.has('verifying') && seen.has('settled'), `saw ${[...seen].join(', ')}`);
    assert.ok(final.output, 'the output is on the task record');
    assert.ok(final.events.some((e) => e.status === 'submitted'), 'the delivery transition is recorded');
    assert.equal(final.execution.mode, 'model');
  } finally {
    delete globalThis[CTX];
    globalThis.fetch = withRedis;
    restore();
    for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VOUCH_FAST', 'VOUCH_LIVE_FLUSH_MS', 'ANTHROPIC_API_KEY', 'VOUCH_EXEC_MODEL', 'VOUCH_GRADER_MODEL', 'VOUCH_ANTHROPIC_BASE_URL']) delete process.env[k];
  }
});

// On Vercel the function may be frozen as soon as the response ends. The
// handler therefore (1) holds res.end until the request's own changes are in
// Redis and (2) hands the execution + grading to the platform's request
// context (waitUntil) so it keeps running after the reply.
test('vercel handler: the task is in Redis before the reply ends; the work runs under waitUntil', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  process.env.VOUCH_FAST = '1';
  const { kv, writes, restore } = fakeRedis();
  const CTX = Symbol.for('@vercel/request-context');
  const background = [];
  globalThis[CTX] = { get: () => ({ waitUntil: (p) => background.push(p) }) };
  try {
    const { default: handler } = await import('../api/index.js');
    const invoke = async (method, path, body, headers = {}) => {
      const req = new EventEmitter(); Object.assign(req, { method, url: path, headers });
      if (body !== undefined) req.body = body;
      const res = {
        headers: {}, status: 0, chunks: [], storedAtEnd: null,
        writeHead(s, h) { this.status = s; Object.assign(this.headers, h); },
        write(c) { this.chunks.push(c); },
        end(c) { if (c) this.chunks.push(c); this.storedAtEnd = kv.get('vouch:state') ?? null; },
        on() {},
      };
      await handler(req, res); return res;
    };
    const token = JSON.parse((await invoke('POST', '/v1/keys', { name: 'bg' })).chunks.join('')).key;
    await Promise.all(background.splice(0));
    const before = writes();
    const posted = await invoke('POST', '/v1/tasks', {
      capability: 'math.eval', input: { expression: '6*7' },
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 0.01, deadline_ms: 5000,
    }, { authorization: `Bearer ${token}` });
    assert.equal(posted.status, 201);
    const id = JSON.parse(posted.chunks.join('')).id;
    // The reply was held until the first flush landed: the task was already stored when end() ran.
    assert.equal(JSON.parse(posted.storedAtEnd).tasks[id].status, 'dispatched', 'visible to other instances before the client sees the reply');
    assert.equal(writes() - before, 1, 'the handler returned after one flush');
    assert.equal(background.length, 1, 'execution + grading handed to waitUntil');
    // Another instance polling now finds it (no 404) while the work is still running.
    const early = await invoke('GET', `/v1/tasks/${id}`, undefined, { authorization: `Bearer ${token}` });
    assert.equal(early.status, 200);
    await Promise.all(background.splice(0));
    assert.equal(writes() - before, 2, 'the outcome was flushed when the background work finished; the read-only poll wrote nothing');
    assert.equal(JSON.parse(kv.get('vouch:state')).tasks[id].status, 'settled');
    // Read-only invocations never write the snapshot back.
    const w = writes();
    await invoke('GET', '/v1/tasks', undefined, { authorization: `Bearer ${token}` });
    await invoke('GET', '/v1/status');
    await Promise.all(background.splice(0));
    assert.equal(writes(), w, 'reads do not rewrite state');
  } finally {
    delete globalThis[CTX];
    restore();
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN; delete process.env.VOUCH_FAST;
  }
});
