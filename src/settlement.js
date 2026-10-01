import crypto from 'node:crypto';
import { sha256 } from './util.js';
import { snapshotParams } from './launchpad-config.js';
import { bondValue, bondCapacity, splitFees, slashPlan } from './launchpad.js';

// Settlement adapter — the seam between Vouch's engine (which decides pass/fail)
// and where the money actually moves. Today the engine settles against its own
// in-memory ledger; this module is the drop-in that moves the same lifecycle
// on-chain: escrow held in a VouchEscrow contract, released or refunded+slashed
// only on a verifier-signed verdict.
//
// The verifier signs with secp256k1 (Ethereum's curve). The mock backend here
// verifies that signature exactly as the on-chain contract's ECDSA.recover
// would, so the trust flow is real and testable without a chain. A real Base
// backend swaps mockChain() for JSON-RPC calls to the deployed contract;
// everything above that line is unchanged. See contracts/VouchEscrow.sol and
// ONCHAIN.md.

// Deterministic verdict digest. NOTE: a real EVM deployment hashes with
// keccak256 over an EIP-712 typed struct; the mock uses sha256 — the signing
// and recovery flow is identical, only the hash function differs.
export function verdictDigest({ taskId, outcome, amount, slashBps = 0 }) {
  return sha256(`vouch.verdict|${taskId}|${outcome}|${amount}|${slashBps}`);
}

// The verifier oracle: holds the signing key, produces signatures the escrow
// (or the mock) checks. In production the private key lives in a KMS/HSM.
export function createVerifier(opts = {}) {
  let priv;
  let pub;
  if (opts.privateKeyPem) {
    priv = crypto.createPrivateKey(opts.privateKeyPem);
    pub = crypto.createPublicKey(priv);
  } else {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    priv = kp.privateKey; pub = kp.publicKey;
  }
  const publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  const id = sha256(publicKeyPem).slice(0, 16);
  return {
    publicKeyPem,
    id,
    sign(verdict) {
      const digest = verdictDigest(verdict);
      return crypto.sign('sha256', Buffer.from(digest), priv).toString('base64');
    },
    // Sign an arbitrary digest string (used for slash verdicts, which have a
    // different shape than settle/refund verdicts). Mirrors AgentBondVault._digest.
    signDigest(digest) {
      return crypto.sign('sha256', Buffer.from(digest), priv).toString('base64');
    },
  };
}

