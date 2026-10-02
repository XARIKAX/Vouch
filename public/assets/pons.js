// Launching an agent's token on Pons from the browser.
//
// Vouch never holds a key. The server prepares the exact transaction (the
// agent's `chain.intent`), this module asks the visitor's wallet (EIP-1193,
// window.ethereum) to switch to the right chain, reads the live launch fee
// from the factory, simulates the call so a revert is caught before anything
// is signed, sends it, then asks the server to confirm from the receipt.
import { api } from '/assets/vouch.js';

export const err = (code, message) => Object.assign(new Error(message), { code });
const hex = (n) => '0x' + BigInt(n).toString(16);
const WEI = 10n ** 18n;

export function walletProvider() {
  const p = typeof window !== 'undefined' ? window.ethereum : null;
  if (!p || typeof p.request !== 'function') throw err('no_wallet', 'No wallet found. Install a browser wallet (MetaMask, Rabby, Coinbase Wallet) and reload.');
  return p;
}

export async function venue() { return api('/v1/launchpad/pons', { key: null }); }

export async function connect(provider = walletProvider()) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw err('no_account', 'The wallet returned no account.');
  return accounts[0];
}

// Switch to the venue's chain, adding it to the wallet when it is unknown.
export async function ensureChain(cfg, provider = walletProvider()) {
  const want = cfg.chain_id_hex || hex(cfg.chain_id);
  const have = await provider.request({ method: 'eth_chainId' });
  if (String(have).toLowerCase() === want.toLowerCase()) return want;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|not added|4902/i.test(String(e?.message))) throw err('chain_switch_refused', 'The wallet did not switch to ' + cfg.network + '. ' + (e?.message || ''));
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: want, chainName: cfg.network, rpcUrls: [cfg.rpc], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [] }],
    });
  }
  const now = await provider.request({ method: 'eth_chainId' });
  if (String(now).toLowerCase() !== want.toLowerCase()) throw err('wrong_chain', `The wallet is on chain ${Number(now)}, not ${cfg.chain_id} (${cfg.network}).`);
  return want;
}

// The factory's live launch fee. msg.value must equal it exactly.
export async function readLaunchFee(intent, provider = walletProvider()) {
  const out = await provider.request({ method: 'eth_call', params: [{ to: intent.to, data: intent.launch_fee_selector }, 'latest'] });
  if (!out || out === '0x') throw err('no_fee', 'The factory did not answer launchFee(). Is the wallet on the right chain?');
  return BigInt(out);
}

// Dry-run the launch from the launcher's address; a revert surfaces here,
// before a signature is requested.
export async function simulate(intent, from, valueWei, provider = walletProvider()) {
  try {
    await provider.request({ method: 'eth_call', params: [{ from, to: intent.to, data: intent.data, value: hex(valueWei) }, 'latest'] });
  } catch (e) {
    const msg = e?.data?.message || e?.message || 'the launch would revert';
    throw err('would_revert', 'The launch would revert: ' + msg.replace(/^execution reverted:?\s*/i, '') + '. Nothing was sent.');
  }
}

export async function send(intent, from, valueWei, provider = walletProvider()) {
  const tx = { from, to: intent.to, data: intent.data, value: hex(valueWei) };
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw err('bad_hash', 'The wallet returned no transaction hash.');
  return hash;
}

// Ask the server to confirm from the receipt; poll while the chain is still
// mining. Resolves with the agent once it is live.
export async function confirm(agentId, txHash, key, { every = 4000, timeoutMs = 240000, onPending } = {}) {
  const t0 = Date.now();
  for (;;) {
    const out = await api(`/v1/agents/${encodeURIComponent(agentId)}/launch/confirm`, { method: 'POST', body: { tx_hash: txHash }, key });
    if (!out.pending) return out;
    onPending?.(Math.round((Date.now() - t0) / 1000));
    if (Date.now() - t0 > timeoutMs) throw err('still_pending', 'The transaction is still pending. Keep this page open and press "Check confirmation" in a moment, or open the transaction in the explorer.');
    await new Promise((r) => setTimeout(r, every));
  }
}

