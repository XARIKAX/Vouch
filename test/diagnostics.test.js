import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { createApp } from '../server.js';

// A fake model API over global fetch. `answer` decides what every call gets.
function fakeModelApi(answer) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://fake.model.test')) return original(url, opts);
    const body = JSON.parse(String(opts.body));
    calls.push(body);
    return answer(body);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const rejected = (status, type, message) => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status });
const replied = (text) => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }), { status: 200 });
const waitTerminal = async (engine, id) => { await engine.drain(); return engine.state.tasks[id]; };

// A fallback to the simulator is never silent: the task says what the model API answered.
test('execution record names the model API error when the simulator had to answer', async () => {
  const api = fakeModelApi(() => rejected(404, 'not_found_error', 'model: claude-nope not found'));
  try {
    const engine = createEngine({ fast: true, anthropicKey: 'sk-test', execModel: 'claude-nope', anthropicBaseUrl: 'https://fake.model.test' });
    engine.state.providers = { prv_real: {
      id: 'prv_real', name: 'Real', stake: 100, stakeReserved: 0, earnings: 0, track: 90, settledCount: 0, slashedCount: 0, reliability: 1,
      offers: { 'classify.text': { price_ceiling: 0.01, sla_deadline_ms: 8000 } },
    } };
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, {
      capability: 'classify.text', input: { text: 'great', labels: ['positive', 'negative'] },
      acceptance: { checks: [{ assert: 'one_of', path: 'label', values: ['positive', 'negative'] }] }, budget: 0.05, deadline_ms: 8000,
    });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.execution.mode, 'simulated');
    assert.match(done.execution.model_error, /model API 404 model: claude-nope not found/);
    assert.ok(!JSON.stringify(done).includes('sk-test'), 'the key never appears on the task');
  } finally { api.restore(); }
});

// A refund caused by an unreachable judge names the grader error.
test('rubric refund names grader API errors instead of looking like a quality verdict', async () => {
  const api = fakeModelApi((body) => (body.max_tokens === 16 ? rejected(401, 'authentication_error', 'invalid x-api-key') : replied('A substantive, on-topic answer that clears every length floor with ease, written for this very test.')));
  try {
    const engine = createEngine({ fast: true, anthropicKey: 'sk-test', execModel: 'exec-x', graderModel: 'grade-y', anthropicBaseUrl: 'https://fake.model.test' });
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, {
      capability: 'text.generate', input: { prompt: 'escrow' }, acceptance: { rubric: 'substantive' }, budget: 0.03, deadline_ms: 8000, min_track: 90,
    });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');
    assert.match(done.refund.detail, /graders voted 0\/3/);
    assert.match(done.refund.detail, /grader API 401 invalid x-api-key/);
  } finally { api.restore(); }
});

// /v1/status?probe=1 reports in words whether the key and model work.
test('GET /v1/status?probe=1 probes the configured models once and caches the answer', async () => {
  let n = 0;
  const api = fakeModelApi((body) => { n++; return body.model === 'good' ? replied('x') : rejected(404, 'not_found_error', `model: ${body.model} not found`); });
  const { server } = createApp({ fast: true, anthropicKey: 'sk-test', execModel: 'bad', graderModel: 'good', anthropicBaseUrl: 'https://fake.model.test', attestKey: null });
  await new Promise((r) => server.listen(0, r));
  try {
    const base = `http://localhost:${server.address().port}`;
    const plain = await (await fetch(`${base}/v1/status`)).json();
    assert.equal(plain.model_probe, undefined, 'no probe unless asked');
    const probed = await (await fetch(`${base}/v1/status?probe=1`)).json();
    assert.equal(probed.model_probe.exec.ok, false);
    assert.match(probed.model_probe.exec.error, /404 model: bad not found/);
    assert.equal(probed.model_probe.grader.ok, true);
    assert.equal(probed.model_probe.grader.model, 'good');
    assert.ok(!JSON.stringify(probed).includes('sk-test'));
    const calls = n;
    await (await fetch(`${base}/v1/status?probe=1`)).json();
    assert.equal(n, calls, 'the second probe within the TTL makes no model calls');
  } finally { server.close(); api.restore(); }
});
