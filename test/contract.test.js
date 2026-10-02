// Backend contract (FIX.md items 1-15) proven over HTTP and MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../server.js';
import { createEngine } from '../src/engine.js';
import { verifyAttestation } from '../src/attest.js';
import { sleep } from '../src/util.js';

const FAST = { fast: true };

async function boot(cfg = {}) {
  const { server, engine } = createApp({ fast: true, ...cfg });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, headers: res.headers, body: parsed };
  };
  const poll = async (key, id) => {
    for (let i = 0; i < 400; i++) {
      const t = (await call('GET', `/v1/tasks/${id}`, { key })).body;
      if (['settled', 'refunded'].includes(t.status)) return t;
      await sleep(20);
    }
    throw new Error('not terminal');
  };
  const mint = async (name = 't') => (await call('POST', '/v1/keys', { body: { name } })).body.key;
  return { server, engine, base, call, poll, mint };
}

async function waitTerminal(engine, taskId, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = engine.state.tasks[taskId];
    if (t && ['settled', 'refunded'].includes(t.status)) return t;
    await sleep(10);
  }
  throw new Error('task never reached a terminal state');
}

function jsonServer(handler) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const out = await handler(raw ? JSON.parse(raw) : {}, req);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.payload ?? out));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    url: `http://localhost:${server.address().port}/hook`, close: () => server.close(),
  })));
}

// ---- 1. identity -----------------------------------------------------------
test('GET /v1/me returns { key_id, name, tier, owner, parent }', async () => {
  const { server, call } = await boot();
  try {
    const minted = (await call('POST', '/v1/keys', { body: { name: 'whoami', owner: '0xabc' } })).body;
    const me = await call('GET', '/v1/me', { key: minted.key });
    assert.equal(me.status, 200);
    assert.equal(me.body.key_id, minted.id);
    assert.equal(me.body.name, 'whoami');
    assert.equal(me.body.tier, 'sandbox');
    assert.equal(me.body.owner, '0xabc');
    assert.equal(me.body.parent, null);
    const sub = (await call('POST', '/v1/keys/sub', { key: minted.key, body: { fund: 1 } })).body;
    const subMe = (await call('GET', '/v1/me', { key: sub.key })).body;
    assert.equal(subMe.parent, minted.id);
    assert.equal(subMe.owner, '0xabc', 'sub-keys inherit the parent owner');
    assert.equal((await call('GET', '/v1/me')).status, 401);
  } finally { server.close(); }
});

// ---- 2. launch params come from launchpad-config only ----------------------
test('POST /v1/agents ignores body.params; risk params are platform-set', async () => {
  const { server, call, mint } = await boot();
  try {
    const KEY = await mint();
    const r = await call('POST', '/v1/agents', {
      key: KEY,
      body: { symbol: 'EVIL', params: { bondHaircut: 1, rollingSlashCap: 0.0001, maxSlashMultiple: 0.1, feeSplit: { bond: 1, operating: 0, creator: 0, treasury: 0 } } },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.params.bondHaircut, 0.5);
    assert.equal(r.body.params.rollingSlashCap, 0.2);
    assert.equal(r.body.params.maxSlashMultiple, 2);
    assert.deepEqual(r.body.params.feeSplit, { bond: 0.5, operating: 0.3, creator: 0.15, treasury: 0.05 });
  } finally { server.close(); }
});

// ---- 3. daily ceiling resets per UTC day -----------------------------------
test('daily escrow ceiling: lockedToday rolls over at the UTC day boundary; sub-keys share it', () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const acct = engine.state.accounts[key.id];
  // Yesterday this key hit the ceiling.
  acct.lockedDay = Math.floor(Date.now() / 86400000) - 1;
  acct.lockedToday = engine.cfg.dailyCeiling.sandbox;
  assert.equal(engine.balance(key).ceiling_remaining, engine.cfg.dailyCeiling.sandbox, 'a new day restores the full ceiling');
  const { task } = engine.createTask(key, { capability: 'math.eval', input: { expression: '1+1' }, budget: 0.01, deadline_ms: 5000 });
  assert.ok(task.id);
  assert.ok(engine.state.accounts[key.id].lockedToday > 0);

  // Same day, ceiling full → 402 with resets_at; a sub-key shares the parent's ceiling.
  acct.lockedToday = engine.cfg.dailyCeiling.sandbox;
  assert.throws(() => engine.createTask(key, { capability: 'math.eval', input: { expression: '1+1' }, budget: 0.01, deadline_ms: 5000 }),
    (e) => e.code === 'escrow_insufficient' && e.extra.resets_at > Date.now());
  engine.deposit(key, 2);
  const sub = engine.createSubKey(key, { fund: 0.5 });
  assert.throws(() => engine.createTask(engine.authenticate(sub.key), { capability: 'math.eval', input: { expression: '1+1' }, budget: 0.01, deadline_ms: 5000 }),
    (e) => e.code === 'escrow_insufficient' && e.extra.locked_today === engine.cfg.dailyCeiling.sandbox);
});

