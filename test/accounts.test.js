import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';

const FAST = { fast: true };

async function waitTerminal(engine, id, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const st = engine.state.tasks[id].status;
    if (st === 'settled' || st === 'refunded') return engine.state.tasks[id];
    if (Date.now() - t0 > ms) throw new Error('timeout in ' + st);
    await new Promise((r) => setTimeout(r, 40));
  }
}

test('agentic account: per-task cap and allowlist block out-of-policy tasks', () => {
  const engine = createEngine(FAST);
  const parent = engine.createKey('p');
  engine.deposit(parent, 5);
  const sub = engine.createSubKey(parent, { name: 'trader-agent', fund: 1, allow: ['math.eval'], per_task_cap: 0.01 });
  assert.equal(sub.per_task_cap, 0.01);
  assert.equal(sub.frozen, false);
  const acct = engine.state.keys[sub.id];

  // Over the per-task cap → rejected before any auction.
  assert.throws(() => engine.createTask(acct, {
    capability: 'math.eval', input: { expression: '2+2' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 4 }] },
    budget: 0.05, deadline_ms: 5000,
  }), (e) => e.code === 'per_task_cap_exceeded');

  // Outside the capability allowlist → rejected.
  assert.throws(() => engine.createTask(acct, {
    capability: 'text.generate', input: { prompt: 'hi' }, acceptance: {}, budget: 0.008, deadline_ms: 5000,
  }), (e) => e.code === 'capability_not_allowed');
});

test('agentic account: freeze is an instant, reversible kill switch', async () => {
  const engine = createEngine(FAST);
  Object.values(engine.state.providers).forEach((p) => { p.reliability = 1; }); // deterministic settle
  const parent = engine.createKey('p');
  engine.deposit(parent, 5);
  const sub = engine.createSubKey(parent, { name: 'agent', fund: 1, allow: ['math.eval'], per_task_cap: 0.06 });
  const acct = engine.state.keys[sub.id];
  const body = {
    capability: 'math.eval', input: { expression: '6*7' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
    budget: 0.05, deadline_ms: 5000,
  };

  // In policy → settles.
  const { task } = engine.createTask(acct, body);
  assert.equal((await waitTerminal(engine, task.id)).status, 'settled');

  // Freeze → new tasks blocked.
  assert.equal(engine.freezeSubKey(parent, sub.id, true).frozen, true);
  assert.throws(() => engine.createTask(acct, body), (e) => e.code === 'account_frozen');

  // Unfreeze → works again.
  engine.freezeSubKey(parent, sub.id, false);
  const { task: t2 } = engine.createTask(acct, body);
  assert.equal((await waitTerminal(engine, t2.id)).status, 'settled');
});
