import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates, createUpstashStore } from '../src/store-upstash.js';
import { createEngine } from '../src/engine.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const acct = (balance, locked, history = []) => ({ balance, locked, lockedToday: locked, lockedDay: 1, history });

// Two serverless invocations load the same snapshot and both lock escrow on
// the same account. The second one to write must keep BOTH locks.
test('three-way merge: concurrent escrow locks on one account are both kept (no lost lock)', () => {
  const base = { accounts: { k: acct(5, 0) }, tasks: {}, keys: {} };
  // other invocation: locked 0.01 for task A
  const remote = clone(base);
  remote.accounts.k = acct(4.99, 0.01, [{ ts: 1, kind: 'lock', amount: 0.01, tx: 'a' }]);
  remote.tasks.A = { id: 'A', status: 'dispatched' };
  // this invocation: locked 0.02 for task B
  const local = clone(base);
  local.accounts.k = acct(4.98, 0.02, [{ ts: 2, kind: 'lock', amount: 0.02, tx: 'b' }]);
  local.tasks.B = { id: 'B', status: 'dispatched' };
  mergeStates(local, remote, base);
  assert.equal(local.accounts.k.balance, 4.97);
  assert.equal(local.accounts.k.locked, 0.03);
  assert.deepEqual(local.accounts.k.history.map((h) => h.tx), ['a', 'b'], 'both ledger entries, in time order');
  assert.ok(local.tasks.A && local.tasks.B);
});

// This invocation still holds an old copy of a task another invocation has
// since settled. Its unchanged copy must not revert the settlement, and the
// other invocation's unlock must not be undone.
test('three-way merge: an untouched record never reverts another invocation\'s write', () => {
  const base = { accounts: { k: acct(4.99, 0.01) }, tasks: { A: { id: 'A', status: 'dispatched' } }, keys: {} };
  const remote = clone(base);
  remote.tasks.A = { id: 'A', status: 'settled', settlement: { price: 0.01 } };
  remote.accounts.k = acct(4.99, 0);
  const local = clone(base);          // loaded A as dispatched, touched nothing about it
  local.tasks.B = { id: 'B', status: 'dispatched' };
  local.accounts.k = acct(4.98, 0.02); // locked 0.01 more for B
  mergeStates(local, remote, base);
  assert.equal(local.tasks.A.status, 'settled', 'remote settlement survives');
  assert.equal(local.accounts.k.locked, 0.01, 'remote unlock of A plus our lock of B');
  assert.equal(local.accounts.k.balance, 4.98);
});

// Both sides finished the same task (restart recovery on one instance, the real
// outcome on another). The first terminal state in the store wins.
test('three-way merge: a task finished elsewhere first stays as it was finished', () => {
  const base = { accounts: {}, tasks: { A: { id: 'A', status: 'dispatched' } }, keys: {} };
  const remote = clone(base); remote.tasks.A = { id: 'A', status: 'refunded', refund: { reason: 'platform_restart' } };
  const local = clone(base); local.tasks.A = { id: 'A', status: 'settled' };
  mergeStates(local, remote, base);
  assert.equal(local.tasks.A.status, 'refunded');
});

