// pump.fun on Solana: the launchpad agents launch their tokens on.
//
// Vouch never holds a wallet or signs a launch. It prepares the exact
// `create` instruction for the pump.fun program (the agent's metadata, a
// fresh mint the browser generated, the creator who earns the curve's
// creator fees), the launcher's wallet signs and sends it, and Vouch then
// verifies the transaction on-chain, derives the bonding curve, and prices
// the agent's token from the curve's reserves from then on.
//
// Program facts (from the published pump.fun IDL):
//   create(name, symbol, uri, creator)  accounts: mint (signer), mint_authority
//     PDA ["mint-authority"], bonding_curve PDA ["bonding-curve", mint],
//     associated_bonding_curve (ATA of the curve), global PDA ["global"],
//     mpl_token_metadata, metadata PDA, user (signer, payer), system, token,
//     associated token, rent, event_authority PDA ["__event_authority"], program
//   collect_creator_fee()  accounts: creator (signer), creator_vault PDA
//     ["creator-vault", creator], system, event_authority, program
//   BondingCurve account: 8-byte discriminator, virtual_token_reserves u64,
//     virtual_sol_reserves u64, real_token_reserves u64, real_sol_reserves u64,
//     token_total_supply u64, complete bool, creator pubkey
import { encodeBase58, decodeBase58, isPubkey } from './base58.js';
import { PROGRAMS, findProgramAddress, associatedTokenAddress, anchorDiscriminator, borshString, toBase64 } from './solana.js';
import { utf8, concat, readU64le } from '../../public/assets/solmsg.js';

export const PUMP = Object.freeze({
  network: 'Solana', cluster: 'mainnet-beta',
  rpc: 'https://api.mainnet-beta.solana.com',
  explorer: 'https://solscan.io',
  site: 'https://pump.fun',
  program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pair: { symbol: 'SOL', decimals: 9 },
  tokenDecimals: 6,
  graduationSol: 85,              // real SOL in the curve at which pump.fun graduates a token
  estimatedCostSol: 0.025,        // rent for the mint, curve and metadata accounts plus fees
  limits: { name: 32, symbol: 10, uri: 200 },
});

export function pumpConfig(env = process.env) {
  return {
    ...PUMP,
    rpc: env.VOUCH_CHAIN_RPC || PUMP.rpc,
    explorer: env.VOUCH_CHAIN_EXPLORER || PUMP.explorer,
    program: env.VOUCH_PUMP_PROGRAM || PUMP.program,
    publicUrl: (env.VOUCH_PUBLIC_URL || 'https://www.vouchagents.com').replace(/\/$/, ''),
    creatorFeeRecipient: isPubkey(env.VOUCH_CREATOR_FEE_RECIPIENT) ? env.VOUCH_CREATOR_FEE_RECIPIENT : null,   // null: the launcher's own wallet
    solUsd: Number(env.VOUCH_SOL_USD) || null,          // a fixed dollar rate for SOL
    solUsdUrl: env.VOUCH_SOL_USD_URL || null,           // or a JSON URL the operator chooses, read every minute
    solUsdPath: env.VOUCH_SOL_USD_PATH || null,         // dot path to the number in that JSON
    graduationSol: Number(env.VOUCH_PUMP_GRADUATION_SOL) || PUMP.graduationSol,
  };
}

// ---- addresses --------------------------------------------------------------
export const pda = {
  global: (cfg = PUMP) => findProgramAddress(['global'], cfg.program).address,
  mintAuthority: (cfg = PUMP) => findProgramAddress(['mint-authority'], cfg.program).address,
  eventAuthority: (cfg = PUMP) => findProgramAddress(['__event_authority'], cfg.program).address,
  bondingCurve: (mint, cfg = PUMP) => findProgramAddress(['bonding-curve', decodeBase58(mint)], cfg.program).address,
  creatorVault: (creator, cfg = PUMP) => findProgramAddress(['creator-vault', decodeBase58(creator)], cfg.program).address,
  metadata: (mint) => findProgramAddress(['metadata', decodeBase58(PROGRAMS.metadata), decodeBase58(mint)], PROGRAMS.metadata).address,
};
export const DISC = { create: anchorDiscriminator('create'), collectCreatorFee: anchorDiscriminator('collect_creator_fee'), buy: anchorDiscriminator('buy'), sell: anchorDiscriminator('sell') };

const clampStr = (v, n) => String(v ?? '').trim().slice(0, n);
const key = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const publicIx = (ix) => ({ program_id: ix.programId, keys: ix.keys.map((k) => ({ pubkey: k.pubkey, is_signer: k.isSigner, is_writable: k.isWritable })), data: toBase64(ix.data) });

