// RLP and EIP-1559 transactions, zero dependencies. Enough to sign a token
// transfer from the treasury: build the typed transaction, hash it, sign it
// with secp256k1, and serialise the raw bytes for eth_sendRawTransaction.
import { keccak256 } from './keccak.js';
import { sign } from './secp256k1.js';

const hexBuf = (h) => { const s = String(h).replace(/^0x/, ''); return Buffer.from(s.length % 2 ? '0' + s : s, 'hex'); };
const intBuf = (n) => { n = BigInt(n); if (n === 0n) return Buffer.alloc(0); let s = n.toString(16); if (s.length % 2) s = '0' + s; return Buffer.from(s, 'hex'); };
const lenPrefix = (len, offset) => {
  if (len < 56) return Buffer.from([offset + len]);
  const l = intBuf(len); return Buffer.concat([Buffer.from([offset + 55 + l.length]), l]);
};
// items: Buffer (bytes), bigint/number (integer), string '0x…' (bytes), or nested arrays
export function rlp(item) {
  if (Array.isArray(item)) { const body = Buffer.concat(item.map(rlp)); return Buffer.concat([lenPrefix(body.length, 0xc0), body]); }
  let b;
  if (Buffer.isBuffer(item)) b = item;
  else if (typeof item === 'bigint' || typeof item === 'number') b = intBuf(item);
  else if (typeof item === 'string') b = hexBuf(item);
  else throw new Error('rlp: unsupported item');
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([lenPrefix(b.length, 0x80), b]);
}
// decode one RLP item (used by tests to check what the signer produced)
export function rlpDecode(buf, at = 0) {
  const b = buf[at];
  if (b < 0x80) return { value: buf.subarray(at, at + 1), next: at + 1 };
  if (b < 0xb8) { const len = b - 0x80; return { value: buf.subarray(at + 1, at + 1 + len), next: at + 1 + len }; }
  if (b < 0xc0) { const ll = b - 0xb7, len = Number(BigInt('0x' + buf.subarray(at + 1, at + 1 + ll).toString('hex'))); return { value: buf.subarray(at + 1 + ll, at + 1 + ll + len), next: at + 1 + ll + len }; }
  let len, start;
  if (b < 0xf8) { len = b - 0xc0; start = at + 1; } else { const ll = b - 0xf7; len = Number(BigInt('0x' + buf.subarray(at + 1, at + 1 + ll).toString('hex'))); start = at + 1 + ll; }
  const items = []; let i = start;
  while (i < start + len) { const d = rlpDecode(buf, i); items.push(d.value); i = d.next; }
  return { value: items, next: start + len };
}

// tx: { chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data }
export function signEip1559(tx, priv) {
  const fields = [BigInt(tx.chainId), BigInt(tx.nonce), BigInt(tx.maxPriorityFeePerGas), BigInt(tx.maxFeePerGas), BigInt(tx.gas), tx.to, BigInt(tx.value ?? 0), tx.data ?? '0x', []];
  const hash = keccak256(Buffer.concat([Buffer.from([2]), rlp(fields)]));
  const { r, s, recid } = sign(hash, priv);
  const raw = Buffer.concat([Buffer.from([2]), rlp([...fields, BigInt(recid & 1), r, s])]);
  return { raw: '0x' + raw.toString('hex'), hash: '0x' + keccak256(raw).toString('hex') };
}
