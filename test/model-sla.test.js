import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';

const waitTerminal = async (engine, id) => {
  await engine.drain();
  return engine.state.tasks[id];
};

// With a real model configured, the built-in text providers cannot promise the
// simulator's seed SLAs: a model answer plus a cold start takes longer. Their
// quotes are floored at cfg.modelSlaMs so a short buyer deadline is refused up
// front (409 with the nearest quote) instead of refunded after a miss.
test('model-backed quotes are floored at modelSlaMs; math stays fast; every task records how it ran', async () => {
  const engine = createEngine({
    fast: false, modelSlaMs: 20000,
    anthropicKey: 'test-key', execModel: 'exec-x',
    anthropicBaseUrl: 'http://127.0.0.1:1', // nothing listens: the model call fails fast, the simulator answers
  });
  const key = engine.createKey('t');
  engine.deposit(key, 1);

  // A deadline under the floor: honest refusal, naming the deadline the provider needs.
  assert.throws(
    () => engine.createTask(key, { capability: 'text.generate', input: { prompt: 'x' }, acceptance: {}, budget: 0.05, deadline_ms: 10000 }),
    (e) => e.status === 409 && e.code === 'no_quotes' && e.extra?.nearest_miss?.violated === 'deadline' && e.extra.nearest_miss.deadline_ms >= 20000,
  );

  // At or above the floor: quoted, and the quote carries the floored deadline.
  const { task } = engine.createTask(key, { capability: 'text.generate', input: { prompt: 'x' }, acceptance: { checks: [{ assert: 'length_between', min: 10 }] }, budget: 0.05, deadline_ms: 30000 });
  assert.ok(task.quote.deadline_ms >= 20000);

  // math.eval is not model-backed: the seed SLA (2 s) still applies.
  const m = engine.createTask(key, { capability: 'math.eval', input: { expression: '2+2' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 4 }] }, budget: 0.01, deadline_ms: 5000 });
  assert.ok(m.task.quote.deadline_ms <= 2000);

  const done = await waitTerminal(engine, task.id);
  assert.equal(done.execution.mode, 'simulated', 'the unreachable model fell back to the simulator, and the task says so');
  assert.ok(Number.isInteger(done.execution.ms));
  const math = engine.state.tasks[m.task.id];
  assert.equal(math.status, 'settled');
  assert.equal(math.execution.mode, 'simulated');
});

test('without a model configured (sandbox), the floor does not apply', () => {
  const engine = createEngine({ fast: false, anthropicKey: null, execModel: null, graderModel: null });
  const key = engine.createKey('t');
  const { task } = engine.createTask(key, { capability: 'text.generate', input: { prompt: 'x' }, acceptance: {}, budget: 0.05, deadline_ms: 10000 });
  assert.ok(task.quote.deadline_ms <= 10000);
});
