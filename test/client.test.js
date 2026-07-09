import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { VouchClient } from '../examples/vouch-client.js';
import { verifyAttestation } from '../src/attest.js';

async function boot() {
  const { server } = createApp({ fast: true });
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://localhost:${server.address().port}` };
}

test('client SDK: mint, fund, run a verified task, and check the proof', async () => {
  const { server, base } = await boot();
  try {
    const vouch = new VouchClient({ baseUrl: base });
    await vouch.mintKey('sdk-test');
    await vouch.deposit(1);
    assert.ok((await vouch.balance()).balance > 0);

    const task = await vouch.run({
      capability: 'math.eval', input: { expression: '6 * 7' },
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
      budget: 0.02, deadline_ms: 5000,
    });
    assert.equal(task.status, 'settled');
    assert.equal(task.output.result, 42);

    const { attestation, public_key } = await vouch.attestation(task.id);
    assert.ok(verifyAttestation(attestation, public_key), 'attestation verifies');

    // sub-key + verify-as-a-service through the client
    const sub = await vouch.createSubKey({ fund: 0.3, allow: ['math.eval'] });
    assert.ok(sub.key.startsWith('vch_'));
    const v = await vouch.verify({
      capability: 'math.eval', input: {}, output: { result: 4 },
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 4 }] },
    });
    assert.equal(v.pass, true);
  } finally {
    server.close();
  }
});

test('client SDK: run a verified two-step workflow', async () => {
  const { server, base } = await boot();
  try {
    const vouch = new VouchClient({ baseUrl: base });
    await vouch.mintKey('wf');
    await vouch.deposit(1);
    const wf = await vouch.runWorkflow([
      { capability: 'math.eval', input: { expression: '20 + 1' },
        acceptance: { checks: [{ assert: 'equals', path: 'result', value: 21 }] }, budget: 0.02, deadline_ms: 5000 },
      { capability: 'math.eval', input: { expression: '{{steps.0.output.result}} * 2' },
        acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 0.02, deadline_ms: 5000 },
    ]);
    assert.equal(wf.status, 'completed');
    assert.equal(wf.output.result, 42);
  } finally {
    server.close();
  }
});
