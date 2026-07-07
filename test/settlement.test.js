import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerifier, verifyVerdictSig, mockChain } from '../src/settlement.js';

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
