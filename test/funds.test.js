import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEngine } from '../src/engine.js';
import { createApp } from '../server.js';
import { fundsConfig, TRANSFER_TOPIC, toUnits } from '../src/chain/funds.js';
import { ponsConfig, PONS } from '../src/chain/pons.js';
import { addressFromPrivate, signPersonal, recover, addressOf } from '../src/chain/secp256k1.js';
import { rlpDecode, rlp } from '../src/chain/tx.js';
import { keccak256 } from '../src/chain/keccak.js';
import { encodeParams, toHex } from '../src/chain/abi.js';
import { createSpend } from '../src/spend.js';

const USER_KEY = '0x' + '42'.repeat(32), USER = addressFromPrivate(USER_KEY);
const TREASURY_KEY = '0x' + '77'.repeat(32), TREASURY = addressFromPrivate(TREASURY_KEY);
const USDG = PONS.pairs.USDG.address;
const pad = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const transferReceipt = (from, to, units, token = USDG) => ({ status: '0x1', blockNumber: '0x20', logs: [{ address: token, topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)], data: toHex(encodeParams(['uint256'], [units])) }] });

// a fake node: receipts by hash, and enough to accept a signed payout
function fakeChain() {
  const receipts = {}, sent = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      let result = null;
      if (method === 'eth_chainId') result = '0x1237';
      else if (method === 'eth_getTransactionReceipt') result = receipts[String(params[0]).toLowerCase()] ?? null;
      else if (method === 'eth_getTransactionCount') result = '0x5';
      else if (method === 'eth_gasPrice') result = '0x5f5e100';
      else if (method === 'eth_maxPriorityFeePerGas') result = '0x0';
      else if (method === 'eth_estimateGas') result = '0xea60';
      else if (method === 'eth_sendRawTransaction') { sent.push(params[0]); result = '0x' + keccak256(Buffer.from(params[0].slice(2), 'hex')).toString('hex'); }
      else result = '0x';
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, receipts, sent, close: () => server.close() })));
}
const realCfg = (url, extra = {}) => ({ fast: true, chain: ponsConfig({ VOUCH_CHAIN_RPC: url }), funds: fundsConfig({ VOUCH_REAL_FUNDS: '1', VOUCH_TREASURY_ADDRESS: TREASURY, ...extra }) });

test('funds: sandbox deployments keep the faucet and refuse real-money endpoints', async () => {
  const e = createEngine({ fast: true });
  const k = e.createKey('t');
  assert.equal(e.balance(k).balance, 5);
  await assert.rejects(e.confirmDeposit(k, '0x' + '11'.repeat(32)), /sandbox/);
  await assert.rejects(e.requestWithdrawal(k, 2), /sandbox/);
  assert.equal(e.fundsInfo().mode, 'sandbox');
});

test('auth: a wallet signature mints an account, and signing again recovers it with a fresh key', () => {
  const e = createEngine({ fast: true });
  const { message, nonce } = e.authNonce(USER);
  assert.ok(message.includes(USER) && message.includes(nonce));
  // the wrong wallet's signature is refused
  assert.throws(() => e.authVerify(USER, signPersonal(message, '0x' + '99'.repeat(32))), /not made by this wallet/);
  const first = e.authVerify(USER, signPersonal(message, USER_KEY));
  assert.equal(first.recovered, false); assert.equal(first.wallet, USER.toLowerCase());
  const key = e.authenticate(first.key);
  assert.equal(key.wallet, USER.toLowerCase()); assert.equal(e.me(key).wallet, USER.toLowerCase());
  // a nonce is single use
  assert.throws(() => e.authVerify(USER, signPersonal(message, USER_KEY)), /new sign-in message/);
  // recovery: same wallet, same account, new token; the old one is dead
  const again = e.authNonce(USER);
  const second = e.authVerify(USER, signPersonal(again.message, USER_KEY));
  assert.equal(second.recovered, true); assert.equal(second.id, first.id); assert.notEqual(second.key, first.key);
  assert.throws(() => e.authenticate(first.key), /revoked|invalid/i);
  assert.equal(e.authenticate(second.key).id, first.id);
});

