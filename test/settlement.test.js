import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerifier, verifyVerdictSig, mockChain, mockBondVault, slashDigest } from '../src/settlement.js';
import { snapshotParams } from '../src/launchpad-config.js';

test('verifier: signs verdicts that verify, and tampering fails', () => {
  const v = createVerifier();
  const verdict = { taskId: 'tsk_1', outcome: 'settled', amount: 0.021, slashBps: 0 };
  const sig = v.sign(verdict);
  assert.ok(verifyVerdictSig(verdict, sig, v.publicKeyPem));
  // any change to the verdict invalidates the signature
  assert.equal(verifyVerdictSig({ ...verdict, amount: 999 }, sig, v.publicKeyPem), false);
  assert.equal(verifyVerdictSig({ ...verdict, outcome: 'refunded' }, sig, v.publicKeyPem), false);
});

test('mock chain: escrow settles the provider and refunds surplus on a signed verdict', () => {
  const v = createVerifier();
  const chain = mockChain({ verifierPublicKeyPem: v.publicKeyPem });
  chain.depositEscrow('tsk_1', 'agent', 0.03, 'prov', 0.05); // budget 0.03, stake 0.05
  const price = 0.021;
  const sig = v.sign({ taskId: 'tsk_1', outcome: 'settled', amount: price, slashBps: 0 });
  const r = chain.settle('tsk_1', price, sig);
  assert.equal(r.paid, 0.021);
  assert.equal(r.surplus, 0.009);
  assert.equal(chain.balanceOf('prov'), 0.021);
  assert.equal(chain.balanceOf('agent'), 0.009, 'surplus refunded to the agent');
  assert.equal(chain.escrowState('tsk_1'), 'settled');
});

test('mock chain: failure refunds the agent in full and funds insurance from the slash', () => {
  const v = createVerifier();
  const chain = mockChain({ verifierPublicKeyPem: v.publicKeyPem });
  chain.depositEscrow('tsk_2', 'agent', 0.03, 'prov', 0.06);
  const sig = v.sign({ taskId: 'tsk_2', outcome: 'refunded', amount: 0.03, slashBps: 10000 });
  const r = chain.refundAndSlash('tsk_2', 10000, sig);
  assert.equal(r.refunded, 0.03);
  assert.equal(r.slashed, 0.06);
  assert.equal(chain.balanceOf('agent'), 0.03, 'agent made whole');
  assert.equal(chain.insuranceBalance(), 0.06, 'slash capitalized the pool');
});

test('mock chain: a forged verdict signature is rejected on-chain-style', () => {
  const real = createVerifier();
  const attacker = createVerifier();
  const chain = mockChain({ verifierPublicKeyPem: real.publicKeyPem });
  chain.depositEscrow('tsk_3', 'agent', 0.02, 'prov', 0.04);
  // attacker signs a settlement to themselves — different key, must be refused
  const forged = attacker.sign({ taskId: 'tsk_3', outcome: 'settled', amount: 0.02, slashBps: 0 });
  assert.throws(() => chain.settle('tsk_3', 0.02, forged), /invalid verifier signature/);
  assert.equal(chain.escrowState('tsk_3'), 'locked', 'escrow untouched');
});

// ---- AgentBondVault (launchpad on-chain risk layer) ----------------------

function signSlash(v, slashId, agentId, price, multiple) {
  return v.signDigest(slashDigest({ slashId, agentId, price, multipleBps: Math.round(multiple * 10000) }));
}

test('bond vault: harvest stakes bond, capacity = haircut / reservation multiple', () => {
  const v = createVerifier();
  const vault = mockBondVault({ verifierPublicKeyPem: v.publicKeyPem });
  vault.launch('agt_1', { twap_usdg: 1, pool_liquidity_usdg: 5000 });
  const s = vault.harvest('agt_1', 1000); // 500/300/150/50
  assert.deepEqual(s, { bond: 500, operating: 300, creator: 150, treasury: 50 });
  assert.equal(vault.bondOf('agt_1'), 500);     // $500 of token at $1
  assert.equal(vault.capacityUsdg('agt_1'), 125); // 500 * 0.5 / 2
  // a thin pool makes the bond worthless for capacity
  vault.setPrice('agt_1', { pool_liquidity_usdg: 10 });
  assert.equal(vault.capacityUsdg('agt_1'), 0);
});