// The `create` instruction a wallet signs, with the fresh mint as co-signer.
// Pure: no network. The metadata URI points back at Vouch, which serves the
// token's JSON (name, symbol, description, image, socials) for pump.fun.
export function buildLaunchIntent(input, cfg = pumpConfig()) {
  const symbol = clampStr(input.symbol, cfg.limits.symbol).toUpperCase();
  const name = clampStr(input.name, cfg.limits.name) || `${symbol} agent`;
  if (!symbol) throw Object.assign(new Error('symbol is required'), { code: 'invalid_input' });
  if (!isPubkey(input.wallet)) throw Object.assign(new Error('launch.wallet must be the launcher\'s Solana wallet address'), { code: 'invalid_input' });
  if (!isPubkey(input.mint)) throw Object.assign(new Error('launch.mint must be the public key of a fresh mint keypair the launcher generated and will co-sign with'), { code: 'invalid_input' });
  if (input.pair && String(input.pair).toUpperCase() !== 'SOL') throw Object.assign(new Error('pump.fun curves are paired with SOL'), { code: 'invalid_input' });
  const creator = cfg.creatorFeeRecipient || input.wallet;
  const uri = clampStr(input.uri, cfg.limits.uri) || `${cfg.publicUrl}/v1/agents/${encodeURIComponent(input.agent_id || symbol.toLowerCase())}/token.json`;
  const s = input.socials || {};
  const params = {
    name, symbol, uri, description: clampStr(input.description, 600), logo: clampStr(input.logo, 256),
    socials: { twitter: clampStr(s.twitter, 64), telegram: clampStr(s.telegram, 64), website: clampStr(s.website || input.website, 128) },
  };
  const mint = input.wallet && input.mint;
  const curve = pda.bondingCurve(mint, cfg);
  const data = concat(DISC.create, borshString(name), borshString(symbol), borshString(uri), decodeBase58(creator));
  const ix = {
    programId: cfg.program,
    keys: [
      key(mint, true, true), key(pda.mintAuthority(cfg)), key(curve, false, true), key(associatedTokenAddress(curve, mint), false, true),
      key(pda.global(cfg)), key(PROGRAMS.metadata), key(pda.metadata(mint), false, true), key(input.wallet, true, true),
      key(PROGRAMS.system), key(PROGRAMS.token), key(PROGRAMS.associatedToken), key(PROGRAMS.rent), key(pda.eventAuthority(cfg)), key(cfg.program),
    ],
    data,
  };
  return {
    venue: 'pump', network: cfg.network, cluster: cfg.cluster, explorer: cfg.explorer, site: cfg.site, program: cfg.program,
    fee_payer: input.wallet, mint, creator, bonding_curve: curve, creator_vault: pda.creatorVault(creator, cfg),
    signers: [input.wallet, mint], instructions: [publicIx(ix)],
    estimated_cost_sol: cfg.estimatedCostSol, cost_note: 'rent for the mint, curve and metadata accounts plus network fees; read live by the wallet before signing',
    params: { ...params, creator_fee_recipient: creator, pair: 'SOL' },
  };
}

// The Metaplex-style token JSON pump.fun reads from the metadata URI.
export const tokenMetadata = (params) => ({
  name: params.name, symbol: params.symbol, description: params.description || '', image: params.logo || '', showName: true, createdOn: PUMP.site,
  ...(params.socials?.twitter ? { twitter: params.socials.twitter } : {}), ...(params.socials?.telegram ? { telegram: params.socials.telegram } : {}), ...(params.socials?.website ? { website: params.socials.website } : {}),
});

// The claim a creator's wallet signs to pull accrued creator fees out of the vault.
export function buildClaimIntent(creator, cfg = pumpConfig()) {
  if (!isPubkey(creator)) throw Object.assign(new Error('creator must be a Solana address'), { code: 'invalid_input' });
  // per the IDL the creator account is writable, not a signer: the wallet signs as fee payer
  const ix = { programId: cfg.program, keys: [key(creator, false, true), key(pda.creatorVault(creator, cfg), false, true), key(PROGRAMS.system), key(pda.eventAuthority(cfg)), key(cfg.program)], data: DISC.collectCreatorFee };
  return { venue: 'pump', fee_payer: creator, signers: [creator], creator_vault: pda.creatorVault(creator, cfg), instructions: [publicIx(ix)] };
}

// ---- reading the chain --------------------------------------------------------
const startsWith = (a, b) => b.every((v, i) => a[i] === v);
const decodeArgs = (data) => {
  let o = 8; const str = () => { const n = new DataView(data.buffer, data.byteOffset + o, 4).getUint32(0, true); o += 4; const s = new TextDecoder().decode(data.subarray(o, o + n)); o += n; return s; };
  const name = str(), symbol = str(), uri = str();
  const creator = data.length >= o + 32 ? encodeBase58(data.subarray(o, o + 32)) : null;
  return { name, symbol, uri, creator };
};
// The create instruction from a confirmed transaction (jsonParsed), or null.
export function parseLaunchTransaction(tx, cfg = PUMP) {
  const msg = tx?.transaction?.message; if (!msg) return null;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []);
  for (const ix of [...(msg.instructions ?? []), ...inner]) {
    if (ix.programId !== cfg.program || typeof ix.data !== 'string' || !Array.isArray(ix.accounts)) continue;
    let data; try { data = decodeBase58(ix.data); } catch { continue; }
    if (!startsWith(data, DISC.create)) continue;
    const args = decodeArgs(data);
    const mint = ix.accounts[0], deployer = ix.accounts[7];
    return { token: mint, curve: pda.bondingCurve(mint, cfg), deployer, creator: args.creator ?? deployer, name: args.name, symbol: args.symbol, uri: args.uri, slot: tx.slot ?? null, block_time: tx.blockTime ?? null };
  }
  return null;
}
const checkSignature = (s) => { let b; try { b = decodeBase58(s); } catch { b = null; } if (!b || b.length !== 64) throw Object.assign(new Error('tx_hash must be a Solana transaction signature (base58, 64 bytes)'), { code: 'invalid_input' }); };