test('funds: a real deployment credits a verified USDG deposit once, from the signed-in wallet only', async () => {
  const chain = await fakeChain();
  try {
    const e = createEngine(realCfg(chain.url));
    const { message } = e.authNonce(USER);
    const key = e.authenticate(e.authVerify(USER, signPersonal(message, USER_KEY)).key);
    assert.equal(e.balance(key).balance, 0, 'no faucet with real funds');
    assert.throws(() => e.deposit(key, 2), /Simulated deposits are off/);
    const tx = '0x' + 'aa'.repeat(32);
    // pending first
    assert.equal((await e.confirmDeposit(key, tx)).pending, true);
    chain.receipts[tx] = transferReceipt(USER, TREASURY, 25_500000n);
    const out = await e.confirmDeposit(key, tx);
    assert.equal(out.amount, 25.5); assert.equal(out.balance, 25.5); assert.equal(out.status, 'credited');
    const twice = await e.confirmDeposit(key, tx);
    assert.equal(twice.already_credited, true); assert.equal(e.balance(key).balance, 25.5, 'never credited twice');
    // someone else's deposit cannot be claimed
    const other = '0x' + 'bb'.repeat(32); chain.receipts[other] = transferReceipt('0x' + '55'.repeat(20), TREASURY, 1_000000n);
    await assert.rejects(e.confirmDeposit(key, other), /different wallet/);
    // a transfer to the wrong place is not a deposit
    const wrong = '0x' + 'cc'.repeat(32); chain.receipts[wrong] = transferReceipt(USER, '0x' + '66'.repeat(20), 1_000000n);
    await assert.rejects(e.confirmDeposit(key, wrong), /not transfer/);
    // a key without a wallet cannot deposit
    await assert.rejects(e.confirmDeposit(e.createKey('anon'), tx), /Sign in with a wallet/);
  } finally { chain.close(); }
});

test('funds: a withdrawal debits the ledger and the treasury signs a transfer to the wallet', async () => {
  const chain = await fakeChain();
  try {
    const e = createEngine(realCfg(chain.url, { VOUCH_TREASURY_KEY: TREASURY_KEY }));
    assert.equal(e.fundsInfo().payouts, 'automatic');
    const { message } = e.authNonce(USER);
    const key = e.authenticate(e.authVerify(USER, signPersonal(message, USER_KEY)).key);
    const dep = '0x' + 'aa'.repeat(32); chain.receipts[dep] = transferReceipt(USER, TREASURY, 40_000000n);
    await e.confirmDeposit(key, dep);
    await assert.rejects(e.requestWithdrawal(key, 0.5), /Minimum/);
    await assert.rejects(e.requestWithdrawal(key, 100), /Available balance/);
    const w = await e.requestWithdrawal(key, 12.25);
    assert.equal(w.status, 'sent'); assert.ok(w.tx_hash); assert.equal(w.balance, 27.75);
    // the raw transaction: type 2, to the USDG contract, transfer(wallet, 12.25e6), signed by the treasury
    assert.equal(chain.sent.length, 1);
    const bytes = Buffer.from(chain.sent[0].slice(2), 'hex');
    assert.equal(bytes[0], 2);
    const f = rlpDecode(bytes, 1).value;
    assert.equal('0x' + f[5].toString('hex'), USDG.toLowerCase());
    const data = '0x' + f[7].toString('hex');
    assert.equal(data.slice(0, 10), '0xa9059cbb');
    assert.equal('0x' + data.slice(34, 74), USER.toLowerCase());
    assert.equal(BigInt('0x' + data.slice(74)), toUnits(12.25));
    const signing = keccak256(Buffer.concat([Buffer.from([2]), rlp(f.slice(0, 9).map((b, i) => i === 8 ? [] : b))]));
    assert.equal(addressOf(recover(signing, BigInt('0x' + f[10].toString('hex')), BigInt('0x' + f[11].toString('hex')), f[9].length ? f[9][0] : 0)).toLowerCase(), TREASURY.toLowerCase());
    // confirmed on-chain → paid
    chain.receipts[w.tx_hash] = transferReceipt(TREASURY, USER, 12_250000n);
    const paid = await e.confirmPayout(w.id);
    assert.equal(paid.status, 'paid'); assert.ok(paid.explorer.includes(w.tx_hash));
    assert.equal(e.listWithdrawals(key)[0].status, 'paid');
    assert.equal(e.listPendingWithdrawals().length, 0);
  } finally { chain.close(); }
});

test('funds: without a treasury key a withdrawal waits for the operator, and a short payout is refused', async () => {
  const chain = await fakeChain();
  try {
    const e = createEngine(realCfg(chain.url));
    assert.equal(e.fundsInfo().payouts, 'operator');
    const { message } = e.authNonce(USER);
    const key = e.authenticate(e.authVerify(USER, signPersonal(message, USER_KEY)).key);
    const dep = '0x' + 'aa'.repeat(32); chain.receipts[dep] = transferReceipt(USER, TREASURY, 10_000000n);
    await e.confirmDeposit(key, dep);
    const w = await e.requestWithdrawal(key, 4);
    assert.equal(w.status, 'pending'); assert.equal(w.balance, 6); assert.equal(chain.sent.length, 0);
    assert.equal(e.listPendingWithdrawals()[0].id, w.id);
    const short = '0x' + 'dd'.repeat(32); chain.receipts[short] = transferReceipt(TREASURY, USER, 3_000000n);
    await assert.rejects(e.confirmPayout(w.id, short), /smaller/);
    const full = '0x' + 'ee'.repeat(32); chain.receipts[full] = transferReceipt(TREASURY, USER, 4_000000n);
    assert.equal((await e.confirmPayout(w.id, full)).status, 'paid');
  } finally { chain.close(); }
});

