// Vouch Credit, Phase 1: the score mirror, the engine's credit record, the
// min_credit filter, the read endpoints, MCP tools and the vector file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createApp } from '../server.js';
import { createEngine } from '../src/engine.js';
import { sleep } from '../src/util.js';
import * as S from '../src/credit/score.js';
import { creditConfig, readDeployment, linkMessage } from '../src/credit/chain.js';
import { generate, VECTORS_PATH } from '../scripts/credit-vectors.js';

const FAST = { fast: true, allowPrivateWebhooks: true };
const USDG = S.USDG, DAY = S.DAY, T0 = 1_800_000_000n;

function fakeProvider(output) {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(output)); });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}/task`, close: () => server.close() })));
}
async function waitTerminal(engine, taskId, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = engine.state.tasks[taskId];
    if (t && ['settled', 'refunded'].includes(t.status)) return t;
    await sleep(10);
  }
  throw new Error('task never settled');
}
const mathTask = (budget = 0.03) => ({ capability: 'math.eval', input: { expression: '6 * 7' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget, deadline_ms: 5000, retry: false });

// ---- the score mirror: the same worked examples as contracts/test/ScoreLib.t.sol ----

test('score: a fresh record is 0; verified work earns up to 450 and decays by half every 30 days', () => {
  const r = S.emptyReport();
  assert.equal(S.score(r, T0), 0n);
  for (let i = 0; i < 50; i++) S.addSettlement(r, 20n * USDG, T0);
  assert.equal(S.score(r, T0), 450n);
  assert.equal(S.score(r, T0 + 30n * DAY), 325n);
  assert.equal(S.score(r, T0 + 36500n * DAY), 200n);
});

test('score: repayments and advances add, defaults crater and decay, a recovery removes half', () => {
  const r = S.emptyReport();
  S.addRepayment(r, 100n * USDG, 10, true); assert.equal(S.score(r, T0), 120n);
  S.addRepayment(r, 50n * USDG, 4, false); assert.equal(S.score(r, T0), 148n);
  S.addAdvanceRepayment(r, 80n * USDG); assert.equal(S.score(r, T0), 153n);
  const d = S.emptyReport();
  for (let i = 0; i < 50; i++) S.addSettlement(d, 20n * USDG, T0);
  S.addRepayment(d, 200n * USDG, 20, true);
  assert.equal(S.score(d, T0), 850n);
  S.addDefault(d, 100n * USDG, T0); assert.equal(S.score(d, T0), 430n);
  assert.equal(S.score(d, T0 + 180n * DAY), 603n - 210n);
  S.addRecovery(d, 100n * USDG, T0 + 180n * DAY); assert.equal(S.score(d, T0 + 180n * DAY), 603n);
  assert.deepEqual(S.breakdown(d, T0 + 180n * DAY).points, { work: 203, repayment: 400, advances: 0, slashes: 0, disputes: 0, defaults: 0 });
});

test('score: pricing tiers, fees and the credit line', () => {
  assert.deepEqual([0, 299, 300, 549, 550, 799, 800, 1000].map(S.tier), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual([0, 300, 600, 900].map((s) => S.feeBps30d(s)), [0n, 300n, 200n, 100n]);
  assert.equal(S.creditLine(300, 0n, 1000n * USDG), 25n * USDG);
  assert.equal(S.creditLine(850, 600n * USDG, 1000n * USDG), 300n * USDG);
  assert.equal(S.creditLine(850, 5000n * USDG, 1000n * USDG), 1000n * USDG);
});

test('score: the committed parity vectors are what this implementation generates', () => {
  assert.equal(fs.readFileSync(VECTORS_PATH, 'utf8'), generate(), 'run `npm run credit:vectors` and re-run the Foundry suite');
});

// ---- the engine's credit record --------------------------------------------------------

test('record: a settled task is a credit event, a failed one a slash, an upheld dispute a dispute loss (not a second slash)', async () => {
  const good = await fakeProvider({ result: 42 });
  const bad = await fakeProvider({ error: 'boom' });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const buyer = engine.createKey('buyer');
    engine.deposit(buyer, 5);
    const p1 = engine.registerProvider({ name: 'good', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, stake: 10 });
    const t1 = await waitTerminal(engine, engine.createTask(buyer, mathTask()).task.id);
    assert.equal(t1.status, 'settled');
    let rep = await engine.creditReport(p1.id);
    assert.equal(rep.inputs.settled_count, 1);
    assert.equal(rep.inputs.settled_volume_usd, t1.settlement.price);
    assert.equal(rep.events[0].kind, 'settlement'); assert.equal(rep.events[0].ref, t1.id);
    assert.equal(rep.score, 4, '4 points per settlement, the cents of volume round to nothing');
    assert.equal(engine.creditScore(p1.id).score, 4);

    // slash: the bad provider abandons → refund + slash
    delete engine.state.providers[p1.id];
    const p2 = engine.registerProvider({ name: 'bad', endpoint_url: bad.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, stake: 10 });
    const t2 = await waitTerminal(engine, engine.createTask(buyer, mathTask()).task.id);
    assert.equal(t2.status, 'refunded');
    rep = await engine.creditReport(p2.id);
    assert.equal(rep.inputs.slash_count, 1); assert.equal(rep.events.at(-1).kind, 'slash'); assert.equal(rep.events.at(-1).task_id, t2.id);
    assert.equal(rep.score, 0);

    // dispute upheld: the provider "settled" then loses the dispute
    engine.state.providers = {};
    const p3 = engine.registerProvider({ name: 'liar', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, stake: 10 });
    const t3 = await waitTerminal(engine, engine.createTask(buyer, { ...mathTask(), acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] } }).task.id);
    assert.equal(t3.status, 'settled');
    engine.state.tasks[t3.id].output = { result: 41 }; // the output a re-check will now fail
    const d = engine.openDispute(buyer, t3.id, { reason: 'wrong answer' });
    await engine.drain();
    assert.equal(engine.getDispute(buyer, d.id).status, 'upheld');
    rep = await engine.creditReport(p3.id);
    assert.equal(rep.inputs.dispute_loss_count, 1);
    assert.equal(rep.inputs.slash_count, 0, 'the dispute slash is not also a slash event');
    assert.equal(rep.events.at(-1).kind, 'dispute_loss'); assert.equal(rep.events.at(-1).ref, d.id);
  } finally { good.close(); bad.close(); }
});

test('record: a launched agent resolves to its provider, and scores carry into quotes and min_credit', async () => {
  const good = await fakeProvider({ result: 42 });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const buyer = engine.createKey('buyer');
    engine.deposit(buyer, 5);
    const a = engine.launchAgent({ name: 'calc', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, stake: 50 });
    assert.equal(engine.creditScore(a.id).subject, a.provider_id);
    // nobody has credit yet: a min_credit task finds no quote and says why
    assert.throws(() => engine.createTask(buyer, { ...mathTask(), min_credit: 1 }), (e) => e.code === 'no_quotes' && e.extra.nearest_miss.violated === 'min_credit' && e.extra.nearest_miss.credit === 0);
    assert.throws(() => engine.createTask(buyer, { ...mathTask(), min_credit: 1001 }), (e) => e.code === 'invalid_input');
    const t = await waitTerminal(engine, engine.createTask(buyer, mathTask()).task.id);
    assert.equal(t.status, 'settled');
    assert.equal(engine.creditScore(a.id).score, 4);
    const ok = engine.createTask(buyer, { ...mathTask(), min_credit: 4 });
    assert.equal(ok.task.min_credit, 4);
    assert.equal(ok.task.quote.credit, 4, 'the committed quote carries the score');
    await waitTerminal(engine, ok.task.id);
    assert.equal(engine.creditScore(a.id).score, 8);
    assert.equal(engine.creditLine(a.id).credit_line_usd, 0, 'below tier 1 there is no line');
  } finally { good.close(); }
});

test('identity: linking an ERC-8004 agentId is owner-only, unique, unverified without a chain, and queues past events', async () => {
  const engine = createEngine(FAST);
  engine.state.providers = {};
  const owner = engine.createKey('owner');
  const p = engine.registerProvider({ name: 'p', endpoint_url: 'http://localhost:1/task', offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } } }, owner);
  engine.credit.record('settlement', p.id, 'tsk_1', 10);
  await assert.rejects(engine.linkIdentity(p.id, { agent_id: '7' }, { key: engine.createKey('x') }), (e) => e.code === 'not_owner');
  await assert.rejects(engine.linkIdentity(p.id, { agent_id: 'abc' }, { key: owner }), (e) => e.code === 'invalid_input');
  const linked = await engine.linkIdentity(p.id, { agent_id: '7' }, { key: owner });
  assert.equal(linked.agent_id, '7'); assert.equal(linked.verified, false); assert.equal(linked.outbox.pending, 1, 'the earlier settlement waits for a chain');
  assert.equal(engine.creditScore('7').subject, p.id, 'a numeric id resolves through the link');
  const other = engine.registerProvider({ name: 'q', endpoint_url: 'http://localhost:1/task', offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } } }, owner);
  await assert.rejects(engine.linkIdentity(other.id, { agent_id: '7' }, { key: owner }), (e) => e.code === 'identity_taken');
  const flushed = await engine.credit.flush();
  assert.equal(flushed.posted, 0); assert.match(flushed.reason, /VOUCH_CREDIT_CHAIN_ID/);
  assert.equal(linkMessage(p.id, '7'), `vouch-credit-identity|${p.id}|7`);
});

test('chain config: off without a chain id, refused without a deployment record, and the Robinhood Chain record carries the external addresses only', () => {
  assert.equal(creditConfig({}).enabled, false);
  const none = creditConfig({ VOUCH_CREDIT_CHAIN_ID: '999999' });
  assert.equal(none.enabled, false); assert.match(none.reason, /no deployment record/);
  const rh = creditConfig({ VOUCH_CREDIT_CHAIN_ID: '4663' });
  assert.equal(rh.enabled, false); assert.match(rh.reason, /no creditRegistry deployed/);
  assert.equal(rh.rpc, 'https://rpc.mainnet.chain.robinhood.com');
  const rec = readDeployment(4663);
  assert.equal(rec.identityRegistry, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
  assert.equal(rec.usdg, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
  assert.equal(rec.creditRegistry, null);
});

test('phase 2 without a chain: borrowing, repaying and payouts are refused with a reason; reads say the pool is off', async () => {
  const engine = createEngine(FAST);
  engine.state.providers = {};
  const owner = engine.createKey('owner');
  const p = engine.registerProvider({ name: 'p', endpoint_url: 'http://localhost:1/task', offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } } }, owner);
  engine.credit.record('settlement', p.id, 'tsk_1', 20, { payout_at: Date.now() + 1000 });
  await assert.rejects(engine.creditBorrow(p.id, { path: 'advance', settlement_id: 'tsk_1' }, { key: owner }), (e) => e.code === 'credit_chain_off');
  await assert.rejects(engine.creditBorrow(p.id, { path: 'task_escrow' }, { key: owner }), (e) => e.code === 'credit_chain_off');
  await assert.rejects(engine.creditBorrow(p.id, { path: 'nope' }, { key: owner }), (e) => e.code === 'invalid_input');
  await assert.rejects(engine.creditRepay(p.id, { loan_id: '0x00' }, { key: owner }), (e) => e.code === 'credit_chain_off');
  await assert.rejects(engine.creditPayout('tsk_1', { key: owner }), (e) => e.code === 'credit_chain_off');
  await assert.rejects(engine.creditPayout('tsk_nope', { key: owner }), (e) => e.code === 'not_found');
  await assert.rejects(engine.creditQuote(p.id, 'tsk_1'), (e) => e.code === 'credit_chain_off');
  const pool = await engine.creditPool();
  assert.equal(pool.enabled, false); assert.match(pool.reason, /VOUCH_CREDIT_CHAIN_ID/);
  const s = await engine.creditSettlement('tsk_1');
  assert.equal(s.amount_usd, 20); assert.equal(s.chain, null); assert.equal(s.payout, null);
  const loans = await engine.creditLoans(p.id);
  assert.deepEqual(loans.loans, []); assert.equal(loans.exposure_usd, null);
  assert.equal((await engine.creditStatus()).borrowing, false);
});

test('record: a settlement event carries what the agent will be paid and when', async () => {
  const good = await fakeProvider({ result: 42 });
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const owner = engine.createKey('owner');
    engine.deposit(owner, 100);
    const a = engine.launchAgent({ name: 'calc', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, stake: 50 }, owner);
    const buyer = engine.createKey('buyer');
    engine.deposit(buyer, 5);
    const ownerBefore = engine.balance(owner).balance;
    const t = await waitTerminal(engine, engine.createTask(buyer, mathTask()).task.id);
    const ev = engine.credit.eventsFor(a.provider_id).at(-1);
    assert.equal(ev.kind, 'settlement'); assert.equal(ev.price, t.settlement.price);
    assert.ok(ev.amount < t.settlement.price, 'the agent\'s proceeds are its owner\'s net share, not the price');
    assert.ok(Math.abs(ev.amount - (engine.balance(owner).balance - ownerBefore)) < 1e-6, 'exactly what reached the owner key');
    assert.ok(ev.payout_at > Date.now() + 23 * 3600 * 1000, 'pending until the dispute window closes');
    // a plain provider's proceeds are the full price
    engine.state.providers = {};
    const p = engine.registerProvider({ name: 'p', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, stake: 10 });
    const t2 = await waitTerminal(engine, engine.createTask(buyer, mathTask()).task.id);
    assert.equal(engine.credit.eventsFor(p.id).at(-1).amount, t2.settlement.price);
  } finally { good.close(); }
});

test('stake discount: a quote reserves less of a creditworthy provider\'s stake, by tier, on a configurable curve', async () => {
  const good = await fakeProvider({ result: 42 });
  try {
    const engine = createEngine({ ...FAST, creditStakeDiscount: { 0: 0, 1: 0.5, 2: 0.6, 3: 0.75 } });
    engine.state.providers = {};
    const buyer = engine.createKey('buyer');
    engine.deposit(buyer, 5);
    const p = engine.registerProvider({ name: 'p', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, stake: 10 });
    const t1 = engine.createTask(buyer, mathTask()).task;
    assert.equal(t1.quote.stake_reserved, t1.quote.price, 'tier 0: the full price');
    await waitTerminal(engine, t1.id);
    // give the provider a tier-1 record: 50 settlements of $20
    for (let i = 0; i < 50; i++) engine.credit.record('settlement', p.id, `h${i}`, 20);
    assert.equal(engine.creditScore(p.id).tier, 1);
    const t2 = engine.createTask(buyer, mathTask()).task;
    assert.ok(Math.abs(t2.quote.stake_reserved - t2.quote.price * 0.5) < 1e-6, 'tier 1 on this curve: half');
    assert.ok(Math.abs(engine.state.providers[p.id].stakeReserved - t2.quote.stake_reserved) < 1e-6, 'the reservation itself is discounted');
    await waitTerminal(engine, t2.id);
    assert.equal(engine.state.providers[p.id].stakeReserved, 0, 'and released on settlement');
    // the default curve leaves tiers 0 and 1 alone
    const plain = createEngine(FAST);
    assert.deepEqual(plain.cfg.creditStakeDiscount, { 0: 0, 1: 0, 2: 0.1, 3: 0.25 });
  } finally { good.close(); }
});

// ---- HTTP + MCP ----------------------------------------------------------------------------

test('api: credit reads are public, identity link is owner-only, MCP exposes the three read tools', async () => {
  const { server, engine } = createApp(FAST);
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, { key, body } = {}) => { const r = await fetch(base + path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    const pid = Object.keys(engine.state.providers)[0];
    engine.credit.record('settlement', pid, 'tsk_a', 100);
    const st = await call('GET', '/v1/credit');
    assert.equal(st.status, 200); assert.equal(st.body.phase, 1); assert.equal(st.body.chain.enabled, false); assert.equal(st.body.events, 1);
    const sc = await call('GET', `/v1/credit/score/${pid}`);
    assert.equal(sc.status, 200); assert.equal(sc.body.score, 29); assert.equal(sc.body.tier, 0);
    const rep = await call('GET', `/v1/credit/report/${pid}`);
    assert.equal(rep.body.inputs.settled_volume_usd, 100); assert.equal(rep.body.points.work, 29);
    const ln = await call('GET', `/v1/credit/line/${pid}`);
    assert.equal(ln.body.credit_line_usd, 0); assert.equal(ln.body.cap_usd, 1000);
    assert.equal((await call('GET', '/v1/credit/score/prv_nope')).status, 404);
    // identity: a stranger is refused, an admin may link
    assert.equal((await call('POST', `/v1/credit/identity/${pid}`, { body: { agent_id: '12' } })).status, 403);
    const stranger = (await call('POST', '/v1/keys', { body: { name: 's' } })).body.key;
    assert.equal((await call('POST', `/v1/credit/identity/${pid}`, { key: stranger, body: { agent_id: '12' } })).status, 403);
    engine.cfg.adminToken = 'adm';
    const r = await fetch(base + `/v1/credit/identity/${pid}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'adm' }, body: JSON.stringify({ agent_id: '12' }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).agent_id, '12');
    assert.equal((await call('GET', '/v1/credit/score/12')).body.subject, pid);
    // MCP
    const rpc = async (body, key) => (await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) })).json();
    const tools = (await rpc({ method: 'tools/list' })).result.tools.map((t) => t.name);
    for (const t of ['vouch_credit_score', 'vouch_credit_report', 'vouch_credit_line', 'vouch_borrow', 'vouch_repay', 'vouch_credit_loans']) assert.ok(tools.includes(t), t);
    const off = await rpc({ method: 'tools/call', params: { name: 'vouch_borrow', arguments: { agent_id: pid, path: 'advance', settlement_id: 'tsk_a' } } }, stranger);
    assert.match(JSON.stringify(off), /not_owner|credit_chain_off/);
    assert.equal((await call('GET', '/v1/credit/pool')).body.enabled, false);
    assert.equal((await call('POST', `/v1/credit/borrow/${pid}`, { key: stranger, body: { path: 'advance' } })).status, 403);
    assert.equal((await call('GET', `/v1/credit/loans/${pid}`)).status, 200);
    assert.ok((await rpc({ method: 'tools/list' })).result.tools.find((t) => t.name === 'vouch_post_task').inputSchema.properties.min_credit);
    const got = await rpc({ method: 'tools/call', params: { name: 'vouch_credit_score', arguments: { agent_id: '12' } } }, stranger);
    assert.equal(JSON.parse(got.result.content[0].text).score, 29);
  } finally { server.close(); }
});
