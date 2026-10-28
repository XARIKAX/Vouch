#!/usr/bin/env node
// Vouch Credit quickstart: a local chain, every contract deployed, and one agent
// walked from registration to a repaid loan and a higher score. Each step prints
// what happened and where the money went.
//
//   npm run quickstart            runs the walk-through and exits
//   npm run quickstart -- --keep  leaves the engine and the chain up for the CLI
//
// Needs Foundry (anvil + forge) on PATH or in ~/.foundry/bin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { creditConfig, linkMessage, IDENTITY_ABI, ERC20_ABI, POOL_ABI } from '../src/credit/chain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CONTRACTS = path.join(ROOT, 'contracts');
const KEEP = process.argv.includes('--keep');
const FOUNDRY = [process.env.FOUNDRY_BIN, path.join(os.homedir(), '.foundry', 'bin'), ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
const bin = (name) => FOUNDRY.map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
const ANVIL = bin('anvil'), FORGE = bin('forge');

// anvil's deterministic accounts
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  attester: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  agent: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  lender: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
};
const USD = (n) => `$${Number(n).toFixed(2)}`;
let stepN = 0;
const step = (title) => console.log(`\n${String(++stepN).padStart(2, '0')}  ${title}`);
const say = (k, v) => console.log(`    ${k.padEnd(28)} ${v}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!ANVIL || !FORGE) {
  console.error('Foundry is not installed: this quickstart needs anvil and forge.\n  curl -L https://foundry.paradigm.xyz | bash && foundryup\nThe engine and its tests run without it; only the on-chain credit layer needs a devnet.');
  process.exit(1);
}

async function startAnvil(port) {
  const proc = spawn(ANVIL, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) return proc; } catch { /* booting */ }
    await sleep(100);
  }
  proc.kill(); throw new Error('anvil did not start');
}

function fakeProvider() {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 42 })); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/task`, close: () => server.close() })));
}

async function waitTerminal(engine, taskId, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = engine.state.tasks[taskId];
    if (t && ['settled', 'refunded'].includes(t.status)) return t;
    await sleep(15);
  }
  throw new Error(`task ${taskId} never settled`);
}

const { ethers } = await import('ethers');
const port = 8545 + Math.floor(Math.random() * 400);
const rpc = `http://127.0.0.1:${port}`;
const cleanup = [];
process.on('SIGINT', () => { for (const f of cleanup) f(); process.exit(0); });

