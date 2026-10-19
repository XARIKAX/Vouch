// Agent economics: pure, stateless functions the engine shares with the
// settlement mock. No I/O, no mutation: given numbers and a params snapshot,
// return numbers. All money is USDT.

const money = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

// ---- stake & capacity ---------------------------------------------------
// The stake counts at face value (it is USDT). Open-quote capacity is the
// backing stake divided by the reservation multiple: each quote reserves
// reservationMultiple times its price, so a slash always covers the outcome.
// (Worked example: $500 staked / 2 = $250 of open quotes at once.)
export function haircutValue(stakeUsdt, p) {
  return money(Math.max(0, Number(stakeUsdt) || 0) * (p.bondHaircut ?? 1));
}
export function bondCapacity(stakeUsdt, p) {
  return money(haircutValue(stakeUsdt, p) / p.reservationMultiple);
}
// What a single quote must reserve: reservationMultiple * price.
export function reservationFor(quotedPrice, p) {
  return money(Math.max(0, Number(quotedPrice) || 0) * p.reservationMultiple);
}
export function canReserve({ stakeUsdt, reserved, quotedPrice }, p) {
  const remaining = money(haircutValue(stakeUsdt, p) - (Number(reserved) || 0));
  return reservationFor(quotedPrice, p) <= remaining + 1e-9;
}

// ---- protocol fee on settled work ---------------------------------------
// 5% of the settled price to the treasury; net is paid out.
export function protocolFeeSplit(settledPrice, p) {
  const price = Math.max(0, Number(settledPrice) || 0);
  const fee = money(price * p.protocolFee);
  const burn = money(fee * (p.protocolFeeUse?.burn ?? 0));
  const treasury = money(fee - burn);
  const net = money(price - fee);
  return { price, fee, burn, treasury, net };
}

// ---- net payout routing for agents --------------------------------------
// Net (after protocol fee) splits owner / stake top-up. Plain providers skip
// this and keep 100% of net.
export function netPayoutSplit(net, p) {
  const n = Math.max(0, Number(net) || 0);
  const owner = money(n * p.netSplit.owner);
  const bond = money(n - owner);
  return { owner, bond };
}

// ---- compute top-up from job revenue -----------------------------------
// While the agent's compute balance is under its threshold, a share of each
// settled job's net payout moves into it. It comes out of the owner's share
// only; the stake share is untouched.
// (Worked example: net $190, owner $171, share 10% → top-up $19, owner $152.)
export function topUpFromRevenue({ net, ownerShare, balance }, rule) {
  const share = Math.max(0, Math.min(Number(rule?.share) || 0, 1));
  const threshold = Math.max(0, Number(rule?.threshold) || 0);
  if (!(share > 0) || !(Number(balance) < threshold)) return { topUp: 0, owner: money(ownerShare) };
  const topUp = money(Math.min(Math.max(0, Number(net) || 0) * share, Math.max(0, Number(ownerShare) || 0)));
  return { topUp, owner: money(ownerShare - topUp) };
}

// ---- inference billing --------------------------------------------------
// A billed call pays the inference protocol fee to the treasury; the net is
// the provider's payout. (Worked example: $10.00 → fee $0.30, net $9.70.)
export function inferenceFeeSplit(cost, p) {
  const price = Math.max(0, Number(cost) || 0);
  const fee = money(price * p.inferenceFee);
  const burn = money(fee * (p.inferenceFeeUse?.burn ?? 0));
  const treasury = money(fee - burn);
  return { price, fee, burn, treasury, net: money(price - fee) };
}
// An agent selling inference splits its payout on thinner rates than tasks.
// (Worked example: $9.70 → owner $9.506, stake $0.194.)
export function inferenceNetSplit(net, p) {
  const n = Math.max(0, Number(net) || 0);
  const owner = money(n * p.inferenceNetSplit.owner);
  return { owner, bond: money(n - owner) };
}
// The stake an offer's provider must keep free: a multiple of its inference
// revenue in the audit window, plus the call at hand.
export function inferenceReservation(windowRevenue, callCost, p) {
  return money((Math.max(0, Number(windowRevenue) || 0) + Math.max(0, Number(callCost) || 0)) * p.inference.bondMultiple);
}

// ---- slashing ----------------------------------------------------------
// A slash is priceUsdt * multiple, with the multiple capped per verdict and a
// rolling window cap over the full stake (an unstaking request included: it
// must never make a slash free).
export function slashPlan({ priceUsdt, multiple, stakeUsdt, slashedInWindowUsdt }, p) {
  const capMultiple = Math.min(Number(multiple) || 1, p.maxSlashMultiple);
  let amountUsdt = money(Math.max(0, Number(priceUsdt) || 0) * capMultiple);
  const rollingBudget = money((Math.max(0, Number(stakeUsdt) || 0)) * p.rollingSlashCap - (Number(slashedInWindowUsdt) || 0));
  const capped = amountUsdt > rollingBudget;
  if (capped) amountUsdt = money(Math.max(0, rollingBudget));
  return { amountUsdt, capped, cappedBy: capped ? 'rolling_window' : null };
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
