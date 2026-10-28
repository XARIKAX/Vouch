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
export const POOL_ABI = [
  'function usdg() view returns (address)',
  'function attester() view returns (address)',
  'function protocolTreasury() view returns (address)',
  'function lenderBps() view returns (uint16)', 'function reserveBps() view returns (uint16)', 'function protocolBps() view returns (uint16)',
  'function minLoan() view returns (uint128)', 'function maxLoan() view returns (uint128)', 'function advanceBps() view returns (uint16)', 'function graceSeconds() view returns (uint64)',
  'function totalShares() view returns (uint256)', 'function shares(address) view returns (uint256)',
  'function lenderCash() view returns (uint256)', 'function outstanding() view returns (uint256)', 'function reserve() view returns (uint256)', 'function protocolFees() view returns (uint256)',
  'function lenderAssets() view returns (uint256)',
  'function convertToShares(uint256 assets) view returns (uint256)', 'function convertToAssets(uint256 shares) view returns (uint256)',
  'function deposit(uint256 assets) returns (uint256)', 'function withdraw(uint256 shares) returns (uint256)', 'function fundReserve(uint256 amount)',
  'function attestSettlement(uint256 agentId, bytes32 settlementId, uint128 amount, uint64 payoutAt)',
  'function voidSettlement(bytes32 settlementId)',
  'function settlements(bytes32) view returns (uint256 agentId, uint128 amount, uint64 payoutAt, uint64 attestedAt, bytes32 loanId, bool paid, bool voided)',
  'function quoteAdvance(uint256 agentId, bytes32 settlementId) view returns (uint128 principal, uint128 fee, uint16 termDays, uint16 feeBps, uint256 score, uint256 line)',
  'function advance(uint256 agentId, bytes32 settlementId) returns (bytes32 loanId)',
  'function settleProceeds(bytes32 settlementId) returns (uint128 repaid, uint128 forwarded)',
  'function repay(bytes32 loanId, uint128 amount) returns (uint128 applied)',
  'function owedOn(bytes32 loanId) view returns (uint128)',
  'function markDefault(bytes32 loanId)',
  'function isOverdue(bytes32 loanId) view returns (bool)',
  'function exposure(uint256 agentId) view returns (uint256)',
  'function loansOf(uint256 agentId) view returns (bytes32[])',
  'function quoteLoan(uint256 agentId, uint128 amount, uint16 termDays) view returns (uint128 fee, uint16 feeBps, uint256 score, uint256 line, uint256 room)',
  'function fundTaskEscrow(uint256 agentId, bytes32 taskRef, uint128 amount, uint16 termDays) returns (bytes32 loanId)',
  'function settleTaskEscrow(bytes32 taskRef) returns (uint128 amount)',
  'function refundTaskEscrow(bytes32 taskRef) returns (uint128 amount)',
  'function fundStake(uint256 agentId, uint128 amount, uint16 termDays) returns (bytes32 loanId)',
  'function slashHeldStake(bytes32 loanId, uint128 amount)',
  'function releaseStake(bytes32 loanId, uint128 amount) returns (uint128 released)',
  'function held(bytes32 loanId) view returns (uint128)',
  'function escrowLoan(bytes32 taskRef) view returns (bytes32)',
  'function escrowHeld() view returns (uint256)', 'function stakeHeld() view returns (uint256)',
  'error EscrowTaken(bytes32 taskRef)', 'error WrongKind(bytes32 loanId)', 'error NothingHeld(bytes32 loanId)',
  'event EscrowFunded(uint256 indexed agentId, bytes32 indexed loanId, bytes32 indexed taskRef, uint128 principal, uint128 fee, uint64 dueAt)',
  'event StakeFunded(uint256 indexed agentId, bytes32 indexed loanId, uint128 principal, uint128 fee, uint64 dueAt)',
  'function loans(bytes32) view returns (uint256 agentId, uint8 kind, uint8 status, uint128 principal, uint128 remainingPrincipal, uint128 fee, uint128 feePaid, uint64 borrowedAt, uint64 dueAt, uint16 termDays, uint16 feeBps, bytes32 settlementId, address borrower, uint128 reserveCovered, uint128 lenderLoss)',
  'error NotAttester()', 'error NotBorrower()', 'error BadAmount()', 'error InsufficientLiquidity()', 'error UnknownAgent(uint256 agentId)',
  'error UnknownSettlement(bytes32 settlementId)', 'error SettlementClosed(bytes32 settlementId)', 'error SettlementAlreadyAdvanced(bytes32 settlementId)',
  'error AlreadyAttested(bytes32 settlementId)', 'error TermOutOfRange(uint256 seconds_)', 'error NoCredit(uint256 agentId, uint256 score)',
  'error BelowMinimum(uint256 amount, uint256 minimum)', 'error UnknownLoan(bytes32 loanId)', 'error LoanNotActive(bytes32 loanId)', 'error NotDue(bytes32 loanId, uint64 dueAt, uint64 graceSeconds)',
  'event Advanced(uint256 indexed agentId, bytes32 indexed loanId, bytes32 indexed settlementId, uint128 principal, uint128 fee, uint64 dueAt, address borrower)',
  'event ProceedsSettled(bytes32 indexed settlementId, uint128 proceeds, uint128 repaid, uint128 forwarded, address to)',
];
export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)', 'function decimals() view returns (uint8)',
];
export const LOAN_STATUS = ['none', 'active', 'repaid', 'defaulted', 'recovered'];
export const LOAN_KIND = ['advance', 'task_escrow', 'stake'];
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
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const deployed = !!(record && isAddr(record.creditRegistry));
  return {
    poolDeployed: !!(record && isAddr(record.creditPool)),
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
  const pool = cfg.poolDeployed ? new ethers.Contract(cfg.record.creditPool, POOL_ABI, signer ?? provider) : null;
  const usdg = new ethers.Contract(cfg.record.usdg, ERC20_ABI, signer ?? provider);
  const refOf = (s) => ethers.id(String(s));
  const toUnits = (usd) => BigInt(Math.round((Number(usd) + Number.EPSILON) * 1e6));
  const fromUnits = (u) => Number(u) / 1e6;
  const nextNonce = async () => Number(await provider.send('eth_getTransactionCount', [signer.address, 'pending']));
  const mustWrite = () => { if (!signer) throw new Error('no attester key configured'); };
  // simulate, then send: a revert surfaces as its decoded custom error instead of a bare receipt failure
  const send = async (contract, fn, args) => {
    await contract[fn].staticCall(...args);
    const tx = await contract[fn](...args, { nonce: await nextNonce() });
    return tx.wait();
  };
  const mustPool = () => { if (!pool) throw new Error('no credit pool deployed on this chain'); };
  // the pool pulls settlement proceeds and repayments from the attester: approve once
  let approved = false;
  const ensureAllowance = async () => {
    if (approved) return;
    const a = await usdg.allowance(signer.address, pool.target);
    if (a < 10n ** 30n) { const tx = await usdg.approve(pool.target, ethers.MaxUint256, { nonce: await nextNonce() }); await tx.wait(); }
    approved = true;
  };
  // owed_usd is cash owed: principal the pool does not still hold, plus the unpaid fee (the contract's owedOn)
  const loanView = (loanId, l, heldU = 0n) => ({
    loan_id: loanId, agent_id: String(l.agentId), kind: LOAN_KIND[Number(l.kind)], status: LOAN_STATUS[Number(l.status)],
    principal_usd: fromUnits(l.principal), remaining_principal_usd: fromUnits(l.remainingPrincipal), fee_usd: fromUnits(l.fee), fee_paid_usd: fromUnits(l.feePaid),
    owed_usd: fromUnits(l.remainingPrincipal - heldU + (l.fee - l.feePaid)),
    borrowed_at: Number(l.borrowedAt), due_at: Number(l.dueAt), term_days: Number(l.termDays), fee_bps_30d: Number(l.feeBps),
    settlement_id: l.settlementId, borrower: l.borrower, reserve_covered_usd: fromUnits(l.reserveCovered), lender_loss_usd: fromUnits(l.lenderLoss),
  });

  return {
    chainId: cfg.chainId, rpc: cfg.rpc, record: cfg.record,
    attesterAddress: signer?.address ?? null,
    canWrite: !!signer,
    hasPool: !!pool,
    refOf, toUnits, fromUnits,
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
    // Post one engine credit event. Returns the transaction hash. With a pool
    // deployed a settlement is attested there (the pool forwards it to the
    // registry in the same transaction), so it is also borrowable against.
    async post(event, agentId) {
      mustWrite();
      const fn = { settlement: 'recordSettlement', slash: 'recordSlash', dispute_loss: 'recordDisputeLoss' }[event.kind];
      if (!fn) throw new Error(`event kind ${event.kind} is not posted by the attester`);
      if (await this.recorded(KIND_KEY[event.kind], agentId, event.ref)) { const e = new Error('AlreadyRecorded'); e.already = true; throw e; }
      let receipt;
      if (event.kind === 'settlement' && pool) {
        const payoutAt = Math.max(Math.floor((event.payout_at ?? Date.now()) / 1000), Math.floor(Date.now() / 1000) + 60);
        receipt = await send(pool, 'attestSettlement', [BigInt(agentId), refOf(event.ref), toUnits(event.amount), BigInt(payoutAt)]);
      } else {
        receipt = await send(registry, fn, [BigInt(agentId), refOf(event.ref), toUnits(event.amount)]);
      }
      return receipt.hash;
    },

    // ---- the pool -------------------------------------------------------------------
    async poolInfo() {
      if (!pool) return null;
      const [cash, out, res, fees, shares, assets, lb, rb, pb, minL, maxL, adv, grace, treasuryBal] = await Promise.all([
        pool.lenderCash(), pool.outstanding(), pool.reserve(), pool.protocolFees(), pool.totalShares(), pool.lenderAssets(),
        pool.lenderBps(), pool.reserveBps(), pool.protocolBps(), pool.minLoan(), pool.maxLoan(), pool.advanceBps(), pool.graceSeconds(),
        signer ? usdg.balanceOf(signer.address) : 0n,
      ]);
      return {
        address: pool.target, usdg: cfg.record.usdg,
        lender_cash_usd: fromUnits(cash), outstanding_usd: fromUnits(out), lender_assets_usd: fromUnits(assets), reserve_usd: fromUnits(res), protocol_fees_usd: fromUnits(fees),
        escrow_held_usd: fromUnits(await pool.escrowHeld()), stake_held_usd: fromUnits(await pool.stakeHeld()),
        total_shares: shares.toString(), share_price: shares > 0n ? Number(assets) / Number(shares) : 1,
        split: { lenders_bps: Number(lb), reserve_bps: Number(rb), protocol_bps: Number(pb) },
        loan_usd: { min: fromUnits(minL), max: fromUnits(maxL) }, advance_bps: Number(adv), grace_seconds: Number(grace),
        treasury_usdg_usd: fromUnits(treasuryBal),
      };
    },
    async settlement(ref) {
      mustPool();
      const s = await pool.settlements(refOf(ref));
      if (!s.attestedAt) return null;
      return { settlement_id: refOf(ref), agent_id: String(s.agentId), amount_usd: fromUnits(s.amount), payout_at: Number(s.payoutAt), attested_at: Number(s.attestedAt), loan_id: s.loanId === ethers.ZeroHash ? null : s.loanId, paid: s.paid, voided: s.voided };
    },
    async quoteAdvance(agentId, ref) {
      mustPool();
      const q = await pool.quoteAdvance(BigInt(agentId), refOf(ref));
      return { principal_usd: fromUnits(q.principal), fee_usd: fromUnits(q.fee), term_days: Number(q.termDays), fee_bps_30d: Number(q.feeBps), score: Number(q.score), credit_line_usd: fromUnits(q.line) };
    },
    async advance(agentId, ref) {
      mustWrite(); mustPool();
      const receipt = await send(pool, 'advance', [BigInt(agentId), refOf(ref)]);
      const log = receipt.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'Advanced');
      const loanId = log?.args?.loanId ?? null;
      return { tx: receipt.hash, loan_id: loanId, principal_usd: log ? fromUnits(log.args.principal) : null, fee_usd: log ? fromUnits(log.args.fee) : null, due_at: log ? Number(log.args.dueAt) : null, borrower: log?.args?.borrower ?? null };
    },
    async settleProceeds(ref) {
      mustWrite(); mustPool();
      await ensureAllowance();
      const receipt = await send(pool, 'settleProceeds', [refOf(ref)]);
      const log = receipt.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'ProceedsSettled');
      return { tx: receipt.hash, proceeds_usd: log ? fromUnits(log.args.proceeds) : null, repaid_usd: log ? fromUnits(log.args.repaid) : null, forwarded_usd: log ? fromUnits(log.args.forwarded) : null, to: log?.args?.to ?? null };
    },
    async voidSettlement(ref) {
      mustWrite(); mustPool();
      return (await send(pool, 'voidSettlement', [refOf(ref)])).hash;
    },
    async repay(loanId, amountUsd) {
      mustWrite(); mustPool();
      await ensureAllowance();
      const receipt = await send(pool, 'repay', [loanId, toUnits(amountUsd)]);
      return { tx: receipt.hash, loan: await this.loan(loanId) };
    },
    async markDefault(loanId) {
      mustWrite(); mustPool();
      return (await send(pool, 'markDefault', [loanId])).hash;
    },
    async loan(loanId) {
      mustPool();
      const l = await pool.loans(loanId);
      if (Number(l.status) === 0) return null;
      const [overdue, heldU] = await Promise.all([pool.isOverdue(loanId), pool.held(loanId)]);
      return { ...loanView(loanId, l, heldU), held_usd: fromUnits(heldU), overdue };
    },
    // ---- sized loans: task escrow and stake (the principal never leaves the pool) ----
    async quoteLoan(agentId, amountUsd, termDays) {
      mustPool();
      const q = await pool.quoteLoan(BigInt(agentId), toUnits(amountUsd), termDays);
      return { amount_usd: Number(amountUsd), term_days: termDays, fee_usd: fromUnits(q.fee), fee_bps_30d: Number(q.feeBps), score: Number(q.score), credit_line_usd: fromUnits(q.line), room_usd: fromUnits(q.room) };
    },
    async fundTaskEscrow(agentId, ref, amountUsd, termDays) {
      mustWrite(); mustPool();
      const receipt = await send(pool, 'fundTaskEscrow', [BigInt(agentId), refOf(ref), toUnits(amountUsd), termDays]);
      const log = receipt.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'EscrowFunded');
      return { tx: receipt.hash, loan_id: log?.args?.loanId ?? null, principal_usd: log ? fromUnits(log.args.principal) : null, fee_usd: log ? fromUnits(log.args.fee) : null, due_at: log ? Number(log.args.dueAt) : null };
    },
    async fundStake(agentId, amountUsd, termDays) {
      mustWrite(); mustPool();
      const receipt = await send(pool, 'fundStake', [BigInt(agentId), toUnits(amountUsd), termDays]);
      const log = receipt.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === 'StakeFunded');
      return { tx: receipt.hash, loan_id: log?.args?.loanId ?? null, principal_usd: log ? fromUnits(log.args.principal) : null, fee_usd: log ? fromUnits(log.args.fee) : null, due_at: log ? Number(log.args.dueAt) : null };
    },
    async settleTaskEscrow(ref) { mustWrite(); mustPool(); return (await send(pool, 'settleTaskEscrow', [refOf(ref)])).hash; },
    async refundTaskEscrow(ref) { mustWrite(); mustPool(); return (await send(pool, 'refundTaskEscrow', [refOf(ref)])).hash; },
    async slashHeldStake(loanId, amountUsd) { mustWrite(); mustPool(); return (await send(pool, 'slashHeldStake', [loanId, toUnits(amountUsd)])).hash; },
    async releaseStake(loanId, amountUsd) { mustWrite(); mustPool(); return (await send(pool, 'releaseStake', [loanId, toUnits(amountUsd)])).hash; },
    async escrowLoanOf(ref) { mustPool(); const id_ = await pool.escrowLoan(refOf(ref)); return id_ === ethers.ZeroHash ? null : id_; },
    async loansOf(agentId) {
      mustPool();
      const ids = await pool.loansOf(BigInt(agentId));
      return Promise.all(ids.map((id_) => this.loan(id_)));
    },
    async exposure(agentId) { mustPool(); return fromUnits(await pool.exposure(BigInt(agentId))); },
    async treasuryUsdg() { return signer ? fromUnits(await usdg.balanceOf(signer.address)) : 0; },
    async walletUsdg(address) { return fromUnits(await usdg.balanceOf(address)); },
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
