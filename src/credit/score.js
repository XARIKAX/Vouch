// Vouch Credit score: the engine-side mirror of contracts/src/ScoreLib.sol.
// Same integer arithmetic (BigInt), same constants, same event application, so
// the score the engine shows for an agent is the score the chain computes from
// the same events. contracts/test/Vectors.t.sol replays the vectors this module
// generates (scripts/credit-vectors.js) through the Solidity library and asserts
// equality, so a drift in either breaks the build.
//
// Amounts are USDG base units (6 decimals) as BigInt; times are unix seconds.

export const ONE = 10n ** 18n;
export const USDG = 10n ** 6n;
export const MAX_SCORE = 1000n;
export const DAY = 86400n;
export const WORK_HALF_LIFE = 30n * DAY;
export const DEFAULT_HALF_LIFE = 180n * DAY;

const big = (v) => (typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0)));
const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);

export function emptyReport() {
  return {
    settledCount: 0n, settledVolume: 0n, recentVolume: 0n, workUpdatedAt: 0n,
    slashCount: 0n, slashedVolume: 0n, disputeLossCount: 0n, disputeLossVolume: 0n,
    loansRepaid: 0n, loansRepaidOnTime: 0n, repaidPrincipalDays: 0n,
    advancesRepaid: 0n, advancesRepaidVolume: 0n,
    defaults: 0n, defaultedVolume: 0n, defaultPenalty: 0n, defaultUpdatedAt: 0n, recoveries: 0n,
  };
}

// 2^-(dt / halfLife) in ONE units: exact at whole half-lives, linear in between.
export function decayFactor(dt, halfLife) {
  dt = big(dt); halfLife = big(halfLife);
  const whole = dt / halfLife;
  if (whole >= 64n) return 0n;
  const f = ONE >> whole;
  const frac = ((dt % halfLife) * ONE) / halfLife;
  return f - (f * frac) / (2n * ONE);
}

export function decayed(value, updatedAt, nowTs, halfLife) {
  value = big(value); updatedAt = big(updatedAt); nowTs = big(nowTs);
  if (nowTs <= updatedAt || value === 0n) return value;
  return (value * decayFactor(nowTs - updatedAt, halfLife)) / ONE;
}

export const defaultPoints = (amount) => 400n + min(200n, big(amount) / (5n * USDG));

// ---- event application: mutates and returns the report -----------------------

export function addSettlement(r, amount, ts) {
  amount = big(amount); ts = big(ts);
  r.recentVolume = decayed(r.recentVolume, r.workUpdatedAt, ts, WORK_HALF_LIFE) + amount;
  r.workUpdatedAt = ts;
  r.settledCount += 1n;
  r.settledVolume += amount;
  return r;
}
export function addSlash(r, amount) { r.slashCount += 1n; r.slashedVolume += big(amount); return r; }
export function addDisputeLoss(r, amount) { r.disputeLossCount += 1n; r.disputeLossVolume += big(amount); return r; }
export function addRepayment(r, principal, durationDays, onTime) {
  r.loansRepaid += 1n;
  if (onTime) r.loansRepaidOnTime += 1n;
  r.repaidPrincipalDays += big(principal) * big(durationDays);
  return r;
}
export function addAdvanceRepayment(r, amount) { r.advancesRepaid += 1n; r.advancesRepaidVolume += big(amount); return r; }
export function addDefault(r, amount, ts) {
  amount = big(amount); ts = big(ts);
  r.defaultPenalty = decayed(r.defaultPenalty, r.defaultUpdatedAt, ts, DEFAULT_HALF_LIFE) + defaultPoints(amount) * ONE;
  r.defaultUpdatedAt = ts;
  r.defaults += 1n;
  r.defaultedVolume += amount;
  return r;
}
export function addRecovery(r, amount, ts) {
  ts = big(ts);
  const current = decayed(r.defaultPenalty, r.defaultUpdatedAt, ts, DEFAULT_HALF_LIFE);
  const relief = (defaultPoints(amount) * ONE) / 2n;
  r.defaultPenalty = current > relief ? current - relief : 0n;
  r.defaultUpdatedAt = ts;
  r.recoveries += 1n;
  return r;
}

