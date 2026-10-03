// secp256k1 in BigInt, zero dependencies: public keys and addresses, RFC 6979
// deterministic ECDSA signing with a recovery id, and public-key recovery.
// Used to verify wallet sign-in signatures (EIP-191 personal_sign) and to
// sign treasury payouts. Small and auditable rather than fast: a signature
// or a recovery takes a few milliseconds.
import crypto from 'node:crypto';
import { keccak256 } from './keccak.js';

export const P = (1n << 256n) - (1n << 32n) - 977n;
export const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
export const G = { x: Gx, y: Gy };

const mod = (a, m = P) => { const r = a % m; return r < 0n ? r + m : r; };
export function modPow(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
export function modInv(a, m = P) {
  let [g, x, y] = [mod(a, m), 1n, 0n], [g2, x2] = [m, 0n];
  void y;
  while (g2 !== 0n) { const q = g / g2; [g, g2] = [g2, g - q * g2]; [x, x2] = [x2, x - q * x2]; }
  if (g !== 1n) throw new Error('no inverse');
  return mod(x, m);
}

// affine point arithmetic; null is the point at infinity
export function add(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.x === b.x) { if (mod(a.y + b.y) === 0n) return null; return dbl(a); }
  const l = mod((b.y - a.y) * modInv(b.x - a.x));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}
export function dbl(a) {
  if (!a || a.y === 0n) return null;
  const l = mod(3n * a.x * a.x * modInv(2n * a.y));
  const x = mod(l * l - 2n * a.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}
export function mul(pt, k) {
  let r = null, q = pt; k = mod(k, N);
  while (k > 0n) { if (k & 1n) r = add(r, q); q = dbl(q); k >>= 1n; }
  return r;
}
export const onCurve = (pt) => !!pt && mod(pt.y * pt.y - (pt.x * pt.x * pt.x + 7n)) === 0n;

const toBuf = (n, len = 32) => Buffer.from(n.toString(16).padStart(len * 2, '0'), 'hex');
const toInt = (buf) => BigInt('0x' + Buffer.from(buf).toString('hex'));
export const hexToBuf = (h) => Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex');
export const privFrom = (hex) => { const d = toInt(hexToBuf(hex)); if (d <= 0n || d >= N) throw new Error('invalid private key'); return d; };

export function publicKey(priv) { const pt = mul(G, typeof priv === 'bigint' ? priv : privFrom(priv)); return Buffer.concat([toBuf(pt.x), toBuf(pt.y)]); }
export const addressOf = (pub64) => '0x' + keccak256(pub64).subarray(12).toString('hex');
export function addressFromPrivate(priv) { return addressOf(publicKey(priv)); }
export const checksum = (addr) => {
  const a = addr.toLowerCase().replace(/^0x/, ''), h = keccak256(Buffer.from(a, 'ascii')).toString('hex');
  return '0x' + [...a].map((c, i) => parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c).join('');
};

// RFC 6979 deterministic nonce
function rfc6979(h1, x) {
  const hmac = (k, ...parts) => crypto.createHmac('sha256', k).update(Buffer.concat(parts)).digest();
  let V = Buffer.alloc(32, 1), K = Buffer.alloc(32, 0);
  K = hmac(K, V, Buffer.from([0]), x, h1); V = hmac(K, V);
  K = hmac(K, V, Buffer.from([1]), x, h1); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = toInt(V);
    if (k >= 1n && k < N) return k;
    K = hmac(K, V, Buffer.from([0])); V = hmac(K, V);
  }
}

// Sign a 32-byte hash. Returns { r, s, recid } with low-s normalisation.
export function sign(hash32, priv) {
  const d = typeof priv === 'bigint' ? priv : privFrom(priv);
  const h = Buffer.from(hash32), z = toInt(h);
  for (let attempt = 0; ; attempt++) {
    const k = attempt === 0 ? rfc6979(h, toBuf(d)) : rfc6979(keccak256(Buffer.concat([h, Buffer.from([attempt])])), toBuf(d));
    const R = mul(G, k);
    const r = mod(R.x, N);
    if (r === 0n) continue;
    let s = mod(modInv(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    let recid = Number(R.y & 1n) | (R.x >= N ? 2 : 0);
    if (s > N / 2n) { s = N - s; recid ^= 1; }
    return { r, s, recid };
  }
}
export const sigToBytes = ({ r, s, recid }, vOffset = 27) => Buffer.concat([toBuf(r), toBuf(s), Buffer.from([recid + vOffset])]);

// Recover the public key from a signature over a 32-byte hash.
export function recover(hash32, r, s, recid) {
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('invalid signature');
  const x = r + (recid & 2 ? N : 0n);
  if (x >= P) throw new Error('invalid signature');
  const y2 = mod(x * x * x + 7n);
  let y = modPow(y2, (P + 1n) / 4n, P);
  if (mod(y * y) !== y2) throw new Error('invalid signature');
  if (Number(y & 1n) !== (recid & 1)) y = P - y;
  const R = { x, y };
  const z = toInt(Buffer.from(hash32)), rInv = modInv(r, N);
  const Q = add(mul(R, mod(s * rInv, N)), mul(G, mod(-z * rInv, N)));
  if (!Q || !onCurve(Q)) throw new Error('invalid signature');
  return Buffer.concat([toBuf(Q.x), toBuf(Q.y)]);
}
// A 65-byte wallet signature (r, s, v with v 27/28 or 0/1) → the signer's address.
export function recoverAddress(hash32, sigHex) {
  const b = Buffer.from(String(sigHex).replace(/^0x/, ''), 'hex');
  if (b.length !== 65) throw new Error('signature must be 65 bytes');
  const r = toInt(b.subarray(0, 32)), s = toInt(b.subarray(32, 64));
  let v = b[64]; if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('invalid recovery id');
  return addressOf(recover(hash32, r, s, v));
}
// EIP-191: the hash a wallet signs for personal_sign.
export function personalHash(message) {
  const m = Buffer.from(String(message), 'utf8');
  return keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`, 'utf8'), m]));
}
export function signPersonal(message, priv) { return '0x' + sigToBytes(sign(personalHash(message), priv)).toString('hex'); }
