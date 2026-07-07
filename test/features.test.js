import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEngine } from '../src/engine.js';
import { verifyAttestation } from '../src/attest.js';
import { sleep } from '../src/util.js';

const FAST = { fast: true };

async function waitTerminal(engine, taskId, ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = engine.state.tasks[taskId];
    if (t && ['settled', 'refunded'].includes(t.status)) return t;
    await sleep(10);
  }
  throw new Error('task never reached a terminal state');
}
async function waitWorkflow(engine, id, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const w = engine.state.workflows[id];
    if (w && ['completed', 'failed'].includes(w.status)) return w;
    await sleep(10);
  }
  throw new Error('workflow never finished');
}

// A throwaway HTTP provider whose /task always returns the given output.
function fakeProvider(output) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(output)); });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    url: `http://localhost:${server.address().port}/task`, close: () => server.close(),
  })));
}

// ---- 1. auto-retry -------------------------------------------------------
test('auto-retry: a failing provider is slashed, the task reroutes and settles', async () => {
  const junk = await fakeProvider({ text: '### ERROR ###' });
  const good = await fakeProvider({ text: 'A thorough, on-topic answer. '.repeat(8) });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {}; // isolate: only our two providers quote
    const junkP = engine.registerProvider({ name: 'junk', endpoint_url: junk.url, stake: 60,
      offers: { 'text.generate': { price_ceiling: 0.008, sla_deadline_ms: 8000 } } });
    const goodP = engine.registerProvider({ name: 'good', endpoint_url: good.url, stake: 60,
      offers: { 'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 8000 } } });

    const key = engine.createKey('t');
    engine.deposit(key, 1);
    const { task } = engine.createTask(key, {
      capability: 'text.generate', input: { prompt: 'why escrow beats retries' },
      acceptance: { checks: [{ assert: 'length_between', min: 120 }, { assert: 'contains_none', values: ['###', 'ERROR'] }] },
      budget: 0.03, deadline_ms: 8000, retry: true,
    });
    const done = await waitTerminal(engine, task.id);

    assert.equal(done.status, 'settled', 'reroute reached a verified provider');
    assert.equal(done.settlement.provider, goodP.id, 'the good provider settled it');
    assert.ok(done.attempts.length >= 1, 'at least one failed attempt recorded');
    assert.equal(done.attempts[0].provider, junkP.id);
    assert.equal(done.attempts[0].reason, 'verification_failed');
    assert.ok(engine.state.providers[junkP.id].slashedCount >= 1, 'failed provider was slashed');
  } finally { junk.close(); good.close(); }
});

test('auto-retry off by default: a single junk provider just refunds', async () => {
  const junk = await fakeProvider({ text: '### ERROR ###' });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    engine.registerProvider({ name: 'junk', endpoint_url: junk.url, stake: 60,
      offers: { 'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 8000 } } });
    const key = engine.createKey('t');
    engine.deposit(key, 1);
    const { task } = engine.createTask(key, {
      capability: 'text.generate', input: { prompt: 'x' },
      acceptance: { checks: [{ assert: 'length_between', min: 120 }] },
      budget: 0.03, deadline_ms: 8000, // no retry
    });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');
  } finally { junk.close(); }
});

// ---- 2. insurance pool ---------------------------------------------------
test('insurance: slashes capitalize the pool; a later failure is compensated', async () => {
  const junk = await fakeProvider({ text: '### ERROR ###' });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    engine.registerProvider({ name: 'junk', endpoint_url: junk.url, stake: 200,
      offers: { 'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 8000 } } });
    const key = engine.createKey('t');
    engine.deposit(key, 5);
    const body = {
      capability: 'text.generate', input: { prompt: 'x' },
      acceptance: { checks: [{ assert: 'length_between', min: 120 }] },
      budget: 0.03, deadline_ms: 8000,
    };
    // First failure funds the pool (empty pool → no compensation yet).
    const a = engine.createTask(key, body); await waitTerminal(engine, a.task.id);
    assert.ok(engine.state.insurance.funded > 0, 'pool funded by the slash');
    const balBefore = engine.balance(key).balance;
    // Second failure draws compensation from the now-funded pool.
    const b = engine.createTask(key, body); const done = await waitTerminal(engine, b.task.id);
    assert.ok(done.compensation && done.compensation.amount > 0, 'compensation paid');
    const balAfter = engine.balance(key).balance;
    // Net: escrow fully refunded plus the compensation on top.
    assert.ok(balAfter > balBefore, 'agent netted the compensation on a failed task');
    assert.equal(engine.insuranceStats().claims_paid, 1);
  } finally { junk.close(); }
});

// ---- 3. signed attestations ---------------------------------------------
test('attestation: a settled task carries an ed25519 proof that verifies', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const { task } = engine.createTask(key, {
    capability: 'math.eval', input: { expression: '6 * 7' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
    budget: 0.02, deadline_ms: 5000,
  });
  const done = await waitTerminal(engine, task.id);
  assert.equal(done.status, 'settled');
  const { attestation, public_key } = engine.getAttestation(key, task.id);
  assert.equal(attestation.alg, 'ed25519');
  assert.equal(attestation.payload.task_id, task.id);
  assert.ok(verifyAttestation(attestation, public_key), 'signature verifies against the public key');
  // Tamper detection: flip the price and the signature must fail.
  const forged = { ...attestation, payload: { ...attestation.payload, price: 999 } };
  assert.equal(verifyAttestation(forged, public_key), false);
});

// ---- 4. verification-as-a-service ---------------------------------------
test('verify endpoint: bring your own output, get a signed verdict — no escrow', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const balBefore = engine.balance(key).balance;

  const pass = await engine.verifyOutput(key, {
    capability: 'math.eval', input: { expression: '2+2' },
    output: { result: 4 }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 4 }] },
  });
  assert.equal(pass.pass, true);
  assert.ok(pass.attestation && verifyAttestation(pass.attestation, engine.attestorKey().public_key));

  const fail = await engine.verifyOutput(key, {
    capability: 'math.eval', input: { expression: '2+2' },
    output: { result: 5 }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 4 }] },
  });
  assert.equal(fail.pass, false);
  assert.equal(fail.attestation, null);
  assert.equal(engine.balance(key).balance, balBefore, 'verification moved no money');
});

