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
