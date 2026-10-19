import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotParams, validateParams, LAUNCHPAD_DEFAULTS } from '../src/launchpad-config.js';
import {
  bondCapacity, haircutValue, reservationFor, canReserve,
  protocolFeeSplit, netPayoutSplit, topUpFromRevenue, inferenceFeeSplit, inferenceNetSplit, slashPlan, trackWeight,
} from '../src/launchpad.js';

const P = snapshotParams();

test('params: every share group sums to 1 and is snapshotted immutable', () => {
  validateParams(P);
  assert.throws(() => Object.assign(P.netSplit, { owner: 0.9 })); // frozen
  const snap = snapshotParams();
  assert.notEqual(snap, LAUNCHPAD_DEFAULTS); // a copy, not the live default
  assert.throws(() => snapshotParams({ netSplit: { owner: 0.5, bond: 0.1 } }), /sum to 1/);
  assert.throws(() => snapshotParams({ topUp: { share: 0.5, shareCap: 0.3, threshold: 20 } }), /topUp\.share/);
});

// --- the worked examples, as the end-to-end fixture ---------------------
test('worked example: $500 staked → $250 of open-quote capacity; the stake counts at face value', () => {
  assert.equal(haircutValue(500, P), 500);
  assert.equal(bondCapacity(500, P), 250);        // 500 / 2
});

test('worked example: $200 settled → fee $10 to the treasury, net $190 → 171 / 19, top-up 19 out of the owner share', () => {
  const fee = protocolFeeSplit(200, P);
  assert.equal(fee.fee, 10);
  assert.equal(fee.burn, 0);
  assert.equal(fee.treasury, 10);
  assert.equal(fee.net, 190);
  const net = netPayoutSplit(fee.net, P);
  assert.deepEqual(net, { owner: 171, bond: 19 });
  assert.equal(net.owner + net.bond, fee.net); // sums exactly
  const tu = topUpFromRevenue({ net: fee.net, ownerShare: net.owner, balance: 5 }, P.topUp);
  assert.deepEqual(tu, { topUp: 19, owner: 152 });
  assert.deepEqual(topUpFromRevenue({ net: 190, ownerShare: 171, balance: 25 }, P.topUp), { topUp: 0, owner: 171 }, 'over the threshold nothing moves');
});

test('worked example: $10 of inference → fee $0.30 to the treasury, net $9.70 → 9.506 / 0.194 for an agent seller', () => {
  const f = inferenceFeeSplit(10, P);
  assert.deepEqual(f, { price: 10, fee: 0.3, burn: 0, treasury: 0.3, net: 9.7 });
  assert.deepEqual(inferenceNetSplit(f.net, P), { owner: 9.506, bond: 0.194 });
});

// --- invariants ----------------------------------------------------------
test('no reservation can exceed the stake', () => {
  // $500 staked → supports quotes whose 200% ≤ $500.
  assert.equal(reservationFor(250, P), 500);
  assert.ok(canReserve({ stakeUsdt: 500, reserved: 0, quotedPrice: 250 }, P));
  assert.ok(!canReserve({ stakeUsdt: 500, reserved: 0, quotedPrice: 250.01 }, P));
  // a filled stake rejects the next quote
  assert.ok(!canReserve({ stakeUsdt: 500, reserved: 500, quotedPrice: 0.01 }, P));
});

test('no slash exceeds 200% of price, and the rolling cap bites', () => {
  // dispute slash at 2x on a $10 task = $20, within a healthy stake.
  const a = slashPlan({ priceUsdt: 10, multiple: 2, stakeUsdt: 1000, slashedInWindowUsdt: 0 }, P);
  assert.equal(a.amountUsdt, 20);
  assert.ok(!a.capped);
  // a verifier asking for 5x is clamped to 2x
  const b = slashPlan({ priceUsdt: 10, multiple: 5, stakeUsdt: 1000, slashedInWindowUsdt: 0 }, P);
  assert.equal(b.amountUsdt, 20);        // clamped to maxSlashMultiple
  // rolling cap: 20% of a $100 stake = $20/24h; already $15 used → only $5 left
  const c = slashPlan({ priceUsdt: 10, multiple: 2, stakeUsdt: 100, slashedInWindowUsdt: 15 }, P);
  assert.equal(c.amountUsdt, 5);
  assert.equal(c.capped, true);
});

test('track weight: self-dealing scores 0, rubric-only reduced, hard checks full', () => {
  assert.equal(trackWeight({ sameOwner: true, validators: ['checks'] }), 0);
  assert.equal(trackWeight({ sameOwner: false, validators: ['rubric'] }), 0.3);
  assert.equal(trackWeight({ sameOwner: false, validators: ['checks', 'rubric'] }), 1.0);
  assert.equal(trackWeight({ sameOwner: false, validators: ['webhook'] }), 1.0);
});