// Slash-verdict digest. Mirrors AgentBondVault._digest(slashId, agentId, price, multipleBps).
export function slashDigest({ slashId, agentId, price, multipleBps }) {
  return sha256(`vouch.slash|${slashId}|${agentId}|${price}|${multipleBps}`);
}
export function verifyDigestSig(digest, signatureB64, verifierPublicKeyPem) {
  try {
    return crypto.verify('sha256', Buffer.from(digest),
      crypto.createPublicKey(verifierPublicKeyPem), Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

export function verifyVerdictSig(verdict, signatureB64, verifierPublicKeyPem) {
  try {
    const digest = verdictDigest(verdict);
    return crypto.verify('sha256', Buffer.from(digest),
      crypto.createPublicKey(verifierPublicKeyPem), Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

// In-memory stand-in for the VouchEscrow contract: same state machine, same
// signature gate. Used for tests and local dev; a Base backend implements the
// same interface over JSON-RPC.
export function mockChain({ verifierPublicKeyPem }) {
  const escrows = {}; // taskId -> { keyId, amount, provider, stake, state }
  const balances = {}; // address -> USDC
  const insurancePool = { balance: 0 };
  const credit = (addr, amt) => { balances[addr] = round(fromNum(balances[addr]) + amt); };

  function depositEscrow(taskId, keyId, amount, provider, stake) {
    if (escrows[taskId]) throw new Error(`escrow ${taskId} already exists`);
    escrows[taskId] = { keyId, amount: round(amount), provider, stake: round(stake), state: 'locked' };
    return { ok: true };
  }

  function settle(taskId, price, signatureB64) {
    const e = mustLocked(taskId);
    const verdict = { taskId, outcome: 'settled', amount: price, slashBps: 0 };
    if (!verifyVerdictSig(verdict, signatureB64, verifierPublicKeyPem)) throw new Error('invalid verifier signature');
    credit(e.provider, round(price));
    if (e.amount > price) credit(e.keyId, round(e.amount - price)); // refund surplus
    e.state = 'settled';
    return { paid: round(price), surplus: round(e.amount - price) };
  }

  function refundAndSlash(taskId, slashBps, signatureB64) {
    const e = mustLocked(taskId);
    const verdict = { taskId, outcome: 'refunded', amount: e.amount, slashBps };
    if (!verifyVerdictSig(verdict, signatureB64, verifierPublicKeyPem)) throw new Error('invalid verifier signature');
    credit(e.keyId, e.amount); // agent made whole
    const slashed = round(e.stake * (slashBps / 10000));
    insurancePool.balance = round(insurancePool.balance + slashed);
    e.state = 'refunded';
    return { refunded: e.amount, slashed };
  }

  const mustLocked = (taskId) => {
    const e = escrows[taskId];
    if (!e) throw new Error(`no escrow ${taskId}`);
    if (e.state !== 'locked') throw new Error(`escrow ${taskId} is ${e.state}`);
    return e;
  };
  return {
    depositEscrow, settle, refundAndSlash,
    balanceOf: (addr) => fromNum(balances[addr]),
    insuranceBalance: () => insurancePool.balance,
    escrowState: (taskId) => escrows[taskId]?.state ?? null,
  };
}

const fromNum = (v) => (typeof v === 'number' ? v : 0);
const round = (n) => Math.round(n * 1e6) / 1e6;

// In-memory stand-in for AgentBondVault.sol: the launchpad's on-chain risk
// layer. Same state machine and the same risk limits a real deployment needs —
// capped slashing (per-verdict max multiple + rolling-window cap), a delayed
// pending-slash queue, a guardian pause, and unbonding cooldown — so the risk
// flow is real and testable without a chain. Shares the pure math in
// src/launchpad.js with the engine, so sandbox and on-chain value identically.
//
// `now` is injectable so tests can fast-forward the pending delay / cooldown.
export function mockBondVault({ verifierPublicKeyPem, params, now = () => Date.now() } = {}) {
  const p = params ?? snapshotParams();
  const agents = {};   // agentId -> { wallet, bond, reserved, unbondingQty, unbondReady, token, slashWindow }
  const pending = {};  // slashId -> { agentId, amountUsdg, tokenQty, executeAfter, settled }
  const insurance = { balance: 0 }; // USDG value of executed slashes
  let paused = false;

  const must = (agentId) => {
    const a = agents[agentId];
    if (!a) throw new Error(`no agent ${agentId}`);
    return a;
  };
  // Live (slashable-but-backing) token quantity excludes the unbonding request.
  const liveRaw = (a) => bondValue({
    tokenQty: Math.max(0, a.bond - a.unbondingQty),
    twapUsdg: a.token.twap, poolLiquidityUsdg: a.token.liq,
  }, p);

  function launch(agentId, { wallet = 'owner', twap_usdg = 1, pool_liquidity_usdg = 0 } = {}) {
    if (agents[agentId]) throw new Error(`agent ${agentId} exists`);
    agents[agentId] = { wallet, bond: 0, reserved: 0, unbondingQty: 0, unbondReady: 0,
      token: { twap: twap_usdg, liq: pool_liquidity_usdg }, slashWindow: [] };
    return { ok: true };
  }
  function bond(agentId, tokenQty) { const a = must(agentId); a.bond = round(a.bond + Math.max(0, tokenQty)); return a.bond; }
  // Harvest pool fees → bond / operating / creator / treasury (the bond share is
  // staked as token at the current TWAP). Returns the full split for the caller.
  function harvest(agentId, feeUsdg) {
    const a = must(agentId);
    const s = splitFees(feeUsdg, p);
    if (a.token.twap > 0) a.bond = round(a.bond + s.bond / a.token.twap);
    return s;
  }
  function setPrice(agentId, { twap_usdg, pool_liquidity_usdg } = {}) {
    const a = must(agentId);
    if (twap_usdg !== undefined) a.token.twap = Math.max(0, twap_usdg);
    if (pool_liquidity_usdg !== undefined) a.token.liq = Math.max(0, pool_liquidity_usdg);
    return capacityUsdg(agentId);
  }
  const haircutValueUsdg = (agentId) => round(liveRaw(must(agentId)) * p.bondHaircut);
  const capacityUsdg = (agentId) => bondCapacity(liveRaw(must(agentId)), p);

  function reserve(agentId, price) {
    const a = must(agentId);
    const need = round(price * p.reservationMultiple);
    if (a.reserved + need > haircutValueUsdg(agentId) + 1e-9) throw new Error('over capacity');
    a.reserved = round(a.reserved + need);
    return a.reserved;
  }
  function release(agentId, price) {
    const a = must(agentId);
    a.reserved = round(Math.max(0, a.reserved - price * p.reservationMultiple));
    return a.reserved;
  }

  // Queue a capped slash on a signed verdict — funds do NOT move yet.
  function queueSlash(slashId, agentId, price, multiple, signatureB64) {
    const a = must(agentId);
    if (pending[slashId]) throw new Error(`slash ${slashId} exists`);
    const multipleBps = Math.round(multiple * 10000);
    const digest = slashDigest({ slashId, agentId, price, multipleBps });
    if (!verifyDigestSig(digest, signatureB64, verifierPublicKeyPem)) throw new Error('invalid verifier signature');
    const t = now();
    a.slashWindow = a.slashWindow.filter((e) => t - e.ts < p.rollingSlashWindowMs);
    const slashedInWindowUsdg = round(a.slashWindow.reduce((s, e) => s + e.amountUsdg, 0));
    const plan = slashPlan({ priceUsdg: price, multiple, twapUsdg: a.token.twap,
      bondRawValueUsdg: liveRaw(a), slashedInWindowUsdg }, p);
    a.slashWindow.push({ ts: t, amountUsdg: plan.amountUsdg });
    pending[slashId] = { agentId, amountUsdg: plan.amountUsdg, tokenQty: plan.tokenQty,
      executeAfter: t + p.pendingSlashMs, settled: false };
    return { ...plan, executeAfter: pending[slashId].executeAfter };
  }
  // Execute after the delay. Blocked while paused — the guardian's safety window.
  function executeSlash(slashId) {
    if (paused) throw new Error('paused');
    const s = pending[slashId];
    if (!s || s.settled) throw new Error(`no pending slash ${slashId}`);
    if (now() < s.executeAfter) throw new Error('too early');
    const a = must(s.agentId);
    const qty = Math.min(s.tokenQty, a.bond);
    a.bond = round(a.bond - qty);
    insurance.balance = round(insurance.balance + s.amountUsdg);
    s.settled = true;
    return { tokenQty: qty, amountUsdg: s.amountUsdg };
  }

  function requestUnbond(agentId, tokenQty) {
    const a = must(agentId);
    const qty = Math.min(tokenQty, a.bond);
    a.unbondingQty = qty;
    a.unbondReady = now() + p.unbondingCooldownMs;
    return { tokenQty: qty, ready: a.unbondReady };
  }
  function withdrawUnbonded(agentId) {
    const a = must(agentId);
    if (!(a.unbondingQty > 0) || now() < a.unbondReady) throw new Error('not ready');
    const qty = Math.min(a.unbondingQty, a.bond);
    a.bond = round(a.bond - qty); a.unbondingQty = 0; a.unbondReady = 0;
    return { withdrawn: qty };
  }

  return {
    launch, bond, harvest, setPrice, reserve, release,
    queueSlash, executeSlash, requestUnbond, withdrawUnbonded,
    pause: () => { paused = true; }, unpause: () => { paused = false; },
    isPaused: () => paused,
    capacityUsdg, haircutValueUsdg,
    bondOf: (agentId) => must(agentId).bond,
    insuranceBalance: () => insurance.balance,
    pendingSlash: (slashId) => pending[slashId] ?? null,
  };
}
