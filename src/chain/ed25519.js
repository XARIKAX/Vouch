// Ed25519 for Solana, zero dependencies: signing and verification through
// Node's crypto, key handling for the treasury (a 64-byte Solana secret key
// or a 32-byte seed), and the one piece of curve arithmetic a program-derived
// address needs: whether 32 bytes decode to a point on the curve.
import crypto from 'node:crypto';
import { encodeBase58, decodeBase58 } from './base58.js';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const publicKeyObject = (raw32) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw32)]), format: 'der', type: 'spki' });
export const privateKeyObject = (seed32) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed32)]), format: 'der', type: 'pkcs8' });
export const publicFromSeed = (seed32) => new Uint8Array(crypto.createPublicKey(privateKeyObject(seed32)).export({ format: 'der', type: 'spki' }).subarray(-32));

// A keypair from the forms wallets export: base58 of 64 bytes (seed ‖ pubkey),
// base58 or hex of a 32-byte seed, or a JSON array of 64 numbers.
export function keypairFromSecret(secret) {
  let bytes;
  const s = String(secret ?? '').trim();
  if (/^\[[\d,\s]+\]$/.test(s)) bytes = Uint8Array.from(JSON.parse(s));
  else if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) bytes = Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));
  else bytes = decodeBase58(s);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('a Solana secret key is 64 bytes (or a 32-byte seed)');
  const seed = bytes.subarray(0, 32);
  const pub = publicFromSeed(seed);
  if (bytes.length === 64 && Buffer.compare(Buffer.from(bytes.subarray(32)), Buffer.from(pub)) !== 0) throw new Error('the secret key\'s public half does not match its seed');
  return { seed, publicKey: pub, address: encodeBase58(pub) };
}
export const sign = (message, seed32) => new Uint8Array(crypto.sign(null, Buffer.from(message), privateKeyObject(seed32)));
export function verify(message, signature, publicKey32) {
  try { return crypto.verify(null, Buffer.from(message), publicKeyObject(publicKey32), Buffer.from(signature)); } catch { return false; }
}
// A wallet's signature over a message, as wallets return it (base58 or hex, 64 bytes).
export function verifyMessage(message, signature, address) {
  const sig = /^(0x)?[0-9a-fA-F]{128}$/.test(String(signature)) ? Buffer.from(String(signature).replace(/^0x/, ''), 'hex') : decodeBase58(signature);
  if (sig.length !== 64) throw new Error('signature must be 64 bytes');
  const pub = decodeBase58(address);
  if (pub.length !== 32) throw new Error('address must be a 32-byte public key');
  return verify(Buffer.from(String(message), 'utf8'), sig, pub);
}
export const randomKeypair = () => keypairFromSecret(crypto.randomBytes(32).toString('hex'));

// ---- is a point on the curve? (program-derived addresses must not be) -----
const P = (1n << 255n) - 19n;
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = modpow(2n, (P - 1n) / 4n);
function mod(a) { const r = a % P; return r < 0n ? r + P : r; }
function modpow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
function inv(a) { return modpow(a, P - 2n); }
export function isOnCurve(bytes32) {
  const b = Uint8Array.from(bytes32);
  if (b.length !== 32) return false;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  const sign = (y >> 255n) & 1n; y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  let x = modpow(u * inv(v), (P + 3n) / 8n);
  const vx2 = (v * x * x) % P;
  if (vx2 !== u) { if (vx2 !== mod(-u)) return false; x = (x * SQRT_M1) % P; }
  if (x === 0n && sign === 1n) return false;
  return true;
}
