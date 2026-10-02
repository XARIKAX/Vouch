// Pons V2 on Robinhood Chain: the launchpad agents launch their tokens on.
//
// Vouch never holds a wallet or signs a launch. It prepares the exact
// transaction (the calldata for PonsV2LaunchFactory.launchToken with the
// agent's metadata and the creator-fee recipient), the launcher's wallet
// signs and sends it, and Vouch then verifies the receipt on-chain, reads
// the token and bonding-curve addresses from the TokenLaunched event, and
// prices the agent's token from the curve's reserves from then on.
//
// Contract facts (from the published pons-labs sources):
//   launchToken(TokenParams params, uint256 launchConfigId, address pairToken)
//     payable, msg.value must equal launchFee(); pairToken address(0) = native ETH
//   TokenParams { name, symbol, logo, description, Socials{twitter, telegram,
//     discord, website, farcaster}, creatorFeeRecipient, creatorTaxBps (≤ 1000),
//     buybackEnabled, expectedEconomics (bytes32(0) = no pin), salt }
//   event TokenLaunched(address indexed token, address indexed curve,
//     address indexed deployer, address pairToken, uint256 launchConfigId,
//     uint256 graduationThreshold)
//   curve: getReserves() → (quoteReserve, tokenReserve); realQuoteReserve();
//     graduated(); readyToGraduate(); graduationThreshold()
//   fee escrow: balanceOf(recipient) for ETH, balanceOfToken(recipient, token)

import { encodeCall, decodeParams, eventTopic, selector, toHex, decodeAddressWord } from './abi.js';
import { keccakHex } from './keccak.js';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const PONS = Object.freeze({
  network: 'Robinhood Chain',
  chainId: 4663,
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  launchRouter: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
  pairs: {
    ETH: { symbol: 'ETH', address: ZERO, decimals: 18, native: true },
    USDG: { symbol: 'USDG', address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6, native: false },
  },
  defaultLaunchFeeWei: 500000000000000n,      // 0.0005 ETH, the usual value; read live before sending
  maxCreatorTaxBps: 1000,
});

export const LAUNCH_SIG = 'launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)';
export const TOKEN_LAUNCHED_TOPIC = eventTopic('TokenLaunched(address,address,address,address,uint256,uint256)');
const SEL = { launchFee: toHex(selector('launchFee()')), getReserves: toHex(selector('getReserves()')), realQuoteReserve: toHex(selector('realQuoteReserve()')), graduated: toHex(selector('graduated()')), readyToGraduate: toHex(selector('readyToGraduate()')), graduationThreshold: toHex(selector('graduationThreshold()')), feeEscrow: toHex(selector('feeEscrow()')) };

// Deployment-time overrides (another RPC, a different factory, a fee
// recipient contract once the bond vault is on-chain).
export function ponsConfig(env = process.env) {
  return {
    ...PONS,
    rpc: env.VOUCH_CHAIN_RPC || PONS.rpc,
    chainId: Number(env.VOUCH_CHAIN_ID) || PONS.chainId,
    factory: env.VOUCH_PONS_FACTORY || PONS.factory,
    explorer: env.VOUCH_CHAIN_EXPLORER || PONS.explorer,
    creatorFeeRecipient: env.VOUCH_CREATOR_FEE_RECIPIENT || null,   // null: the launcher's own wallet
    ethUsd: Number(env.VOUCH_ETH_USD) || null,                      // to value ETH-quoted tokens in dollars
  };
}

const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const clampStr = (v, n) => String(v ?? '').trim().slice(0, n);

// The transaction a wallet signs. Pure: no network.
export function buildLaunchIntent(input, cfg = ponsConfig()) {
  const symbol = clampStr(input.symbol, 12).toUpperCase();
  const name = clampStr(input.name, 48) || `${symbol} agent`;
  if (!symbol) throw Object.assign(new Error('symbol is required'), { code: 'invalid_input' });
  if (!isAddress(input.wallet)) throw Object.assign(new Error('launch.wallet must be the launcher\'s wallet address'), { code: 'invalid_input' });
  const pairKey = String(input.pair || 'USDG').toUpperCase();
  const pair = cfg.pairs[pairKey];
  if (!pair) throw Object.assign(new Error(`launch.pair must be one of ${Object.keys(cfg.pairs).join(', ')}`), { code: 'invalid_input' });
  const tax = Math.round(Number(input.creator_tax_bps ?? 100));
  if (!(tax >= 0 && tax <= cfg.maxCreatorTaxBps)) throw Object.assign(new Error(`launch.creator_tax_bps must be between 0 and ${cfg.maxCreatorTaxBps}`), { code: 'invalid_input' });
  const recipient = cfg.creatorFeeRecipient || input.wallet;
  const s = input.socials || {};
  const socials = [clampStr(s.twitter, 64), clampStr(s.telegram, 64), clampStr(s.discord, 64), clampStr(s.website || input.website, 128), clampStr(s.farcaster, 64)];
  const salt = input.salt && /^0x[0-9a-fA-F]{64}$/.test(input.salt) ? input.salt : keccakHex(`vouch:${input.agent_id || symbol}:${input.wallet}`);
  const launchConfigId = Number.isInteger(input.launch_config_id) ? input.launch_config_id : 0;
  const params = [name, symbol, clampStr(input.logo, 256), clampStr(input.description, 600), socials, recipient, tax, !!input.buyback, '0x' + '00'.repeat(32), salt];
  const data = encodeCall(LAUNCH_SIG, [params, launchConfigId, pair.address]);
  return {
    venue: 'pons', network: cfg.network, chain_id: cfg.chainId, explorer: cfg.explorer,
    to: cfg.factory, data, value_wei: cfg.defaultLaunchFeeWei.toString(), value_note: 'read launchFee() from the factory right before sending; msg.value must equal it',
    launch_fee_selector: SEL.launchFee,
    params: { name, symbol, logo: params[2], description: params[3], socials: { twitter: socials[0], telegram: socials[1], discord: socials[2], website: socials[3], farcaster: socials[4] }, creator_fee_recipient: recipient, creator_tax_bps: tax, buyback_enabled: !!input.buyback, launch_config_id: launchConfigId, pair: pair.symbol, pair_token: pair.address, salt },
  };
}

