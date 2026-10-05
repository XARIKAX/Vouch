// pump.fun launches: the create instruction, reading a confirmed launch,
// the bonding curve, creator fees, the claim, the engine and API flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildLaunchIntent, buildClaimIntent, parseLaunchTransaction, decodeCurve, readCurve, readCreatorFees, tokenMetadata, pumpConfig, pda, DISC, PUMP, solUsd } from '../src/chain/pump.js';
import { PROGRAMS, associatedTokenAddress } from '../src/chain/solana.js';
import { encodeBase58, decodeBase58 } from '../src/chain/base58.js';
import { randomKeypair } from '../src/chain/ed25519.js';
import { createRpc } from '../src/chain/rpc.js';
import { u64le, concat } from '../public/assets/solmsg.js';
import { createEngine } from '../src/engine.js';
import { createApp } from '../server.js';

const WALLET = randomKeypair().address, MINT = randomKeypair().address;
const SIG = encodeBase58(Buffer.alloc(64, 7));
const sol = (n) => BigInt(Math.round(n * 1e9)), tok = (n) => BigInt(Math.round(n * 1e6));
const curveData = ({ vTok = 1_073_000_000, vSol = 30, rTok = 793_100_000, rSol = 0, supply = 1_000_000_000, complete = false, creator = WALLET } = {}) =>
  concat(new Uint8Array(8), u64le(tok(vTok)), u64le(sol(vSol)), u64le(tok(rTok)), u64le(sol(rSol)), u64le(tok(supply)), Uint8Array.of(complete ? 1 : 0), decodeBase58(creator));

// A fake Solana node: a confirmed transaction by signature, curve account data, balances.
function fakeChain({ tx = null, curve = curveData(), vaultLamports = 890880n + 370_000_000n } = {}) {
  const calls = [], sent = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const { id, method, params } = JSON.parse(body); calls.push(method);
      let result = null;
      if (method === 'getTransaction') result = typeof tx === 'function' ? tx(params[0]) : tx;
      else if (method === 'getAccountInfo') result = { context: { slot: 1 }, value: curve ? { data: [Buffer.from(curve).toString('base64'), 'base64'], owner: PUMP.program, lamports: 1 } : null };
      else if (method === 'getBalance') result = { context: { slot: 1 }, value: Number(vaultLamports) };
      else if (method === 'getMinimumBalanceForRentExemption') result = 890880;
      else if (method === 'getLatestBlockhash') result = { context: { slot: 1 }, value: { blockhash: encodeBase58(Buffer.alloc(32, 3)), lastValidBlockHeight: 100 } };
      else if (method === 'sendTransaction') { sent.push(params[0]); result = SIG; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, sent, close: () => server.close() })));
}
// A confirmed create transaction in jsonParsed shape, built from an intent.
const launchTx = (intent, { err = null, deployer } = {}) => {
  const ixn = intent.instructions[0];
  const accounts = ixn.keys.map((k) => k.pubkey); if (deployer) accounts[7] = deployer;
  return { slot: 1234, blockTime: 1700000000, meta: { err, innerInstructions: [] }, transaction: { message: { instructions: [{ programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: '3' }, { programId: ixn.program_id, accounts, data: encodeBase58(Buffer.from(ixn.data, 'base64')) }] } } };
};