// ---- 5. verified workflows ----------------------------------------------
test('workflow: a two-step chain settles and threads the first output into the second', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  engine.deposit(key, 2);
  const wf = engine.createWorkflow(key, {
    steps: [
      { capability: 'math.eval', input: { expression: '20 + 1' },
        acceptance: { checks: [{ assert: 'equals', path: 'result', value: 21 }] },
        budget: 0.02, deadline_ms: 5000 },
      // The second step consumes the first step's verified result via a ref.
      { capability: 'math.eval', input: { expression: '{{steps.0.output.result}} * 2' },
        acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
        budget: 0.02, deadline_ms: 5000 },
    ],
  });
  const done = await waitWorkflow(engine, wf.id);
  assert.equal(done.status, 'completed', done.failure ? JSON.stringify(done.failure) : '');
  assert.equal(done.steps.length, 2);
  assert.ok(done.steps.every((s) => s.status === 'settled'));
  // The second task's input must have had the first step's result spliced in.
  const step2 = engine.state.tasks[done.steps[1].taskId];
  assert.equal(step2.input.expression, '21 * 2');
  assert.equal(done.output.result, 42);
});

// ---- x402 execution adapter ---------------------------------------------
// A mock x402 resource: first call (no X-PAYMENT) → 402 with requirements;
// retry with X-PAYMENT → 200 with the output.
function x402Resource(output) {
  let sawPayment = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!req.headers['x-payment']) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ accepts: [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: '1000', asset: 'USDC' }] }));
      }
      sawPayment = true;
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-PAYMENT-RESPONSE': 'settled' });
      res.end(JSON.stringify(output));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    url: `http://localhost:${server.address().port}/x402`,
    paid: () => sawPayment, close: () => server.close(),
  })));
}