// Transaction → launch facts. null while it is not yet confirmed.
export async function verifyLaunch(rpc, signature, cfg = pumpConfig()) {
  checkSignature(signature);
  const tx = await rpc.getTransaction(signature);
  if (!tx) return null;
  if (tx.meta?.err) throw Object.assign(new Error('the launch transaction failed on-chain'), { code: 'launch_reverted' });
  const launch = parseLaunchTransaction(tx, cfg);
  if (!launch) throw Object.assign(new Error('the transaction did not create a token on the pump.fun program'), { code: 'not_a_launch' });
  return launch;
}

// Price and liquidity from the bonding curve account. Tokens are 6-decimal,
// SOL 9. Price = virtual SOL / virtual tokens, the constant-product spot.
export function decodeCurve(data, cfg = PUMP) {
  if (!data || data.length < 49) throw new Error('not a bonding curve account');
  const vTok = readU64le(data, 8), vSol = readU64le(data, 16), rTok = readU64le(data, 24), rSol = readU64le(data, 32), supply = readU64le(data, 40);
  const complete = data[48] === 1;
  const creator = data.length >= 81 ? encodeBase58(data.subarray(49, 81)) : null;
  const sol = (n) => Number(n) / 1e9, tok = (n) => Number(n) / 10 ** cfg.tokenDecimals;
  const quote = sol(vSol), tokens = tok(vTok), realQuote = sol(rSol), thr = cfg.graduationSol;
  return {
    price_quote: tokens > 0 ? quote / tokens : 0, quote_reserve: quote, token_reserve: tok(rTok), virtual_token_reserve: tokens, real_quote_reserve: realQuote,
    token_total_supply: tok(supply), graduation_threshold_quote: thr, graduation_progress: thr > 0 ? Math.min(1, realQuote / thr) : null,
    graduated: complete, ready_to_graduate: !complete && thr > 0 && realQuote >= thr, pair: cfg.pair.symbol, creator,
  };
}
export async function readCurve(rpc, curve, cfg = pumpConfig()) {
  const data = await rpc.getAccountData(curve);
  if (!data) throw new Error('the bonding curve account does not exist (yet)');
  return decodeCurve(data, cfg);
}

// Creator fees accrue as SOL in the creator vault; what is above the rent
// floor is claimable by the creator's signature.
const RENT_FLOOR = 890880n;
export async function readCreatorFees(rpc, creator, cfg = pumpConfig()) {
  const vault = pda.creatorVault(creator, cfg);
  const lamports = await rpc.getBalance(vault);
  let floor = RENT_FLOOR; try { floor = BigInt(await rpc.getMinimumBalanceForRentExemption(0)); } catch { /* the usual value */ }
  const claimable = lamports > floor ? lamports - floor : 0n;
  return { vault, balance: Number(claimable) / 1e9, lamports: lamports.toString(), pair: cfg.pair.symbol };
}

// The dollar rate for SOL: fixed by env, or read from the operator's chosen
// JSON URL at most once a minute. null when neither is set.
const rateCache = new Map();
export async function solUsd(cfg, fetchImpl = fetch) {
  if (cfg.solUsd) return cfg.solUsd;
  if (!cfg.solUsdUrl) return null;
  const hit = rateCache.get(cfg.solUsdUrl);
  if (hit && Date.now() - hit.at < 60_000) return hit.rate;
  try {
    const res = await fetchImpl(cfg.solUsdUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    let v = await res.json();
    for (const part of String(cfg.solUsdPath || '').split('.').filter(Boolean)) v = v?.[part];
    if (!v || typeof v === 'object') { for (const k of ['price', 'usd', 'value', 'rate']) if (v && typeof v[k] === 'number') { v = v[k]; break; } }
    const rate = Number(v);
    if (!(rate > 0)) throw new Error('no number at the configured path');
    rateCache.set(cfg.solUsdUrl, { at: Date.now(), rate });
    return rate;
  } catch { return hit?.rate ?? null; }
}

export const pairFor = (cfg) => cfg.pair;
export const explorerUrl = (cfg, kind, value) => `${cfg.explorer.replace(/\/$/, '')}/${kind}/${value}`;
export const pumpUrl = (cfg, mint) => `${cfg.site}/coin/${mint}`;
export { utf8 };
