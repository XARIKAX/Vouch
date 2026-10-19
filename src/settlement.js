import crypto from 'node:crypto';
import { sha256 } from './util.js';

// Settlement adapter — the seam between Vouch's engine (which decides pass/fail)
// and where the money actually moves. Today the engine settles against its own
// in-memory ledger; this module is the drop-in that moves the same lifecycle
// on-chain: escrow held in a VouchEscrow contract, released or refunded+slashed
// only on a verifier-signed verdict.
//
// The verifier signs with ed25519 (Solana's curve). The mock backend here
// verifies that signature the way an on-chain program would through the
// ed25519 native program, so the trust flow is real and testable without a
// chain. A real Solana backend swaps mockChain() for JSON-RPC calls to the
// deployed escrow program; everything above that line is unchanged. See
// ONCHAIN.md.

// Deterministic verdict digest over the verdict's fields (sha256).
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
    const kp = crypto.generateKeyPairSync('ed25519');
    priv = kp.privateKey; pub = kp.publicKey;
  }
  const publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  const id = sha256(publicKeyPem).slice(0, 16);
  return {
    publicKeyPem,
    id,
    sign(verdict) {
      const digest = verdictDigest(verdict);
      return crypto.sign(null, Buffer.from(digest), priv).toString('base64');
    },
    // Sign an arbitrary digest string (used for slash verdicts, which have a
    // different shape than settle/refund verdicts). Mirrors the bond vault's digest.
    signDigest(digest) {
      return crypto.sign(null, Buffer.from(digest), priv).toString('base64');
    },
  };
}

// Slash-verdict digest. Mirrors AgentBondVault._digest(slashId, agentId, price, multipleBps).
export function slashDigest({ slashId, agentId, price, multipleBps }) {
  return sha256(`vouch.slash|${slashId}|${agentId}|${price}|${multipleBps}`);
}
export function verifyDigestSig(digest, signatureB64, verifierPublicKeyPem) {
  try {
    return crypto.verify(null, Buffer.from(digest),
      crypto.createPublicKey(verifierPublicKeyPem), Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

export function verifyVerdictSig(verdict, signatureB64, verifierPublicKeyPem) {
  try {
    const digest = verdictDigest(verdict);
    return crypto.verify(null, Buffer.from(digest),
      crypto.createPublicKey(verifierPublicKeyPem), Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

// In-memory stand-in for the VouchEscrow contract: same state machine, same
// signature gate. Used for tests and local dev; a Solana backend implements the
// same interface over JSON-RPC.
const fromNum = (v) => (typeof v === 'number' ? v : 0);
const round = (n) => Math.round(n * 1e6) / 1e6;

export function mockChain({ verifierPublicKeyPem }) {
  const escrows = {}; // taskId -> { keyId, amount, provider, stake, state }
  const balances = {}; // address -> USDT
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

