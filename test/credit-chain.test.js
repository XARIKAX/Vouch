// Vouch Credit against a real devnet: anvil + the deploy script + the engine as
// attester. Skipped when Foundry is not installed (CI without it still runs the
// rest of the suite); run `npm run contracts:test` for the Solidity suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.js';
import { creditConfig, linkMessage, IDENTITY_ABI } from '../src/credit/chain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(here, '..', 'contracts');
const FOUNDRY = [process.env.FOUNDRY_BIN, path.join(os.homedir(), '.foundry', 'bin'), ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
const bin = (name) => FOUNDRY.map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
const ANVIL = bin('anvil'), FORGE = bin('forge');

// anvil's deterministic accounts (mnemonic "test test … junk")
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ATTESTER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AGENT_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

async function startAnvil(port) {
  const proc = spawn(ANVIL, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) return proc; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill(); throw new Error('anvil did not start');
}

test('devnet: deploy, link a registered agentId with a wallet signature, post settlements, read the same score back from the chain', { skip: !ANVIL || !FORGE ? 'foundry not installed' : false }, async () => {
  const port = 8600 + Math.floor(Math.random() * 300);
  const rpc = `http://127.0.0.1:${port}`;
  const anvil = await startAnvil(port);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-credit-'));
  try {
    const { ethers } = await import('ethers');
    const attester = new ethers.Wallet(ATTESTER_KEY);
    fs.rmSync(path.join(CONTRACTS, 'deployments', '31337.json'), { force: true }); // a stale devnet record would point at a dead chain
    const dep = spawnSync(FORGE, ['script', 'script/Deploy.s.sol', '--rpc-url', rpc, '--private-key', DEPLOYER_KEY, '--broadcast'], { cwd: CONTRACTS, env: { ...process.env, ATTESTER: attester.address }, encoding: 'utf8' });
    assert.equal(dep.status, 0, dep.stdout + dep.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'deployments', '31337.json'), 'utf8'));
    assert.equal(record.attester, attester.address);
    fs.writeFileSync(path.join(tmp, '31337.json'), JSON.stringify(record));

    const cfg = creditConfig({ VOUCH_CREDIT_CHAIN_ID: '31337', VOUCH_CREDIT_RPC: rpc, VOUCH_CREDIT_ATTESTER_KEY: ATTESTER_KEY, VOUCH_CREDIT_DEPLOYMENTS: tmp });
    assert.equal(cfg.enabled, true);
    const engine = createEngine({ fast: true, credit: cfg });
    engine.state.providers = {};
    const owner = engine.createKey('owner');
    const p = engine.registerProvider({ name: 'p', endpoint_url: 'http://localhost:1/task', offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } } }, owner);
    engine.credit.record('settlement', p.id, 'tsk_before_link', 100);

    // the agent registers its identity with its own wallet, then proves it owns it
    const provider = new ethers.JsonRpcProvider(rpc, 31337, { staticNetwork: true });
    const agentWallet = new ethers.Wallet(AGENT_KEY, provider);
    const identity = new ethers.Contract(record.identityRegistry, IDENTITY_ABI, agentWallet);
    await (await identity.register('https://agent.example/8004.json')).wait();
    const agentId = '1';
    const badSig = await new ethers.Wallet(DEPLOYER_KEY).signMessage(linkMessage(p.id, agentId));
    await assert.rejects(engine.linkIdentity(p.id, { agent_id: agentId, signature: badSig }, { key: owner }), (e) => e.code === 'not_identity_owner');
    await assert.rejects(engine.linkIdentity(p.id, { agent_id: '2', signature: badSig }, { key: owner }), (e) => e.code === 'unknown_agent');
    await assert.rejects(engine.linkIdentity(p.id, { agent_id: agentId }, { key: owner }), (e) => e.code === 'signature_required');
    const sig = await agentWallet.signMessage(linkMessage(p.id, agentId));
    const linked = await engine.linkIdentity(p.id, { agent_id: agentId, signature: sig }, { key: owner });
    assert.equal(linked.verified, true); assert.equal(linked.owner.toLowerCase(), agentWallet.address.toLowerCase());

    // the backfilled event and a new one are posted by the attester
    await engine.drain();
    engine.credit.record('settlement', p.id, 'tsk_after_link', 100);
    await engine.drain();
    await engine.credit.flush();
    const rep = await engine.creditReport(p.id);
    assert.equal(rep.identity.outbox.posted, 2, JSON.stringify(engine.state.credit.outbox));
    assert.equal(rep.identity.outbox.pending, 0);
    assert.equal(rep.score, 58); // 2 settlements: 8 + 200/4
    assert.equal(rep.chain.score, 58, 'the chain computes the same score from the same events');
    assert.equal(rep.chain.report.inputs.settled_volume_usd, 200);
    // the same fact twice is refused on-chain and marked, never double counted
    engine.state.credit.outbox.push({ event_id: rep.events[0].id, subject: p.id, agent_id: agentId, status: 'pending', attempts: 0 });
    await engine.credit.flush();
    assert.equal(engine.state.credit.outbox.at(-1).note, 'already recorded');
    assert.equal((await engine.creditReport(p.id)).chain.score, 58);
    const status = await engine.creditStatus();
    assert.equal(status.chain.attester, attester.address); assert.equal(status.chain.can_write, true);
  } finally {
    anvil.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
