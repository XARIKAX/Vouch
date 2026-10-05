// A Solana legacy transaction message, compiled and serialized. Pure: no
// hashing, no network, no dependencies, so the same file runs in the browser
// (where a wallet signs it) and on the server (where the treasury signs it).
//
// An instruction is { programId, keys: [{ pubkey, isSigner, isWritable }], data }
// with pubkeys as base58 strings and data as a Uint8Array.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));
export function b58decode(str) {
  const s = String(str ?? ''); if (!s) return new Uint8Array(0);
  let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < s.length; i++) {
    const v = MAP[s[i]]; if (v === undefined) throw new Error(`invalid base58 character "${s[i]}"`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}
export function b58encode(bytes) {
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

export function compactU16(n) {
  const out = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n === 0) { out.push(b); return out; } out.push(b | 0x80); }
}
export function readCompactU16(bytes, offset) {
  let n = 0, shift = 0, i = offset;
  for (;;) { const b = bytes[i++]; n |= (b & 0x7f) << shift; if (!(b & 0x80)) return [n, i]; shift += 7; }
}

// Account ordering, as the runtime wants it: the fee payer first, then
// writable signers, read-only signers, writable non-signers, read-only
// non-signers, each group in first-seen order. Program ids are read-only
// non-signers. Returns { header, accountKeys, instructions } with indexes.
export function compileMessage({ feePayer, instructions, recentBlockhash }) {
  const metas = new Map();
  const add = (pubkey, isSigner, isWritable) => {
    const m = metas.get(pubkey) || { pubkey, isSigner: false, isWritable: false };
    m.isSigner = m.isSigner || isSigner; m.isWritable = m.isWritable || isWritable;
    metas.set(pubkey, m);
  };
  add(feePayer, true, true);
  for (const ix of instructions) for (const k of ix.keys) add(k.pubkey, !!k.isSigner, !!k.isWritable);
  for (const ix of instructions) add(ix.programId, false, false);
  const all = [...metas.values()];
  const payer = all.shift();
  const groups = [[], [], [], []];
  for (const m of all) groups[m.isSigner ? (m.isWritable ? 0 : 1) : (m.isWritable ? 2 : 3)].push(m);
  const ordered = [payer, ...groups[0], ...groups[1], ...groups[2], ...groups[3]];
  const index = new Map(ordered.map((m, i) => [m.pubkey, i]));
  const header = {
    numRequiredSignatures: 1 + groups[0].length + groups[1].length,
    numReadonlySignedAccounts: groups[1].length,
    numReadonlyUnsignedAccounts: groups[3].length,
  };
  const compiled = instructions.map((ix) => ({ programIdIndex: index.get(ix.programId), accounts: ix.keys.map((k) => index.get(k.pubkey)), data: ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data) }));
  return { header, accountKeys: ordered.map((m) => m.pubkey), recentBlockhash, instructions: compiled };
}

export function serializeMessage(msg) {
  const out = [msg.header.numRequiredSignatures, msg.header.numReadonlySignedAccounts, msg.header.numReadonlyUnsignedAccounts];
  out.push(...compactU16(msg.accountKeys.length));
  for (const k of msg.accountKeys) out.push(...b58decode(k));
  out.push(...b58decode(msg.recentBlockhash));
  out.push(...compactU16(msg.instructions.length));
  for (const ix of msg.instructions) {
    out.push(ix.programIdIndex);
    out.push(...compactU16(ix.accounts.length), ...ix.accounts);
    out.push(...compactU16(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(out);
}

// The wire transaction: signatures (one per required signer, in account
// order; zeros where a signer has not signed yet) followed by the message.
export function serializeTransaction(messageBytes, signatures) {
  const out = [...compactU16(signatures.length)];
  for (const s of signatures) { const b = s ? Uint8Array.from(s) : new Uint8Array(64); if (b.length !== 64) throw new Error('a signature is 64 bytes'); out.push(...b); }
  out.push(...messageBytes);
  return Uint8Array.from(out);
}

// Parse a serialized legacy transaction back: used by tests and by the
// server to read what a wallet or the treasury signed.
export function parseTransaction(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let [nSig, i] = readCompactU16(b, 0);
  const signatures = [];
  for (let k = 0; k < nSig; k++) { signatures.push(b.subarray(i, i + 64)); i += 64; }
  const messageBytes = b.subarray(i);
  const header = { numRequiredSignatures: b[i], numReadonlySignedAccounts: b[i + 1], numReadonlyUnsignedAccounts: b[i + 2] }; i += 3;
  let nKeys; [nKeys, i] = readCompactU16(b, i);
  const accountKeys = [];
  for (let k = 0; k < nKeys; k++) { accountKeys.push(b58encode(b.subarray(i, i + 32))); i += 32; }
  const recentBlockhash = b58encode(b.subarray(i, i + 32)); i += 32;
  let nIx; [nIx, i] = readCompactU16(b, i);
  const instructions = [];
  for (let k = 0; k < nIx; k++) {
    const programIdIndex = b[i++];
    let nAcc; [nAcc, i] = readCompactU16(b, i);
    const accounts = [...b.subarray(i, i + nAcc)]; i += nAcc;
    let nData; [nData, i] = readCompactU16(b, i);
    const data = b.subarray(i, i + nData); i += nData;
    instructions.push({ programIdIndex, accounts, data });
  }
  return { signatures, messageBytes, header, accountKeys, recentBlockhash, instructions };
}

export const u64le = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
export const readU64le = (bytes, off = 0) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]); return v; };
export const utf8 = (s) => new TextEncoder().encode(String(s));
export const concat = (...parts) => { const n = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
