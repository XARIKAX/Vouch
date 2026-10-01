import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotParams, validateParams, LAUNCHPAD_DEFAULTS } from '../src/launchpad-config.js';
import {
  splitFees, bondCapacity, bondValue, reservationFor, canReserve,
  protocolFeeSplit, netPayoutSplit, slashPlan, trackWeight,
} from '../src/launchpad.js';

const P = snapshotParams();

test('params: every share group sums to 1 and is snapshotted immutable', () => {
  validateParams(P);
  assert.throws(() => Object.assign(P.feeSplit, { bond: 0.9 })); // frozen
  const snap = snapshotParams();
  assert.notEqual(snap, LAUNCHPAD_DEFAULTS); // a copy, not the live default
});

// --- the brief's worked example, as the end-to-end fixture ---------------
test('worked example: $100k volume at 1% → fee split 500/300/150/50', () => {
  const fees = Math.round(100000 * P.poolSwapFee * 1e6) / 1e6; // $1,000
  assert.equal(fees, 1000);
  const s = splitFees(fees, P);
  assert.deepEqual(s, { bond: 500, operating: 300, creator: 150, treasury: 50 });
  assert.equal(s.bond + s.operating + s.creator + s.treasury, fees); // sums exactly
});

test('worked example: $500 bond → $125 of open-quote capacity', () => {
  // bond staked = $500 of token value; haircut 50%; reserve 200% per quote.
  assert.equal(bondCapacity(500, P), 125);        // 500 * 0.5 / 2
});

test('worked example: $200 settled → fee $10 (5/5), net $190 → 152/19/19', () => {
  const fee = protocolFeeSplit(200, P);
  assert.equal(fee.fee, 10);
  assert.equal(fee.burn, 5);
  assert.equal(fee.treasury, 5);
  assert.equal(fee.net, 190);
  const net = netPayoutSplit(fee.net, P);
  assert.deepEqual(net, { owner: 152, buyback: 19, bond: 19 });
  assert.equal(net.owner + net.buyback + net.bond, fee.net); // sums exactly
});

// --- invariants from "Done means" ----------------------------------------
test('no reservation can exceed bond value after haircut', () => {
  // $500 raw bond → $250 haircut value → supports quotes whose 200% ≤ $250.
  assert.equal(reservationFor(125, P), 250);
  assert.ok(canReserve({ rawValueUsdg: 500, reservedHaircut: 0, quotedPrice: 125 }, P));
  assert.ok(!canReserve({ rawValueUsdg: 500, reservedHaircut: 0, quotedPrice: 125.01 }, P));
  // a filled bond rejects the next quote
  assert.ok(!canReserve({ rawValueUsdg: 500, reservedHaircut: 250, quotedPrice: 0.01 }, P));
});

test('token bond is worthless below the liquidity floor', () => {
  assert.equal(bondValue({ tokenQty: 1000, twapUsdg: 1, poolLiquidityUsdg: 10 }, P), 0);
  assert.equal(bondValue({ tokenQty: 1000, twapUsdg: 1, poolLiquidityUsdg: 5000 }, P), 1000);
});

test('no slash exceeds 200% of price, and the rolling cap bites', () => {
  // dispute slash at 2x on a $10 task = $20, within a healthy bond.
  const a = slashPlan({ priceUsdg: 10, multiple: 2, twapUsdg: 2, bondRawValueUsdg: 1000, slashedInWindowUsdg: 0 }, P);
  assert.equal(a.amountUsdg, 20);
  assert.equal(a.tokenQty, 10);          // $20 / $2 TWAP
  assert.ok(!a.capped);
  // a verifier asking for 5x is clamped to 2x
  const b = slashPlan({ priceUsdg: 10, multiple: 5, twapUsdg: 2, bondRawValueUsdg: 1000, slashedInWindowUsdg: 0 }, P);
  assert.equal(b.amountUsdg, 20);        // clamped to maxSlashMultiple
  // rolling cap: 20% of a $100 bond = $20/24h; already $15 used → only $5 left
  const c = slashPlan({ priceUsdg: 10, multiple: 2, twapUsdg: 1, bondRawValueUsdg: 100, slashedInWindowUsdg: 15 }, P);
  assert.equal(c.amountUsdg, 5);
  assert.equal(c.capped, true);
});

test('track weight: self-dealing scores 0, rubric-only reduced, hard checks full', () => {
  assert.equal(trackWeight({ sameOwner: true, validators: ['checks'] }), 0);
  assert.equal(trackWeight({ sameOwner: false, validators: ['rubric'] }), 0.3);
  assert.equal(trackWeight({ sameOwner: false, validators: ['checks', 'rubric'] }), 1.0);
  assert.equal(trackWeight({ sameOwner: false, validators: ['webhook'] }), 1.0);
});
