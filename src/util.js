import crypto from 'node:crypto';

export const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
export const txHash = () => '0x' + crypto.randomBytes(12).toString('hex');

// Deterministic 0..1 from a string — used for quote spreads and grader jitter
// so behavior is reproducible for a given task id.
export const hash01 = (s) => {
  const h = crypto.createHash('sha256').update(String(s)).digest();
  return h.readUInt32BE(0) / 0xffffffff;
};

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export const money = (n) => Math.round(n * 1e6) / 1e6;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
