// Launchpad parameters. Global defaults live here; each agent snapshots these
// at launch (see snapshotParams) and is immutable afterwards, so changing a
// default never alters an already-launched agent.
//
// All money values are in USDG (Robinhood Chain). The platform token is
// referenced by address only — its identity is a deploy-time parameter, not
// hard-coded here. Shares are fractions of 1 and each group must sum to 1.

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

// Validate that each share group sums to 1 (fixed, cannot drift per agent).
export function validateParams(p) {
  const groups = [p.feeSplit, p.protocolFeeUse, p.netSplit];
  for (const g of groups) {
    const total = Object.values(g).reduce((a, b) => a + (Number(b) || 0), 0);
    if (!near(total)) throw new Error(`share group must sum to 1, got ${total}: ${JSON.stringify(g)}`);
  }
  if (!(p.bondHaircut > 0 && p.bondHaircut <= 1)) throw new Error('bondHaircut must be in (0,1]');
  if (!(p.reservationMultiple >= 1)) throw new Error('reservationMultiple must be >= 1');
  return p;
}

// Snapshot the live config into an immutable per-agent parameter set at launch.
export function snapshotParams(overrides = {}) {
  const merged = {
    ...LAUNCHPAD_DEFAULTS,
    ...overrides,
    feeSplit: { ...LAUNCHPAD_DEFAULTS.feeSplit, ...(overrides.feeSplit || {}) },
    protocolFeeUse: { ...LAUNCHPAD_DEFAULTS.protocolFeeUse, ...(overrides.protocolFeeUse || {}) },
    netSplit: { ...LAUNCHPAD_DEFAULTS.netSplit, ...(overrides.netSplit || {}) },
  };
  validateParams(merged);
  return deepFreeze(merged);
}