test('pump: the launch intent is the exact create instruction, with the launcher as creator by default and the metadata URI on Vouch', () => {
  const cfg = pumpConfig({ VOUCH_PUBLIC_URL: 'https://vouch.example' });
  const intent = buildLaunchIntent({ symbol: 'calc', name: 'Calc agent', description: 'Does arithmetic for a living', wallet: WALLET, mint: MINT, socials: { twitter: '@calc' }, agent_id: 'agt_1', logo: 'https://img/x.png' }, cfg);
  assert.equal(intent.venue, 'pump'); assert.equal(intent.program, PUMP.program); assert.equal(intent.fee_payer, WALLET); assert.equal(intent.mint, MINT);
  assert.equal(intent.creator, WALLET, 'creator fees go to the launcher');
  assert.deepEqual(intent.signers, [WALLET, MINT]);
  assert.equal(intent.bonding_curve, pda.bondingCurve(MINT)); assert.equal(intent.creator_vault, pda.creatorVault(WALLET));
  const ixn = intent.instructions[0];
  assert.equal(ixn.program_id, PUMP.program);
  assert.deepEqual(ixn.keys.map((k) => k.pubkey), [MINT, pda.mintAuthority(), pda.bondingCurve(MINT), associatedTokenAddress(pda.bondingCurve(MINT), MINT), pda.global(), PROGRAMS.metadata, pda.metadata(MINT), WALLET, PROGRAMS.system, PROGRAMS.token, PROGRAMS.associatedToken, PROGRAMS.rent, pda.eventAuthority(), PUMP.program]);
  assert.deepEqual(ixn.keys.filter((k) => k.is_signer).map((k) => k.pubkey), [MINT, WALLET]);
  const data = Buffer.from(ixn.data, 'base64');
  assert.deepEqual([...data.subarray(0, 8)], [...DISC.create]);
  const parsed = parseLaunchTransaction(launchTx(intent));
  assert.equal(parsed.name, 'Calc agent'); assert.equal(parsed.symbol, 'CALC'); assert.equal(parsed.uri, 'https://vouch.example/v1/agents/agt_1/token.json'); assert.equal(parsed.creator, WALLET);
  assert.equal(parsed.token, MINT); assert.equal(parsed.curve, pda.bondingCurve(MINT)); assert.equal(parsed.deployer, WALLET); assert.equal(parsed.slot, 1234);
  assert.deepEqual(tokenMetadata(intent.params), { name: 'Calc agent', symbol: 'CALC', description: 'Does arithmetic for a living', image: 'https://img/x.png', showName: true, createdOn: 'https://pump.fun', twitter: '@calc' });
  // guards
  assert.throws(() => buildLaunchIntent({ symbol: 'X', wallet: '0xnope', mint: MINT }), /wallet/);
  assert.throws(() => buildLaunchIntent({ symbol: 'X', wallet: WALLET }), /mint/);
  assert.throws(() => buildLaunchIntent({ symbol: 'X', wallet: WALLET, mint: MINT, pair: 'USDT' }), /SOL/);
  assert.equal(buildLaunchIntent({ symbol: 'averyverylongsymbol', wallet: WALLET, mint: MINT }).params.symbol.length, 10, 'symbol clamped to the metadata limit');
  // a configured recipient (the future bond vault) overrides the wallet
  const vault = randomKeypair().address;
  assert.equal(buildLaunchIntent({ symbol: 'X', wallet: WALLET, mint: MINT }, pumpConfig({ VOUCH_CREATOR_FEE_RECIPIENT: vault })).creator, vault);
  // the claim
  const claim = buildClaimIntent(WALLET);
  assert.deepEqual(claim.instructions[0].keys.map((k) => k.pubkey), [WALLET, pda.creatorVault(WALLET), PROGRAMS.system, pda.eventAuthority(), PUMP.program]);
  assert.deepEqual([...Buffer.from(claim.instructions[0].data, 'base64')], [...DISC.collectCreatorFee]);
  assert.equal(parseLaunchTransaction({ transaction: { message: { instructions: [] } } }), null);
});

test('pump: the curve prices the token in SOL and reports graduation; creator fees are what sits above the rent floor', async () => {
  const c = decodeCurve(curveData({ vTok: 1_000_000_000, vSol: 40, rSol: 17, rTok: 700_000_000 }));
  assert.equal(c.price_quote, 40 / 1_000_000_000); assert.equal(c.real_quote_reserve, 17); assert.equal(c.graduation_progress, 17 / 85);
  assert.equal(c.graduated, false); assert.equal(c.pair, 'SOL'); assert.equal(c.creator, WALLET); assert.equal(c.token_reserve, 700_000_000);
  assert.equal(decodeCurve(curveData({ complete: true, rSol: 90 })).graduated, true);
  assert.throws(() => decodeCurve(new Uint8Array(10)), /not a bonding curve/);
  const chain = await fakeChain();
  try {
    const rpc = createRpc(chain.url);
    const read = await readCurve(rpc, pda.bondingCurve(MINT), pumpConfig());
    assert.equal(read.price_quote, 30 / 1_073_000_000);
    const fees = await readCreatorFees(rpc, WALLET, pumpConfig());
    assert.equal(fees.vault, pda.creatorVault(WALLET)); assert.equal(fees.balance, 0.37); assert.equal(fees.pair, 'SOL');
  } finally { chain.close(); }
});