test('x402 adapter: pays the 402 challenge, gets output, and it settles through verification', async () => {
  const resource = await x402Resource({ text: 'A verified answer delivered over x402. '.repeat(6) });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const p = engine.registerProvider({ name: 'x402 vendor', protocol: 'x402', endpoint_url: resource.url, stake: 60,
      offers: { 'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 8000 } } });
    assert.equal(engine.getProvider(p.id).protocol, 'x402');

    const key = engine.createKey('t');
    engine.deposit(key, 1);
    const { task } = engine.createTask(key, {
      capability: 'text.generate', input: { prompt: 'hello' },
      acceptance: { checks: [{ assert: 'length_between', min: 120 }, { assert: 'contains_none', values: ['###'] }] },
      budget: 0.03, deadline_ms: 8000,
    });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled', 'x402 output verified and settled');
    assert.ok(resource.paid(), 'the adapter completed the x402 payment handshake');
    assert.equal(done.settlement.provider, p.id);
  } finally { resource.close(); }
});

// ---- consensus / redundant execution ------------------------------------
test('consensus: parallel providers, the junk one is slashed, a passer settles', async () => {
  const junk = await fakeProvider({ text: '### ERROR ###' });
  const good = await fakeProvider({ text: 'A correct, on-topic consensus answer. '.repeat(6) });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const junkP = engine.registerProvider({ name: 'junk', endpoint_url: junk.url, stake: 80,
      offers: { 'text.generate': { price_ceiling: 0.01, sla_deadline_ms: 8000 } } });
    const goodP = engine.registerProvider({ name: 'good', endpoint_url: good.url, stake: 80,
      offers: { 'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 8000 } } });
    const key = engine.createKey('t');
    engine.deposit(key, 1);
    const { task } = engine.createTask(key, {
      capability: 'text.generate', input: { prompt: 'consensus' },
      acceptance: { checks: [{ assert: 'length_between', min: 120 }, { assert: 'contains_none', values: ['###'] }] },
      budget: 0.05, deadline_ms: 8000, consensus: 2,
    });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled');
    assert.equal(done.settlement.provider, goodP.id, 'the passing provider settled');
    assert.equal(done.settlement.consensus.dispatched, 2);
    assert.ok(engine.state.providers[junkP.id].slashedCount >= 1, 'the failing provider was slashed');
    assert.equal(engine.state.providers[goodP.id].slashedCount, 0);
  } finally { junk.close(); good.close(); }
});

// ---- sub-agent wallets ---------------------------------------------------
test('sub-agent wallets: capped funding, allowlist enforced, revoke refunds', async () => {
  const engine = createEngine(FAST);
  const parent = engine.createKey('parent');
  engine.deposit(parent, 3);
  const before = engine.balance(parent).balance;

  const sub = engine.createSubKey(parent, { fund: 1, allow: ['math.eval'] });
  assert.ok(sub.key.startsWith('vch_'));
  assert.equal(engine.balance(parent).balance, before - 1, 'funding moved from parent');

  const subKey = engine.authenticate(sub.key);
  assert.equal(engine.balance(subKey).balance, 1);

  // Allowlisted capability works.
  const ok = engine.createTask(subKey, {
    capability: 'math.eval', input: { expression: '2+2' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 4 }] },
    budget: 0.01, deadline_ms: 5000,
  });
  assert.ok(ok.task.id);
  // Off-allowlist capability is rejected.
  assert.throws(() => engine.createTask(subKey, {
    capability: 'text.generate', input: { prompt: 'x' }, budget: 0.02, deadline_ms: 5000,
  }), /may not post/);

  // Revoke returns the unspent balance and disables the key.
  const rev = engine.revokeSubKey(parent, sub.id);
  assert.equal(rev.revoked, true);
  assert.ok(rev.refunded > 0);
  assert.throws(() => engine.authenticate(sub.key), /revoked/);
  // A sub-key cannot mint its own sub-keys.
  const sub2 = engine.createSubKey(parent, { fund: 0.5 });
  assert.throws(() => engine.createSubKey(engine.authenticate(sub2.key), { fund: 0.1 }), /Sub-keys cannot/);
});

// ---- semantic cache ------------------------------------------------------
test('semantic cache: an identical verified task is served instantly and cheaper', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  engine.deposit(key, 1);
  const body = {
    capability: 'math.eval', input: { expression: '9 * 9' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 81 }] },
    budget: 0.02, deadline_ms: 5000, cache: true,
  };
  // First run executes normally and populates the cache.
  const first = engine.createTask(key, body);
  const done = await waitTerminal(engine, first.task.id);
  assert.equal(done.status, 'settled');
  assert.ok(!done.cached);
  const paidFirst = done.settlement.price;

  // Second identical run is served from cache: instant, cheaper, same proof.
  const second = engine.createTask(key, body);
  assert.equal(second.cached, true, 'served from cache synchronously');
  assert.equal(second.task.status, 'settled');
  assert.equal(second.task.settlement.provider, 'cache');
  assert.ok(second.task.settlement.price < paidFirst, 'cache hit costs less than execution');
  assert.deepEqual(second.task.output, done.output, 'same verified output returned');
  assert.ok(second.task.attestation, 'carries the original signed proof');
});

// ---- production hardening: signup lock ----------------------------------
test('signup lock: VOUCH_LOCK_SIGNUP gates key minting behind an admin token', async () => {
  const { createApp } = await import('../server.js');
  process.env.VOUCH_LOCK_SIGNUP = '1';
  process.env.VOUCH_ADMIN_TOKEN = 'secret-admin';
  const { server } = createApp({ fast: true });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const denied = await fetch(base + '/v1/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const ok = await fetch(base + '/v1/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'secret-admin' }, body: '{}',
    });
    assert.equal(ok.status, 201);
  } finally {
    server.close();
    delete process.env.VOUCH_LOCK_SIGNUP;
    delete process.env.VOUCH_ADMIN_TOKEN;
  }
});

// ---- 6. provider reputation ---------------------------------------------
test('provider reputation: list and detail expose track record and stake', async () => {
  const engine = createEngine(FAST);
  const list = engine.listProviders();
  assert.ok(list.length > 0);
  assert.ok('track' in list[0] && 'stake_available' in list[0] && 'reliability' in list[0]);
  const one = engine.getProvider(list[0].id);
  assert.equal(one.id, list[0].id);
  assert.ok(Array.isArray(one.capabilities));
  assert.throws(() => engine.getProvider('prv_nope'), /No provider/);
});