// Apply one event record {kind, amount, ts, days, on_time} to a report.
export function apply(r, e) {
  switch (e.kind) {
    case 'settlement': return addSettlement(r, e.amount, e.ts);
    case 'slash': return addSlash(r, e.amount);
    case 'dispute_loss': return addDisputeLoss(r, e.amount);
    case 'repayment': return addRepayment(r, e.amount, e.days ?? 0, !!e.on_time);
    case 'advance_repayment': return addAdvanceRepayment(r, e.amount);
    case 'default': return addDefault(r, e.amount, e.ts);
    case 'recovery': return addRecovery(r, e.amount, e.ts);
    default: return r;
  }
}

export function replay(events) { return events.reduce((r, e) => apply(r, e), emptyReport()); }

// ---- the score -----------------------------------------------------------------

export const workPoints = (r, nowTs) => {
  const recent = decayed(r.recentVolume, r.workUpdatedAt, nowTs, WORK_HALF_LIFE);
  return min(200n, r.settledCount * 4n) + min(250n, recent / (4n * USDG));
};
export const repaymentPoints = (r) => {
  const late = r.loansRepaid - r.loansRepaidOnTime;
  return min(400n, r.loansRepaidOnTime * 20n + late * 8n + r.repaidPrincipalDays / (10n * USDG));
};
export const advancePoints = (r) => min(150n, r.advancesRepaid * 3n + r.advancesRepaidVolume / (40n * USDG));
export const slashPenalty = (r) => min(300n, r.slashCount * 30n + r.slashedVolume / (2n * USDG));
export const disputePenalty = (r) => min(400n, r.disputeLossCount * 80n + r.disputeLossVolume / USDG);
export const defaultPenaltyNow = (r, nowTs) => decayed(r.defaultPenalty, r.defaultUpdatedAt, nowTs, DEFAULT_HALF_LIFE) / ONE;

export function score(r, nowTs) {
  nowTs = big(nowTs);
  const positive = workPoints(r, nowTs) + repaymentPoints(r) + advancePoints(r);
  const negative = slashPenalty(r) + disputePenalty(r) + defaultPenaltyNow(r, nowTs);
  if (negative >= positive) return 0n;
  return min(MAX_SCORE, positive - negative);
}

// ---- pricing from the score ---------------------------------------------------------

export function tier(s) { s = big(s); return s < 300n ? 0 : s < 550n ? 1 : s < 800n ? 2 : 3; }
export function feeBps30d(s) { const t = tier(s); return t === 0 ? 0n : t === 1 ? 300n : t === 2 ? 200n : 100n; }
export function creditLine(s, recentVolume, cap) {
  const t = tier(s);
  if (t === 0) return 0n;
  const base = t === 1 ? 25n * USDG : t === 2 ? 100n * USDG : 200n * USDG;
  return min(big(cap), max(base, big(recentVolume) / 2n));
}

// A full report at `nowTs`, numbers as JS numbers (dollars where they are money).
export function breakdown(r, nowTs) {
  nowTs = big(nowTs);
  const s = score(r, nowTs);
  const recent = decayed(r.recentVolume, r.workUpdatedAt, nowTs, WORK_HALF_LIFE);
  return {
    score: Number(s),
    tier: tier(s),
    fee_bps_30d: Number(feeBps30d(s)),
    points: {
      work: Number(workPoints(r, nowTs)), repayment: Number(repaymentPoints(r)), advances: Number(advancePoints(r)),
      slashes: -Number(slashPenalty(r)) || 0, disputes: -Number(disputePenalty(r)) || 0, defaults: -Number(defaultPenaltyNow(r, nowTs)) || 0,
    },
    recent_volume_usd: Number(recent) / 1e6,
  };
}

export const toUsdg = (usd) => BigInt(Math.round((Number(usd) + Number.EPSILON) * 1e6));
export const fromUsdg = (units) => Number(units) / 1e6;
