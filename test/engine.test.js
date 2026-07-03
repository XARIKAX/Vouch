import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, ApiError } from '../src/engine.js';
import { evalExpression } from '../src/providers.js';
import { verify } from '../src/verification.js';
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

test('math expression evaluator', () => {
  assert.equal(evalExpression('12 * (3 + 4) - 10 / 4'), 81.5);
  assert.equal(evalExpression('-3 + 5'), 2);
  assert.throws(() => evalExpression('2 + fs.readFile'), /unexpected|expected a number/);
});

test('a reliable provider settles: escrow moves to the provider, stake releases', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const { task } = engine.createTask(key, {
    capability: 'math.eval',
    input: { expression: '2 + 2' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 4 }] },
    budget: 0.01,
    deadline_ms: 5000,
  });
  assert.equal(task.status, 'dispatched');

  const done = await waitTerminal(engine, task.id);
  assert.equal(done.status, 'settled');
  assert.equal(done.output.result, 4);
  assert.ok(done.settlement.verified_by.includes('schema'));
  assert.ok(done.settlement.verified_by.includes('checks'));

  const acct = engine.state.accounts[key.id];
  assert.equal(acct.locked, 0);
  assert.equal(acct.balance, engine.cfg.faucet - done.quote.price);
  const provider = engine.state.providers[done.quote.provider];
  assert.equal(provider.earnings, done.quote.price);
  assert.equal(provider.stakeReserved, 0);
});

test('junk output fails verification: full refund, provider slashed', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const stakeBefore = engine.state.providers.prv_shade.stake;
  const trackBefore = engine.state.providers.prv_shade.track;

  // Budget below every reliable provider's floor — only prv_shade quotes.
  const { task } = engine.createTask(key, {
    capability: 'text.generate',
    input: { prompt: 'anything at all' },
    acceptance: {
      checks: [
        { assert: 'length_between', min: 120 },
        { assert: 'contains_none', values: ['###', 'ERROR'] },
      ],
    },
    budget: 0.006,
    deadline_ms: 8000,
  });
  assert.equal(task.quote.provider, 'prv_shade');

  const done = await waitTerminal(engine, task.id);
  assert.equal(done.status, 'refunded');
  assert.equal(done.refund.reason, 'verification_failed');
  assert.match(done.refund.detail, /checks\./);

  const acct = engine.state.accounts[key.id];
  assert.equal(acct.balance, engine.cfg.faucet); // made whole
  assert.equal(acct.locked, 0);
  const shade = engine.state.providers.prv_shade;
  assert.ok(shade.stake < stakeBefore, 'stake was slashed');
  assert.ok(shade.track < trackBefore, 'track dropped');
  assert.equal(shade.earnings, 0);
});

test('no admissible quote → 409 with the nearest miss and no money movement', () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  try {
    engine.createTask(key, {
      capability: 'text.generate',
      input: { prompt: 'x' },
      budget: 0.0001, // below every floor
      deadline_ms: 60000,
    });
    assert.fail('expected no_quotes');
  } catch (e) {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'no_quotes');
    assert.equal(e.extra.nearest_miss.violated, 'budget');
  }
  const acct = engine.state.accounts[key.id];
  assert.equal(acct.balance, engine.cfg.faucet);
  assert.equal(acct.locked, 0);
});

test('insufficient escrow → 402 before anything locks', () => {
  const engine = createEngine({ ...FAST, faucet: 0 });
  const key = engine.createKey('t');
  assert.throws(
    () => engine.createTask(key, {
      capability: 'math.eval', input: { expression: '1+1' },
      budget: 0.01, deadline_ms: 5000,
    }),
    (e) => e.code === 'escrow_insufficient' && e.status === 402,
  );
});

test('unknown capability → 404; bad input → 400; bad acceptance → 400', () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const base = { budget: 0.01, deadline_ms: 5000 };
  assert.throws(() => engine.createTask(key, { ...base, capability: 'nope.nope', input: {} }),
    (e) => e.code === 'unknown_capability');
  assert.throws(() => engine.createTask(key, { ...base, capability: 'math.eval', input: {} }),
    (e) => e.code === 'invalid_input');
  assert.throws(() => engine.createTask(key, {
    ...base, capability: 'math.eval', input: { expression: '1' },
    acceptance: { checks: [{ assert: 'sounds_nice' }] },
  }), (e) => e.code === 'invalid_acceptance');
});

test('idempotency: reposting returns the existing task, no double escrow', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const body = {
    capability: 'math.eval', input: { expression: '1+1' },
    budget: 0.01, deadline_ms: 5000, idempotency_key: 'abc',
  };
  const first = engine.createTask(key, body);
  const second = engine.createTask(key, body);
  assert.equal(second.reused, true);
  assert.equal(first.task.id, second.task.id);
  const locks = engine.state.accounts[key.id].history.filter((h) => h.kind === 'lock');
  assert.equal(locks.length, 1);
});

test('dispute on a settled task claws back, re-reviews, and resolves', async () => {
  const engine = createEngine(FAST);
  const key = engine.createKey('t');
  const { task } = engine.createTask(key, {
    capability: 'text.generate',
    input: { prompt: 'the economics of staking' },
    acceptance: { rubric: 'substantive, non-empty' },
    budget: 0.03, deadline_ms: 8000, min_track: 90,
  });
  const done = await waitTerminal(engine, task.id);
  assert.equal(done.status, 'settled');

  const dispute = engine.openDispute(key, task.id, { reason: 'too generic' });
  assert.equal(engine.state.tasks[task.id].status, 'disputed');
  await sleep(300);
  const resolved = engine.getDispute(key, dispute.id);
  assert.ok(['upheld', 'rejected'].includes(resolved.status));

  const t = engine.state.tasks[task.id];
  const provider = engine.state.providers[t.quote.provider];
  const acct = engine.state.accounts[key.id];
  if (resolved.status === 'rejected') {
    assert.equal(t.status, 'settled');
    assert.equal(provider.earnings, t.quote.price); // payment restored
  } else {
    assert.equal(t.status, 'refunded');
    assert.equal(acct.balance, engine.cfg.faucet); // made whole
  }
});

test('dispute window closes → 410', async () => {
  const engine = createEngine({ ...FAST, disputeWindowMs: 1 });
  const key = engine.createKey('t');
  const { task } = engine.createTask(key, {
    capability: 'math.eval', input: { expression: '1+1' },
    budget: 0.01, deadline_ms: 5000,
  });
  await waitTerminal(engine, task.id);
  await sleep(20);
  assert.throws(
    () => engine.openDispute(key, task.id, { reason: 'late' }),
    (e) => e.status === 410 && e.code === 'dispute_window_closed',
  );
});

test('verification pipeline: check failures name the failing validator', async () => {
  const task = {
    id: 'tsk_fixed', capability: 'text.generate',
    input: { prompt: 'hello world testing' },
    acceptance: { checks: [{ assert: 'contains_all', values: ['zebra'] }] },
  };
  const verdict = await verify(task, { text: 'a perfectly reasonable hello world testing response with adequate length' }, {});
  assert.equal(verdict.pass, false);
  assert.equal(verdict.failed.validator, 'checks.contains_all');
});