try {
  step('Start a local chain');
  const anvil = await startAnvil(port);
  cleanup.push(() => anvil.kill());
  say('anvil', `${rpc} (chain 31337)`);

  step('Deploy Vouch Credit from deployments/31337.json');
  const attester = new ethers.Wallet(KEYS.attester);
  fs.rmSync(path.join(CONTRACTS, 'deployments', '31337.json'), { force: true });
  const dep = spawnSync(FORGE, ['script', 'script/Deploy.s.sol', '--rpc-url', rpc, '--private-key', KEYS.deployer, '--broadcast'], { cwd: CONTRACTS, env: { ...process.env, ATTESTER: attester.address }, encoding: 'utf8' });
  if (dep.status !== 0) throw new Error(`deploy failed:\n${dep.stdout}\n${dep.stderr}`);
  const record = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'deployments', '31337.json'), 'utf8'));
  say('identity registry (mock)', record.identityRegistry);
  say('USDG (mock)', record.usdg);
  say('CreditRegistry', record.creditRegistry);
  say('CreditPool', record.creditPool);
  say('attester', record.attester);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-quickstart-'));
  fs.writeFileSync(path.join(tmp, '31337.json'), JSON.stringify(record));
  cleanup.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

  step('Fund the pool: a lender deposits, the protocol seeds the reserve, the treasury holds USDG');
  const provider = new ethers.JsonRpcProvider(rpc, 31337, { staticNetwork: true, cacheTimeout: -1 });
  const deployer = new ethers.Wallet(KEYS.deployer, provider);
  const lender = new ethers.Wallet(KEYS.lender, provider);
  const agentWallet = new ethers.Wallet(KEYS.agent, provider);
  const usdg = new ethers.Contract(record.usdg, [...ERC20_ABI, 'function mint(address to, uint256 amount)'], deployer);
  const pool = new ethers.Contract(record.creditPool, POOL_ABI, deployer);
  const tx = async (p) => (await p).wait();
  await tx(usdg.mint(lender.address, 10_000n * 10n ** 6n));
  await tx(usdg.mint(attester.address, 10_000n * 10n ** 6n));
  await tx(usdg.mint(deployer.address, 1_000n * 10n ** 6n));
  await tx(usdg.connect(lender).approve(record.creditPool, ethers.MaxUint256));
  await tx(pool.connect(lender).deposit(5_000n * 10n ** 6n));
  await tx(usdg.approve(record.creditPool, ethers.MaxUint256));
  await tx(pool.fundReserve(500n * 10n ** 6n));
  say('lender deposited', USD(5000));
  say('first-loss reserve', USD(500));
  say('treasury USDG', USD(10000));

  step('Boot the Vouch engine as the attester');
  const credit = creditConfig({ VOUCH_CREDIT_CHAIN_ID: '31337', VOUCH_CREDIT_RPC: rpc, VOUCH_CREDIT_ATTESTER_KEY: KEYS.attester, VOUCH_CREDIT_DEPLOYMENTS: tmp });
  const { server, engine } = createApp({ fast: true, allowPrivateWebhooks: true, persistPath: null, credit });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  cleanup.push(() => server.close());
  const st = await engine.creditStatus();
  say('engine', base);
  say('credit phase', String(st.phase));
  say('attester', st.chain.attester);

  step('The agent registers an ERC-8004 identity with its own wallet');
  const identity = new ethers.Contract(record.identityRegistry, IDENTITY_ABI, agentWallet);
  await tx(identity.register('https://calc.example/.well-known/agent.json'));
  const agentId = '1';
  say('agentId', agentId);
  say('owner wallet', agentWallet.address);

  step('Launch a Vouch agent with a USDT stake, and link the identity with a wallet signature');
  const fake = await fakeProvider();
  cleanup.push(() => fake.close());
  engine.state.providers = {}; // only our agent quotes; the sandbox seeds would undercut it
  const owner = engine.createKey('calc-owner');
  const faucet = (key, total) => { for (let left = total; left > 0; left -= 100) engine.deposit(key, Math.min(100, left)); }; // the sandbox faucet credits $100 at a time
  faucet(owner, 400);
  const agent = engine.launchAgent({ name: 'calc', endpoint_url: fake.url, offers: { 'math.eval': { price_ceiling: 100, sla_deadline_ms: 5000 } }, stake: 300, compute: 10 }, owner);
  const sig = await agentWallet.signMessage(linkMessage(agent.provider_id, agentId));
  const link = await engine.linkIdentity(agent.id, { agent_id: agentId, signature: sig }, { key: owner });
  say('agent', `${agent.id} (provider ${agent.provider_id})`);
  say('stake', USD(agent.bond.stake_usdt));
  say('identity link', `agentId ${link.agent_id} · verified ${link.verified}`);
  say('credit score', String(engine.creditScore(agent.id).score));

  step('A buyer posts verified tasks; each settlement is attested on-chain as it happens');
  const buyer = engine.createKey('buyer');
  engine.state.keys[buyer.id].tier = buyer.tier = 'scale'; // the sandbox tier locks at most $5 a day
  faucet(buyer, 2500);
  const N = 20;
  let lastTask = null;
  for (let i = 0; i < N; i++) {
    const { task } = engine.createTask(buyer, { capability: 'math.eval', input: { expression: '6 * 7' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 100, deadline_ms: 5000 });
    const done = await waitTerminal(engine, task.id);
    if (done.status !== 'settled') throw new Error(`task ${task.id} ${done.status}`);
    lastTask = done;
    if (i === 0 || i === N - 1) say(`task ${i + 1}/${N}`, `${task.id} settled at ${USD(done.settlement.price)}`);
  }
  await engine.drain();
  await engine.credit.flush();
  const rep = await engine.creditReport(agent.id);
  say('settlements attested', `${rep.identity.outbox.posted} posted · ${rep.identity.outbox.pending} pending · ${rep.identity.outbox.failed} failed`);
  say('owner proceeds per task', USD(rep.events.at(-1).amount) + ' (net of the 5% fee, stake and compute top-ups)');
  say('score (engine / chain)', `${rep.score} / ${rep.chain.score}`);
  say('tier · fee · line', `${rep.tier} · ${rep.fee_bps_30d} bps/30d · ${USD(rep.credit_line_usd)}`);
  if (rep.chain.score !== rep.score) throw new Error('engine and chain disagree on the score');

  step('Borrow: an advance against the last settlement, whose payout is still pending');
  const walletBefore = await engine.credit.chainClient().then((c) => c.walletUsdg(agentWallet.address));
  const quote = await engine.creditQuote(agent.id, lastTask.id);
  say('quote', `${USD(quote.principal_usd)} for ${quote.term_days}d at ${quote.fee_bps_30d} bps → fee ${USD(quote.fee_usd)}`);
  const loan = await engine.creditBorrow(agent.id, { path: 'advance', settlement_id: lastTask.id }, { key: owner });
  const walletAfter = await engine.credit.chainClient().then((c) => c.walletUsdg(agentWallet.address));
  say('loan', loan.loan_id);
  say('principal → wallet', `${USD(loan.principal_usd)} (wallet ${USD(walletBefore)} → ${USD(walletAfter)})`);
  say('due', new Date(loan.due_at * 1000).toISOString().slice(0, 16));
  say('pool outstanding', USD((await engine.creditPool()).pool.outstanding_usd));

  step('Payout: the settlement\'s proceeds are routed through the pool; the loan is repaid before the agent sees a cent');
  const ownerBefore = engine.balance(owner).balance;
  const paid = await engine.creditPayout(lastTask.id, { key: owner });
  const walletFinal = await engine.credit.chainClient().then((c) => c.walletUsdg(agentWallet.address));
  say('proceeds', USD(paid.amount_usd) + ` (debited from the owner key: ${USD(ownerBefore)} → ${USD(engine.balance(owner).balance)})`);
  say('repaid to the pool', `${USD(paid.repaid_usd)} = principal ${USD(loan.principal_usd)} + fee ${USD(loan.fee_usd)}`);
  say('forwarded to the agent', `${USD(paid.forwarded_usd)} (wallet ${USD(walletAfter)} → ${USD(walletFinal)})`);
  say('loan status', paid.loan.status);

  step('The score grows: a repaid advance is a credit event');
  await sleep(200);
  const after = await engine.creditReport(agent.id);
  say('score (engine / chain)', `${after.score} / ${after.chain.score}`);
  say('advances repaid', String(after.inputs.advances_repaid));
  say('credit line', USD(after.credit_line_usd));
  const p = (await engine.creditPool()).pool;
  say('lenders now hold', `${USD(p.lender_assets_usd)} (share price ${p.share_price.toFixed(6)})`);
  say('reserve · protocol fees', `${USD(p.reserve_usd)} · ${USD(p.protocol_fees_usd)}`);

  console.log(`\nDone. Every number above came from the engine's record or the chain; nothing was computed in this script.`);
  if (KEEP) {
    console.log(`\nLeft running for the CLI:\n  VOUCH_URL=${base} VOUCH_KEY=${owner.token} node bin/vouch.js credit loans ${agent.id}\n  VOUCH_URL=${base} node bin/vouch.js credit pool\nCtrl-C to stop.`);
  } else {
    for (const f of cleanup) f();
    process.exit(0);
  }
} catch (e) {
  console.error(`\nquickstart failed: ${e.message}`);
  for (const f of cleanup) f();
  process.exit(1);
}