test('bond vault: reservations cannot exceed haircut capacity', () => {
  const v = createVerifier();
  const vault = mockBondVault({ verifierPublicKeyPem: v.publicKeyPem });
  vault.launch('agt_2', { twap_usdg: 1, pool_liquidity_usdg: 5000 });
  vault.harvest('agt_2', 1000); // $500 bond → $250 haircut value
  vault.reserve('agt_2', 125);  // needs 200% = $250 → exactly fills it
  assert.throws(() => vault.reserve('agt_2', 0.01), /over capacity/);
  vault.release('agt_2', 125);
  vault.reserve('agt_2', 100);  // room again
});

test('bond vault: a slash is capped, delayed, and only moves value after the window', () => {
  const v = createVerifier();
  let clock = 1_000_000;
  const vault = mockBondVault({ verifierPublicKeyPem: v.publicKeyPem, now: () => clock });
  vault.launch('agt_3', { twap_usdg: 2, pool_liquidity_usdg: 5000 });
  vault.bond('agt_3', 1000); // raw $2,000
  const before = vault.bondOf('agt_3');

  // verifier asks for 5x on a $10 task → clamped to 2x = $20 = 10 tokens at $2
  const sig = signSlash(v, 'sl_1', 'agt_3', 10, 5);
  const q = vault.queueSlash('sl_1', 'agt_3', 10, 5, sig);
  assert.equal(q.amountUsdg, 20, 'clamped to maxSlashMultiple');
  assert.equal(q.tokenQty, 10);
  assert.equal(vault.bondOf('agt_3'), before, 'queued only — no value moved yet');
  assert.throws(() => vault.executeSlash('sl_1'), /too early/);

  clock += snapshotParams().pendingSlashMs + 1; // fast-forward past the delay
  const r = vault.executeSlash('sl_1');
  assert.equal(r.tokenQty, 10);
  assert.equal(vault.bondOf('agt_3'), before - 10, 'token burned out of the bond');
  assert.equal(vault.insuranceBalance(), 20, 'insurance capitalized in USDG');
});

test('bond vault: a forged slash signature is rejected', () => {
  const real = createVerifier();
  const attacker = createVerifier();
  const vault = mockBondVault({ verifierPublicKeyPem: real.publicKeyPem });
  vault.launch('agt_4', { twap_usdg: 1, pool_liquidity_usdg: 5000 });
  vault.bond('agt_4', 1000);
  const forged = signSlash(attacker, 'sl_x', 'agt_4', 10, 2);
  assert.throws(() => vault.queueSlash('sl_x', 'agt_4', 10, 2, forged), /invalid verifier signature/);
});

test('bond vault: the guardian pause freezes slash execution', () => {
  const v = createVerifier();
  let clock = 2_000_000;
  const vault = mockBondVault({ verifierPublicKeyPem: v.publicKeyPem, now: () => clock });
  vault.launch('agt_5', { twap_usdg: 1, pool_liquidity_usdg: 5000 });
  vault.bond('agt_5', 1000);
  vault.queueSlash('sl_2', 'agt_5', 10, 2, signSlash(v, 'sl_2', 'agt_5', 10, 2));
  clock += snapshotParams().pendingSlashMs + 1;
  vault.pause();
  assert.throws(() => vault.executeSlash('sl_2'), /paused/);
  vault.unpause();
  assert.equal(vault.executeSlash('sl_2').tokenQty, 20); // $20 at $1
});

test('bond vault: unbonding is withheld until the cooldown passes', () => {
  const v = createVerifier();
  let clock = 3_000_000;
  const vault = mockBondVault({ verifierPublicKeyPem: v.publicKeyPem, now: () => clock });
  vault.launch('agt_6', { twap_usdg: 1, pool_liquidity_usdg: 5000 });
  vault.bond('agt_6', 1000);
  const { ready } = vault.requestUnbond('agt_6', 300);
  assert.ok(ready > clock);
  // unbonding shrinks live capacity immediately: (1000-300)*0.5/2 = 175
  assert.equal(vault.capacityUsdg('agt_6'), 175);
  assert.throws(() => vault.withdrawUnbonded('agt_6'), /not ready/);
  clock = ready; // cooldown elapsed
  assert.equal(vault.withdrawUnbonded('agt_6').withdrawn, 300);
  assert.equal(vault.bondOf('agt_6'), 700);
});
