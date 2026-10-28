// Vouch Credit against a real devnet: anvil + the deploy script + the engine as
// attester and treasury. Skipped when Foundry is not installed (CI without it
// still runs the rest of the suite); run `npm run contracts:test` for the
// Solidity suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.js';
import { creditConfig, linkMessage, IDENTITY_ABI, ERC20_ABI, POOL_ABI } from '../src/credit/chain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(here, '..', 'contracts');
const FOUNDRY = [process.env.FOUNDRY_BIN, path.join(os.homedir(), '.foundry', 'bin'), ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
const bin = (name) => FOUNDRY.map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
const ANVIL = bin('anvil'), FORGE = bin('forge');
const SKIP = !ANVIL || !FORGE ? 'foundry not installed' : false;

// anvil's deterministic accounts (mnemonic "test test … junk")
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ATTESTER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AGENT_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const LENDER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const U = 10n ** 6n;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function startAnvil(port) {
  const proc = spawn(ANVIL, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) return proc; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('anvil did not start');
}

// One devnet per test: anvil, the deploy script (with a temp copy of the record),
// an engine as attester, an agent with a registered and linked identity.
async function devnet() {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const anvil = await startAnvil(port);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-credit-'));
  const { ethers } = await import('ethers');
  const attester = new ethers.Wallet(ATTESTER_KEY);
  fs.rmSync(path.join(CONTRACTS, 'deployments', '31337.json'), { force: true }); // a stale devnet record would point at a dead chain
  const dep = spawnSync(FORGE, ['script', 'script/Deploy.s.sol', '--rpc-url', rpc, '--private-key', DEPLOYER_KEY, '--broadcast'], { cwd: CONTRACTS, env: { ...process.env, ATTESTER: attester.address }, encoding: 'utf8', timeout: 300000 });
  assert.equal(dep.status, 0, dep.stdout + dep.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'deployments', '31337.json'), 'utf8'));
  fs.writeFileSync(path.join(tmp, '31337.json'), JSON.stringify(record));
  const cfg = creditConfig({ VOUCH_CREDIT_CHAIN_ID: '31337', VOUCH_CREDIT_RPC: rpc, VOUCH_CREDIT_ATTESTER_KEY: ATTESTER_KEY, VOUCH_CREDIT_DEPLOYMENTS: tmp });
  const engine = createEngine({ fast: true, credit: cfg });
  engine.state.providers = {};
  const provider = new ethers.JsonRpcProvider(rpc, 31337, { staticNetwork: true, cacheTimeout: -1 });
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);
  const agentWallet = new ethers.Wallet(AGENT_KEY, provider);
  const lender = new ethers.Wallet(LENDER_KEY, provider);
  const usdg = new ethers.Contract(record.usdg, [...ERC20_ABI, 'function mint(address to, uint256 amount)'], deployer);
  const pool = new ethers.Contract(record.creditPool, POOL_ABI, deployer);
  const identity = new ethers.Contract(record.identityRegistry, IDENTITY_ABI, agentWallet);
  await (await identity.register('https://agent.example/8004.json')).wait();
  const agentId = '1';
  const warp = async (seconds) => { await provider.send('evm_increaseTime', [seconds]); await provider.send('evm_mine', []); };
  const close = () => { anvil.kill(); fs.rmSync(tmp, { recursive: true, force: true }); };
  // post everything queued; a transient RPC error under load is retried on the next flush
  const flushAll = async () => { for (let i = 0; i < 4; i++) { await engine.drain(); await engine.credit.flush(); if (!engine.state.credit.outbox.some((o) => o.status === 'pending')) break; } };
  return { ethers, rpc, record, cfg, engine, provider, deployer, attester, agentWallet, lender, usdg, pool, identity, agentId, warp, close, flushAll };
}

