// Transport and input hardening: malformed URLs, bodies, static routes,
// payload limits, acceptance validation, regex guards, state file safety,
// serverless without Redis, admin/lock gates, provider privacy.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createEngine } from '../src/engine.js';
import { createStore } from '../src/store.js';
import { verify, validateAcceptance, regexProblem, safeRegexTest } from '../src/verification.js';
import { isPrivateHost } from '../src/netguard.js';
import { sleep } from '../src/util.js';

async function boot(cfg = {}) {
  const { server, engine } = createApp({ fast: true, ...cfg });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  const call = async (method, path, { key, body, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, headers: res.headers, body: parsed };
  };
  return { server, engine, base, port, call };
}

// Raw HTTP over a socket: returns the response text (status line + headers + body).
function rawRequest(port, text, { bodyBytes = 0 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let out = '';
    sock.on('data', (d) => { out += d.toString(); });
    sock.on('error', () => {});
    sock.on('close', () => resolve(out));
    sock.on('connect', () => {
      sock.write(text);
      if (bodyBytes) {
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < bodyBytes && !sock.destroyed) {
            const n = Math.min(chunk.length, bodyBytes - sent);
            sent += n;
            if (!sock.write(chunk.subarray(0, n))) { sock.once('drain', pump); return; }
          }
        };
        pump();
      }
    });
    setTimeout(() => sock.destroy(), 3000).unref();
  });
}

