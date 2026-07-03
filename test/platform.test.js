import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine.js';
import { createApp } from '../server.js';
import { sleep } from '../src/util.js';

const FAST = { fast: true };

async function waitTerminal(engine, taskId, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = engine.state.tasks[taskId];
    if (['settled', 'refunded'].includes(t.status)) return t;
    await sleep(10);
  }
  throw new Error('task never reached a terminal state');
}

function jsonServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { status, payload } = handler(JSON.parse(body || '{}'), req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(0, () =>
    resolve({ server, url: `http://localhost:${server.address().port}` })));
}

// ---------------------------------------------------------------------------
// Claude grader (stubbed Anthropic endpoint)
// ---------------------------------------------------------------------------

test('claude grader panel: PASS verdicts settle, FAIL verdicts refund', async () => {
  let verdict = 'PASS';
  const calls = [];
  const { server, url } = await jsonServer((body, req) => {
    calls.push({ path: req.url, model: body.model, system: body.system });
    return {
      status: 200,
      payload: { content: [{ type: 'text', text: verdict }], stop_reason: 'end_turn' },
    };
  });

  try {
    const engine = createEngine({ ...FAST, anthropicKey: 'test-key', anthropicBaseUrl: url });
    const key = engine.createKey('t');

    const good = engine.createTask(key, {
      capability: 'text.generate',
      input: { prompt: 'escrow economics' },
      acceptance: { rubric: 'substantive treatment of the prompt' },
      budget: 0.03, deadline_ms: 8000, min_track: 90,
    });
    const settled = await waitTerminal(engine, good.task.id);
    assert.equal(settled.status, 'settled');
    assert.ok(settled.settlement.verified_by.includes('rubric:3/3'));
    assert.equal(calls.length, 3); // one call per panel seat
    assert.ok(calls.every((c) => c.path === '/v1/messages'));
    assert.equal(new Set(calls.map((c) => c.system)).size, 3); // distinct personas

    verdict = 'FAIL';
    const bad = engine.createTask(key, {
      capability: 'text.generate',
      input: { prompt: 'another prompt entirely' },
      acceptance: { rubric: 'an impossible standard' },
      budget: 0.03, deadline_ms: 8000, min_track: 90,
    });
    const refunded = await waitTerminal(engine, bad.task.id);
    assert.equal(refunded.status, 'refunded');
    assert.equal(refunded.refund.reason, 'verification_failed');
    assert.match(refunded.refund.detail, /rubric/);
  } finally {
    server.close();
  }
});

test('claude grader: an unreachable judge never releases escrow', async () => {
  const engine = createEngine({
    ...FAST,
    anthropicKey: 'test-key',
    anthropicBaseUrl: 'http://localhost:1', // nothing listens here
    graderTimeoutMs: 300,
  });
  const key = engine.createKey('t');
  const { task } = engine.createTask(key, {
    capability: 'text.generate',
    input: { prompt: 'anything' },
    acceptance: { rubric: 'anything' },
    budget: 0.03, deadline_ms: 8000, min_track: 90,
  });
  const done = await waitTerminal(engine, task.id);
  assert.equal(done.status, 'refunded');
  assert.equal(engine.state.accounts[key.id].balance, engine.cfg.faucet);
});

// ---------------------------------------------------------------------------
// Provider registration + external dispatch
// ---------------------------------------------------------------------------

