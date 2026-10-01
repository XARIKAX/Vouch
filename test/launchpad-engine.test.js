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

test('launch + harvest: fees split, bond capacity, unbond and price-drop shrink it', () => {
  const engine = createEngine(FAST);
  const a = engine.launchAgent({
    owner: '0xowner', endpoint_url: 'http://x/task',
    offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } },
    twap_usdg: 1, pool_liquidity_usdg: 5000,
  });
  // harvest $1,000 → 500/300/150/50 (the worked example)
  const h = engine.harvestFees(a.id, 1000);
  assert.deepEqual(h.split, { bond: 500, operating: 300, creator: 150, treasury: 50 });
  const g = engine.getAgent(a.id);
  assert.equal(g.bond.token_qty, 500);          // $500 at $1 TWAP
  assert.equal(g.bond.capacity_usdg, 125);      // 500 * 0.5 / 2
  assert.equal(g.operating_usdg, 300);          // spend-only USDG
  assert.equal(g.totals.creator_paid, 150);
  assert.equal(engine.state.treasury.balance, 50);
  // the linked provider's usable stake == capacity (reuses reservation machinery)
  assert.equal(engine.state.providers[g.provider_id].stake, 125);

  // price halves → capacity halves, no liquidation
  const d = engine.setAgentPrice(a.id, { twap_usdg: 0.5 });
  assert.equal(d.bond.capacity_usdg, 62.5);

  // below the liquidity floor → zero capacity
  assert.equal(engine.setAgentPrice(a.id, { pool_liquidity_usdg: 10 }).bond.capacity_usdg, 0);
  engine.setAgentPrice(a.id, { pool_liquidity_usdg: 5000, twap_usdg: 1 }); // restore

  // unbond 300 tokens → only 200 remain backing quotes → capacity 200*0.5/2 = 50
  const u = engine.requestUnbond(a.id, 300);
  assert.ok(u.unbonding.release_at > Date.now());
  assert.equal(engine.getAgent(a.id).bond.capacity_usdg, 50);
});

test('end-to-end: a launched agent settles verified work and routes its revenue', async () => {
  const good = await fakeProvider({ result: 42 });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {}; // isolate: only the launched agent quotes
    const a = engine.launchAgent({
      owner: '0xowner', name: 'calc-agent', endpoint_url: good.url,
      offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } },
      twap_usdg: 1, pool_liquidity_usdg: 5000,
    });
    engine.harvestFees(a.id, 100); // bond 50 tokens → capacity 12.5, plenty for a $0.02 task

    const buyer = engine.createKey('buyer');
    engine.deposit(buyer, 1);
    const { task } = engine.createTask(buyer, {
      capability: 'math.eval', input: { expression: '6 * 7' },
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
      budget: 0.03, deadline_ms: 5000,
    });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled');

    // revenue routed: price 0.02 → fee 0.001 (burn/treasury 0.0005 each),
    // net 0.019 → owner 0.0152, buyback 0.0019, bond top-up 0.0019.
    const g = engine.getAgent(a.id);
    const price = done.settlement.price;
    assert.ok(price <= 0.02);
    assert.ok(near(g.totals.owner_paid, price * 0.95 * 0.80), 'owner gets 80% of net');
    assert.ok(near(g.totals.buyback, price * 0.95 * 0.10), 'buyback 10% of net');
    assert.ok(near(g.totals.burned, price * 0.05 * 0.50), 'burn = half the protocol fee');
    assert.ok(g.totals.bond_topped_up > 0, 'net bond share tops the bond up');
  } finally { good.close(); }
});
