// Second-audit items: recovery, consensus release, timers, launchpad risk
// (pending slashes, guardian, unbonding), sub-key edge cases, revenue reversal.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { createEngine } from '../src/engine.js';
import { sleep } from '../src/util.js';

const FAST = { fast: true };
const clone = (v) => JSON.parse(JSON.stringify(v));

async function waitTerminal(engine, taskId, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = engine.state.tasks[taskId];
    if (t && ['settled', 'refunded'].includes(t.status)) return t;
    await sleep(10);
  }
  throw new Error('task never reached a terminal state');
}
function fakeProvider(output, delayMs = 0) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(typeof output === 'function' ? output() : output)); }, delayMs));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}/task`, close: () => server.close() })));
}
function jsonServer(handler) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const out = await handler(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}/hook`, close: () => server.close() })));
}
function x402Hang() {
  const server = http.createServer((req, res) => { res.writeHead(402, { 'Content-Type': 'application/json' }); res.end('{"accepts":[{"scheme":"exact"}]}'); });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}/x`, close: () => server.close() })));
}
async function boot(cfg = {}) {
  const { server, engine } = createApp({ fast: true, ...cfg });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { server, engine, base, call };
}

// ---- boot recovery -------------------------------------------------------------
test('boot recovery: a dispute left reviewing is re-scheduled and resolved', async () => {
  let saved = null;
  const e1 = createEngine({ ...FAST, store: { load: () => null, save: (s) => { saved = s; } } });
  const key = e1.createKey('t');
  const { task } = e1.createTask(key, { capability: 'math.eval', input: { expression: '1+1' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 2 }] }, budget: 0.01, deadline_ms: 5000 });
  await waitTerminal(e1, task.id);
  const d = e1.openDispute(key, task.id, { reason: 'hmm' });
  const snapshot = clone(saved); // captured before the 50 ms review timer fires
  assert.equal(snapshot.disputes[d.id].status, 'reviewing');
  assert.equal(snapshot.tasks[task.id].status, 'disputed');

  const e2 = createEngine({ ...FAST, store: { load: () => snapshot, save: () => {} } });
  await e2.drain();
  assert.equal(e2.state.disputes[d.id].status, 'rejected');
  assert.equal(e2.state.tasks[task.id].status, 'settled');
  assert.equal(e2.state.providers[task.quote.provider].earnings, task.quote.price, 'clawed payment released on resolution');
});

test('boot recovery: a running workflow resumes; the step cut off by the restart is re-run', async () => {
  let saved = null;
  const e1 = createEngine({ ...FAST, store: { load: () => null, save: (s) => { saved = s; } } });
  const key = e1.createKey('t');
  e1.deposit(key, 1);
  const wf = e1.createWorkflow(key, {
    steps: [
      { capability: 'math.eval', input: { expression: '20 + 1' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 21 }] }, budget: 0.02, deadline_ms: 5000 },
      { capability: 'math.eval', input: { expression: '{{steps.0.output.result}} * 2' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 0.02, deadline_ms: 5000 },
    ],
  });
  // Wait until step 1 has been dispatched (step 0 settled), then snapshot mid-flight.
  for (let i = 0; i < 500; i++) {
    const w = e1.state.workflows[wf.id];
    if (w.steps.length === 2 && e1.state.tasks[w.steps[1].taskId]?.status === 'dispatched') break;
    await sleep(2);
  }
  const snapshot = clone(saved);
  assert.equal(snapshot.workflows[wf.id].status, 'running');
  assert.equal(snapshot.workflows[wf.id].steps.length, 2);

  const e2 = createEngine({ ...FAST, store: { load: () => snapshot, save: () => {} } });
  await e2.drain();
  const w = e2.state.workflows[wf.id];
  assert.equal(w.status, 'completed', JSON.stringify(w.failure ?? null));
  assert.equal(w.output.result, 42);
  assert.equal(w.resumed, 1);
  const cutOff = w.steps.find((s) => s.superseded);
  assert.ok(cutOff, 'the interrupted step is recorded');
  assert.equal(e2.state.tasks[cutOff.taskId].refund.reason, 'platform_restart');
  assert.equal(e2.state.tasks[cutOff.taskId].slash, null, 'no slash for the platform restart');
  const rerun = w.steps.filter((s) => s.index === 1 && !s.superseded);
  assert.equal(rerun.length, 1);
  assert.equal(e2.state.tasks[rerun[0].taskId].input.expression, '21 * 2', 'refs resolved from the surviving step');
  assert.equal(e2.getWorkflow(e2.authenticate(key.token), wf.id).spec, undefined, 'spec is internal');
});

test('boot recovery: an in-flight consensus task releases every reservation without a slash', () => {
  const snapshot = {
    keys: { k1: { id: 'k1', tokenHash: 'x', name: 'n', tier: 'sandbox', createdAt: Date.now() } },
    accounts: { k1: { balance: 0, locked: 0.05, lockedToday: 0.05, history: [] } },
    providers: {
      p1: { id: 'p1', offers: {}, stake: 10, stakeReserved: 0.01, earnings: 0, track: 50, settledCount: 0, slashedCount: 0 },
      p2: { id: 'p2', offers: {}, stake: 10, stakeReserved: 0.02, earnings: 0, track: 50, settledCount: 0, slashedCount: 0 },
    },
    tasks: {
      c: { id: 'c', keyId: 'k1', status: 'dispatched', createdAt: Date.now() - 1000, events: [], consensus: 2,
        escrow: { locked: 0.05 },
        quote: { provider: 'p1', price: 0.01, deadline_ms: 1000, stake_reserved: 0.01 },
        consensusQuotes: [{ provider: 'p1', price: 0.01, stake_reserved: 0.01 }, { provider: 'p2', price: 0.02, stake_reserved: 0.02 }] },
    },
    disputes: {},
  };
  const e = createEngine({ ...FAST, store: { load: () => snapshot, save: () => {} } });
  assert.equal(e.state.tasks.c.status, 'refunded');
  assert.equal(e.state.tasks.c.refund.reason, 'platform_restart');
  assert.equal(e.state.providers.p1.stakeReserved, 0);
  assert.equal(e.state.providers.p2.stakeReserved, 0);
  assert.equal(e.state.providers.p1.stake, 10);
  assert.equal(e.state.providers.p2.stake, 10);
  assert.equal(e.state.accounts.k1.balance, 0.05);
  assert.equal(e.state.accounts.k1.locked, 0);
});

// ---- timers --------------------------------------------------------------------
test('deadline timer: a provider that never answers is refunded as deadline_missed and slashed', async () => {
  const hang = await x402Hang();
  try {
    const engine = createEngine({ ...FAST, x402Payer: () => new Promise(() => {}) });
    engine.state.providers = {};
    const p = engine.registerProvider({ name: 'hang', protocol: 'x402', endpoint_url: hang.url, stake: 50, offers: { 'math.eval': { price_ceiling: 0.01, sla_deadline_ms: 300 } } });
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, { capability: 'math.eval', input: { expression: '1' }, budget: 0.02, deadline_ms: 400 });
    const done = await waitTerminal(engine, task.id, 3000);
    assert.equal(done.status, 'refunded');
    assert.equal(done.refund.reason, 'deadline_missed');
    assert.equal(engine.state.providers[p.id].slashedCount, 1);
    assert.equal(engine.state.providers[p.id].stakeReserved, 0);
    assert.equal(engine.balance(key).balance, engine.cfg.faucet);
  } finally { hang.close(); }
});

test('verification time never causes deadline_missed: the timer clears at submitted', async () => {
  const good = await fakeProvider({ result: 4 });
  const slowHook = await jsonServer(async () => { await sleep(900); return { pass: true }; });
  try {
    const engine = createEngine({ ...FAST, allowPrivateWebhooks: true });
    engine.state.providers = {};
    engine.registerProvider({ name: 'g', endpoint_url: good.url, stake: 50, offers: { 'math.eval': { price_ceiling: 0.01, sla_deadline_ms: 300 } } });
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, { capability: 'math.eval', input: { expression: '2+2' }, acceptance: { webhook: slowHook.url }, budget: 0.02, deadline_ms: 400 });
    const done = await waitTerminal(engine, task.id, 5000);
    assert.equal(done.status, 'settled', 'a 900 ms validator on a 300 ms quote still settles');
    assert.ok(done.settlement.verified_by.includes('webhook'));
  } finally { good.close(); slowHook.close(); }
});

// ---- criteria errors -------------------------------------------------------------
test('a check that cannot run is the buyer\'s fault: refund without a slash (criteria_error)', async () => {
  const good = await fakeProvider({ text: 'A perfectly good answer that is long enough for anything reasonable. '.repeat(3) }, 60);
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const p = engine.registerProvider({ name: 'g', endpoint_url: good.url, stake: 50, offers: { 'text.generate': { price_ceiling: 0.01, sla_deadline_ms: 3000 } } });
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, { capability: 'text.generate', input: { prompt: 'x' }, acceptance: { checks: [{ assert: 'contains_none', values: ['zzz'] }] }, budget: 0.02, deadline_ms: 3000 });
    // Corrupt the criteria after validation, before the provider answers (simulates a check that throws at run time).
    engine.state.tasks[task.id].acceptance.checks[0].values = 'not-an-array';
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');
    assert.equal(done.refund.reason, 'criteria_error');
    assert.equal(done.slash, null);
    assert.equal(engine.state.providers[p.id].slashedCount, 0);
    assert.equal(engine.state.providers[p.id].stake, 50);
    assert.equal(engine.state.providers[p.id].stakeReserved, 0);
    assert.equal(engine.balance(key).balance, engine.cfg.faucet);
  } finally { good.close(); }
});

// ---- launchpad risk: pending slash + guardian, slash base, unbond/withdraw --------
test('launchpad: a slash is queued behind the guardian; pause holds it, unpause executes it', async () => {
  const bad = await fakeProvider({ error: 'boom' });
  process.env.VOUCH_ADMIN_TOKEN = 'guardian-secret';
  const { server, engine, call } = await boot();
  try {
    const KEY = (await call('POST', '/v1/keys', { body: {} })).body.key;
    const launched = await call('POST', '/v1/agents', {
      key: KEY, body: { name: 'calc', owner: '0xo', twap_usdg: 1, pool_liquidity_usdg: 5000, endpoint_url: bad.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } } },
    });
    const id = launched.body.id;
    await call('POST', `/v1/agents/${id}/harvest`, { key: KEY, body: { fee_amount: 100 } }); // bond 50 tokens
    engine.state.providers = Object.fromEntries(Object.entries(engine.state.providers).filter(([pid]) => pid === launched.body.provider_id));

    assert.equal((await call('POST', '/v1/admin/guardian', { body: { paused: true } })).status, 403, 'admin token required');
    const paused = await call('POST', '/v1/admin/guardian', { headers: { 'X-Admin-Token': 'guardian-secret' }, body: { paused: true } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.paused, true);

    const bondBefore = (await call('GET', `/v1/agents/${id}`)).body.bond.token_qty;
    const insBefore = engine.state.insurance.funded;
    const t = await call('POST', '/v1/tasks', { key: KEY, body: { capability: 'math.eval', input: { expression: '1' }, budget: 0.03, deadline_ms: 5000 } });
    assert.equal(t.body.quote.provider, launched.body.provider_id);
    const done = await waitTerminal(engine, t.body.id);
    assert.equal(done.status, 'refunded');

    const held = (await call('GET', `/v1/agents/${id}`)).body;
    assert.equal(held.bond.token_qty, bondBefore, 'no token moved while paused');
    assert.ok(held.pending_slash_usdg > 0, 'slash is queued');
    assert.equal(held.pending_slashes[0].status, 'pending');
    assert.equal(engine.state.insurance.funded, insBefore, 'insurance not credited yet');
    assert.equal(engine.state.launchpad.pending_slashes.length, 1);
    const g = await call('GET', '/v1/admin/guardian', { headers: { 'X-Admin-Token': 'guardian-secret' } });
    assert.equal(g.body.pending_slashes, 1);

    const resumed = await call('POST', '/v1/admin/guardian', { headers: { 'X-Admin-Token': 'guardian-secret' }, body: { paused: false } });
    assert.equal(resumed.body.paused, false);
    const after = (await call('GET', `/v1/agents/${id}`)).body;
    assert.ok(after.bond.token_qty < bondBefore, 'token burned on unpause');
    assert.equal(after.pending_slash_usdg, 0);
    assert.ok(after.totals.slashed_usdg > 0);
    assert.ok(engine.state.insurance.funded > insBefore, 'insurance credited when funds moved');
    assert.equal(engine.state.launchpad.pending_slashes[0].status, 'executed');
    assert.equal((await call('POST', '/v1/admin/guardian', { headers: { 'X-Admin-Token': 'guardian-secret' }, body: { paused: 'yes' } })).status, 400);
  } finally { server.close(); bad.close(); delete process.env.VOUCH_ADMIN_TOKEN; }
});

test('launchpad: unbonding everything (or a thin pool) does not make a slash free', async () => {
  const bad = await fakeProvider({ error: 'boom' }, 40);
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const a = engine.launchAgent({ owner: '0xo', name: 'calc', endpoint_url: bad.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, twap_usdg: 1, pool_liquidity_usdg: 5000 });
    engine.harvestFees(a.id, 100); // 50 tokens
    const buyer = engine.createKey('b');
    const { task } = engine.createTask(buyer, { capability: 'math.eval', input: { expression: '1' }, budget: 0.03, deadline_ms: 5000 });
    // While the task is in flight the owner tries to pull the whole bond and the pool drains.
    engine.requestUnbond(a.id, 50);
    engine.setAgentPrice(a.id, { pool_liquidity_usdg: 0 });
    assert.equal(engine.getAgent(a.id).bond.capacity_usdg, 0);
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');
    const g = engine.getAgent(a.id);
    assert.ok(g.totals.slashed_usdg > 0, 'slash sized off the full bond at TWAP');
    assert.ok(g.bond.token_qty < 50);
    assert.ok(g.unbonding.token_qty <= g.bond.token_qty, 'the slash ate into the unbonding request');
  } finally { bad.close(); }
});

test('launchpad: a second unbond request adds to the first; withdraw works only after the cooldown (fast mode shortens it)', async () => {
  const engine = createEngine(FAST);
  const a = engine.launchAgent({ owner: '0xo', twap_usdg: 1, pool_liquidity_usdg: 5000, initial_bond_tokens: 100 });
  engine.requestUnbond(a.id, 10);
  const u = engine.requestUnbond(a.id, 20);
  assert.equal(u.unbonding.token_qty, 30);
  assert.throws(() => engine.withdrawUnbonded(a.id), (e) => e.code === 'unbond_cooldown');
  await sleep(150);
  const w = engine.withdrawUnbonded(a.id);
  assert.equal(w.withdrawn_token_qty, 30);
  assert.equal(w.bond.token_qty, 70);
  assert.equal(w.unbonding, null);
  assert.throws(() => engine.withdrawUnbonded(a.id), (e) => e.code === 'nothing_unbonding');
  // TWAP 0 harvest is rejected rather than silently losing the bond share.
  engine.setAgentPrice(a.id, { twap_usdg: 0 });
  assert.throws(() => engine.harvestFees(a.id, 10), (e) => e.status === 400);
  // Owner-only over the engine when an actor is supplied.
  const other = engine.createKey('other');
  assert.throws(() => engine.requestUnbond(a.id, 1, { key: other, admin: false }), (e) => e.code === 'not_owner');
});

test('launchpad: a launch with an invalid endpoint leaves no orphan account', () => {
  const engine = createEngine(FAST);
  const before = Object.keys(engine.state.accounts).length;
  assert.throws(() => engine.launchAgent({ endpoint_url: 'ftp://nope', offers: { 'math.eval': { price_ceiling: 0.01, sla_deadline_ms: 100 } } }), (e) => e.code === 'invalid_input');
  assert.equal(Object.keys(engine.state.accounts).length, before);
  assert.equal(Object.keys(engine.state.agents).length, 0);
});

// ---- upheld dispute on a launched agent reverses routed revenue ------------------
test('an upheld dispute against a launched agent reverses owner/buyback/bond/burn/treasury for that task', async () => {
  const good = await fakeProvider({ result: 42 });
  const hook = await jsonServer((body) => ({ pass: !body.context }));
  try {
    const engine = createEngine({ ...FAST, allowPrivateWebhooks: true });
    engine.state.providers = {};
    const a = engine.launchAgent({ owner: '0xo', name: 'calc', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, twap_usdg: 1, pool_liquidity_usdg: 5000 });
    engine.harvestFees(a.id, 1000);
    const treasuryBefore = clone(engine.state.treasury);
    const totalsBefore = engine.getAgent(a.id).totals;
    const bondBefore = engine.getAgent(a.id).bond.token_qty;
    const buyer = engine.createKey('b', { owner: '0xbuyer' });
    engine.deposit(buyer, 1);
    const { task } = engine.createTask(buyer, { capability: 'math.eval', input: { expression: '6*7' }, acceptance: { webhook: hook.url }, budget: 0.03, deadline_ms: 5000 });
    assert.equal((await waitTerminal(engine, task.id)).status, 'settled');
    assert.ok(engine.getAgent(a.id).totals.owner_paid > totalsBefore.owner_paid);
    assert.ok(engine.getAgent(a.id).bond.token_qty > bondBefore, 'bond topped up by net share');

    const d = engine.openDispute(buyer, task.id, { reason: 'wrong' });
    await engine.drain();
    assert.equal(engine.getDispute(buyer, d.id).status, 'upheld');
    const totals = engine.getAgent(a.id).totals;
    assert.equal(totals.owner_paid, totalsBefore.owner_paid);
    assert.equal(totals.buyback, totalsBefore.buyback);
    assert.equal(totals.bond_topped_up, totalsBefore.bond_topped_up);
    assert.equal(totals.burned, totalsBefore.burned);
    assert.equal(totals.treasury_paid, totalsBefore.treasury_paid);
    assert.equal(engine.state.treasury.balance, treasuryBefore.balance);
    assert.equal(engine.state.treasury.burned, treasuryBefore.burned);
    assert.equal(engine.state.treasury.buyback, treasuryBefore.buyback);
    assert.ok(totals.slashed_usdg > 0, 'and the bond was slashed for the bad outcome');
    assert.ok(engine.state.agents[a.id].ledger.some((e) => e.kind === 'revenue_reversed' && e.taskId === task.id));
  } finally { good.close(); hook.close(); }
});

// ---- sub-key edge cases ------------------------------------------------------------
test('sub-keys: a revoked account\'s later refund credits the parent; a revoked key cannot act inside a workflow', async () => {
  try {
    const engine = createEngine(FAST);
    const parent = engine.createKey('p');
    engine.deposit(parent, 3);
    const sub = engine.createSubKey(parent, { fund: 1 });
    const subKey = engine.authenticate(sub.key);
    // A 6 s deadline selects the seeded unreliable node: this task will refund.
    const { task } = engine.createTask(subKey, { capability: 'text.generate', input: { prompt: 'x' }, acceptance: { checks: [{ assert: 'length_between', min: 120 }] }, budget: 0.03, deadline_ms: 6000 });
    assert.equal(task.quote.provider, 'prv_shade');
    const parentAfterRevoke = engine.revokeSubKey(parent, sub.id);
    const pBal = engine.balance(parent).balance;
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');
    assert.equal(engine.state.accounts[sub.id].balance, 0, 'revoked account holds nothing');
    assert.equal(engine.balance(parent).balance, pBal + task.quote.price, 'escrow refund landed on the parent');
    assert.ok(engine.state.accounts[parent.id].history.some((h) => h.kind === 'refund' && h.from_sub === sub.id));
    assert.ok(parentAfterRevoke.refunded > 0);

    // A workflow created by a sub-key that is revoked mid-way fails at the next step with account_revoked.
    const sub2 = engine.createSubKey(parent, { fund: 1 });
    const k2 = engine.authenticate(sub2.key);
    const wf = engine.createWorkflow(k2, { steps: [
      { capability: 'math.eval', input: { expression: '1+1' }, budget: 0.01, deadline_ms: 5000 },
      { capability: 'math.eval', input: { expression: '2+2' }, budget: 0.01, deadline_ms: 5000 },
    ] });
    engine.revokeSubKey(parent, sub2.id);
    await engine.drain();
    const w = engine.state.workflows[wf.id];
    assert.equal(w.status, 'failed');
    assert.equal(w.failure.code, 'account_revoked');
  } finally { /* seed providers only */ }
});

test('retry: { max_attempts: 1 } means a single attempt', async () => {
  const junk = await fakeProvider({ text: '### ERROR ###' });
  const good = await fakeProvider({ text: 'A thorough, on-topic answer. '.repeat(8) });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    engine.registerProvider({ name: 'junk', endpoint_url: junk.url, stake: 60, offers: { 'text.generate': { price_ceiling: 0.008, sla_deadline_ms: 8000 } } });
    engine.registerProvider({ name: 'good', endpoint_url: good.url, stake: 60, offers: { 'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 8000 } } });
    const key = engine.createKey('t');
    engine.deposit(key, 1);
    const { task } = engine.createTask(key, { capability: 'text.generate', input: { prompt: 'x' }, acceptance: { checks: [{ assert: 'length_between', min: 120 }] }, budget: 0.03, deadline_ms: 8000, retry: { max_attempts: 1 } });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');
    assert.equal(done.attempts.length, 1);
    assert.equal(engine.state.accounts[key.id].lockedToday, 0, 'refund releases the day counter');
  } finally { junk.close(); good.close(); }
});

test('settlement surplus does not count against the daily ceiling', async () => {
  const good = await fakeProvider({ result: 4 });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    engine.registerProvider({ name: 'g', endpoint_url: good.url, stake: 60, offers: { 'math.eval': { price_ceiling: 0.01, sla_deadline_ms: 5000 } } });
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, { capability: 'math.eval', input: { expression: '2+2' }, budget: 0.05, deadline_ms: 5000, retry: true });
    assert.equal(engine.state.accounts[key.id].lockedToday, 0.05, 'retry locks the full budget');
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled');
    assert.equal(engine.state.accounts[key.id].lockedToday, done.settlement.price, 'only the spent price counts');
    assert.ok(engine.state.accounts[key.id].history.some((h) => h.kind === 'surplus'));
  } finally { good.close(); }
});

test('rubric-only (and schema-only) settlements earn a launched agent reduced reputation', async () => {
  const good = await fakeProvider({ result: 42 });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const a = engine.launchAgent({ owner: '0xo', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, twap_usdg: 1, pool_liquidity_usdg: 5000 });
    engine.harvestFees(a.id, 1000);
    const pid = engine.getAgent(a.id).provider_id;
    const buyer = engine.createKey('b', { owner: '0xb' });
    const t0 = engine.state.providers[pid].track;
    const { task } = engine.createTask(buyer, { capability: 'math.eval', input: { expression: '6*7' }, budget: 0.03, deadline_ms: 5000 }); // schema only
    await waitTerminal(engine, task.id);
    const gained = engine.state.providers[pid].track - t0;
    assert.ok(gained > 0 && Math.abs(gained - 0.06) < 1e-9, `schema-only earns 0.3 weight (got ${gained})`);
  } finally { good.close(); }
});