test('a registered provider serves tasks over HTTP and settles', async () => {
  const { server, url } = await jsonServer((body) => ({
    status: 200,
    payload: { text: `Delivered work on "${body.input.prompt}". A concrete, substantive treatment follows with enough length to clear deterministic checks and the review panel.` },
  }));

  const { server: app, engine } = createApp({ fast: true });
  await new Promise((r) => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;

  try {
    const reg = await fetch(`${base}/v1/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test External', endpoint_url: `${url}/task`,
        offers: { 'text.generate': { price_ceiling: 0.004, sla_deadline_ms: 8000 } },
        stake: 25,
      }),
    });
    assert.equal(reg.status, 201);
    const provider = await reg.json();
    assert.match(provider.id, /^prv_/);
    assert.equal(provider.track, 50);

    // Cheapest ceiling on the network → the external provider wins the quote.
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, {
      capability: 'text.generate',
      input: { prompt: 'external dispatch' },
      acceptance: { checks: [{ assert: 'length_between', min: 80 }] },
      budget: 0.004, deadline_ms: 8000,
    });
    assert.equal(task.quote.provider, provider.id);
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled');
    assert.ok(engine.state.providers[provider.id].earnings > 0);
  } finally {
    server.close();
    app.close();
  }
});

test('an unreachable registered provider is slashed and the buyer refunded', async () => {
  const engine = createEngine(FAST);
  const provider = engine.registerProvider({
    name: 'Ghost', endpoint_url: 'http://localhost:1/task',
    offers: { 'text.generate': { price_ceiling: 0.004, sla_deadline_ms: 1000 } },
    stake: 25,
  });
  const key = engine.createKey('t');
  const { task } = engine.createTask(key, {
    capability: 'text.generate', input: { prompt: 'x' },
    budget: 0.004, deadline_ms: 8000,
  });
  assert.equal(task.quote.provider, provider.id);
  const done = await waitTerminal(engine, task.id);
  assert.equal(done.status, 'refunded');
  assert.ok(['provider_abandoned', 'deadline_missed'].includes(done.refund.reason));
  assert.ok(engine.state.providers[provider.id].stake < 25);
  assert.equal(engine.state.accounts[key.id].balance, engine.cfg.faucet);
});

test('registration validation: bad capability, ceiling, and url are rejected', () => {
  const engine = createEngine(FAST);
  const base = { name: 'X', endpoint_url: 'http://x.example/task' };
  assert.throws(() => engine.registerProvider({ ...base, offers: { 'nope.nope': { price_ceiling: 1, sla_deadline_ms: 100 } } }),
    (e) => e.code === 'unknown_capability');
  assert.throws(() => engine.registerProvider({ ...base, offers: { 'text.generate': { price_ceiling: -1, sla_deadline_ms: 100 } } }),
    (e) => e.code === 'invalid_input');
  assert.throws(() => engine.registerProvider({ name: 'X', endpoint_url: 'ftp://x', offers: { 'text.generate': { price_ceiling: 1, sla_deadline_ms: 100 } } }),
    (e) => e.code === 'invalid_input');
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('state survives a restart: keys, balances, and in-flight recovery', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vouch-'));
  const statePath = path.join(dir, 'state.json');

  try {
    const engine1 = createEngine({ ...FAST, persistPath: statePath });
    const key = engine1.createKey('persistent');
    engine1.deposit(key, 3);
    const { task } = engine1.createTask(key, {
      capability: 'math.eval', input: { expression: '2+2' },
      budget: 0.01, deadline_ms: 5000,
    });
    await waitTerminal(engine1, task.id);
    const balanceBefore = engine1.state.accounts[key.id].balance;

    // Simulate a crash mid-flight: inject a dispatched task, snapshot, restart.
    const inflight = {
      id: 'tsk_inflight', keyId: key.id, capability: 'text.generate',
      input: { prompt: 'x' }, acceptance: {}, budget: 0.02, deadline_ms: 60000,
      status: 'dispatched', createdAt: Date.now(), events: [],
      quote: { provider: 'prv_calder', price: 0.01, deadline_ms: 5000, stake_reserved: 0.01 },
      escrow: { locked: 0.01, tx: '0xdead' },
    };
    engine1.state.tasks[inflight.id] = inflight;
    const acct = engine1.state.accounts[key.id];
    acct.balance -= 0.01; acct.locked += 0.01;
    engine1.state.providers.prv_calder.stakeReserved += 0.01;
    await sleep(400); // let the debounced snapshot flush

    const engine2 = createEngine({ ...FAST, persistPath: statePath });
    // Key still authenticates (hash survived the round trip)
    const restored = engine2.authenticate(key.token);
    assert.equal(restored.id, key.id);
    // In-flight task was recovered: refunded, escrow made whole
    assert.equal(engine2.state.tasks.tsk_inflight.status, 'refunded');
    assert.equal(engine2.state.tasks.tsk_inflight.refund.reason, 'provider_abandoned');
    assert.equal(engine2.state.accounts[key.id].locked, 0);
    assert.equal(engine2.state.accounts[key.id].balance, balanceBefore);
    // Settled history survived
    assert.equal(engine2.state.tasks[task.id].status, 'settled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keys are stored hashed, not in plaintext', () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const stored = engine.state.keys[key.id];
  assert.equal(stored.token, undefined);
  assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(engine.state).includes(key.token), false);
});
