// Base58 (the Bitcoin/Solana alphabet), zero dependencies. Solana addresses,
// transaction signatures and instruction data all travel in it.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export function encodeBase58(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let zeros = 0; while (zeros < b.length && b[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < b.length; i++) {
    let carry = b[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function decodeBase58(str) {
  const s = String(str ?? '');
  if (!s) return new Uint8Array(0);
  let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < s.length; i++) {
    const v = MAP[s[i]];
    if (v === undefined) throw new Error(`invalid base58 character "${s[i]}"`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// A Solana public key: 32 bytes in base58. Returns the bytes or null.
export function pubkeyBytes(str) {
  try { const b = decodeBase58(str); return b.length === 32 ? b : null; } catch { return null; }
}
export const isPubkey = (str) => pubkeyBytes(str) !== null;
