// A small ABI codec: enough to call Pons and read its answers. Encodes
// address, uintN, intN, bool, bytes32, string, bytes, arrays and tuples
// (static and dynamic); decodes static words, strings and tuples of them.
// Types are given as the canonical Solidity strings ("uint256", "address",
// "tuple(string,uint16)" or "(string,uint16)", "address[]").

import { keccak256 } from './keccak.js';

const WORD = 32;
const hexToBuf = (h) => Buffer.from(String(h).replace(/^0x/, '').padStart(2, '0'), 'hex');
export const toHex = (buf) => '0x' + Buffer.from(buf).toString('hex');
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));

// --- type parsing ------------------------------------------------------------
export function parseType(t) {
  t = String(t).trim();
  const arr = t.match(/^(.*)\[(\d*)\]$/);
  if (arr) return { kind: 'array', len: arr[2] === '' ? null : Number(arr[2]), inner: parseType(arr[1]) };
  if (t.startsWith('tuple(') || t.startsWith('(')) {
    const body = t.slice(t.indexOf('(') + 1, t.lastIndexOf(')'));
    const parts = []; let depth = 0, cur = '';
    for (const ch of body) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; }
    if (cur.trim()) parts.push(cur);
    return { kind: 'tuple', components: parts.map(parseType) };
  }
  if (t === 'address') return { kind: 'address' };
  if (t === 'bool') return { kind: 'bool' };
  if (t === 'string') return { kind: 'string' };
  if (t === 'bytes') return { kind: 'bytes' };
  const b = t.match(/^bytes(\d+)$/); if (b) return { kind: 'bytesN', n: Number(b[1]) };
  const u = t.match(/^uint(\d*)$/); if (u) return { kind: 'uint', bits: Number(u[1] || 256) };
  const i = t.match(/^int(\d*)$/); if (i) return { kind: 'int', bits: Number(i[1] || 256) };
  throw new Error(`unsupported ABI type ${t}`);
}
const isDynamic = (ty) => ty.kind === 'string' || ty.kind === 'bytes' || (ty.kind === 'array' && (ty.len === null || isDynamic(ty.inner))) || (ty.kind === 'tuple' && ty.components.some(isDynamic));