// ---- 4. plain text.generate settles (the homepage curl body) ---------------
test('the homepage curl example settles by default (no min_track)', async () => {
  const { server, call, poll, mint } = await boot();
  try {
    const KEY = await mint();
    const r = await call('POST', '/v1/tasks', {
      key: KEY,
      body: {
        capability: 'text.generate',
        input: { prompt: 'brief: why escrow beats retries' },
        acceptance: { checks: [{ assert: 'length_between', min: 120 }], rubric: 'answers the prompt; no filler' },
        budget: 0.03, deadline_ms: 10000,
      },
    });
    assert.equal(r.status, 201);
    assert.notEqual(r.body.quote.provider, 'prv_shade', 'the unreliable node no longer wins a plain task');
    const done = await poll(KEY, r.body.id);
    assert.equal(done.status, 'settled');
    assert.ok(done.output.text.length >= 120);
  } finally { server.close(); }
});

// ---- 5. attestation key persists in state --------------------------------------
test('attestation key: generated once, persisted in state, old receipts verify after rotation', async () => {
  let saved = null;
  const e1 = createEngine({ ...FAST, store: { load: () => null, save: (s) => { saved = s; } } });
  const key = e1.createKey('t');
  const { task } = e1.createTask(key, { capability: 'math.eval', input: { expression: '2+2' }, budget: 0.01, deadline_ms: 5000 });
  await waitTerminal(e1, task.id);
  const snapshot = JSON.parse(JSON.stringify(saved));
  assert.ok(snapshot.attest.private_key_pem.includes('PRIVATE KEY'));

  // Restart from the snapshot: same key id, same receipt.
  const e2 = createEngine({ ...FAST, store: { load: () => JSON.parse(JSON.stringify(snapshot)), save: () => {} } });
  assert.equal(e2.attestorKey().key_id, e1.attestorKey().key_id);
  const att = e2.getAttestation(e2.authenticate(key.token), task.id);
  assert.ok(verifyAttestation(att.attestation, att.public_key));
  assert.ok(att.attestation.payload.input_sha256 && att.attestation.payload.acceptance_sha256, 'payload carries input/acceptance hashes');

  // Rotate: a configured key takes over, but the receipt's key is still served by key_id.
  const rotated = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const e3 = createEngine({ ...FAST, attestKey: rotated, store: { load: () => JSON.parse(JSON.stringify(snapshot)), save: () => {} } });
  assert.notEqual(e3.attestorKey().key_id, e1.attestorKey().key_id);
  const old = e3.getAttestation(e3.authenticate(key.token), task.id);
  assert.equal(old.key_id, e1.attestorKey().key_id);
  assert.equal(old.current_key_id, e3.attestorKey().key_id);
  assert.ok(verifyAttestation(old.attestation, old.public_key), 'served the key that signed it');
  assert.equal(e3.attestorKey(e1.attestorKey().key_id).public_key, e1.attestorKey().public_key);
  assert.ok(e3.attestorKey().keys.length >= 2);
});