// The TokenLaunched log from a receipt, or null when the receipt has none.
export function parseLaunchReceipt(receipt, factory = PONS.factory) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== factory.toLowerCase()) continue;
    if (!log.topics || String(log.topics[0]).toLowerCase() !== TOKEN_LAUNCHED_TOPIC) continue;
    const [pairToken, launchConfigId, graduationThreshold] = decodeParams(['address', 'uint256', 'uint256'], log.data);
    return {
      token: decodeAddressWord(log.topics[1]), curve: decodeAddressWord(log.topics[2]), deployer: decodeAddressWord(log.topics[3]),
      pair_token: pairToken, launch_config_id: Number(launchConfigId), graduation_threshold: graduationThreshold.toString(),
      block_number: receipt.blockNumber ? Number(receipt.blockNumber) : null,
    };
  }
  return null;
}

// Receipt → launch facts. null while the transaction is still pending.
export async function verifyLaunch(rpc, txHash, cfg = ponsConfig()) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw Object.assign(new Error('tx_hash must be a 32-byte hex hash'), { code: 'invalid_input' });
  const receipt = await rpc.getTransactionReceipt(txHash);
  if (!receipt) return null;
  if (receipt.status && Number(receipt.status) !== 1) throw Object.assign(new Error('the launch transaction reverted'), { code: 'launch_reverted' });
  const launch = parseLaunchReceipt(receipt, cfg.factory);
  if (!launch) throw Object.assign(new Error('the transaction did not emit TokenLaunched from the Pons factory'), { code: 'not_a_launch' });
  return launch;
}

export async function readLaunchFee(rpc, cfg = ponsConfig()) {
  const [fee] = decodeParams(['uint256'], await rpc.ethCall(cfg.factory, SEL.launchFee));
  return fee;
}

// Price and liquidity from the bonding curve. Tokens are 18-decimal; the
// quote has the pair's decimals. Price = quoteReserve / tokenReserve, the
// constant-product spot (the curve's phantom quote is included, as Pons prices).
export async function readCurve(rpc, curve, pair) {
  const [q, t] = decodeParams(['uint256', 'uint256'], await rpc.ethCall(curve, SEL.getReserves));
  const [real] = decodeParams(['uint256'], await rpc.ethCall(curve, SEL.realQuoteReserve));
  const [graduated] = decodeParams(['bool'], await rpc.ethCall(curve, SEL.graduated));
  const [ready] = decodeParams(['bool'], await rpc.ethCall(curve, SEL.readyToGraduate));
  const [threshold] = decodeParams(['uint256'], await rpc.ethCall(curve, SEL.graduationThreshold));
  const qd = 10 ** pair.decimals, td = 1e18;
  const quote = Number(q) / qd, tokens = Number(t) / td, realQuote = Number(real) / qd, thr = Number(threshold) / qd;
  return {
    price_quote: tokens > 0 ? quote / tokens : 0, quote_reserve: quote, token_reserve: tokens, real_quote_reserve: realQuote,
    graduation_threshold_quote: thr, graduation_progress: thr > 0 ? Math.min(1, realQuote / thr) : null,
    graduated, ready_to_graduate: ready, pair: pair.symbol,
  };
}

export async function readCreatorFees(rpc, factory, recipient, pair) {
  const [escrow] = decodeParams(['address'], await rpc.ethCall(factory, SEL.feeEscrow));
  const data = pair.native
    ? encodeCall('balanceOf(address)', [recipient])
    : encodeCall('balanceOfToken(address,address)', [recipient, pair.address]);
  const [bal] = decodeParams(['uint256'], await rpc.ethCall(escrow, data));
  return { escrow, balance: Number(bal) / 10 ** pair.decimals, pair: pair.symbol };
}

export const pairFor = (cfg, pairToken) => Object.values(cfg.pairs).find((p) => p.address.toLowerCase() === String(pairToken).toLowerCase()) || { symbol: 'TOKEN', address: pairToken, decimals: 18, native: false };
export const chainIdHex = (id) => '0x' + Number(id).toString(16);
