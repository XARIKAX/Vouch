// Launchpad math — pure, stateless functions the engine and contracts share.
// No I/O, no mutation: given numbers and a params snapshot, return numbers.
// All money is USDG. These encode the brief's worked example exactly.

const money = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

// ---- fee harvest split --------------------------------------------------
// A harvested pool-fee amount splits into bond / operating / creator / treasury.
export function splitFees(feeAmount, p) {
  const f = Math.max(0, Number(feeAmount) || 0);
  const s = p.feeSplit;
  const bond = money(f * s.bond);
  const operating = money(f * s.operating);
  const creator = money(f * s.creator);
  // Treasury takes the remainder so the four always sum to exactly `feeAmount`.
  const treasury = money(f - bond - operating - creator);
  return { bond, operating, creator, treasury };
}

// ---- token-bond valuation & capacity ------------------------------------
// Haircut-adjusted value of a token bond, given a TWAP price in USDG.
// Below the liquidity floor the token bond is worth nothing for capacity.
export function bondValue({ tokenQty = 0, twapUsdg = 0, poolLiquidityUsdg = 0 }, p) {
  if (!(poolLiquidityUsdg >= p.liquidityFloorUsdg)) return 0;
  return money(tokenQty * twapUsdg);
}
export function haircutValue(rawValueUsdg, p) {
  return money(Math.max(0, rawValueUsdg) * p.bondHaircut);
}

// Open-quote capacity a bond supports: haircut value / reservationMultiple.
// (Worked example: $500 bond * 50% / 2 = $125.)
export function bondCapacity(rawValueUsdg, p) {
  return money(haircutValue(rawValueUsdg, p) / p.reservationMultiple);
}

// Haircut-value a single quote must reserve: reservationMultiple * price.
// A quote is admissible iff this fits in the remaining haircut capacity.
export function reservationFor(quotedPrice, p) {
  return money(Math.max(0, Number(quotedPrice) || 0) * p.reservationMultiple);
}
export function canReserve({ rawValueUsdg, reservedHaircut, quotedPrice }, p) {
  const remaining = money(haircutValue(rawValueUsdg, p) - (Number(reservedHaircut) || 0));
  return reservationFor(quotedPrice, p) <= remaining + 1e-9;
}

// ---- protocol fee on settled work ---------------------------------------
// 5% of the settled price; the fee splits burn / treasury; net is paid out.
export function protocolFeeSplit(settledPrice, p) {
  const price = Math.max(0, Number(settledPrice) || 0);
  const fee = money(price * p.protocolFee);
  const burn = money(fee * p.protocolFeeUse.burn);
  const treasury = money(fee - burn);
  const net = money(price - fee);
  return { price, fee, burn, treasury, net };
}

// ---- net payout routing for launched agents -----------------------------
// Net (after protocol fee) splits owner / token-buyback / bond-top-up.
// Non-launchpad providers skip this and keep 100% of net.
export function netPayoutSplit(net, p) {
  const n = Math.max(0, Number(net) || 0);
  const owner = money(n * p.netSplit.owner);
  const buyback = money(n * p.netSplit.buyback);
  const bond = money(n - owner - buyback);
  return { owner, buyback, bond };
}

// ---- compute top-up from job revenue -----------------------------------
// While the agent's compute balance is under its threshold, a share of each
// settled job's net payout moves into it. It comes out of the owner's share
// only; the buyback and bond shares are untouched.
// (Worked example: net $190, owner $152, share 10% → top-up $19, owner $133.)
export function topUpFromRevenue({ net, ownerShare, balance }, rule) {
  const share = Math.max(0, Math.min(Number(rule?.share) || 0, 1));
  const threshold = Math.max(0, Number(rule?.threshold) || 0);
  if (!(share > 0) || !(Number(balance) < threshold)) return { topUp: 0, owner: money(ownerShare) };
  const topUp = money(Math.min(Math.max(0, Number(net) || 0) * share, Math.max(0, Number(ownerShare) || 0)));
  return { topUp, owner: money(ownerShare - topUp) };
}

// ---- inference billing --------------------------------------------------
// A billed call pays the inference protocol fee (burn / treasury); the net is
// the provider's payout. (Worked example: $10.00 → fee $0.30, net $9.70.)
export function inferenceFeeSplit(cost, p) {
  const price = Math.max(0, Number(cost) || 0);
  const fee = money(price * p.inferenceFee);
  const burn = money(fee * p.inferenceFeeUse.burn);
  const treasury = money(fee - burn);
  return { price, fee, burn, treasury, net: money(price - fee) };
}
// A launched sourcing agent's payout splits on its own thinner rates.
// (Worked example: $9.70 → owner $9.312, buyback $0.194, bond $0.194.)
export function inferenceNetSplit(net, p) {
  const n = Math.max(0, Number(net) || 0);
  const owner = money(n * p.inferenceNetSplit.owner);
  const buyback = money(n * p.inferenceNetSplit.buyback);
  return { owner, buyback, bond: money(n - owner - buyback) };
}
// The bond an offer's provider must keep free: a multiple of its inference
// revenue in the audit window, plus the call at hand.
export function inferenceReservation(windowRevenue, callCost, p) {
  return money((Math.max(0, Number(windowRevenue) || 0) + Math.max(0, Number(callCost) || 0)) * p.inference.bondMultiple);
}

// ---- slashing in token terms --------------------------------------------
// Slash is sized in USDG; taken in platform token at the TWAP; the per-verdict
// cap is reservationMultiple * price; a rolling window cap limits total damage.
// `bondRawValueUsdg` is the slash base: the FULL bond (including any tokens
// in an unbonding request) at TWAP, ignoring the liquidity floor. The floor
// limits quote capacity only; it must never make a slash free.
export function slashBase({ tokenQty = 0, twapUsdg = 0 }) {
  return money(Math.max(0, tokenQty) * Math.max(0, twapUsdg));
}
export function slashPlan({ priceUsdg, multiple, twapUsdg, bondRawValueUsdg, slashedInWindowUsdg }, p) {
  const capMultiple = Math.min(Number(multiple) || 1, p.maxSlashMultiple);
  let amountUsdg = money(Math.max(0, Number(priceUsdg) || 0) * capMultiple);
  // Rolling cap: no more than rollingSlashCap of bond value per window.
  const rollingBudget = money(bondRawValueUsdg * p.rollingSlashCap - (Number(slashedInWindowUsdg) || 0));
  const capped = amountUsdg > rollingBudget;
  if (capped) amountUsdg = money(Math.max(0, rollingBudget));
  const tokenQty = twapUsdg > 0 ? money(amountUsdg / twapUsdg) : 0;
  return { amountUsdg, tokenQty, capped, cappedBy: capped ? 'rolling_window' : null };
}

// ---- track weighting (anti-gaming) --------------------------------------
// Distinct paying counterparties matter, not raw task count. Self-dealing
// (shared owner wallet) earns zero track. Rubric-only (or schema-only) tasks
// earn reduced weight; deterministic checks or a webhook earn full weight.
// Schema is not a hard validator: every settled task passes it, so counting
// it would make the reduced weight unreachable.
export function trackWeight({ sameOwner, validators = [] }) {
  if (sameOwner) return 0;
  const hard = validators.some((v) => v === 'checks' || v === 'webhook');
  return hard ? 1.0 : 0.3; // rubric-only / schema-only → 0.3
}

export const _money = money;