// ---- 6. MCP: new tools, OPTIONS, /mcp only ----------------------------------
test('MCP: sub-key and dispute tools work end to end; OPTIONS answers CORS; only /mcp serves it', async () => {
  const { server, call, base, mint } = await boot();
  try {
    const KEY = await mint();
    await call('POST', '/v1/escrow/deposit', { key: KEY, body: { amount: 2 } });
    const rpc = async (name, args, key = KEY) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const j = await res.json();
      return { ...j.result, data: JSON.parse(j.result.content[0].text) };
    };
    const sub = (await rpc('vouch_create_subkey', { fund: 0.5, allow: ['math.*'] })).data;
    assert.ok(sub.key.startsWith('vch_'));
    const listed = (await rpc('vouch_list_subkeys', {})).data.sub_keys;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, sub.id);
    assert.equal((await rpc('vouch_freeze_subkey', { sub_key_id: sub.id })).data.frozen, true);
    const blocked = await rpc('vouch_post_task', { capability: 'math.eval', input: { expression: '1+1' }, budget: 0.01, deadline_ms: 5000 }, sub.key);
    assert.equal(blocked.isError, true);
    assert.equal(blocked.data.error.code, 'account_frozen');
    assert.equal((await rpc('vouch_freeze_subkey', { sub_key_id: sub.id, frozen: false })).data.frozen, false);
    const revoked = (await rpc('vouch_revoke_subkey', { sub_key_id: sub.id })).data;
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.refunded, 0.5);

    const posted = (await rpc('vouch_post_task', { capability: 'math.eval', input: { expression: '1+1' }, budget: 0.01, deadline_ms: 5000 })).data;
    await sleep(400);
    const dispute = (await rpc('vouch_dispute', { task_id: posted.id, reason: 'check it' })).data;
    assert.equal(dispute.keyId, undefined, 'dispute objects omit keyId');
    await sleep(300);
    const status = (await rpc('vouch_dispute_status', { dispute_id: dispute.id })).data;
    assert.ok(['upheld', 'rejected'].includes(status.status));

    const opt = await fetch(`${base}/mcp`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
    assert.match(opt.headers.get('access-control-allow-headers'), /Authorization/);
    const meta = await (await fetch(`${base}/mcp`)).json();
    assert.equal(meta.endpoint, '/mcp');
    const elsewhere = await fetch(`${base}/v1/mcp`, { method: 'POST', body: '{}' });
    assert.equal(elsewhere.status, 404);
  } finally { server.close(); }
});

// ---- 7. sub-key allowlist prefixes ------------------------------------------
test('sub-key allowlist: "text.*" prefixes work; unknown entries and bad shapes are 400 invalid_input', async () => {
  const { server, call, mint } = await boot();
  try {
    const KEY = await mint();
    await call('POST', '/v1/escrow/deposit', { key: KEY, body: { amount: 3 } });
    const ok = await call('POST', '/v1/keys/sub', { key: KEY, body: { fund: 1, allow: ['text.*'] } });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.allow, ['text.*']);
    const sum = await call('POST', '/v1/tasks', {
      key: ok.body.key,
      body: { capability: 'text.summarize', input: { text: 'Escrow gates settlement. Failed work refunds.' }, budget: 0.01, deadline_ms: 8000 },
    });
    assert.equal(sum.status, 201, 'prefix match admits text.summarize');
    const math = await call('POST', '/v1/tasks', { key: ok.body.key, body: { capability: 'math.eval', input: { expression: '1' }, budget: 0.01, deadline_ms: 5000 } });
    assert.equal(math.status, 403);
    assert.equal(math.body.error.code, 'capability_not_allowed');

    for (const allow of [['nope.*'], ['text.generate', 'bogus.cap'], 'text.generate', [42]]) {
      const bad = await call('POST', '/v1/keys/sub', { key: KEY, body: { fund: 0.1, allow } });
      assert.equal(bad.status, 400, JSON.stringify(allow));
      assert.equal(bad.body.error.code, 'invalid_input');
    }
    const cap = await call('POST', '/v1/keys/sub', { key: KEY, body: { fund: 0.1, per_task_cap: 'abc' } });
    assert.equal(cap.status, 400);
    const neg = await call('POST', '/v1/keys/sub', { key: KEY, body: { fund: 0.1, per_task_cap: -1 } });
    assert.equal(neg.status, 400);
    // A sub-key cannot use the faucet.
    const dep = await call('POST', '/v1/escrow/deposit', { key: ok.body.key, body: { amount: 1 } });
    assert.equal(dep.status, 403);
  } finally { server.close(); }
});