test('funds: a failed automatic payout gives the balance back', async () => {
  const chain = await fakeChain();
  try {
    const e = createEngine(realCfg('http://127.0.0.1:1', { VOUCH_TREASURY_KEY: TREASURY_KEY }));   // unreachable node for the send
    // credit through a reachable node first
    e.cfg.chain = ponsConfig({ VOUCH_CHAIN_RPC: chain.url });
    const { message } = e.authNonce(USER);
    const key = e.authenticate(e.authVerify(USER, signPersonal(message, USER_KEY)).key);
    const dep = '0x' + 'aa'.repeat(32); chain.receipts[dep] = transferReceipt(USER, TREASURY, 10_000000n);
    await e.confirmDeposit(key, dep);
    e.cfg.chain = ponsConfig({ VOUCH_CHAIN_RPC: 'http://127.0.0.1:1' });
    await assert.rejects(e.requestWithdrawal(key, 5), /could not be sent/);
    assert.equal(e.balance(key).balance, 10, 'refunded');
    assert.equal(e.listWithdrawals(key)[0].status, 'failed');
  } finally { chain.close(); }
});

test('api: sign-in, deposit confirm and withdrawal over HTTP; admin lists and pays', async () => {
  const chain = await fakeChain();
  const { server } = createApp({ ...realCfg(chain.url), adminToken: 'adm' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const funds = await (await fetch(`${base}/v1/funds`)).json();
    assert.equal(funds.mode, 'real'); assert.equal(funds.treasury, TREASURY); assert.equal(funds.token.symbol, 'USDG');
    const n = await (await post('/v1/auth/nonce', { address: USER })).json();
    const v = await (await post('/v1/auth/verify', { address: USER, signature: signPersonal(n.message, USER_KEY) })).json();
    const h = { Authorization: `Bearer ${v.key}` };
    const me = await (await fetch(`${base}/v1/me`, { headers: h })).json();
    assert.equal(me.wallet, USER.toLowerCase()); assert.equal(me.funds, 'real');
    const dep = '0x' + 'aa'.repeat(32);
    assert.equal((await post('/v1/escrow/deposits/confirm', { tx_hash: dep }, h)).status, 202);
    chain.receipts[dep] = transferReceipt(USER, TREASURY, 9_000000n);
    const c = await post('/v1/escrow/deposits/confirm', { tx_hash: dep }, h);
    assert.equal(c.status, 200); assert.equal((await c.json()).balance, 9);
    const w = await (await post('/v1/withdrawals', { amount: 2 }, h)).json();
    assert.equal(w.status, 'pending');
    assert.equal((await fetch(`${base}/v1/admin/withdrawals`)).status, 403);
    const pend = await (await fetch(`${base}/v1/admin/withdrawals`, { headers: { 'X-Admin-Token': 'adm' } })).json();
    assert.equal(pend.withdrawals[0].id, w.id);
    const tx = '0x' + 'ff'.repeat(32); chain.receipts[tx] = transferReceipt(TREASURY, USER, 2_000000n);
    const paid = await (await post(`/v1/admin/withdrawals/${w.id}/paid`, { tx_hash: tx }, { 'X-Admin-Token': 'adm' })).json();
    assert.equal(paid.status, 'paid');
    const mine = await (await fetch(`${base}/v1/withdrawals`, { headers: h })).json();
    assert.equal(mine.withdrawals[0].status, 'paid');
    const status = await (await fetch(`${base}/v1/status`)).json();
    assert.equal(status.funds, 'real'); assert.equal(typeof status.spend.today_usd, 'number');
  } finally { server.close(); chain.close(); }
});

test('spend: the daily budget and a credit error switch model calls off, and the day rolls over', () => {
  const state = {};
  const s = createSpend(state, { budgetUsd: 1 });
  assert.equal(s.blocked(), null);
  s.record('claude-sonnet-4-5', { input_tokens: 100000, output_tokens: 50000 });   // $0.3 + $0.75
  assert.equal(s.summary().today_usd, 1.05);
  assert.match(s.blocked(), /budget/);
  state.spend.day -= 1;                                                           // a new day
  assert.equal(s.blocked(), null); assert.equal(s.summary().today_usd, 0); assert.equal(s.summary().total_usd, 1.05);
  s.fail(400, 'Your credit balance is too low to access the Anthropic API');
  assert.match(s.blocked(), /credit/);
  state.spend.degraded_until = Date.now() - 1;
  assert.equal(s.blocked(), null);
  s.fail(500, 'server error');
  assert.equal(s.blocked(), null, 'other errors do not degrade');
});
