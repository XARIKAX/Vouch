// Real funds: USDG on Robinhood Chain, in and out of the Vouch treasury.
//
// Deposits: the account's wallet sends USDG to the treasury address; the
// server verifies the receipt (an ERC-20 Transfer from that wallet to the
// treasury on the USDG contract) and credits the ledger 1:1.
// Withdrawals: the ledger is debited, then USDG is sent back to the
// account's wallet. With a treasury key configured the server signs and
// sends the transfer itself; without one the request waits for an operator
// to pay it from their wallet and confirm the transaction hash, which is
// verified on-chain the same way before the request is marked paid.
import { PONS } from './pons.js';
import { encodeCall, decodeParams, eventTopic, decodeAddressWord } from './abi.js';
import { signEip1559 } from './tx.js';
import { addressFromPrivate } from './secp256k1.js';

export const TRANSFER_TOPIC = eventTopic('Transfer(address,address,uint256)');
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function fundsConfig(env = process.env) {
  const treasury = isAddress(env.VOUCH_TREASURY_ADDRESS) ? env.VOUCH_TREASURY_ADDRESS : null;
  let treasuryKey = env.VOUCH_TREASURY_KEY && /^(0x)?[0-9a-fA-F]{64}$/.test(env.VOUCH_TREASURY_KEY) ? env.VOUCH_TREASURY_KEY : null;
  let signer = null;
  if (treasuryKey) { try { signer = addressFromPrivate(treasuryKey); } catch { treasuryKey = null; } }
  // the key must be the treasury's own key, or payouts would come from elsewhere
  if (signer && treasury && !same(signer, treasury)) { treasuryKey = null; signer = null; }
  return {
    enabled: env.VOUCH_REAL_FUNDS === '1' && !!treasury,
    treasury, treasuryKey, signer,
    token: { symbol: 'USDG', address: env.VOUCH_USDG_ADDRESS || PONS.pairs.USDG.address, decimals: 6 },
    minWithdrawal: Number(env.VOUCH_MIN_WITHDRAWAL) || 1,
    maxWithdrawal: Number(env.VOUCH_MAX_WITHDRAWAL) || 1000,
  };
}

export const toUnits = (amount, decimals = 6) => BigInt(Math.round(Number(amount) * 10 ** decimals));
export const fromUnits = (units, decimals = 6) => Number(units) / 10 ** decimals;

// The Transfer of the configured token into the treasury, from a receipt.
export function parseTransfer(receipt, { token, to }) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  for (const log of receipt.logs) {
    if (!same(log.address, token.address)) continue;
    if (!log.topics || String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const from = decodeAddressWord(log.topics[1]), dest = decodeAddressWord(log.topics[2]);
    if (!same(dest, to)) continue;
    const [units] = decodeParams(['uint256'], log.data);
    return { from, to: dest, units, amount: fromUnits(units, token.decimals), block_number: receipt.blockNumber ? Number(receipt.blockNumber) : null };
  }
  return null;
}
const checkHash = (h) => { if (!/^0x[0-9a-fA-F]{64}$/.test(String(h || ''))) throw Object.assign(new Error('tx_hash must be a 32-byte hex hash'), { code: 'invalid_input' }); };

// A deposit: null while pending; throws deposit_reverted / not_a_deposit.
export async function verifyDeposit(rpc, txHash, cfg) {
  checkHash(txHash);
  const receipt = await rpc.getTransactionReceipt(txHash);
  if (!receipt) return null;
  if (receipt.status && Number(receipt.status) !== 1) throw Object.assign(new Error('the deposit transaction reverted'), { code: 'deposit_reverted' });
  const t = parseTransfer(receipt, { token: cfg.token, to: cfg.treasury });
  if (!t) throw Object.assign(new Error(`the transaction did not transfer ${cfg.token.symbol} to the treasury`), { code: 'not_a_deposit' });
  return t;
}
// A payout someone sent by hand: the transfer must go from the treasury to the recipient for the amount.
export async function verifyPayout(rpc, txHash, cfg, { to, units }) {
  checkHash(txHash);
  const receipt = await rpc.getTransactionReceipt(txHash);
  if (!receipt) return null;
  if (receipt.status && Number(receipt.status) !== 1) throw Object.assign(new Error('the payout transaction reverted'), { code: 'payout_reverted' });
  const t = parseTransfer(receipt, { token: cfg.token, to });
  if (!t || !same(t.from, cfg.treasury)) throw Object.assign(new Error('the transaction is not a treasury payout to this wallet'), { code: 'not_a_payout' });
  if (t.units < units) throw Object.assign(new Error('the payout is smaller than the withdrawal'), { code: 'payout_short' });
  return t;
}

export const transferData = (to, units) => encodeCall('transfer(address,uint256)', [to, units]);

// Sign and send a token transfer from the treasury. Returns the tx hash.
export async function sendToken(rpc, cfg, to, units, { chainId } = {}) {
  if (!cfg.treasuryKey) throw Object.assign(new Error('no treasury key configured'), { code: 'no_signer' });
  if (!isAddress(to)) throw Object.assign(new Error('recipient must be an address'), { code: 'invalid_input' });
  const data = transferData(to, units);
  const from = cfg.signer;
  const [nonce, gasPrice, tip, id] = await Promise.all([rpc.getTransactionCount(from), rpc.gasPrice(), rpc.maxPriorityFeePerGas(), chainId ? Promise.resolve(chainId) : rpc.chainId()]);
  let gas;
  try { gas = await rpc.estimateGas({ from, to: cfg.token.address, data }); }
  catch (e) { throw Object.assign(new Error('the payout would fail: ' + e.message.replace(/^rpc \w+ failed: /, '')), { code: 'payout_would_fail' }); }
  const maxFee = gasPrice * 2n + tip;
  const { raw, hash } = signEip1559({ chainId: id, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gas: gas + gas / 5n, to: cfg.token.address, value: 0n, data }, cfg.treasuryKey);
  const sent = await rpc.sendRawTransaction(raw);
  return sent || hash;
}