// ---- 8. disputes -----------------------------------------------------------
test('disputes: evidence reaches the grader; a task is disputable once; rejected cannot be re-opened', async () => {
  const graderCalls = [];
  const grader = await jsonServer((body) => { graderCalls.push(body); return { pass: true }; });
  try {
    const engine = createEngine({ ...FAST, graderUrl: grader.url });
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, {
      capability: 'text.generate', input: { prompt: 'the economics of staking' },
      acceptance: { rubric: 'substantive' }, budget: 0.03, deadline_ms: 8000, min_track: 90,
    });
    assert.equal((await waitTerminal(engine, task.id)).status, 'settled');
    const before = graderCalls.length;
    const d = engine.openDispute(key, task.id, { reason: 'too generic', evidence: { quote: 'line 2 is filler' } });
    assert.equal(d.keyId, undefined);
    await engine.drain();
    const review = graderCalls.slice(before);
    assert.ok(review.length >= 3, 'the re-review panel sat');
    assert.ok(review.every((c) => c.context?.dispute?.evidence?.quote === 'line 2 is filler'), 'evidence passed to every grader');
    assert.equal(engine.getDispute(key, d.id).status, 'rejected');
    assert.equal(engine.state.tasks[task.id].status, 'settled');
    assert.equal(engine.state.providers[task.quote.provider].earnings, task.quote.price, 'payment restored');
    // Not re-openable.
    assert.throws(() => engine.openDispute(key, task.id, { reason: 'again' }),
      (e) => e.status === 409 && e.code === 'not_disputable' && e.extra.dispute_id === d.id && e.extra.outcome === 'rejected');
  } finally { grader.close(); }
});

test('disputes: no rubric → deterministic re-check only (an exact math result is not upheld by a heuristic)', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const { task } = engine.createTask(key, {
    capability: 'math.eval', input: { expression: '1+1' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 2 }] }, budget: 0.01, deadline_ms: 5000,
  });
  await waitTerminal(engine, task.id);
  const d = engine.openDispute(key, task.id, { reason: 'I just do not like 2' });
  await engine.drain();
  assert.equal(engine.getDispute(key, d.id).status, 'rejected');
  assert.equal(engine.getDispute(key, d.id).review.recheck, true);
});

test('disputes: uphold evicts the cache entry, slashes without a second stake release, refund.tx is the history tx', async () => {
  // A webhook validator that passes at settlement and fails on re-review (it sees the dispute context).
  const hook = await jsonServer((body) => ({ pass: !body.context, reason: body.context ? 'disputant is right' : undefined }));
  try {
    const engine = createEngine({ ...FAST, allowPrivateWebhooks: true });
    const key = engine.createKey('t');
    const body = {
      capability: 'math.eval', input: { expression: '3*3' }, acceptance: { webhook: hook.url },
      budget: 0.01, deadline_ms: 5000, cache: true,
    };
    const { task } = engine.createTask(key, body);
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled');
    assert.ok(Object.values(engine.state.cache).some((e) => e.task_id === task.id), 'cached after settlement');
    const p = engine.state.providers[task.quote.provider];
    p.stakeReserved = 0.5; // simulate other open quotes on this provider
    const stakeBefore = p.stake;
    const balBefore = engine.balance(key).balance;

    const d = engine.openDispute(key, task.id, { reason: 'wrong', evidence: { expected: 9 } });
    await engine.drain();
    assert.equal(engine.getDispute(key, d.id).status, 'upheld');
    const t = engine.state.tasks[task.id];
    assert.equal(t.status, 'refunded');
    assert.equal(t.refund.reason, 'dispute_upheld');
    assert.ok(t.slash.amount > 0);
    assert.equal(p.stake, stakeBefore - t.slash.amount);
    assert.equal(p.stakeReserved, 0.5, 'dispute slash does not release stake a second time');
    assert.equal(engine.balance(key).balance, balBefore + task.quote.price, 'buyer made whole');
    const hist = engine.state.accounts[key.id].history.find((h) => h.kind === 'clawback_refund' && h.task === task.id);
    assert.equal(hist.tx, t.refund.tx, 'refund.tx is the ledger tx');
    assert.ok(!Object.values(engine.state.cache).some((e) => e.task_id === task.id), 'cache entry evicted');
    // The next identical cache:true task is not served the disputed output.
    const again = engine.createTask(key, body);
    assert.equal(again.cached, undefined);
    assert.throws(() => engine.openDispute(key, task.id, { reason: 'again' }), (e) => e.code === 'not_disputable');
  } finally { hook.close(); }
});