test('devnet: deploy, link a registered agentId with a wallet signature, post settlements, read the same score back from the chain', { skip: SKIP }, async () => {
  const d = await devnet();
  try {
    const { engine, record, attester, agentWallet, agentId } = d;
    assert.equal(record.attester, attester.address);
    assert.equal(d.cfg.enabled, true); assert.equal(d.cfg.poolDeployed, true);
    const owner = engine.createKey('owner');
    const p = engine.registerProvider({ name: 'p', endpoint_url: 'http://localhost:1/task', offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } } }, owner);
    engine.credit.record('settlement', p.id, 'tsk_before_link', 100);

    const badSig = await new d.ethers.Wallet(DEPLOYER_KEY).signMessage(linkMessage(p.id, agentId));
    await assert.rejects(engine.linkIdentity(p.id, { agent_id: agentId, signature: badSig }, { key: owner }), (e) => e.code === 'not_identity_owner');
    await assert.rejects(engine.linkIdentity(p.id, { agent_id: '2', signature: badSig }, { key: owner }), (e) => e.code === 'unknown_agent');
    await assert.rejects(engine.linkIdentity(p.id, { agent_id: agentId }, { key: owner }), (e) => e.code === 'signature_required');
    const sig = await agentWallet.signMessage(linkMessage(p.id, agentId));
    const linked = await engine.linkIdentity(p.id, { agent_id: agentId, signature: sig }, { key: owner });
    assert.equal(linked.verified, true); assert.equal(linked.owner.toLowerCase(), agentWallet.address.toLowerCase());

    // the backfilled event and a new one are posted by the attester, through the pool
    await d.flushAll();
    engine.credit.record('settlement', p.id, 'tsk_after_link', 100, { payout_at: Date.now() + 86400000 });
    await d.flushAll();
    const rep = await engine.creditReport(p.id);
    assert.equal(rep.identity.outbox.posted, 2, JSON.stringify(engine.state.credit.outbox));
    assert.equal(rep.identity.outbox.pending, 0);
    assert.ok(Math.abs(rep.engine_score - 58) <= 1, String(rep.engine_score)); // 2 settlements: 8 + 200/4, less a point when a second passed between them
    assert.ok(Math.abs(rep.chain.score - 58) <= 1, `the chain computes the same score from the same events, within a point of decay rounding (${rep.chain.score})`);
    assert.equal(rep.score, rep.chain.score, 'linked: the chain score is the one reported'); assert.equal(rep.source, 'chain');
    assert.equal(engine.creditScore(p.id).score, rep.chain.score, 'and the one quotes use');
    assert.equal(rep.chain.report.inputs.settled_volume_usd, 200);
    const s = await engine.creditSettlement('tsk_after_link');
    assert.equal(s.chain.amount_usd, 100); assert.equal(s.chain.paid, false); assert.equal(s.chain.loan_id, null);
    // the same fact twice is refused on-chain and marked, never double counted
    engine.state.credit.outbox.push({ event_id: rep.events[0].id, subject: p.id, agent_id: agentId, status: 'pending', attempts: 0 });
    await engine.credit.flush();
    assert.equal(engine.state.credit.outbox.at(-1).note, 'already recorded');
    assert.equal((await engine.creditReport(p.id)).chain.score, rep.chain.score);
    const status = await engine.creditStatus();
    assert.equal(status.chain.attester, attester.address); assert.equal(status.chain.can_write, true); assert.equal(status.phase, 3); assert.equal(status.borrowing, true);
  } finally { d.close(); }
});

