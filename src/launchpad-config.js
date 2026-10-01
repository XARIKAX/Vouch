import { ApiError } from './errors.js';

// Launchpad parameters. Global defaults live here; each agent snapshots these
// at launch (see snapshotParams) and is immutable afterwards, so changing a
// default never alters an already-launched agent. Risk parameters are set by
// the platform only: the launch request body cannot override them.
//
// All money values are in USDG. The platform token is referenced by address
// only — its identity is a deploy-time parameter, not hard-coded here. Shares
// are fractions of 1 and each group must sum to 1.

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

export const LAUNCHPAD_DEFAULTS = deepFreeze({
  // Pool / fees
  poolSwapFee: 0.01,                 // 1% swap fee on the agent-token pool
  feeSplit: { bond: 0.50, operating: 0.30, creator: 0.15, treasury: 0.05 },

  // Token bond
  bondHaircut: 0.50,                 // token bond counts at 50% of value
  reservationMultiple: 2.0,          // reserve 200% of a quote's price (max slash)
  priceWindowMinutes: 30,            // TWAP window for token valuation
  liquidityFloorUsdg: 1000,          // below this pool liquidity, token-bond capacity = 0
  unbondingCooldownMs: 30 * 24 * 60 * 60 * 1000, // 30 days

  // Protocol fee on settled work
  protocolFee: 0.05,                 // 5% of settled price
  protocolFeeUse: { burn: 0.50, treasury: 0.50 },

  // Net payout split for LAUNCHED agents (non-launchpad providers keep 100% of net)
  netSplit: { owner: 0.80, buyback: 0.10, bond: 0.10 },

  // Anti-gaming / verifier risk limits
  rollingSlashCap: 0.20,             // max 20% of bond slashable per rolling 24h
  rollingSlashWindowMs: 24 * 60 * 60 * 1000,
  maxSlashMultiple: 2.0,             // a single verdict can never slash > 200% of price
  pendingSlashMs: 24 * 60 * 60 * 1000, // token-bond slashes wait 24h before funds move

  // Platform token — identity is a deploy parameter (address filled per chain).
  platformToken: { symbol: 'VOUCH', address: null, decimals: 18 },
  stablecoin: { symbol: 'USDG', address: null, decimals: 6 },
  chain: 'robinhood',
});

const near = (sum) => Math.abs(sum - 1) < 1e-9;
const bad = (msg) => new ApiError(400, 'invalid_input', `launchpad params: ${msg}`);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Validate the parameter set: share groups sum to 1 with every share in
// [0, 1]; risk limits inside their sane ranges. Throws ApiError 400.
export function validateParams(p) {
  const groups = { feeSplit: p.feeSplit, protocolFeeUse: p.protocolFeeUse, netSplit: p.netSplit };
  for (const [name, g] of Object.entries(groups)) {
    if (!g || typeof g !== 'object') throw bad(`${name} must be an object of shares`);
    for (const [k, v] of Object.entries(g)) {
      if (!isNum(v) || v < 0 || v > 1) throw bad(`${name}.${k} must be a number in [0, 1], got ${JSON.stringify(v)}`);
    }
    const total = Object.values(g).reduce((a, b) => a + b, 0);
    if (!near(total)) throw bad(`${name} shares must sum to 1, got ${total}`);
  }
  if (!isNum(p.bondHaircut) || !(p.bondHaircut > 0 && p.bondHaircut <= 1)) throw bad('bondHaircut must be in (0, 1]');
  if (!isNum(p.reservationMultiple) || !(p.reservationMultiple >= 1)) throw bad('reservationMultiple must be >= 1');
  if (!isNum(p.maxSlashMultiple) || !(p.maxSlashMultiple >= 1)) throw bad('maxSlashMultiple must be >= 1');
  if (!isNum(p.rollingSlashCap) || !(p.rollingSlashCap > 0 && p.rollingSlashCap <= 1)) throw bad('rollingSlashCap must be in (0, 1]');
  if (!isNum(p.protocolFee) || p.protocolFee < 0 || p.protocolFee > 1) throw bad('protocolFee must be in [0, 1]');
  if (!isNum(p.poolSwapFee) || p.poolSwapFee < 0 || p.poolSwapFee > 1) throw bad('poolSwapFee must be in [0, 1]');
  for (const k of ['liquidityFloorUsdg', 'unbondingCooldownMs', 'rollingSlashWindowMs', 'pendingSlashMs', 'priceWindowMinutes']) {
    if (!isNum(p[k]) || p[k] < 0) throw bad(`${k} must be a non-negative number`);
  }
  return p;
}

// Snapshot the live config into an immutable per-agent parameter set at launch.
// `overrides` is for the platform operator (tests, deploy-time tuning); the
// public launch endpoint never passes the request body here.
export function snapshotParams(overrides = {}) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const merged = {
    ...LAUNCHPAD_DEFAULTS,
    ...o,
    feeSplit: { ...LAUNCHPAD_DEFAULTS.feeSplit, ...(o.feeSplit || {}) },
    protocolFeeUse: { ...LAUNCHPAD_DEFAULTS.protocolFeeUse, ...(o.protocolFeeUse || {}) },
    netSplit: { ...LAUNCHPAD_DEFAULTS.netSplit, ...(o.netSplit || {}) },
  };
  validateParams(merged);
  return deepFreeze(merged);
}