// --- encoding ----------------------------------------------------------------
const word = (buf) => { const w = Buffer.alloc(WORD); Buffer.from(buf).copy(w, WORD - buf.length); return w; };
const uintWord = (v, bits = 256) => {
  let n = typeof v === 'bigint' ? v : BigInt(typeof v === 'string' && v.startsWith('0x') ? v : Math.trunc(Number(v)));
  if (n < 0n) throw new Error('negative value for uint');
  if (n >= (1n << BigInt(bits))) throw new Error(`value exceeds uint${bits}`);
  return word(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
};
const intWord = (v, bits = 256) => { let n = BigInt(v); if (n < 0n) n = (1n << 256n) + n; const lim = 1n << BigInt(bits - 1); if (BigInt(v) >= lim || BigInt(v) < -lim) throw new Error(`value exceeds int${bits}`); return word(Buffer.from(n.toString(16).padStart(64, '0'), 'hex')); };
const bytesDyn = (b) => { const buf = Buffer.from(b); const padded = Buffer.alloc(Math.ceil(buf.length / WORD) * WORD); buf.copy(padded); return Buffer.concat([uintWord(buf.length), padded]); };

function encodeValue(ty, v) {
  switch (ty.kind) {
    case 'address': if (!isAddress(v)) throw new Error(`bad address ${v}`); return word(hexToBuf(v));
    case 'bool': return uintWord(v ? 1 : 0);
    case 'uint': return uintWord(v, ty.bits);
    case 'int': return intWord(v, ty.bits);
    case 'bytesN': { const b = hexToBuf(v); if (b.length > ty.n) throw new Error(`bytes${ty.n} too long`); const w = Buffer.alloc(WORD); b.copy(w); return w; }
    case 'string': return bytesDyn(Buffer.from(String(v ?? ''), 'utf8'));
    case 'bytes': return bytesDyn(hexToBuf(v));
    case 'array': {
      const items = Array.isArray(v) ? v : [];
      if (ty.len !== null && items.length !== ty.len) throw new Error(`expected ${ty.len} items`);
      const body = encodeTuple(items.map(() => ty.inner), items);
      return ty.len === null ? Buffer.concat([uintWord(items.length), body]) : body;
    }
    case 'tuple': { const vals = Array.isArray(v) ? v : ty.components.map((_, i) => v?.[i]); return encodeTuple(ty.components, vals); }
    default: throw new Error(`cannot encode ${ty.kind}`);
  }
}
function encodeTuple(types, values) {
  if (types.length !== values.length) throw new Error(`expected ${types.length} values, got ${values.length}`);
  const heads = [], tails = [];
  let headLen = 0;
  for (const ty of types) headLen += isDynamic(ty) ? WORD : staticSize(ty);
  let tailLen = 0;
  types.forEach((ty, i) => {
    const enc = encodeValue(ty, values[i]);
    if (isDynamic(ty)) { heads.push(uintWord(headLen + tailLen)); tails.push(enc); tailLen += enc.length; }
    else heads.push(enc);
  });
  return Buffer.concat([...heads, ...tails]);
}
function staticSize(ty) {
  if (ty.kind === 'tuple') return ty.components.reduce((s, c) => s + staticSize(c), 0);
  if (ty.kind === 'array') return ty.len * staticSize(ty.inner);
  return WORD;
}

export const encodeParams = (types, values) => encodeTuple(types.map(parseType), values);
export const selector = (signature) => keccak256(signature).subarray(0, 4);
// "launchToken((string,string),uint256)" → calldata hex
export function encodeCall(signature, values) {
  const types = parseType('(' + signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')')) + ')').components;
  return toHex(Buffer.concat([selector(signature), encodeTuple(types, values)]));
}
export const eventTopic = (signature) => toHex(keccak256(signature));

// --- decoding (static words, strings, flat tuples and dynamic arrays of them) --
export function decodeParams(types, data) {
  const buf = hexToBuf(data);
  const tys = types.map(parseType);
  return decodeTuple(tys, buf, 0);
}
function decodeTuple(tys, buf, base) {
  const out = []; let pos = base;
  for (const ty of tys) {
    if (isDynamic(ty)) { const off = Number(readUint(buf, pos)); out.push(decodeDynamic(ty, buf, base + off)); pos += WORD; }
    else { out.push(decodeStatic(ty, buf, pos)); pos += staticSize(ty); }
  }
  return out;
}
const readUint = (buf, pos) => BigInt('0x' + buf.subarray(pos, pos + WORD).toString('hex'));
function decodeStatic(ty, buf, pos) {
  switch (ty.kind) {
    case 'address': return '0x' + buf.subarray(pos + 12, pos + 32).toString('hex');
    case 'bool': return readUint(buf, pos) !== 0n;
    case 'uint': return readUint(buf, pos);
    case 'int': { const n = readUint(buf, pos); return n >= (1n << 255n) ? n - (1n << 256n) : n; }
    case 'bytesN': return '0x' + buf.subarray(pos, pos + ty.n).toString('hex');
    case 'tuple': return decodeTuple(ty.components, buf, pos);
    default: throw new Error(`cannot decode static ${ty.kind}`);
  }
}
function decodeDynamic(ty, buf, pos) {
  if (ty.kind === 'string' || ty.kind === 'bytes') { const len = Number(readUint(buf, pos)); const b = buf.subarray(pos + WORD, pos + WORD + len); return ty.kind === 'string' ? b.toString('utf8') : toHex(b); }
  if (ty.kind === 'array') { const len = Number(readUint(buf, pos)); return decodeTuple(Array(len).fill(ty.inner), buf, pos + WORD); }
  if (ty.kind === 'tuple') return decodeTuple(ty.components, buf, pos);
  throw new Error(`cannot decode dynamic ${ty.kind}`);
}
export const decodeAddressWord = (hexWord) => '0x' + String(hexWord).replace(/^0x/, '').slice(-40);