test('devnet: an advance is drawn against a pending settlement, repaid out of its payout before the agent is paid, and the score grows; a late one defaults and recovers', { skip: SKIP }, async () => {
  const d = await devnet();
  try {
    const { engine, record, agentWallet, lender, usdg, pool, agentId, warp } = d;
    // the pool: a lender's $5,000, a $500 reserve, a treasury purse for payouts
    const tx = async (p) => (await p).wait();
    await tx(usdg.mint(lender.address, 10_000n * U));
    await tx(usdg.mint(d.attester.address, 10_000n * U));
    await tx(usdg.mint(d.deployer.address, 1_000n * U));
    await tx(usdg.connect(lender).approve(record.creditPool, d.ethers.MaxUint256));
    await tx(pool.connect(lender).deposit(5_000n * U));
    await tx(usdg.approve(record.creditPool, d.ethers.MaxUint256));
    await tx(pool.fundReserve(500n * U));

    // a plain provider with a linked identity and a tier-1 history
    const owner = engine.createKey('owner');
    const p = engine.registerProvider({ name: 'p', endpoint_url: 'http://localhost:1/task', offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } } }, owner);
    p.earnings = 1000; // sandbox: what the provider has earned and may have paid out
    await engine.linkIdentity(p.id, { agent_id: agentId, signature: await agentWallet.signMessage(linkMessage(p.id, agentId)) }, { key: owner });
    for (let i = 0; i < 50; i++) engine.credit.record('settlement', p.id, `tsk_${i}`, 20, { payout_at: Date.now() + 86400000 * 10 });
    await d.flushAll();
    const base = await engine.creditReport(p.id);
    assert.equal(base.identity.outbox.posted, 50, JSON.stringify(engine.state.credit.outbox.filter((o) => o.status !== 'posted')));
    assert.ok(Math.abs(base.engine_score - 450) <= 1, String(base.engine_score)); assert.ok(Math.abs(base.chain.score - 450) <= 1, String(base.chain.score));
    const chain0 = base.chain.score;

    // before a chain: nothing to borrow against that is not attested
    await assert.rejects(engine.creditBorrow(p.id, { path: 'stake' }, { key: owner }), (e) => e.code === 'invalid_input');
    await assert.rejects(engine.creditBorrow(p.id, { path: 'stake', amount: 10 }, { key: owner }), (e) => e.code === 'not_an_agent', 'a plain provider has no bond to borrow into');
    await assert.rejects(engine.creditBorrow(p.id, { path: 'advance', settlement_id: 'tsk_nope' }, { key: owner }), (e) => e.code === 'not_found');
    await assert.rejects(engine.creditBorrow(p.id, { path: 'advance', settlement_id: 'tsk_1' }, { key: engine.createKey('x') }), (e) => e.code === 'not_owner');

    // quote and advance: 80% of $20 = $16 for 10 days at 300 bps per 30 days → fee $0.16
    const q = await engine.creditQuote(p.id, 'tsk_1');
    assert.equal(q.principal_usd, 16); assert.equal(q.term_days, 10); assert.equal(q.fee_bps_30d, 300); assert.ok(near(q.fee_usd, 0.16));
    const walletBefore = Number(await usdg.balanceOf(agentWallet.address)) / 1e6;
    const loan = await engine.creditBorrow(p.id, { path: 'advance', settlement_id: 'tsk_1' }, { key: owner });
    assert.ok(loan.loan_id); assert.equal(loan.principal_usd, 16); assert.equal(loan.chain.status, 'active'); assert.equal(loan.borrower.toLowerCase(), agentWallet.address.toLowerCase());
    assert.equal(Number(await usdg.balanceOf(agentWallet.address)) / 1e6 - walletBefore, 16, 'the advance landed in the identity wallet');
    await assert.rejects(engine.creditBorrow(p.id, { path: 'advance', settlement_id: 'tsk_1' }, { key: owner }), (e) => e.code === 'not_borrowable');
    const ls = await engine.creditLoans(p.id);
    assert.equal(ls.loans.length, 1); assert.equal(ls.exposure_usd, 16); assert.equal(ls.loans[0].record.settlement_ref, 'tsk_1');

    // payout: the owner asks for the settlement's proceeds; the loan is repaid first
    await assert.rejects(engine.creditPayout('tsk_1', { key: engine.createKey('x') }), (e) => e.code === 'not_owner');
    const earningsBefore = engine.state.providers[p.id].earnings;
    const paid = await engine.creditPayout('tsk_1', { key: owner });
    assert.equal(paid.amount_usd, 20); assert.ok(near(paid.repaid_usd, 16.16)); assert.ok(near(paid.forwarded_usd, 3.84));
    assert.equal(paid.loan.status, 'repaid');
    assert.equal(earningsBefore - engine.state.providers[p.id].earnings, 20, 'the provider\'s ledger earnings paid for the on-chain payout');
    assert.ok(near(Number(await usdg.balanceOf(agentWallet.address)) / 1e6 - walletBefore, 16 + 3.84));
    await assert.rejects(engine.creditPayout('tsk_1', { key: owner }), (e) => e.code === 'already_paid');
    const rep = await engine.creditReport(p.id);
    assert.equal(rep.inputs.advances_repaid, 1, 'the repaid advance is mirrored into the engine record');
    assert.ok(Math.abs(rep.engine_score - rep.chain.score) <= 1, 'engine and chain still agree within rounding');
    assert.equal(rep.chain.score, chain0 + 3); // + 3 for the advance ($16 is under the $40 per point)

    // manual partial repayment from the ledger, then the rest
    const loan2 = await engine.creditBorrow(p.id, { path: 'advance', settlement_id: 'tsk_2' }, { key: owner });
    const r1 = await engine.creditRepay(p.id, { loan_id: loan2.loan_id, amount: 10 }, { key: owner });
    assert.equal(r1.paid_usd, 10); assert.equal(r1.loan.status, 'active'); assert.ok(near(r1.loan.owed_usd, 6.16));
    const r2 = await engine.creditRepay(p.id, { loan_id: loan2.loan_id }, { key: owner });
    assert.ok(near(r2.paid_usd, 6.16)); assert.equal(r2.loan.status, 'repaid');
    await assert.rejects(engine.creditRepay(p.id, { loan_id: loan2.loan_id }, { key: owner }), (e) => e.code === 'loan_closed');
    const paid2 = await engine.creditPayout('tsk_2', { key: owner });
    assert.equal(paid2.repaid_usd, 0); assert.equal(paid2.forwarded_usd, 20, 'a repaid loan takes nothing from the payout');

    // a loan nobody repays: past due plus grace anyone marks it; the reserve absorbs it; a late payout recovers it
    const loan3 = await engine.creditBorrow(p.id, { path: 'advance', settlement_id: 'tsk_3' }, { key: owner });
    const client = await engine.credit.chainClient();
    const poolBefore = await client.poolInfo();
    await warp(14 * 86400);
    assert.equal((await client.loan(loan3.loan_id)).overdue, true);
    await client.markDefault(loan3.loan_id);
    const poolAfter = await client.poolInfo();
    assert.ok(near(poolBefore.reserve_usd - poolAfter.reserve_usd, 16), 'the reserve absorbed the whole loss');
    assert.ok(near(poolAfter.lender_assets_usd, poolBefore.lender_assets_usd), 'lender assets untouched');
    const dflt = await engine.creditReport(p.id);
    assert.equal(dflt.inputs.defaults, 1); assert.equal(dflt.chain.report.inputs.defaults, 1);
    // after time travel on the devnet the local replay no longer tracks the chain's decay; the chain's score is the reported one
    assert.equal(dflt.score, dflt.chain.score, 'the chain score is the one reported'); assert.equal(dflt.source, 'chain');
    assert.ok(dflt.score < chain0 + 3 - 400, 'a default craters the score');
    const late = await engine.creditPayout('tsk_3', { key: owner });
    assert.equal(late.loan.status, 'recovered'); assert.ok(near(late.repaid_usd, 16.16));
    const rec = await engine.creditReport(p.id);
    assert.equal(rec.inputs.recoveries, 1); assert.equal(rec.score, rec.chain.score);
    assert.ok(rec.score > dflt.score, 'a recovery lifts the score');
    const finalPool = await client.poolInfo();
    assert.ok(near(finalPool.reserve_usd, poolBefore.reserve_usd + 0.032, 1e-3), 'the reserve is refilled, plus the recovered loan\'s fee share');
  } finally { d.close(); }
});