test('C1: a malformed request target answers 400 and the server keeps serving', async () => {
  const { server, port, call } = await boot();
  try {
    const res = await rawRequest(port, 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(res, /^HTTP\/1\.1 400/);
    assert.match(res, /invalid_url/);
    assert.equal((await call('GET', '/health')).status, 200, 'process survived');
  } finally { server.close(); }
});

test('static routes serve pages and assets; traversal out of /assets is refused', async () => {
  const { server, call } = await boot();
  try {
    for (const p of ['/', '/dashboard', '/docs', '/verify', '/trade']) {
      const r = await call('GET', p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/);
    }
    const css = await call('GET', '/assets/vouch.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    const trav = await call('GET', '/assets/..%2F..%2Fserver.js');
    assert.equal(trav.status, 403);
    // Sent raw so the client cannot normalize the dots away before the server sees them.
    const trav2 = await rawRequest(server.address().port, 'GET /assets/%2e%2e/%2e%2e/package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(trav2, /^HTTP\/1\.1 (302|403|404)/);
    assert.equal(trav2.includes('"name": "vouch"'), false, 'no file outside /assets is served');
    const trav3 = await rawRequest(server.address().port, 'GET /assets/../../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.equal(trav3.includes('"name": "vouch"'), false);
    const missing = await call('GET', '/assets/nope.css');
    assert.equal(missing.status, 404);
    const redirect = await fetch(`http://localhost:${server.address().port}/whatever`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
  } finally { server.close(); }
});

test('bodies: null / array / string JSON → 400 invalid_input, never 500; oversized → 413 delivered', async () => {
  const { server, port, call } = await boot();
  try {
    for (const raw of ['null', '[]', '"str"', '42', '{bad json']) {
      const r = await call('POST', '/v1/keys', { raw });
      assert.equal(r.status, 400, raw);
      assert.equal(r.body.error.code, 'invalid_input');
    }
    const KEY = (await call('POST', '/v1/keys', { body: {} })).body.key;
    for (const path of ['/v1/tasks', '/v1/keys/sub', '/v1/verify', '/v1/workflows', '/v1/escrow/deposit']) {
      const r = await call('POST', path, { key: KEY, raw: 'null' });
      assert.equal(r.status, 400, path);
    }
    const big = 300 * 1024;
    const res = await rawRequest(port,
      `POST /v1/keys HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${big}\r\n\r\n`, { bodyBytes: big });
    assert.match(res, /^HTTP\/1\.1 413/);
    assert.match(res, /payload_too_large/);
    assert.equal((await call('GET', '/health')).status, 200);
  } finally { server.close(); }
});

test('acceptance validation: malformed checks are 400 invalid_acceptance; the regex guard rejects dangerous patterns', async () => {
  const bad = [
    [{ assert: 'contains_none', values: 'str' }, /values must be an array/],
    [{ assert: 'json_parseable', path: 'data', has: 'id' }, /has must be an array/],
    [{ assert: 'length_between' }, /needs min and\/or max/],
    [{ assert: 'length_between', min: 'a' }, /min must be a number/],
    [{ assert: 'equals', value: 1 }, /path is required/],
    [{ assert: 'regex', pattern: '(a+)+$' }, /nested quantifiers/],
    [{ assert: 'regex', pattern: 'x'.repeat(201) }, /longer than 200/],
    [{ assert: 'regex', pattern: '[' }, /invalid pattern/],
    [{ assert: 'one_of', values: [] }, /must not be empty/],
  ];
  for (const [check, re] of bad) {
    const r = validateAcceptance({ checks: [check] });
    assert.equal(r.ok, false, JSON.stringify(check));
    assert.match(r.detail, re);
  }
  assert.equal(validateAcceptance({ checks: [{ assert: 'regex', pattern: '^(buy|sell)$' }] }).ok, true);
  assert.equal(validateAcceptance({ webhook: 'http://localhost:9/hook' }).ok, false, 'private webhook refused by default');
  assert.equal(validateAcceptance({ webhook: 'http://localhost:9/hook' }, { allowPrivateWebhooks: true }).ok, true);
  assert.equal(validateAcceptance({ webhook: 'https://example.com/hook' }).ok, true);

  const engine = createEngine({ fast: true });
  const key = engine.createKey('t');
  assert.throws(() => engine.createTask(key, { capability: 'text.generate', input: { prompt: 'x' }, acceptance: { checks: [{ assert: 'regex', pattern: '(\\w+\\s?)+$' }] }, budget: 0.03, deadline_ms: 8000 }),
    (e) => e.status === 400 && e.code === 'invalid_acceptance');
  assert.throws(() => engine.createTask(key, { capability: 'text.generate', input: { prompt: 'x' }, webhook_url: 'http://127.0.0.1:1/x', budget: 0.03, deadline_ms: 8000 }),
    (e) => e.status === 400 && /public host/.test(e.message));

  // Runtime guard: a pattern the static check allows but that backtracks exponentially is cut off, not hung.
  assert.equal(regexProblem('^(a|a)+$'), null);
  const t0 = Date.now();
  assert.throws(() => safeRegexTest(/^(a|a)+$/, 'a'.repeat(40) + '!'), /timed out/);
  assert.ok(Date.now() - t0 < 2000);
  const verdict = await verify({ capability: 'text.generate', input: {}, acceptance: { checks: [{ assert: 'regex', pattern: '^(a|a)+$' }] } }, { text: 'a'.repeat(40) + '!' }, {});
  assert.equal(verdict.pass, false);
  assert.match(verdict.failed.detail, /match budget/);
  // A check that throws at run time is reported as a criteria error, not a provider failure.
  const thrown = await verify({ capability: 'text.generate', input: {}, acceptance: { checks: [{ assert: 'contains_all', values: 'nope' }] } }, { text: 'hello' }, {});
  assert.equal(thrown.failed.criteria_error, true);
  // Private-host detection covers the usual ranges.
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.1.1', '::1', '[::1]', '0.0.0.0', 'fd00::1']) assert.equal(isPrivateHost(h), true, h);
  assert.equal(isPrivateHost('example.com'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
});

test('state file: a corrupt snapshot is backed up and refused, never seeded over; user fields named "timer" survive', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vouch-corrupt-'));
  try {
    const statePath = path.join(dir, 'state.json');
    writeFileSync(statePath, '{"keys": not json');
    assert.throws(() => createEngine({ fast: true, persistPath: statePath }), (e) => e.code === 'STATE_CORRUPT' && /backed up/.test(e.message));
    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith('state.json.corrupt-')), 'backup written');
    assert.ok(files.includes('state.json'), 'original left in place');

    // ENOENT is a fresh install; a timer-named user field round-trips through the file store.
    const fresh = path.join(dir, 'fresh', 'state.json');
    const e1 = createEngine({ fast: true, persistPath: fresh });
    const key = e1.createKey('t');
    const { task } = e1.createTask(key, { capability: 'text.generate', input: { prompt: 'keep', timer: 'user data' }, budget: 0.03, deadline_ms: 8000, min_track: 90 });
    await sleep(400); // debounced write
    e1.flush();
    const e2 = createEngine({ fast: true, persistPath: fresh });
    assert.equal(e2.state.tasks[task.id].input.timer, 'user data');
    assert.equal(createStore(null).load(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Vercel entry without Redis keeps one app at module scope across invocations; errors are generic', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
  const { default: handler } = await import('../api/index.js');
  const invoke = async (method, url, body, headers = {}) => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } });
    if (body !== undefined) req.body = body;
    const res = { headers: {}, status: 0, chunks: [], headersSent: false,
      writeHead(s, h) { this.status = s; Object.assign(this.headers, h ?? {}); this.headersSent = true; },
      write(c) { this.chunks.push(c); }, end(c) { if (c) this.chunks.push(c); }, on() {}, once() {} };
    await handler(req, res);
    return { ...res, json: () => JSON.parse(res.chunks.join('')) };
  };
  const minted = await invoke('POST', '/v1/keys', { name: 'module-scope' });
  assert.equal(minted.status, 201);
  const token = minted.json().key;
  const bal = await invoke('GET', '/v1/balance', undefined, { authorization: `Bearer ${token}` });
  assert.equal(bal.status, 200, 'the second invocation sees the first one\'s key (same in-memory app)');
  const malformed = await invoke('GET', '//[');
  assert.equal(malformed.status, 400);
  const broken = await invoke('GET', '/v1/offers', undefined, null); // headers null → route throws → generic 500
  assert.equal(broken.status, 500);
  const err = broken.json().error;
  assert.equal(err.code, 'internal_error');
  assert.ok(err.error_id);
  assert.equal(JSON.stringify(err).includes('at '), false, 'no stack trace to the client');
});

test('rate limits cover MCP tools/call and the open mint/provider/attestation routes', async () => {
  const { server, base, call } = await boot({ rpm: { sandbox: 3, startup: 600, scale: 6000 } });
  try {
    const KEY = (await call('POST', '/v1/keys', { body: {} })).body.key;
    const rpc = async () => {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vouch_balance', arguments: {} } }) });
      return (await res.json()).result;
    };
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rpc());
    assert.ok(results.slice(0, 3).every((r) => !r.isError));
    assert.ok(results.slice(3).every((r) => r.isError && JSON.parse(r.content[0].text).error.code === 'rate_limited'));
    // The REST bucket for the same key is shared with MCP.
    assert.equal((await call('GET', '/v1/balance', { key: KEY })).status, 429);
    const mints = [];
    for (let i = 0; i < 5; i++) mints.push((await call('POST', '/v1/keys', { body: {}, headers: { 'X-Forwarded-For': '203.0.113.1' } })).status);
    assert.deepEqual(mints, [201, 201, 201, 429, 429]);
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push((await call('GET', '/v1/attestation/key', { headers: { 'X-Forwarded-For': '203.0.113.2' } })).status);
    assert.deepEqual(keys, [200, 200, 200, 429]);
  } finally { server.close(); }
});

test('signup lock gates the faucet; provider endpoint_url is admin-only; stake is validated; freeze semantics', async () => {
  const { server, call } = await boot();
  try {
    const KEY = (await call('POST', '/v1/keys', { body: {} })).body.key;
    const reg = await call('POST', '/v1/providers', { body: { name: 'P', endpoint_url: 'http://localhost:1/task', offers: { 'text.generate': { price_ceiling: 0.05, sla_deadline_ms: 1000 } } } });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.stake, 1, 'omitted stake → $1 minimum');
    assert.ok(reg.body.endpoint_url, 'the registrant sees its own endpoint');
    for (const stake of [-5, 'abc', true]) {
      const r = await call('POST', '/v1/providers', { raw: JSON.stringify({ name: 'P', endpoint_url: 'http://localhost:1/task', offers: { 'text.generate': { price_ceiling: 0.05, sla_deadline_ms: 1000 } }, stake }) });
      assert.equal(r.status, 400, String(stake));
      assert.equal(r.body.error.code, 'invalid_input');
    }
    const pub = (await call('GET', `/v1/providers/${reg.body.id}`)).body;
    assert.equal(pub.endpoint_url, undefined, 'public view hides the endpoint');
    assert.ok((await call('GET', '/v1/providers')).body.providers.every((p) => !('endpoint_url' in p)));

    process.env.VOUCH_ADMIN_TOKEN = 'adm';
    process.env.VOUCH_LOCK_SIGNUP = '1';
    try {
      const admin = (await call('GET', `/v1/providers/${reg.body.id}`, { headers: { 'X-Admin-Token': 'adm' } })).body;
      assert.equal(admin.endpoint_url, 'http://localhost:1/task');
      const dep = await call('POST', '/v1/escrow/deposit', { key: KEY, body: { amount: 1 } });
      assert.equal(dep.status, 403);
      assert.equal(dep.body.error.code, 'signup_locked');
      const ok = await call('POST', '/v1/escrow/deposit', { key: KEY, body: { amount: 1 }, headers: { 'X-Admin-Token': 'adm' } });
      assert.equal(ok.status, 200);
      const wrong = await call('POST', '/v1/escrow/deposit', { key: KEY, body: { amount: 1 }, headers: { 'X-Admin-Token': 'ad' } });
      assert.equal(wrong.status, 403);
    } finally { delete process.env.VOUCH_ADMIN_TOKEN; delete process.env.VOUCH_LOCK_SIGNUP; }

    const sub = (await call('POST', '/v1/keys/sub', { key: KEY, body: { fund: 0.5 } })).body;
    assert.equal((await call('POST', `/v1/keys/sub/${sub.id}/freeze`, { key: KEY, body: {} })).body.frozen, true, 'no field → freeze');
    assert.equal((await call('POST', `/v1/keys/sub/${sub.id}/freeze`, { key: KEY, body: { frozen: 'false' } })).body.frozen, false, 'only boolean true freezes');
    assert.equal((await call('POST', `/v1/keys/sub/${sub.id}/freeze`, { key: KEY, body: { frozen: true } })).body.frozen, true);
    assert.equal((await call('POST', `/v1/keys/sub/${sub.id}/freeze`, { key: KEY, body: { frozen: false } })).body.frozen, false);
  } finally { server.close(); }
});

test('attestation key: flattened or literal-\\n PEM pastes are accepted; garbage falls back and is reported', async () => {
  const { normalizePem, createAttestor } = await import('../src/attest.js');
  const crypto = await import('node:crypto');
  const good = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.equal(normalizePem(good.replace(/\n/g, ' ')), good, 'single-line paste rebuilt');
  assert.equal(normalizePem(good.replace(/\n/g, '\\n')), good, 'literal \\n paste rebuilt');
  const a = createAttestor({ attestKey: good.replace(/\n/g, ' ') });
  assert.equal(a.source, 'configured');
  assert.equal(a.keyId, createAttestor({ attestKey: good }).keyId, 'same key either way');
  const origError = console.error; const logged = []; console.error = (m) => logged.push(m);
  try { assert.equal(createAttestor({ attestKey: 'not a key' }).source, 'invalid'); } finally { console.error = origError; }
  assert.ok(logged.some((l) => /VOUCH_ATTEST_KEY is not a valid/.test(l)));
  const { createEngine } = await import('../src/engine.js');
  assert.equal(createEngine({ fast: true, attestKey: good }).cfg.attestSource, 'configured');
  assert.equal(createEngine({ fast: true, attestKey: 'bad' }).cfg.attestSource, 'invalid');
  assert.equal(createEngine({ fast: true }).cfg.attestSource, 'generated');
});