test('disputes: a cache-served task answers 409 not_disputable (no crash)', async () => {
  const { server, call, poll, mint } = await boot();
  try {
    const KEY = await mint();
    const body = { capability: 'math.eval', input: { expression: '7*6' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 0.01, deadline_ms: 5000, cache: true };
    const first = await call('POST', '/v1/tasks', { key: KEY, body });
    await poll(KEY, first.body.id);
    const hit = await call('POST', '/v1/tasks', { key: KEY, body });
    assert.equal(hit.status, 201, 'cache hits keep answering 201');
    assert.equal(hit.body.cached, true, 'bare task with cached:true');
    assert.equal(hit.body.settlement.provider, 'cache');
    assert.equal(hit.body.source_task_id, first.body.id);
    assert.ok(hit.body.attestation.payload.cached && hit.body.attestation.payload.source_task_id === first.body.id, 'own attestation names the source');
    const att = await call('GET', `/v1/tasks/${hit.body.id}/attestation`, { key: KEY });
    assert.ok(verifyAttestation(att.body.attestation, att.body.public_key));
    const d = await call('POST', `/v1/tasks/${hit.body.id}/dispute`, { key: KEY, body: { reason: 'cache?' } });
    assert.equal(d.status, 409);
    assert.equal(d.body.error.code, 'not_disputable');
    assert.equal(d.body.error.source_task_id, first.body.id);
    // Idempotency applies to cache hits too.
    const idem = { ...body, idempotency_key: 'same' };
    const a = await call('POST', '/v1/tasks', { key: KEY, body: idem });
    const b = await call('POST', '/v1/tasks', { key: KEY, body: idem });
    assert.equal(a.status, 201); assert.equal(b.status, 200);
    assert.equal(a.body.id, b.body.id);
    // The list view adds provider / verified_by at the top level.
    const list = (await call('GET', '/v1/tasks?limit=abc', { key: KEY })).body.tasks;
    assert.ok(list.length >= 3);
    assert.ok(list.every((t) => 'provider' in t && 'verified_by' in t));
  } finally { server.close(); }
});

// ---- 9. consensus deadline releases every reservation -----------------------
function x402Hang() {
  const server = http.createServer((req, res) => { res.writeHead(402, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ accepts: [{ scheme: 'exact' }] })); });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}/x`, close: () => server.close() })));
}
function fakeProvider(output) {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(output)); }); });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}/task`, close: () => server.close() })));
}

