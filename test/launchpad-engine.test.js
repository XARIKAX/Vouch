import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEngine } from '../src/engine.js';
import { sleep } from '../src/util.js';

const FAST = { fast: true };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function fakeProvider(output) {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(output)); });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    url: `http://localhost:${server.address().port}/task`, close: () => server.close(),
  })));
}
async function waitTerminal(engine, id, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = engine.state.tasks[id];
    if (t && ['settled', 'refunded'].includes(t.status)) return t;
    await sleep(10);
  }
  throw new Error('task never settled');
}

test('launch with a stake: the stake comes out of the owner key, capacity is half of it, more stake and unstaking move it', () => {
  const engine = createEngine(FAST);
  const owner = engine.createKey('owner');
  engine.deposit(owner, 100);                                   // faucet 5 + 100
  assert.throws(() => engine.launchAgent({ stake: 500 }, owner), (e) => e.code === 'insufficient_balance');
  const a = engine.launchAgent({
    owner: '0xowner', name: 'calc', endpoint_url: 'http://x/task',
    offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } },
    stake: 100, compute: 5,
  }, owner);
  assert.equal(a.bond.stake_usdt, 100); assert.equal(a.bond.backing_usdt, 100);
  assert.equal(a.bond.capacity_usdt, 50);       // 100 / 2
  assert.equal(a.compute.balance, 5); assert.equal(a.operating_usdt, 5);
  assert.equal(engine.balance(owner).balance, 0, 'stake and compute came out of the owner key');
  // the linked provider's usable stake == capacity (reuses reservation machinery)
  assert.equal(engine.state.providers[a.provider_id].stake, 50);
  // more stake
  engine.deposit(owner, 50);
  const more = engine.addStake(a.id, 20, { key: owner });
  assert.equal(more.bond.stake_usdt, 120); assert.equal(more.bond.capacity_usdt, 60); assert.equal(more.totals.staked_in, 120);
  assert.equal(engine.balance(owner).balance, 30);
  assert.throws(() => engine.addStake(a.id, 1, { key: engine.createKey('x') }), (e) => e.code === 'not_owner');
  // fund compute from the owner key
  const fed = engine.fundCompute(a.id, 10, { key: owner });
  assert.equal(fed.compute.balance, 15); assert.equal(fed.compute.funded_total, 15);
  // unstake 40 → only 80 backs quotes → capacity 40
  const u = engine.requestUnbond(a.id, 40, { key: owner });
  assert.ok(u.unbonding.release_at > Date.now()); assert.equal(u.unbonding.usdt, 40);
  assert.equal(engine.getAgent(a.id).bond.capacity_usdt, 40);
  // without an owner key (seeds, tests) the stake is granted up to the sandbox cap
  const seeded = engine.launchAgent({ name: 'seed', stake: 5000 });
  assert.equal(seeded.bond.stake_usdt, 1000);
});

test('end-to-end: an agent settles verified work and routes its revenue to the owner key, the stake and the treasury', async () => {
  const good = await fakeProvider({ result: 42 });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {}; // isolate: only the agent quotes
    const owner = engine.createKey('owner', { owner: '0xowner' });
    engine.deposit(owner, 20);
    const a = engine.launchAgent({
      owner: '0xowner', name: 'calc-agent', endpoint_url: good.url,
      offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } },
      stake: 20, compute: 5,                                  // capacity 10, plenty for a $0.02 task; compute under the threshold
    }, owner);
    const ownerBefore = engine.balance(owner).balance;
    const buyer = engine.createKey('buyer');
    engine.deposit(buyer, 1);
    const { task } = engine.createTask(buyer, {
      capability: 'math.eval', input: { expression: '6 * 7' },
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
      budget: 0.03, deadline_ms: 5000,
    });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled');

    // revenue routed: price → fee 5% to the treasury, net → owner 90% (minus the
    // 10% compute top-up while the balance is under the threshold), stake 10%.
    const g = engine.getAgent(a.id);
    const price = done.settlement.price, net = price * 0.95;
    assert.ok(price <= 0.02);
    assert.ok(near(g.totals.treasury_paid, price * 0.05), 'the whole fee goes to the treasury');
    assert.ok(near(g.totals.bond_topped_up, net * 0.10), 'net stake share tops the stake up');
    assert.ok(near(g.bond.stake_usdt, 20 + net * 0.10));
    assert.ok(near(g.compute.topped_up_total, net * 0.10), 'compute topped up from the owner share');
    assert.ok(near(g.totals.owner_paid, net * 0.90 - net * 0.10), 'owner gets 90% of net less the top-up');
    assert.ok(near(engine.balance(owner).balance - ownerBefore, g.totals.owner_paid), 'and it lands in the owner key');
    assert.ok(!('buyback' in g.totals) && !('burned' in g.totals));
  } finally { good.close(); }
});

