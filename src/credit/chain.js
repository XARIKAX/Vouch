// Vouch Credit on-chain client. The engine is the attester: it posts work
// events (verified settlements, slashes, dispute losses) to the CreditRegistry
// under each provider's ERC-8004 agentId, and reads scores back. Every address
// comes from contracts/deployments/<chainId>.json; a chain without a record
// is refused, never guessed.
//
//   VOUCH_CREDIT_CHAIN_ID       4663 (Robinhood Chain), 8453 (Base), 31337 (devnet) …
//   VOUCH_CREDIT_RPC            overrides the record's rpc (devnet: http://127.0.0.1:8545)
//   VOUCH_CREDIT_ATTESTER_KEY   the attester's secp256k1 private key (hex); without it reads only
//   VOUCH_CREDIT_DEPLOYMENTS    directory of records (default contracts/deployments)
//
// ethers is loaded on demand, so a deployment with no credit chain configured
// never touches it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DEPLOYMENTS_DIR = path.resolve(here, '..', '..', 'contracts', 'deployments');

export const REGISTRY_ABI = [
  'function attester() view returns (address)',
  'function pool() view returns (address)',
  'function identity() view returns (address)',
  'function creditLineCap() view returns (uint256)',
  'function exists(uint256 agentId) view returns (bool)',
  'function recorded(bytes32 key) view returns (bool)',
  'function score(uint256 agentId) view returns (uint256)',
  'function creditReport(uint256 agentId) view returns (tuple(uint64 settledCount,uint128 settledVolume,uint128 recentVolume,uint64 workUpdatedAt,uint64 slashCount,uint128 slashedVolume,uint64 disputeLossCount,uint128 disputeLossVolume,uint64 loansRepaid,uint64 loansRepaidOnTime,uint128 repaidPrincipalDays,uint64 advancesRepaid,uint128 advancesRepaidVolume,uint64 defaults,uint128 defaultedVolume,uint128 defaultPenalty,uint64 defaultUpdatedAt,uint64 recoveries) r, uint256 score_, uint8 tier, uint256 feeBps30d, uint256 creditLine, uint256 recentVolumeNow)',
  'function recordSettlement(uint256 agentId, bytes32 ref, uint128 amount)',
  'function recordSlash(uint256 agentId, bytes32 ref, uint128 amount)',
  'function recordDisputeLoss(uint256 agentId, bytes32 ref, uint128 amount)',
  'error NotAttester()', 'error NotPool()', 'error UnknownAgent(uint256 agentId)', 'error AlreadyRecorded(bytes32 key)',
  'event Settled(uint256 indexed agentId, bytes32 indexed ref, uint128 amount, uint64 at)',
  'event Slashed(uint256 indexed agentId, bytes32 indexed ref, uint128 amount, uint64 at)',
  'event DisputeLost(uint256 indexed agentId, bytes32 indexed ref, uint128 amount, uint64 at)',
];
const KIND_KEY = { settlement: 'settlement', slash: 'slash', dispute_loss: 'dispute' };
export const IDENTITY_ABI = [
  'function ownerOf(uint256 agentId) view returns (address)',
  'function register(string agentURI) returns (uint256 agentId)',
];

