import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildLaunchIntent, parseLaunchReceipt, LAUNCH_SIG, TOKEN_LAUNCHED_TOPIC, PONS, ponsConfig, readCurve } from '../src/chain/pons.js';
import { decodeParams, toHex, selector, encodeParams } from '../src/chain/abi.js';
import { keccakHex } from '../src/chain/keccak.js';
import { createRpc } from '../src/chain/rpc.js';
import { createEngine } from '../src/engine.js';
import { createApp } from '../server.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222', CURVE = '0x3333333333333333333333333333333333333333';
const pad = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();

// A fake Robinhood Chain node: answers the receipt and the curve's views.
function fakeChain({ receipt = null, reserves = [5_000n * 10n ** 6n, 800_000_000n * 10n ** 18n], real = 1_200n * 10n ** 6n, graduated = false, ready = false, threshold = 4_200n * 10n ** 6n, feeBalance = 37n * 10n ** 6n } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const { id, method, params } = JSON.parse(body); calls.push(method);
      let result = null;
      if (method === 'eth_chainId') result = '0x1237';
      if (method === 'eth_getTransactionReceipt') result = receipt;
      if (method === 'eth_call') {
        const sel = params[0].data.slice(0, 10);
        if (sel === toHex(selector('getReserves()'))) result = pad(reserves[0]) + pad(reserves[1]).slice(2);
        else if (sel === toHex(selector('realQuoteReserve()'))) result = pad(real);
        else if (sel === toHex(selector('graduated()'))) result = pad(graduated ? 1 : 0);
        else if (sel === toHex(selector('readyToGraduate()'))) result = pad(ready ? 1 : 0);
        else if (sel === toHex(selector('graduationThreshold()'))) result = pad(threshold);
        else if (sel === toHex(selector('launchFee()'))) result = pad(500000000000000n);
        else if (sel === toHex(selector('feeEscrow()'))) result = pad(BigInt('0x4444444444444444444444444444444444444444'));
        else if (sel === toHex(selector('balanceOfToken(address,address)')) || sel === toHex(selector('balanceOf(address)'))) result = pad(feeBalance);
        else result = '0x';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}
const launchReceipt = (pairToken = PONS.pairs.USDG.address, deployer = WALLET) => ({
  status: '0x1', blockNumber: '0x10',
  logs: [
    { address: '0x9999999999999999999999999999999999999999', topics: ['0xdead'], data: '0x' },
    { address: PONS.factory.toLowerCase(), topics: [TOKEN_LAUNCHED_TOPIC, topicAddr(TOKEN), topicAddr(CURVE), topicAddr(deployer)], data: toHex(encodeParams(['address', 'uint256', 'uint256'], [pairToken, 0n, 4_200n * 10n ** 6n])) },
  ],
});

test('pons: the launch intent is the exact launchToken calldata, with the launcher as creator-fee recipient by default', () => {
  const intent = buildLaunchIntent({ symbol: 'calc', name: 'Calc agent', description: 'Does arithmetic for a living', wallet: WALLET, pair: 'USDG', creator_tax_bps: 250, socials: { twitter: '@calc' }, agent_id: 'agt_1' });
  assert.equal(intent.to, PONS.factory); assert.equal(intent.chain_id, 4663);
  assert.equal(intent.data.slice(0, 10), toHex(selector(LAUNCH_SIG)));
  const [params, configId, pairToken] = decodeParams(['(string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32)', 'uint256', 'address'], '0x' + intent.data.slice(10));
  assert.equal(params[0], 'Calc agent'); assert.equal(params[1], 'CALC'); assert.equal(params[3], 'Does arithmetic for a living');
  assert.deepEqual(params[4], ['@calc', '', '', '', '']);
  assert.equal(params[5], WALLET, 'creator fees go to the launcher');
  assert.equal(params[6], 250n); assert.equal(params[7], false);
  assert.equal(params[8], '0x' + '00'.repeat(32), 'no economics pin');
  assert.equal(params[9], keccakHex('vouch:agt_1:' + WALLET), 'deterministic salt per agent and wallet');
  assert.equal(configId, 0n); assert.equal(pairToken, PONS.pairs.USDG.address);
  assert.equal(intent.value_wei, '500000000000000');
  // guards
  assert.throws(() => buildLaunchIntent({ symbol: 'X', wallet: 'nope' }), /wallet/);
  assert.throws(() => buildLaunchIntent({ symbol: 'X', wallet: WALLET, creator_tax_bps: 5000 }), /creator_tax_bps/);
  assert.throws(() => buildLaunchIntent({ symbol: 'X', wallet: WALLET, pair: 'DOGE' }), /pair/);
  const eth = buildLaunchIntent({ symbol: 'X', wallet: WALLET, pair: 'ETH' });
  assert.equal(eth.params.pair_token, '0x0000000000000000000000000000000000000000', 'native quote is address zero');
  // a configured recipient (the future bond vault) overrides the wallet
  const cfg = ponsConfig({ VOUCH_CREATOR_FEE_RECIPIENT: '0x5555555555555555555555555555555555555555' });
  assert.equal(buildLaunchIntent({ symbol: 'X', wallet: WALLET }, cfg).params.creator_fee_recipient, '0x5555555555555555555555555555555555555555');
});

test('pons: the TokenLaunched log is read from the receipt, other logs ignored', () => {
  const launch = parseLaunchReceipt(launchReceipt());
  assert.equal(launch.token, TOKEN); assert.equal(launch.curve, CURVE); assert.equal(launch.deployer, WALLET);
  assert.equal(launch.pair_token, PONS.pairs.USDG.address); assert.equal(launch.launch_config_id, 0); assert.equal(launch.graduation_threshold, (4_200n * 10n ** 6n).toString());
  assert.equal(parseLaunchReceipt({ logs: [] }), null);
});

test('pons: the curve prices the token in the quote asset', async () => {
  const chain = await fakeChain();
  try {
    const c = await readCurve(createRpc(chain.url), CURVE, PONS.pairs.USDG);
    assert.equal(c.price_quote, 5000 / 800_000_000); assert.equal(c.real_quote_reserve, 1200); assert.equal(c.graduation_progress, 1200 / 4200);
    assert.equal(c.graduated, false);
  } finally { chain.close(); }
});

test('engine: launching on Pons prepares the transaction, confirms from the receipt, and prices from the curve', async () => {
  const chain = await fakeChain({ receipt: launchReceipt() });
  try {
    const engine = createEngine({ fast: true, chain: ponsConfig({ VOUCH_CHAIN_RPC: chain.url }) });
    const key = engine.createKey('t');
    const a = engine.launchAgent({ symbol: 'CALC', name: 'Calc agent', launch: { venue: 'pons', wallet: WALLET, pair: 'USDG', creator_tax_bps: 100 } }, key);
    assert.equal(a.chain.status, 'awaiting_signature');
    assert.equal(a.chain.intent.to, PONS.factory); assert.ok(a.chain.intent.data.startsWith(toHex(selector(LAUNCH_SIG))));
    assert.equal(a.token.twap_usdg, 0, 'no price until the launch is on-chain');
    assert.equal(a.bond.capacity_usdg, 0);
    // a stranger cannot confirm
    await assert.rejects(engine.confirmLaunch(a.id, '0x' + 'ab'.repeat(32), { key: engine.createKey('x') }), /Only the key/);
    const live = await engine.confirmLaunch(a.id, '0x' + 'ab'.repeat(32), { key });
    assert.equal(live.chain.status, 'live');
    assert.equal(live.chain.token, TOKEN); assert.equal(live.chain.curve, CURVE); assert.equal(live.token.address, TOKEN);
    assert.equal(live.chain.pair, 'USDG');
    assert.equal(live.token.twap_usdg, 0.00000625, 'USDG-quoted: price is dollars');
    assert.equal(live.token.pool_liquidity_usdg, 1200);
    assert.equal(live.chain.creator_fees.balance, 37, 'creator fees accrued in the Pons escrow');
    assert.equal(live.chain.curve_state.graduation_progress, 1200 / 4200);
    assert.equal(live.chain.price_usd, 0.00000625); assert.equal(live.chain.liquidity_usd, 1200);
    assert.throws(() => engine.setAgentPrice(a.id, { twap_usdg: 5 }, { key }), /on-chain curve/);
    // confirming with a wallet mismatch is refused
    const chain2 = await fakeChain({ receipt: launchReceipt(PONS.pairs.USDG.address, '0x7777777777777777777777777777777777777777') });
    try {
      const e2 = createEngine({ fast: true, chain: ponsConfig({ VOUCH_CHAIN_RPC: chain2.url }) });
      const k2 = e2.createKey('t');
      const b = e2.launchAgent({ symbol: 'B', launch: { wallet: WALLET } }, k2);
      await assert.rejects(e2.confirmLaunch(b.id, '0x' + 'cd'.repeat(32), { key: k2 }), /different wallet/);
    } finally { chain2.close(); }
  } finally { chain.close(); }
});

test('engine: a pending transaction answers pending, not an error', async () => {
  const chain = await fakeChain({ receipt: null });
  try {
    const engine = createEngine({ fast: true, chain: ponsConfig({ VOUCH_CHAIN_RPC: chain.url }) });
    const key = engine.createKey('t');
    const a = engine.launchAgent({ symbol: 'P', launch: { wallet: WALLET } }, key);
    const out = await engine.confirmLaunch(a.id, '0x' + 'ef'.repeat(32), { key });
    assert.equal(out.pending, true); assert.equal(out.chain.status, 'pending');
  } finally { chain.close(); }
});

test('api: GET /v1/launchpad/pons describes the venue; POST .../launch/confirm returns 202 while pending', async () => {
  const chain = await fakeChain({ receipt: null });
  const { server } = createApp({ fast: true, chain: ponsConfig({ VOUCH_CHAIN_RPC: chain.url }) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const cfg = await (await fetch(`${base}/v1/launchpad/pons`)).json();
    assert.equal(cfg.chain_id, 4663); assert.equal(cfg.chain_id_hex, '0x1237'); assert.equal(cfg.factory, PONS.factory);
    assert.ok(cfg.pairs.some((p) => p.symbol === 'USDG'));
    assert.equal(cfg.claim_selectors.claim, toHex(selector('claim()'))); assert.equal(cfg.claim_selectors.claim_token, toHex(selector('claimToken(address)')));
    const key = (await (await fetch(`${base}/v1/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).key;
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    const a = await (await fetch(`${base}/v1/agents`, { method: 'POST', headers: h, body: JSON.stringify({ symbol: 'API', launch: { wallet: WALLET } }) })).json();
    assert.equal(a.chain.status, 'awaiting_signature');
    const r = await fetch(`${base}/v1/agents/${a.id}/launch/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ tx_hash: '0x' + '12'.repeat(32) }) });
    assert.equal(r.status, 202);
    const bad = await fetch(`${base}/v1/agents/${a.id}/launch/confirm`, { method: 'POST', headers: h, body: JSON.stringify({ tx_hash: 'nope' }) });
    assert.equal(bad.status, 400);
  } finally { server.close(); chain.close(); }
});
