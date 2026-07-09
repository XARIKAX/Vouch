// A reference autonomous agent on Vouch. It funds a wallet, buys a verified
// outcome with auto-retry, checks the signed proof, delegates a capped budget
// to a sub-agent, and runs a two-step verified workflow — the whole loop in
// ~40 lines. Zero dependencies.
//
//   npm start            # in one terminal (boots Vouch on :4402)
//   node examples/agent-example.js
//
import { VouchClient } from './vouch-client.js';
import { verifyAttestation } from '../src/attest.js';

const BASE = process.env.VOUCH_URL ?? 'http://localhost:4402';
const log = (...a) => console.log('·', ...a);

const vouch = new VouchClient({ baseUrl: BASE });
await vouch.mintKey('reference-agent');
await vouch.deposit(3);
log('funded:', '$' + (await vouch.balance()).balance);

// 1) Buy a verified outcome. retry:true keeps rerouting until it passes.
const task = await vouch.run({
  capability: 'text.generate',
  input: { prompt: 'In two sentences, why does verifying output before payment matter for AI agents?' },
  acceptance: { checks: [{ assert: 'word_count', min: 15 }, { assert: 'contains_none', values: ['###', 'ERROR'] }] },
  budget: 0.03, deadline_ms: 12000, retry: true,
});
log('task:', task.status, '·', task.settlement ? '$' + task.settlement.price : task.refund?.reason);
if (task.status === 'settled') log('output:', JSON.stringify(task.output).slice(0, 120) + '…');

// 2) Verify the proof-of-verified-work offline — don't trust, check.
if (task.status === 'settled') {
  const { attestation, public_key } = await vouch.attestation(task.id);
  log('attestation valid:', verifyAttestation(attestation, public_key));
}

// 3) Delegate a capped, allowlisted wallet to a child agent.
const sub = await vouch.createSubKey({ name: 'summarizer', fund: 1, allow: ['text.summarize'] });
log('sub-key minted:', sub.id, '· allow:', sub.allow?.join(','));

// 4) Run a verified two-step workflow (output of step 1 feeds step 2).
const wf = await vouch.runWorkflow([
  { capability: 'math.eval', input: { expression: '6 * 7' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 0.01, deadline_ms: 5000 },
  { capability: 'math.eval', input: { expression: '{{steps.0.output.result}} + 8' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 50 }] }, budget: 0.01, deadline_ms: 5000 },
]);
log('workflow:', wf.status, '· final output:', JSON.stringify(wf.output));

log('done — every result above was verified before a cent moved.');