test('a bad outcome slashes the agent stake, capped, and funds insurance', async () => {
  const bad = await fakeProvider({ error: 'boom' }); // provider abandons → slash at 1.5x
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const a = engine.launchAgent({
      owner: '0xowner', name: 'calc', endpoint_url: bad.url,
      offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } },
      stake: 50,
    });
    const before = engine.getAgent(a.id);
    const insBefore = engine.state.insurance.funded;

    const buyer = engine.createKey('buyer');
    engine.deposit(buyer, 1);
    const { task } = engine.createTask(buyer, {
      capability: 'math.eval', input: { expression: '6 * 7' },
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
      budget: 0.03, deadline_ms: 5000, retry: false,
    });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');

    const after = engine.getAgent(a.id);
    const slashed = before.bond.stake_usdt - after.bond.stake_usdt;
    assert.ok(slashed > 0, 'the stake was slashed');
    assert.ok(near(slashed, after.totals.slashed_usdt));
    assert.ok(after.totals.slashed_usdt <= before.bond.stake_usdt * 0.2, 'within the rolling cap');
    assert.ok(engine.state.insurance.funded > insBefore, 'the slash capitalizes insurance');
    assert.ok(after.bond.capacity_usdt < before.bond.capacity_usdt, 'capacity reprices down');
  } finally { bad.close(); }
});

test('reputation is counterparty-weighted: self-dealing earns zero, a real buyer earns full', async () => {
  const good = await fakeProvider({ result: 42 });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const a = engine.launchAgent({
      owner: '0xowner', name: 'calc', endpoint_url: good.url,
      offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } },
      stake: 1000,
    });
    const providerTrack = () => engine.state.providers[engine.getAgent(a.id).provider_id].track;
    const settleOnce = async (buyer) => {
      engine.deposit(buyer, 1);
      const { task } = engine.createTask(buyer, {
        capability: 'math.eval', input: { expression: '6 * 7' },
        acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
        budget: 0.03, deadline_ms: 5000,
      });
      return waitTerminal(engine, task.id);
    };

    const t0 = providerTrack();
    // Self-dealing: same owner wallet on both sides → zero reputation.
    const self = engine.createKey('self', { owner: '0xowner' });
    const d1 = await settleOnce(self);
    assert.equal(d1.status, 'settled');
    assert.equal(providerTrack(), t0, 'self-dealing earns no track');
    assert.equal(engine.getAgent(a.id).totals.distinct_counterparties, 0);

    // A genuine third-party buyer with deterministic checks → full weight.
    const whale = engine.createKey('whale', { owner: '0xwhale' });
    const d2 = await settleOnce(whale);
    assert.equal(d2.status, 'settled');
    assert.ok(providerTrack() > t0, 'a real counterparty earns reputation');
    assert.equal(engine.getAgent(a.id).totals.distinct_counterparties, 1);
    assert.equal(engine.getAgent(a.id).totals.settled_count, 2, 'both settles counted');
  } finally { good.close(); }
});
