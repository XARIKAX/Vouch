import crypto from 'node:crypto';
import { sha256 } from './util.js';

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
  };
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