test('consensus: a missed deadline releases every reserved stake and slashes only the provider that never delivered', async () => {
  const good = await fakeProvider({ text: 'A correct, on-topic consensus answer. '.repeat(6) });
  const hang = await x402Hang();
  try {
    // The x402 payer never resolves, so that provider never delivers.
    const engine = createEngine({ ...FAST, x402Payer: () => new Promise(() => {}) });
    engine.state.providers = {};
    const goodP = engine.registerProvider({ name: 'good', endpoint_url: good.url, stake: 80, offers: { 'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 600 } } });
    const hangP = engine.registerProvider({ name: 'hang', protocol: 'x402', endpoint_url: hang.url, stake: 80, offers: { 'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 600 } } });
    const key = engine.createKey('t');
    engine.deposit(key, 1);
    const { task } = engine.createTask(key, {
      capability: 'text.generate', input: { prompt: 'consensus' },
      acceptance: { checks: [{ assert: 'length_between', min: 120 }] },
      budget: 0.05, deadline_ms: 600, consensus: 2,
    });
    assert.ok(engine.state.providers[goodP.id].stakeReserved > 0);
    assert.ok(engine.state.providers[hangP.id].stakeReserved > 0);
    const done = await waitTerminal(engine, task.id, 4000);
    assert.equal(done.status, 'refunded');
    assert.equal(done.refund.reason, 'deadline_missed');
    assert.equal(engine.state.providers[goodP.id].stakeReserved, 0, 'delivering provider released');
    assert.equal(engine.state.providers[hangP.id].stakeReserved, 0, 'hanging provider released');
    assert.equal(engine.state.providers[goodP.id].slashedCount, 0, 'the one that delivered keeps its stake');
    assert.equal(engine.state.providers[hangP.id].slashedCount, 1);
    assert.deepEqual(done.slashes.map((s) => s.provider), [hangP.id]);
    assert.equal(engine.balance(key).balance, 6, 'buyer made whole (faucet 5 + deposit 1)');
    assert.equal(engine.state.accounts[key.id].locked, 0);
  } finally { good.close(); hang.close(); }
});

// ---- 10. insurance aliases ----------------------------------------------------
test('GET /v1/insurance keeps pool_balance/total_funded and adds balance/funded', async () => {
  const { server, call } = await boot();
  try {
    const r = await call('GET', '/v1/insurance');
    assert.equal(r.status, 200);
    for (const k of ['pool_balance', 'total_funded', 'balance', 'funded', 'claims_paid', 'recent_claims']) assert.ok(k in r.body, k);
    assert.equal(r.body.balance, r.body.pool_balance);
    assert.equal(r.body.funded, r.body.total_funded);
  } finally { server.close(); }
});

// ---- 11. anonymous rate limit per client IP ---------------------------------
test('anonymous rate limit is per client IP (x-forwarded-for first hop), not one shared bucket', async () => {
  const { server, call } = await boot({ rpm: { sandbox: 3, startup: 600, scale: 6000 } });
  try {
    const hit = (ip) => call('GET', '/v1/offers', { headers: { 'X-Forwarded-For': `${ip}, 10.0.0.1` } });
    const a = [];
    for (let i = 0; i < 5; i++) a.push((await hit('203.0.113.7')).status);
    assert.deepEqual(a, [200, 200, 200, 429, 429]);
    assert.equal((await hit('198.51.100.9')).status, 200, 'another client is unaffected');
    const limited = await hit('203.0.113.7');
    assert.ok(limited.headers.get('retry-after'));
    assert.match(limited.headers.get('access-control-expose-headers'), /Retry-After/);
  } finally { server.close(); }
});

// ---- 12. CORS ------------------------------------------------------------------
test('CORS: preflight allows X-Admin-Token and X-Broker-Token; responses expose rate-limit and escrow headers', async () => {
  const { server, call, mint } = await boot();
  try {
    const pre = await call('OPTIONS', '/v1/tasks');
    assert.equal(pre.status, 204);
    const allow = pre.headers.get('access-control-allow-headers');
    assert.match(allow, /X-Admin-Token/);
    assert.match(allow, /X-Broker-Token/);
    const KEY = await mint();
    const bal = await call('GET', '/v1/balance', { key: KEY });
    const expose = bal.headers.get('access-control-expose-headers');
    assert.match(expose, /X-RateLimit-Remaining/);
    assert.match(expose, /X-Escrow-Ceiling-Remaining/);
  } finally { server.close(); }
});

// ---- 13. broker thesis gate ---------------------------------------------------
test('POST /v1/broker/order: 422 thesis_rejected until the thesis verifies, then 503 broker_unconfigured', async () => {
  const { server, call } = await boot();
  try {
    const status = await call('GET', '/v1/broker/status');
    assert.equal(status.body.configured, false);
    assert.ok(status.body.thesis.acceptance.checks.length === 4, 'the gate publishes its checks');

    const none = await call('POST', '/v1/broker/order', { body: { symbol: 'AAPL', qty: 1, side: 'buy' } });
    assert.equal(none.status, 422);
    assert.equal(none.body.error.code, 'thesis_rejected');
    assert.equal(none.body.error.failed.validator, 'thesis');

    const rationale = 'Breakout above the 50-day with volume confirmation; momentum and sector strength support continuation. Invalidated below 180.';
    const badDir = await call('POST', '/v1/broker/order', { body: { symbol: 'AAPL', qty: 1, side: 'buy', thesis: { direction: 'maybe', confidence: 0.7, rationale } } });
    assert.equal(badDir.status, 422);
    assert.equal(badDir.body.error.failed.validator, 'checks.regex');
    const badConf = await call('POST', '/v1/broker/order', { body: { symbol: 'AAPL', qty: 1, side: 'buy', thesis: { direction: 'buy', confidence: 7, rationale } } });
    assert.equal(badConf.body.error.failed.validator, 'checks.regex');
    const short = await call('POST', '/v1/broker/order', { body: { symbol: 'AAPL', qty: 1, side: 'buy', thesis: { direction: 'buy', confidence: 0.7, rationale: 'too short' } } });
    assert.equal(short.body.error.failed.validator, 'checks.length_between');

    const good = await call('POST', '/v1/broker/order', { body: { symbol: 'AAPL', qty: 1, side: 'buy', thesis: { direction: 'buy', confidence: 0.7, rationale } } });
    assert.equal(good.status, 503, 'thesis passed; the broker is simply not configured in tests');
    assert.equal(good.body.error.code, 'broker_unconfigured');
  } finally { server.close(); }
});