test('pump: the SOL rate is fixed by env or read from the operator\'s URL, cached a minute', async () => {
  assert.equal(await solUsd(pumpConfig({ VOUCH_SOL_USD: '150' })), 150);
  assert.equal(await solUsd(pumpConfig({})), null);
  let hits = 0;
  const fetchImpl = async () => { hits++; return { ok: true, json: async () => ({ data: { SOL: { price: 142.5 } } }) }; };
  const cfg = pumpConfig({ VOUCH_SOL_USD_URL: 'https://price.example/sol?' + Math.random(), VOUCH_SOL_USD_PATH: 'data.SOL.price' });
  assert.equal(await solUsd(cfg, fetchImpl), 142.5); assert.equal(await solUsd(cfg, fetchImpl), 142.5); assert.equal(hits, 1, 'cached');
  const bad = pumpConfig({ VOUCH_SOL_USD_URL: 'https://price.example/bad?' + Math.random() });
  assert.equal(await solUsd(bad, async () => ({ ok: false })), null);
});

test('engine: launching on pump.fun prepares the instruction, confirms from the transaction, and prices from the curve', async () => {
  const txs = {};
  const chain = await fakeChain({ tx: (sig) => txs[sig] ?? null });
  try {
    const engine = createEngine({ fast: true, chain: pumpConfig({ VOUCH_CHAIN_RPC: chain.url, VOUCH_SOL_USD: '100' }) });
    const key = engine.createKey('t');
    const a = engine.launchAgent({ symbol: 'CALC', name: 'Calc agent', launch: { venue: 'pump', wallet: WALLET, mint: MINT, description: 'adds things' } }, key);
    assert.equal(a.chain.status, 'awaiting_signature'); assert.equal(a.chain.venue, 'pump'); assert.equal(a.chain.mint, MINT);
    assert.equal(a.chain.intent.instructions[0].program_id, PUMP.program); assert.deepEqual(a.chain.intent.signers, [WALLET, MINT]);
    assert.ok(!('data' in a.chain.intent) && !('to' in a.chain.intent), 'no EVM fields');
    assert.equal(a.token.twap_usdg, 0, 'no price until the launch is on-chain');
    assert.deepEqual(engine.agentTokenMetadata(a.id).symbol, 'CALC');
    assert.equal(engine.agentClaimIntent(a.id).fee_payer, WALLET);
    // a stranger cannot confirm; a pending signature answers pending
    await assert.rejects(engine.confirmLaunch(a.id, SIG, { key: engine.createKey('x') }), /Only the key/);
    const pending = await engine.confirmLaunch(a.id, SIG, { key });
    assert.equal(pending.pending, true); assert.equal(pending.chain.status, 'pending');
    await assert.rejects(engine.confirmLaunch(a.id, '0xabc', { key }), /signature/);
    txs[SIG] = launchTx(a.chain.intent);
    const live = await engine.confirmLaunch(a.id, SIG, { key });
    assert.equal(live.chain.status, 'live'); assert.equal(live.chain.token, MINT); assert.equal(live.chain.curve, pda.bondingCurve(MINT)); assert.equal(live.token.address, MINT);
    assert.equal(live.chain.pair, 'SOL'); assert.equal(live.chain.creator_fee_recipient, WALLET);
    assert.equal(live.chain.sol_usd, 100);
    assert.equal(live.token.twap_usdg, Number(((30 / 1_073_000_000) * 100).toPrecision(12)), 'SOL price times the rate');
    assert.equal(live.chain.creator_fees.balance, 0.37, 'creator fees accrued in the vault');
    assert.equal(live.chain.curve_state.graduation_progress, 0);
    assert.throws(() => engine.setAgentPrice(a.id, { twap_usdg: 5 }, { key }), /on-chain curve/);
    // the wrong wallet or a different mint is refused
    const e2 = createEngine({ fast: true, chain: pumpConfig({ VOUCH_CHAIN_RPC: chain.url }) });
    const k2 = e2.createKey('t');
    const b = e2.launchAgent({ symbol: 'B', launch: { wallet: WALLET, mint: MINT } }, k2);
    const other = encodeBase58(Buffer.alloc(64, 8)); txs[other] = launchTx(b.chain.intent, { deployer: randomKeypair().address });
    await assert.rejects(e2.confirmLaunch(b.id, other, { key: k2 }), /different wallet/);
    const c3 = e2.launchAgent({ symbol: 'C', launch: { wallet: WALLET, mint: randomKeypair().address } }, k2);
    const third = encodeBase58(Buffer.alloc(64, 9)); txs[third] = launchTx(b.chain.intent);
    await assert.rejects(e2.confirmLaunch(c3.id, third, { key: k2 }), /different token/);
    // a failed transaction
    const failed = encodeBase58(Buffer.alloc(64, 10)); txs[failed] = launchTx(b.chain.intent, { err: { InstructionError: [1, 'Custom'] } });
    await assert.rejects(e2.confirmLaunch(b.id, failed, { key: k2 }), /failed on-chain/);
    // without a SOL rate the bond has no dollar value, and says so
    const e3 = createEngine({ fast: true, chain: pumpConfig({ VOUCH_CHAIN_RPC: chain.url }) });
    const k3 = e3.createKey('t');
    const d = e3.launchAgent({ symbol: 'D', launch: { wallet: WALLET, mint: MINT } }, k3);
    txs[SIG] = launchTx(d.chain.intent);
    const liveD = await e3.confirmLaunch(d.id, SIG, { key: k3 });
    assert.equal(liveD.chain.price_usd, null); assert.equal(liveD.chain.sol_usd, null); assert.equal(liveD.token.twap_usdg, 0);
  } finally { chain.close(); }
});

