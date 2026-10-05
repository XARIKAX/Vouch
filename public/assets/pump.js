// Launching an agent's token on pump.fun from the browser.
//
// Vouch never holds a key. The server prepares the exact `create`
// instruction (the agent's `chain.intent`), this module compiles it with a
// fresh blockhash, co-signs with the mint key this browser generated,
// simulates it so a failure is caught before anything is signed, asks the
// visitor's wallet to sign and send, then asks the server to confirm from
// the transaction. Claims work the same way with the creator's wallet.
import { api } from '/assets/vouch.js';
import * as sol from '/assets/sol.js';

export const err = sol.err;
export async function venue() { return api('/v1/launchpad/pump', { key: null }); }
export const connect = (opts) => sol.connect(opts);
export const newMint = () => sol.newMint();
export const storeMint = (agentId, mint) => sol.storeMint(agentId, mint);
export const storedMint = (agentId) => sol.storedMint(agentId);

// Ask the server to confirm from the transaction; poll while the cluster is
// still confirming. Resolves with the agent once it is live.
export async function confirm(agentId, signature, key, { every = 3000, timeoutMs = 180000, onPending } = {}) {
  const t0 = Date.now();
  for (;;) {
    const out = await api(`/v1/agents/${encodeURIComponent(agentId)}/launch/confirm`, { method: 'POST', body: { tx_hash: signature }, key });
    if (!out.pending) return out;
    onPending?.(Math.round((Date.now() - t0) / 1000));
    if (Date.now() - t0 > timeoutMs) throw err('still_pending', 'The transaction is still confirming. Keep this page open and press "Check confirmation" in a moment, or open the transaction in the explorer.');
    await new Promise((r) => setTimeout(r, every));
  }
}

// The whole sequence. `step(name, detail)` reports progress for the UI.
export async function launch({ agent, key, cfg, from, mint, step = () => {} }) {
  const intent = agent.chain?.intent;
  if (!intent) throw err('no_intent', 'This agent has no prepared launch.');
  if (intent.fee_payer !== from) throw err('wrong_wallet', `Connect the wallet this agent was prepared for (${short(intent.fee_payer)}); the wallet is ${short(from)}.`);
  if (!mint || mint.address !== intent.mint) throw err('no_mint', 'The mint key for this launch is not in this browser. Launch from the browser that prepared the agent, or prepare a new one.');
  step('build', 'Building the launch transaction with a fresh blockhash');
  const { bytes } = await sol.buildTx(intent, { rpc: cfg.rpc, extraSigners: [mint] });
  step('simulate', `Simulating the launch (about ${intent.estimated_cost_sol ?? cfg.estimated_cost_sol} SOL in rent and fees)`);
  await sol.simulate(cfg.rpc, bytes);
  step('sign', 'Waiting for your signature in the wallet');
  const signature = await sol.signAndSend(bytes);
  step('sent', `Sent ${signature}. Waiting for the cluster`, { hash: signature });
  const live = await confirm(agent.id, signature, key, { onPending: (s) => step('pending', `Still confirming after ${s}s`, { hash: signature }) });
  sol.forgetMint(agent.id);
  step('live', 'Token launched', { hash: signature, agent: live });
  return { hash: signature, agent: live };
}

// Pull accrued creator fees out of the creator vault. The creator's wallet
// pays the fee; the SOL lands in the creator's wallet.
export async function claimFees({ cfg, agentId, from, step = () => {} }) {
  const intent = await api(`/v1/agents/${encodeURIComponent(agentId)}/claim`, { key: null });
  if (intent.fee_payer !== from) throw err('not_recipient', `Only the creator (${short(intent.fee_payer)}) can claim; the wallet is ${short(from)}.`);
  step('build', 'Building the claim');
  const { bytes } = await sol.buildTx(intent, { rpc: cfg.rpc });
  step('simulate', 'Simulating the claim');
  await sol.simulate(cfg.rpc, bytes);
  step('sign', 'Waiting for your signature in the wallet');
  const signature = await sol.signAndSend(bytes);
  step('sent', `Sent ${signature}. Waiting for the cluster`, { hash: signature });
  const s = await sol.confirmed(cfg.rpc, signature, { timeoutMs: 120000 });
  return s ? { hash: signature } : { hash: signature, pending: true };
}

export const explorer = (cfg, kind, value) => `${(cfg.explorer || '').replace(/\/$/, '')}/${kind === 'address' ? 'account' : kind}/${value}`;
export const pumpUrl = (cfg, mint) => `${(cfg.site || 'https://pump.fun').replace(/\/$/, '')}/coin/${mint}`;
export const short = (a) => (a ? String(a).slice(0, 4) + '…' + String(a).slice(-4) : '—');
export const fmtSol = (n) => { n = Number(n) || 0; return n >= 0.01 ? n.toFixed(3) : n.toPrecision(2).replace(/\.?0+$/, ''); };
// Prices on a fresh curve are fractions of a cent: show significant digits, not cents.
export const fmtPrice = (n) => { n = Number(n) || 0; if (n === 0) return '$0'; if (n >= 1) return '$' + n.toFixed(2); if (n >= 0.01) return '$' + n.toFixed(4); return '$' + n.toPrecision(3).replace(/\.?0+$/, ''); };