// Read a deployment record. Returns null when the chain has none.
export function readDeployment(chainId, dir = DEFAULT_DEPLOYMENTS_DIR) {
  if (!chainId) return null;
  const file = path.join(dir, `${chainId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function creditConfig(env = process.env) {
  const chainId = Number(env.VOUCH_CREDIT_CHAIN_ID) || 0;
  const dir = env.VOUCH_CREDIT_DEPLOYMENTS || DEFAULT_DEPLOYMENTS_DIR;
  const record = readDeployment(chainId, dir);
  const deployed = !!(record && record.creditRegistry && /^0x[0-9a-fA-F]{40}$/.test(record.creditRegistry));
  return {
    chainId,
    rpc: env.VOUCH_CREDIT_RPC || record?.rpc || null,
    explorer: record?.explorer || null,
    record,
    deployed,
    enabled: chainId > 0 && deployed,
    attesterKey: env.VOUCH_CREDIT_ATTESTER_KEY || null,
    reason: !chainId ? 'VOUCH_CREDIT_CHAIN_ID is not set'
      : !record ? `no deployment record for chain ${chainId}`
        : !deployed ? `chain ${chainId} has a record but no creditRegistry deployed` : null,
  };
}

// The message a wallet signs to link an ERC-8004 agentId to a Vouch provider.
export const linkMessage = (subject, agentId) => `vouch-credit-identity|${subject}|${agentId}`;

export async function createCreditChain(cfg) {
  if (!cfg.enabled) return null;
  const ethers = await import('ethers');
  // cacheTimeout -1: ethers would otherwise serve a stale transaction count after a mined tx
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId, { staticNetwork: true, cacheTimeout: -1 });
  const signer = cfg.attesterKey ? new ethers.Wallet(cfg.attesterKey, provider) : null;
  const registry = new ethers.Contract(cfg.record.creditRegistry, REGISTRY_ABI, signer ?? provider);
  const identity = new ethers.Contract(cfg.record.identityRegistry, IDENTITY_ABI, provider);
  const refOf = (s) => ethers.id(String(s));
  const toUnits = (usd) => BigInt(Math.round((Number(usd) + Number.EPSILON) * 1e6));

  return {
    chainId: cfg.chainId, rpc: cfg.rpc, record: cfg.record,
    attesterAddress: signer?.address ?? null,
    canWrite: !!signer,
    refOf,
    async ownerOf(agentId) { try { return await identity.ownerOf(BigInt(agentId)); } catch { return null; } },
    async exists(agentId) { return registry.exists(BigInt(agentId)); },
    async score(agentId) { return Number(await registry.score(BigInt(agentId))); },
    async report(agentId) {
      const [r, score, tier, feeBps30d, creditLine, recentVolumeNow] = await registry.creditReport(BigInt(agentId));
      return {
        score: Number(score), tier: Number(tier), fee_bps_30d: Number(feeBps30d),
        credit_line_usd: Number(creditLine) / 1e6, recent_volume_usd: Number(recentVolumeNow) / 1e6,
        inputs: {
          settled_count: Number(r.settledCount), settled_volume_usd: Number(r.settledVolume) / 1e6,
          slash_count: Number(r.slashCount), slashed_volume_usd: Number(r.slashedVolume) / 1e6,
          dispute_loss_count: Number(r.disputeLossCount), dispute_loss_volume_usd: Number(r.disputeLossVolume) / 1e6,
          loans_repaid: Number(r.loansRepaid), loans_repaid_on_time: Number(r.loansRepaidOnTime), repaid_principal_days_usd: Number(r.repaidPrincipalDays) / 1e6,
          advances_repaid: Number(r.advancesRepaid), advances_repaid_volume_usd: Number(r.advancesRepaidVolume) / 1e6,
          defaults: Number(r.defaults), defaulted_volume_usd: Number(r.defaultedVolume) / 1e6, recoveries: Number(r.recoveries),
        },
      };
    },
    // Has this exact fact already been recorded? (kind, agentId, ref) → bool.
    async recorded(kind, agentId, ref) {
      const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256', 'bytes32'], [ethers.encodeBytes32String(kind), BigInt(agentId), refOf(ref)]));
      return registry.recorded(key);
    },
    // Post one engine credit event. Returns the transaction hash.
    async post(event, agentId) {
      if (!signer) throw new Error('no attester key configured');
      const fn = { settlement: 'recordSettlement', slash: 'recordSlash', dispute_loss: 'recordDisputeLoss' }[event.kind];
      if (!fn) throw new Error(`event kind ${event.kind} is not posted by the attester`);
      if (await this.recorded(KIND_KEY[event.kind], agentId, event.ref)) { const e = new Error('AlreadyRecorded'); e.already = true; throw e; }
      // explicit nonce from the node, so sequential posts never reuse one
      const nonce = Number(await provider.send('eth_getTransactionCount', [signer.address, 'pending']));
      const tx = await registry[fn](BigInt(agentId), refOf(event.ref), toUnits(event.amount), { nonce });
      const receipt = await tx.wait();
      return receipt.hash;
    },
    // Does `signature` over the link message come from the agentId's owner?
    async verifyLink(subject, agentId, signature) {
      const owner = await this.ownerOf(agentId);
      if (!owner) return { ok: false, reason: 'unknown_agent' };
      let signer_;
      try { signer_ = ethers.verifyMessage(linkMessage(subject, agentId), signature); } catch { return { ok: false, reason: 'bad_signature' }; }
      return signer_.toLowerCase() === owner.toLowerCase() ? { ok: true, owner } : { ok: false, reason: 'not_owner', owner };
    },
  };
}
