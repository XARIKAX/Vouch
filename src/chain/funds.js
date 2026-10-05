// Real funds: USDT on Solana, in and out of the Vouch treasury.
//
// Deposits: the account's wallet sends USDT to the treasury's token account;
// the server reads the confirmed transaction, checks from its token balance
// changes that USDT moved from that wallet to the treasury, and credits the
// ledger 1:1. Withdrawals: the ledger is debited, then USDT is sent back to
// the account's wallet. With a treasury key configured the server signs and
// sends the transfer itself (creating the wallet's token account if it is
// missing); without one the request waits for an operator to pay it from
// their wallet and confirm the signature, which is verified on-chain the
// same way before the request is marked paid.
import { isPubkey } from './base58.js';
import { keypairFromSecret } from './ed25519.js';
import { associatedTokenAddress, ix, signTransaction, toBase64 } from './solana.js';

export const USDT = Object.freeze({ symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 });

export function fundsConfig(env = process.env) {
  const treasury = isPubkey(env.VOUCH_TREASURY_ADDRESS) ? env.VOUCH_TREASURY_ADDRESS : null;
  let treasuryKey = null;
  if (env.VOUCH_TREASURY_KEY) { try { treasuryKey = keypairFromSecret(env.VOUCH_TREASURY_KEY); } catch { treasuryKey = null; } }
  // the key must be the treasury's own key, or payouts would come from elsewhere
  if (treasuryKey && treasury && treasuryKey.address !== treasury) treasuryKey = null;
  const token = { symbol: env.VOUCH_TOKEN_SYMBOL || USDT.symbol, mint: isPubkey(env.VOUCH_USDT_MINT) ? env.VOUCH_USDT_MINT : USDT.mint, decimals: Number(env.VOUCH_TOKEN_DECIMALS) || USDT.decimals };
  return {
    enabled: env.VOUCH_REAL_FUNDS === '1' && !!treasury,
    treasury, treasuryKey, signer: treasuryKey?.address ?? null,
    treasuryAta: treasury ? associatedTokenAddress(treasury, token.mint) : null,
    token,
    minWithdrawal: Number(env.VOUCH_MIN_WITHDRAWAL) || 1,
    maxWithdrawal: Number(env.VOUCH_MAX_WITHDRAWAL) || 1000,
  };
}

export const toUnits = (amount, decimals = 6) => BigInt(Math.round(Number(amount) * 10 ** decimals));
export const fromUnits = (units, decimals = 6) => Number(units) / 10 ** decimals;

// What the token's balances did in a confirmed transaction: the credit to
// `to` (an owner wallet) and who paid it. From meta.pre/postTokenBalances,
// which carry owner and mint per token account, so any transfer path counts.
export function parseTokenMovement(tx, { mint, to }) {
  const meta = tx?.meta; if (!meta) return null;
  const pre = new Map(), post = new Map();
  for (const b of meta.preTokenBalances ?? []) if (b.mint === mint && b.owner) pre.set(b.accountIndex, { owner: b.owner, amount: BigInt(b.uiTokenAmount?.amount ?? 0) });
  for (const b of meta.postTokenBalances ?? []) if (b.mint === mint && b.owner) post.set(b.accountIndex, { owner: b.owner, amount: BigInt(b.uiTokenAmount?.amount ?? 0) });
  const delta = new Map();
  for (const idx of new Set([...pre.keys(), ...post.keys()])) {
    const owner = post.get(idx)?.owner ?? pre.get(idx)?.owner;
    const d = (post.get(idx)?.amount ?? 0n) - (pre.get(idx)?.amount ?? 0n);
    delta.set(owner, (delta.get(owner) ?? 0n) + d);
  }
  const credited = delta.get(to) ?? 0n;
  if (credited <= 0n) return null;
  let from = null, most = 0n;
  for (const [owner, d] of delta) if (owner !== to && d < most) { most = d; from = owner; }
  if (!from) return null;
  return { from, to, units: credited, slot: tx.slot ?? null, block_time: tx.blockTime ?? null };
}
const checkSignature = (s) => { if (!/^[1-9A-HJ-NP-Za-km-z]{86,90}$/.test(String(s || ''))) throw Object.assign(new Error('tx_hash must be a Solana transaction signature'), { code: 'invalid_input' }); };

// A deposit: null while pending; throws deposit_reverted / not_a_deposit.
export async function verifyDeposit(rpc, signature, cfg) {
  checkSignature(signature);
  const tx = await rpc.getTransaction(signature);
  if (!tx) return null;
  if (tx.meta?.err) throw Object.assign(new Error('the deposit transaction failed on-chain'), { code: 'deposit_reverted' });
  const t = parseTokenMovement(tx, { mint: cfg.token.mint, to: cfg.treasury });
  if (!t) throw Object.assign(new Error(`the transaction did not transfer ${cfg.token.symbol} to the treasury`), { code: 'not_a_deposit' });
  return { ...t, amount: fromUnits(t.units, cfg.token.decimals) };
}
// A payout someone sent by hand: the transfer must go from the treasury to the recipient for the amount.
export async function verifyPayout(rpc, signature, cfg, { to, units }) {
  checkSignature(signature);
  const tx = await rpc.getTransaction(signature);
  if (!tx) return null;
  if (tx.meta?.err) throw Object.assign(new Error('the payout transaction failed on-chain'), { code: 'payout_reverted' });
  const t = parseTokenMovement(tx, { mint: cfg.token.mint, to });
  if (!t || t.from !== cfg.treasury) throw Object.assign(new Error('the transaction is not a treasury payout to this wallet'), { code: 'not_a_payout' });
  if (t.units < units) throw Object.assign(new Error('the payout is smaller than the withdrawal'), { code: 'payout_short' });
  return { ...t, amount: fromUnits(t.units, cfg.token.decimals) };
}

// The instruction a wallet signs to deposit: a checked transfer from its own
// token account to the treasury's. Pure; the browser compiles and the wallet signs.
export function depositInstructions(cfg, from, units) {
  return [ix.transferChecked(associatedTokenAddress(from, cfg.token.mint), cfg.token.mint, cfg.treasuryAta, from, units, cfg.token.decimals)];
}
// The instructions of a payout: make sure the wallet has a token account, then transfer.
export function payoutInstructions(cfg, to, units) {
  return [
    ix.createAtaIdempotent(cfg.treasury, to, cfg.token.mint),
    ix.transferChecked(cfg.treasuryAta, cfg.token.mint, associatedTokenAddress(to, cfg.token.mint), cfg.treasury, units, cfg.token.decimals),
  ];
}
// Sign and send a token transfer from the treasury. Returns the signature.
export async function sendToken(rpc, cfg, to, units) {
  if (!cfg.treasuryKey) throw Object.assign(new Error('no treasury key configured'), { code: 'no_signer' });
  if (!isPubkey(to)) throw Object.assign(new Error('recipient must be a Solana address'), { code: 'invalid_input' });
  const { blockhash } = await rpc.getLatestBlockhash();
  const { bytes, signature } = signTransaction({ feePayer: cfg.treasury, instructions: payoutInstructions(cfg, to, units), recentBlockhash: blockhash }, [cfg.treasuryKey]);
  try { const sent = await rpc.sendTransaction(toBase64(bytes)); return sent || signature; }
  catch (e) { throw Object.assign(new Error('the payout would fail: ' + e.message.replace(/^rpc \w+ failed: /, '')), { code: 'payout_would_fail' }); }
}