// The whole sequence. `step(name, detail)` reports progress for the UI.
export async function launch({ agent, key, cfg, from, step = () => {} }) {
  const provider = walletProvider();
  const intent = agent.chain?.intent;
  if (!intent) throw err('no_intent', 'This agent has no prepared launch.');
  step('chain', `Switching the wallet to ${cfg.network}`);
  await ensureChain(cfg, provider);
  step('fee', 'Reading the live launch fee from the factory');
  const fee = await readLaunchFee(intent, provider);
  step('simulate', `Simulating the launch (fee ${fmtEth(fee)} ETH)`);
  await simulate(intent, from, fee, provider);
  step('sign', 'Waiting for your signature in the wallet');
  const hash = await send(intent, from, fee, provider);
  step('sent', `Sent ${hash}. Waiting for the chain`, { hash });
  const live = await confirm(agent.id, hash, key, { onPending: (s) => step('pending', `Still mining after ${s}s`, { hash }) });
  step('live', 'Token launched', { hash, agent: live });
  return { hash, agent: live, fee };
}

// Pull accrued creator fees out of the Pons fee escrow. Only the recipient
// wallet can claim, so the connected wallet must be the recipient. Simulated
// first; resolves with the transaction hash once the chain has mined it.
export async function claimFees({ cfg, chain, from, step = () => {} }) {
  const provider = walletProvider();
  const escrow = chain.creator_fees?.escrow;
  const recipient = chain.creator_fee_recipient;
  if (!escrow) throw err('no_escrow', 'The fee escrow has not been read yet. Reload the page and try again.');
  if (recipient && from.toLowerCase() !== String(recipient).toLowerCase()) throw err('not_recipient', `Only the fee recipient (${short(recipient)}) can claim; the wallet is ${short(from)}.`);
  const pair = (cfg.pairs || []).find((p) => p.symbol === chain.pair);
  if (!pair) throw err('no_pair', 'Unknown quote asset for this token.');
  const data = pair.native ? cfg.claim_selectors.claim : cfg.claim_selectors.claim_token + pair.address.slice(2).toLowerCase().padStart(64, '0');
  step('chain', `Switching the wallet to ${cfg.network}`);
  await ensureChain(cfg, provider);
  step('simulate', 'Simulating the claim');
  try { await provider.request({ method: 'eth_call', params: [{ from, to: escrow, data }, 'latest'] }); }
  catch (e) { throw err('would_revert', 'The claim would revert: ' + String(e?.data?.message || e?.message || '').replace(/^execution reverted:?\s*/i, '') + '. Nothing was sent.'); }
  step('sign', 'Waiting for your signature in the wallet');
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to: escrow, data }] });
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw err('bad_hash', 'The wallet returned no transaction hash.');
  step('sent', `Sent ${hash}. Waiting for the chain`, { hash });
  const t0 = Date.now();
  for (;;) {
    const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (r) { if (r.status && Number(r.status) !== 1) throw err('claim_reverted', 'The claim transaction reverted.'); return { hash }; }
    if (Date.now() - t0 > 180000) return { hash, pending: true };
    await new Promise((res) => setTimeout(res, 4000));
  }
}

export const fmtEth = (wei) => { const n = Number(BigInt(wei)) / Number(WEI); return n >= 0.01 ? n.toFixed(4) : n.toPrecision(3).replace(/\.?0+$/, ''); };
export const explorer = (cfg, kind, value) => `${(cfg.explorer || '').replace(/\/$/, '')}/${kind}/${value}`;
export const short = (a) => (a ? String(a).slice(0, 6) + '…' + String(a).slice(-4) : '—');
// Prices on a fresh curve are fractions of a cent: show significant digits, not cents.
export const fmtPrice = (n) => { n = Number(n) || 0; if (n === 0) return '$0'; if (n >= 1) return '$' + n.toFixed(2); if (n >= 0.01) return '$' + n.toFixed(4); return '$' + n.toPrecision(3).replace(/\.?0+$/, ''); };