test('three-way merge: provider stake and pools merge by delta; counters never go negative', () => {
  const base = { accounts: {}, tasks: {}, keys: {}, providers: { p: { id: 'p', stake: 100, stakeReserved: 0.01, earnings: 0, track: 90, settledCount: 0, slashedCount: 0 } }, insurance: { balance: 1, funded: 1, claims: [] }, treasury: { balance: 0, burned: 0, buyback: 0 } };
  const remote = clone(base);
  remote.providers.p.stakeReserved = 0; remote.providers.p.earnings = 0.01; remote.providers.p.settledCount = 1; remote.providers.p.track = 90.2;
  remote.insurance.balance = 1.5; remote.insurance.funded = 1.5; remote.treasury.balance = 0.2;
  const local = clone(base);
  local.providers.p.stakeReserved = 0.03; local.providers.p.track = 89;
  local.insurance.balance = 0.4; local.insurance.claims = [{ ts: 5, task: 'X', amount: 0.6 }];
  mergeStates(local, remote, base);
  assert.equal(local.providers.p.stakeReserved, 0.02, 'remote released 0.01, we reserved 0.02 more');
  assert.equal(local.providers.p.earnings, 0.01);
  assert.equal(local.providers.p.settledCount, 1);
  assert.equal(local.providers.p.track, 89.2);
  assert.equal(local.insurance.balance, 0.9, 'remote funded +0.5, we paid a 0.6 claim');
  assert.equal(local.insurance.claims.length, 1);
  assert.equal(local.treasury.balance, 0.2);
  // a delta that would overshoot clamps at zero
  const b2 = { accounts: { k: acct(1, 0.01) }, tasks: {}, keys: {} };
  const r2 = clone(b2); r2.accounts.k.locked = 0;
  const l2 = clone(b2); l2.accounts.k.locked = 0;
  mergeStates(l2, r2, b2);
  assert.equal(l2.accounts.k.locked, 0);
});

// End to end through the store: the merge uses the snapshot each store loaded.
test('upstash store: a lost compare-and-set merges three-way against the loaded snapshot', async () => {
  const kv = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://fake.upstash.test')) return original(url, opts);
    const [name, ...args] = JSON.parse(String(opts.body));
    if (name === 'GET') return new Response(JSON.stringify({ result: kv.get(args[0]) ?? null }));
    if (name === 'EVAL') {
      const [, , stateKey, versionKey, expected, snapshot, next] = args;
      const cur = kv.get(versionKey);
      if ((cur === undefined && expected === '0') || cur === expected) { kv.set(stateKey, snapshot); kv.set(versionKey, next); return new Response(JSON.stringify({ result: 1 })); }
      return new Response(JSON.stringify({ result: 0 }));
    }
    return new Response(JSON.stringify({ error: 'unsupported' }), { status: 400 });
  };
  try {
    const seed = createUpstashStore({ url: 'https://fake.upstash.test', token: 't', key: 'vouch:m' });
    await seed.load();
    seed.save({ accounts: { k: acct(5, 0) }, tasks: {}, keys: {} }); await seed.flush();
    const a = createUpstashStore({ url: 'https://fake.upstash.test', token: 't', key: 'vouch:m' });
    const b = createUpstashStore({ url: 'https://fake.upstash.test', token: 't', key: 'vouch:m' });
    const sa = await a.load(); const sb = await b.load();
    sb.accounts.k.balance = 4.99; sb.accounts.k.locked = 0.01; sb.tasks.A = { id: 'A' }; b.save(sb); await b.flush();
    sa.accounts.k.balance = 4.98; sa.accounts.k.locked = 0.02; sa.tasks.B = { id: 'B' }; a.save(sa);
    const r = await a.flush();
    assert.equal(r.merged, true);
    const stored = JSON.parse(kv.get('vouch:m'));
    assert.equal(stored.accounts.k.locked, 0.03);
    assert.equal(stored.accounts.k.balance, 4.97);
    assert.ok(stored.tasks.A && stored.tasks.B);
  } finally { globalThis.fetch = original; }
});

test('boot repairs a negative escrow counter from an older snapshot', () => {
  let saved = null;
  const snapshot = {
    keys: { k1: { id: 'k1', tokenHash: 'x', name: 'n', tier: 'sandbox', createdAt: Date.now() } },
    accounts: { k1: { balance: 5, locked: -0.004558, lockedToday: 0, lockedDay: 1, history: [] } },
    providers: {}, tasks: {}, disputes: {},
  };
  const origWarn = console.warn; console.warn = () => {};
  try {
    const engine = createEngine({ fast: true, store: { load: () => snapshot, save: (s) => { saved = s; } } });
    assert.equal(engine.state.accounts.k1.locked, 0);
    assert.ok(saved, 'the repair is persisted');
  } finally { console.warn = origWarn; }
});
