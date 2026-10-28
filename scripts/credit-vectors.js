// Generates the score parity vectors contracts/test/Vectors.t.sol replays through
// ScoreLib.sol: deterministic pseudo-random event histories, each with the JS
// score at several points in time. Run `npm run credit:vectors` after changing
// either implementation; the Foundry test fails when they disagree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, score, USDG, DAY } from '../src/credit/score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'contracts', 'test', 'vectors', 'score.json');

const T0 = 1_800_000_000n;
const KINDS = ['settlement', 'slash', 'dispute_loss', 'repayment', 'advance_repayment', 'default', 'recovery'];

export function generate() {
// xorshift32: the same sequence every run, so the file only changes when the math does.
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
const pick = (n) => rnd() % n;
const vectors = [];
for (let v = 0; v < 48; v++) {
  const n = 1 + pick(24);
  let ts = T0;
  const events = [];
  for (let i = 0; i < n; i++) {
    ts += BigInt(pick(40)) * DAY + BigInt(pick(86400));
    const kind = v < 8 ? 'settlement' : KINDS[pick(KINDS.length)]; // the first few are work-only histories
    const amount = BigInt(pick(2_000_000_000)); // up to $2,000
    events.push({ kind, amount: Number(amount), ts: Number(ts), days: pick(31), on_time: pick(2) === 0 });
  }
  const r = replay(events.map((e) => ({ ...e, amount: BigInt(e.amount), ts: BigInt(e.ts) })));
  const checks = [0n, 1n, 7n * DAY, 30n * DAY, 100n * DAY, 365n * DAY, 3650n * DAY].map((dt) => ({ now: Number(ts + dt), score: Number(score(r, ts + dt)) }));
  vectors.push({ n: events.length, m: checks.length, events, checks });
}
// a hand-built one that exercises decay across a long gap and a recovery
{
  const events = [
    { kind: 'settlement', amount: Number(100n * USDG), ts: Number(T0), days: 0, on_time: false },
    { kind: 'default', amount: Number(50n * USDG), ts: Number(T0 + DAY), days: 0, on_time: false },
    { kind: 'settlement', amount: Number(300n * USDG), ts: Number(T0 + 45n * DAY), days: 0, on_time: false },
    { kind: 'recovery', amount: Number(50n * USDG), ts: Number(T0 + 200n * DAY), days: 0, on_time: false },
    { kind: 'repayment', amount: Number(120n * USDG), ts: Number(T0 + 201n * DAY), days: 12, on_time: true },
  ];
  const r = replay(events.map((e) => ({ ...e, amount: BigInt(e.amount), ts: BigInt(e.ts) })));
  const checks = [0n, 10n * DAY, 400n * DAY].map((dt) => ({ now: Number(T0 + 201n * DAY + dt), score: Number(score(r, T0 + 201n * DAY + dt)) }));
  vectors.push({ n: events.length, m: checks.length, events, checks });
}
return JSON.stringify({ count: vectors.length, vectors }, null, 1) + '\n';
}

export const VECTORS_PATH = out;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = generate();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`${JSON.parse(text).count} vectors → ${path.relative(process.cwd(), out)}`);
}