test('api: GET /v1/launchpad/pump describes the venue; token.json and the claim are public; confirm returns 202 while pending', async () => {
  const chain = await fakeChain({ tx: null });
  const { server } = createApp({ fast: true, chain: pumpConfig({ VOUCH_CHAIN_RPC: chain.url, VOUCH_PUBLIC_URL: 'https://vouch.example' }) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/v1/launchpad/pump`)).json();
    assert.equal(cfg.venue, 'pump'); assert.equal(cfg.cluster, 'mainnet-beta'); assert.equal(cfg.program, PUMP.program); assert.equal(cfg.pair.symbol, 'SOL'); assert.equal(cfg.site, 'https://pump.fun');
    const key = (await (await fetch(`${base}/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).key;
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    const a = await (await fetch(`${base}/v1/agents`, { method: 'POST', headers: h, body: JSON.stringify({ symbol: 'API', name: 'Api agent', launch: { wallet: WALLET, mint: MINT, description: 'd', socials: { website: 'https://x.y' } } }) })).json();
    assert.equal(a.chain.status, 'awaiting_signature');
    assert.equal(a.chain.intent.params.uri, `https://vouch.example/v1/agents/${a.id}/token.json`);
    const meta = await (await fetch(`${base}/v1/agents/${a.id}/token.json`)).json();
    assert.equal(meta.name, 'Api agent'); assert.equal(meta.symbol, 'API'); assert.equal(meta.website, 'https://x.y');
    const claim = await (await fetch(`${base}/v1/agents/${a.id}/claim`)).json();
    assert.equal(claim.creator_vault, pda.creatorVault(WALLET));
    const r = await fetch(`${base}/v1/agents/${a.id}/launch/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ signature: SIG }) });
    assert.equal(r.status, 202);
    const bad = await fetch(`${base}/v1/agents/${a.id}/launch/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ tx_hash: 'nope' }) });
    assert.equal(bad.status, 400);
  } finally { server.close(); chain.close(); }
});