test('devnet: a launched agent borrows stake into its bond and a task budget into escrow; slashes seize borrowed stake, settlements route the budget to the treasury, proceeds repay every loan', { skip: SKIP }, async () => {
  const d = await devnet();
  const { createServer } = await import('node:http');
  const fake = await new Promise((resolve) => { const srv = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 42 })); }); }); srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/task`, close: () => srv.close() })); });
  try {
    const { engine, record, agentWallet, lender, usdg, pool, agentId } = d;
    const tx = async (p) => (await p).wait();
    await tx(usdg.mint(lender.address, 10_000n * U)); await tx(usdg.mint(d.attester.address, 10_000n * U)); await tx(usdg.mint(d.deployer.address, 1_000n * U));
    await tx(usdg.connect(lender).approve(record.creditPool, d.ethers.MaxUint256)); await tx(pool.connect(lender).deposit(5_000n * U));
    await tx(usdg.approve(record.creditPool, d.ethers.MaxUint256)); await tx(pool.fundReserve(500n * U));
    const client = await engine.credit.chainClient();

    // a launched agent with a linked identity and a tier-1 history
    const owner = engine.createKey('owner');
    engine.deposit(owner, 100);
    const a = engine.launchAgent({ name: 'calc', endpoint_url: fake.url, offers: { 'math.eval': { price_ceiling: 20, sla_deadline_ms: 5000 } }, stake: 20, compute: 0 }, owner);
    const subject = a.provider_id;
    await engine.linkIdentity(a.id, { agent_id: agentId, signature: await agentWallet.signMessage(linkMessage(subject, agentId)) }, { key: owner });
    for (let i = 0; i < 50; i++) engine.credit.record('settlement', subject, `hist_${i}`, 20, { payout_at: Date.now() + 86400000 * 10 });
    await d.flushAll();
    assert.ok(engine.creditScore(a.id).score >= 449);

    // --- stake: $100 borrowed into the bond, held by the pool ---
    const size = await engine.creditQuoteLoan(a.id, 100, 10);
    assert.equal(size.fee_usd, 1); assert.ok(Math.abs(size.room_usd - 500) < 0.01, String(size.room_usd));
    const sl = await engine.creditBorrow(a.id, { path: 'stake', amount: 100, term_days: 10 }, { key: owner });
    assert.equal(sl.chain.kind, 'stake'); assert.equal(sl.chain.held_usd, 100); assert.equal(sl.bond_usdt, 120);
    let ag = engine.getAgent(a.id);
    assert.equal(ag.bond.stake_usdt, 120); assert.equal(ag.bond.borrowed_usdt, 100); assert.equal(ag.bond.capacity_usdt, 60);
    assert.equal((await client.poolInfo()).stake_held_usd, 100);
    assert.equal(Number(await usdg.balanceOf(agentWallet.address)), 0, 'nothing reached the wallet');
    // only own stake can be unstaked
    engine.requestUnbond(a.id, 50, { key: owner });
    assert.equal(engine.getAgent(a.id).unbonding.usdt, 20, 'capped at the agent\'s own $20');

    // a slash of $30 takes the own $20 first, then $10 of borrowed stake, seized on-chain to the treasury
    const treasuryBefore = Number(await usdg.balanceOf(d.attester.address)) / 1e6;
    engine.credit.record('slash', subject, 'slash_test', 0); // (the credit event itself)
    const agentRec = engine.state.agents[a.id];
    engine.state.launchpad.pending_slashes.push({ id: 'slh_test', agent_id: a.id, provider_id: subject, task_id: null, reason: 'test', price_usdt: 15, multiple: 2, amount_usdt: 30, capped: false, queued_at: Date.now(), execute_after: Date.now() - 1, status: 'pending' });
    engine.processPendingSlashes();
    await d.flushAll();
    ag = engine.getAgent(a.id);
    assert.equal(ag.bond.stake_usdt, 90); assert.equal(ag.bond.borrowed_usdt, 90);
    const slashed = (await client.loan(sl.loan_id));
    assert.equal(slashed.held_usd, 90); assert.equal(slashed.remaining_principal_usd, 100, 'the agent still owes what it lost');
    assert.ok(Math.abs(Number(await usdg.balanceOf(d.attester.address)) / 1e6 - treasuryBefore - 10) < 1e-6, 'the seized stake went to the treasury');
    assert.equal(engine.state.credit.actions.filter((x) => x.status === 'done').length, 1);

    // repaying returns the held $90 (bond shrinks), then $10 + the $1 fee in cash
    const r = await engine.creditRepay(a.id, { loan_id: sl.loan_id }, { key: owner });
    assert.equal(r.released_usd, 90); assert.ok(near(r.paid_usd, 11)); assert.equal(r.loan.status, 'repaid');
    ag = engine.getAgent(a.id);
    assert.equal(ag.bond.borrowed_usdt, 0); assert.equal(ag.bond.stake_usdt, 0);
    assert.equal((await client.poolInfo()).stake_held_usd, 0);

    // --- task escrow: the agent posts a task with a borrowed budget ---
    engine.deposit(owner, 100);
    engine.state.keys[owner.id].tier = owner.tier = 'scale'; // the sandbox tier may lock only $5 a day
    engine.addStake(a.id, 50, { key: owner }); // the agent is also the only provider: it serves its own task
    const ownerBefore = engine.balance(owner).balance;
    const el = await engine.creditBorrow(a.id, { path: 'task_escrow', term_days: 5, task: { capability: 'math.eval', input: { expression: '6 * 7' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 20, deadline_ms: 5000 } }, { key: owner });
    assert.ok(el.principal_usd >= 5, 'a loan at least the pool minimum');
    assert.equal(el.path, 'task_escrow'); assert.equal(el.chain.kind, 'task_escrow'); assert.ok(el.task.id);
    assert.equal(el.principal_usd, el.task.quote.price, 'the loan is exactly the committed price');
    assert.equal(el.chain.held_usd, el.principal_usd);
    assert.equal(el.task.escrow.locked, el.principal_usd, 'the task locked exactly the loan');
    const hist = engine.state.accounts[owner.id].history;
    const credited = hist.findIndex((h) => h.kind === 'credit_escrow_loan' && h.amount === el.principal_usd);
    assert.ok(credited >= 0 && hist[credited + 1]?.kind === 'lock' && hist[credited + 1].amount === el.principal_usd, 'credited and locked back to back: never spendable on anything else');
    void ownerBefore;
    assert.deepEqual(engine.state.tasks[el.task.id].credit, { loan_id: el.loan_id, ref: el.ref, principal_usd: el.principal_usd });
    const treasury2 = Number(await usdg.balanceOf(d.attester.address)) / 1e6;
    // it settles: the pool sends the held budget to the treasury; the loan is still owed
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && !['settled', 'refunded'].includes(engine.state.tasks[el.task.id].status)) await new Promise((r2) => setTimeout(r2, 20));
    assert.equal(engine.state.tasks[el.task.id].status, 'settled');
    await d.flushAll();
    assert.ok(Math.abs(Number(await usdg.balanceOf(d.attester.address)) / 1e6 - treasury2 - el.principal_usd) < 1e-6, 'the task budget reached the treasury');
    const after = await client.loan(el.loan_id);
    assert.equal(after.held_usd, 0); assert.equal(after.status, 'active'); assert.ok(near(after.owed_usd, el.principal_usd + el.fee_usd));
    // the settlement's own proceeds (the agent served its own task) repay it before the agent is paid
    const settled = engine.state.tasks[el.task.id];
    const paid = await engine.creditPayout(settled.id, { key: owner });
    assert.ok(near(paid.repaid_usd, Math.min(paid.amount_usd, after.owed_usd)), 'the proceeds went to the escrow loan first');
    assert.ok(paid.amount_usd < after.owed_usd ? paid.forwarded_usd === 0 : true, 'nothing reaches the agent while the loan is owed');
    if ((await client.loan(el.loan_id)).status !== 'repaid') await engine.creditRepay(a.id, { loan_id: el.loan_id }, { key: owner });
    assert.equal((await client.loan(el.loan_id)).status, 'repaid');
    const rep = await engine.creditReport(a.id);
    assert.equal(rep.inputs.loans_repaid, 2, 'the stake loan and the escrow loan'); assert.equal(rep.inputs.loans_repaid_on_time, 2);
    const ls = await engine.creditLoans(a.id);
    assert.equal(ls.loans.length, 2); assert.equal(ls.exposure_usd, 0);
  } finally { fake.close(); d.close(); }
});
