import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRedisClient, encodeCommand, parseReply } from '../src/redis-client.js';
import { createRedisStore, createRemoteStore } from '../src/store-upstash.js';

// A fake Redis speaking RESP2 over TCP: AUTH, SELECT, PING, GET, SET and the
// store's compare-and-set EVAL. Optionally dribbles replies byte by byte to
// prove the client reassembles split packets.
function fakeRedisServer({ password = null, dribble = false } = {}) {
  const kv = new Map();
  const log = [];
  let writes = 0;
  const bulk = (v) => (v == null ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let authed = !password;
    const reply = (text) => {
      if (!dribble) return sock.write(text);
      for (const ch of Buffer.from(text)) sock.write(Buffer.from([ch]));
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = parseReply(buf, 0); if (!r) break;
        buf = buf.subarray(r[1]);
        const [name, ...args] = r[0];
        log.push(name);
        if (name === 'AUTH') { authed = args.at(-1) === password; reply(authed ? '+OK\r\n' : '-WRONGPASS invalid password\r\n'); continue; }
        if (!authed) { reply('-NOAUTH Authentication required.\r\n'); continue; }
        if (name === 'SELECT') { reply('+OK\r\n'); continue; }
        if (name === 'PING') { reply('+PONG\r\n'); continue; }
        if (name === 'GET') { reply(bulk(kv.get(args[0]) ?? null)); continue; }
        if (name === 'SET') { kv.set(args[0], args[1]); writes++; reply('+OK\r\n'); continue; }
        if (name === 'EVAL') {
          const [, , stateKey, versionKey, expected, snapshot, next] = args;
          const cur = kv.get(versionKey);
          if ((cur === undefined && expected === '0') || cur === expected) { kv.set(stateKey, snapshot); kv.set(versionKey, next); writes++; reply(':1\r\n'); }
          else reply(':0\r\n');
          continue;
        }
        reply(`-ERR unknown command '${name}'\r\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: (auth = '') => `redis://${auth}127.0.0.1:${server.address().port}`,
    kv, log, writes: () => writes, close: () => server.close(),
  })));
}

test('redis client: round-trips commands, bulk strings with CRLF, nulls, errors, and split packets', async () => {
  const srv = await fakeRedisServer({ dribble: true });
  const c = createRedisClient(srv.url());
  try {
    assert.equal(await c.command(['PING']), 'PONG');
    assert.equal(await c.command(['SET', 'k', 'line1\r\nline2 {"json":true}']), 'OK');
    assert.equal(await c.command(['GET', 'k']), 'line1\r\nline2 {"json":true}');
    assert.equal(await c.command(['GET', 'missing']), null);
    await assert.rejects(c.command(['NOPE']), /unknown command/);
    assert.ok(c.connected);
  } finally { c.close(); srv.close(); }
});

test('redis client: authenticates with the URL password (and user) before the first command, selects the db', async () => {
  const srv = await fakeRedisServer({ password: 'p@ss' });
  const c = createRedisClient(srv.url('default:p%40ss@') + '/2');
  const bad = createRedisClient(srv.url('default:wrong@'));
  try {
    assert.equal(await c.command(['PING']), 'PONG');
    assert.deepEqual(srv.log.slice(0, 3), ['AUTH', 'SELECT', 'PING']);
    await assert.rejects(bad.command(['PING']), /WRONGPASS/);
  } finally { c.close(); bad.close(); srv.close(); }
});

test('redis client: a command times out instead of hanging when the server never answers', async () => {
  const server = net.createServer(() => { /* accept, never reply */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const c = createRedisClient(`redis://127.0.0.1:${server.address().port}`, { timeoutMs: 150 });
  try { await assert.rejects(c.command(['PING']), /timed out/); }
  finally { c.close(); server.close(); }
});

test('redis store: load/save/flush round-trips through a plain Redis with one CAS write', async () => {
  const srv = await fakeRedisServer();
  const store = createRedisStore({ url: srv.url(), key: 'vouch:test' });
  try {
    assert.equal(await store.load(), null);
    const state = { keys: { a: { id: 'a' } }, tasks: {}, note: 'x' };
    store.save(state); store.save(state);
    const r = await store.flush();
    assert.equal(r.version, 1);
    assert.equal(srv.writes(), 1, 'one CAS write for many saves');
    const again = createRedisStore({ url: srv.url(), key: 'vouch:test' });
    const loaded = await again.load();
    assert.equal(loaded.keys.a.id, 'a');
    assert.equal(loaded.version, 1);
    again.close();
  } finally { store.close(); srv.close(); }
});

test('redis store: a concurrent writer bumps the version → flush merges and retries once', async () => {
  const srv = await fakeRedisServer();
  const a = createRedisStore({ url: srv.url(), key: 'vouch:cas' });
  const b = createRedisStore({ url: srv.url(), key: 'vouch:cas' });
  try {
    await a.load(); await b.load();
    b.save({ keys: { fromB: { id: 'fromB' } }, tasks: {} }); await b.flush();
    const mine = { keys: { fromA: { id: 'fromA' } }, tasks: {} };
    a.save(mine);
    const r = await a.flush();
    assert.equal(r.merged, true);
    assert.equal(r.version, 2);
    const final = JSON.parse(srv.kv.get('vouch:cas'));
    assert.ok(final.keys.fromA && final.keys.fromB, 'both writers\' records survive');
  } finally { a.close(); b.close(); srv.close(); }
});

test('remote store selection: REDIS_URL alone gives a Redis store; nothing configured gives null', async () => {
  const srv = await fakeRedisServer();
  const saved = { ...process.env };
  try {
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; delete process.env.KV_URL;
    delete process.env.REDIS_URL;
    assert.equal(createRemoteStore(), null);
    process.env.REDIS_URL = srv.url('default:secret@');
    const s = createRemoteStore();
    assert.ok(s && typeof s.flush === 'function');
    assert.ok(!s.path.includes('secret'), 'the password never appears in the store path');
    s.close();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    srv.close();
  }
});

test('resp encoding is binary-safe for multibyte payloads', () => {
  const buf = encodeCommand(['SET', 'k', 'héllo ✓']);
  assert.equal(buf.toString(), `*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${Buffer.byteLength('héllo ✓')}\r\nhéllo ✓\r\n`);
});
