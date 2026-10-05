// Real funds on Solana: wallet sign-in by ed25519 signature, USDT deposits
// read from a confirmed transaction's token balances, withdrawals signed by
// the treasury or paid by an operator, and the spend guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEngine } from '../src/engine.js';
import { createApp } from '../server.js';
import { fundsConfig, toUnits, parseTokenMovement, USDT } from '../src/chain/funds.js';
import { pumpConfig } from '../src/chain/pump.js';
import { randomKeypair, sign, verify } from '../src/chain/ed25519.js';
import { encodeBase58 } from '../src/chain/base58.js';
import { associatedTokenAddress, PROGRAMS, fromBase64 } from '../src/chain/solana.js';
import { parseTransaction, readU64le } from '../public/assets/solmsg.js';
import { createSpend } from '../src/spend.js';

const USER = randomKeypair(), TREASURY = randomKeypair();
const TREASURY_SECRET = encodeBase58(Buffer.concat([Buffer.from(TREASURY.seed), Buffer.from(TREASURY.publicKey)]));
const signMsg = (message, kp) => encodeBase58(sign(Buffer.from(message, 'utf8'), kp.seed));
const sig = (fill) => encodeBase58(Buffer.alloc(64, fill));
// a confirmed transaction whose token balances show `units` of USDT moving from `from` to `to`
const transferTx = (from, to, units, { mint = USDT.mint, err = null } = {}) => ({
  slot: 99, blockTime: 1700000000, meta: {
    err,
    preTokenBalances: [{ accountIndex: 1, mint, owner: from, uiTokenAmount: { amount: String(100_000000n), decimals: 6 } }, { accountIndex: 2, mint, owner: to, uiTokenAmount: { amount: '0', decimals: 6 } }],
    postTokenBalances: [{ accountIndex: 1, mint, owner: from, uiTokenAmount: { amount: String(100_000000n - units), decimals: 6 } }, { accountIndex: 2, mint, owner: to, uiTokenAmount: { amount: String(units), decimals: 6 } }],
  }, transaction: { message: { instructions: [] } },
});

// a fake node: transactions by signature, and enough to accept a signed payout
function fakeChain() {
  const txs = {}, sent = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      let result = null;
      if (method === 'getTransaction') result = txs[params[0]] ?? null;
      else if (method === 'getLatestBlockhash') result = { context: { slot: 1 }, value: { blockhash: encodeBase58(Buffer.alloc(32, 3)), lastValidBlockHeight: 100 } };
      else if (method === 'sendTransaction') { sent.push(params[0]); result = encodeBase58(parseTransaction(fromBase64(params[0])).signatures[0]); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, txs, sent, close: () => server.close() })));
}
const realCfg = (url, extra = {}) => ({ fast: true, chain: pumpConfig({ VOUCH_CHAIN_RPC: url }), funds: fundsConfig({ VOUCH_REAL_FUNDS: '1', VOUCH_TREASURY_ADDRESS: TREASURY.address, ...extra }) });

test('funds: config derives the treasury token account, refuses a key that is not the treasury\'s, and defaults to USDT', () => {
  const f = fundsConfig({ VOUCH_REAL_FUNDS: '1', VOUCH_TREASURY_ADDRESS: TREASURY.address, VOUCH_TREASURY_KEY: TREASURY_SECRET });
  assert.equal(f.enabled, true); assert.equal(f.signer, TREASURY.address); assert.equal(f.treasuryAta, associatedTokenAddress(TREASURY.address, USDT.mint));
  assert.equal(f.token.symbol, 'USDT'); assert.equal(f.token.mint, USDT.mint); assert.equal(f.token.decimals, 6);
  const wrong = fundsConfig({ VOUCH_REAL_FUNDS: '1', VOUCH_TREASURY_ADDRESS: TREASURY.address, VOUCH_TREASURY_KEY: encodeBase58(Buffer.concat([Buffer.from(USER.seed), Buffer.from(USER.publicKey)])) });
  assert.equal(wrong.treasuryKey, null, 'another wallet\'s key is ignored');
  assert.equal(fundsConfig({ VOUCH_REAL_FUNDS: '1', VOUCH_TREASURY_ADDRESS: '0xFbc943b2cE7A11Eca6d161e3F0b13c083679e82D' }).enabled, false, 'an EVM address is not a treasury here');
  assert.equal(fundsConfig({}).enabled, false);
  // the movement parser
  const t = parseTokenMovement(transferTx(USER.address, TREASURY.address, 25_500000n), { mint: USDT.mint, to: TREASURY.address });
  assert.deepEqual({ from: t.from, to: t.to, units: t.units }, { from: USER.address, to: TREASURY.address, units: 25_500000n });
  assert.equal(parseTokenMovement(transferTx(USER.address, TREASURY.address, 5n, { mint: randomKeypair().address }), { mint: USDT.mint, to: TREASURY.address }), null, 'another token does not count');
  assert.equal(parseTokenMovement(transferTx(USER.address, randomKeypair().address, 5n), { mint: USDT.mint, to: TREASURY.address }), null);
});

test('funds: sandbox deployments keep the faucet and refuse real-money endpoints', async () => {
  const e = createEngine({ fast: true });
  const k = e.createKey('t');
  assert.equal(e.balance(k).balance, 5);
  await assert.rejects(e.confirmDeposit(k, sig(1)), /sandbox/);
  await assert.rejects(e.requestWithdrawal(k, 2), /sandbox/);
  assert.equal(e.fundsInfo().mode, 'sandbox');
});

test('auth: a wallet signature mints an account, and signing again recovers it with a fresh key', () => {
  const e = createEngine({ fast: true });
  assert.throws(() => e.authNonce('0xFbc943b2cE7A11Eca6d161e3F0b13c083679e82D'), /Solana wallet/);
  const { message, nonce } = e.authNonce(USER.address);
  assert.ok(message.includes(USER.address) && message.includes(nonce));
  // the wrong wallet's signature is refused
  assert.throws(() => e.authVerify(USER.address, signMsg(message, randomKeypair())), /not made by this wallet/);
  assert.throws(() => e.authVerify(USER.address, 'zzz'), /could not be verified/);
  const first = e.authVerify(USER.address, signMsg(message, USER));
  assert.equal(first.recovered, false); assert.equal(first.wallet, USER.address);
  const key = e.authenticate(first.key);
  assert.equal(key.wallet, USER.address); assert.equal(e.me(key).wallet, USER.address);
  // a nonce is single use
  assert.throws(() => e.authVerify(USER.address, signMsg(message, USER)), /new sign-in message/);
  // recovery: same wallet, same account, new token; the old one is dead
  const again = e.authNonce(USER.address);
  const second = e.authVerify(USER.address, signMsg(again.message, USER));
  assert.equal(second.recovered, true); assert.equal(second.id, first.id); assert.notEqual(second.key, first.key);
  assert.throws(() => e.authenticate(first.key), /revoked|invalid/i);
  assert.equal(e.authenticate(second.key).id, first.id);
});

test('funds: a real deployment credits a verified USDT deposit once, from the signed-in wallet only', async () => {
  const chain = await fakeChain();
  try {
    const e = createEngine(realCfg(chain.url));
    const { message } = e.authNonce(USER.address);
    const key = e.authenticate(e.authVerify(USER.address, signMsg(message, USER)).key);
    assert.equal(e.balance(key).balance, 0, 'no faucet with real funds');
    assert.throws(() => e.deposit(key, 2), /Simulated deposits are off/);
    const tx = sig(0xaa);
    assert.equal((await e.confirmDeposit(key, tx)).pending, true, 'pending first');
    chain.txs[tx] = transferTx(USER.address, TREASURY.address, 25_500000n);
    const out = await e.confirmDeposit(key, tx);
    assert.equal(out.amount, 25.5); assert.equal(out.balance, 25.5); assert.equal(out.status, 'credited'); assert.equal(out.slot, 99);
    const twice = await e.confirmDeposit(key, tx);
    assert.equal(twice.already_credited, true); assert.equal(e.balance(key).balance, 25.5, 'never credited twice');
    // someone else's deposit cannot be claimed
    const other = sig(0xbb); chain.txs[other] = transferTx(randomKeypair().address, TREASURY.address, 1_000000n);
    await assert.rejects(e.confirmDeposit(key, other), /different wallet/);
    // a transfer to the wrong place is not a deposit
    const wrong = sig(0xcc); chain.txs[wrong] = transferTx(USER.address, randomKeypair().address, 1_000000n);
    await assert.rejects(e.confirmDeposit(key, wrong), /not transfer/);
    // a failed transaction
    const failed = sig(0xdd); chain.txs[failed] = transferTx(USER.address, TREASURY.address, 1_000000n, { err: { InstructionError: [0, 'Custom'] } });
    await assert.rejects(e.confirmDeposit(key, failed), /failed on-chain/);
    // a key without a wallet cannot deposit
    await assert.rejects(e.confirmDeposit(e.createKey('anon'), tx), /Sign in with a wallet/);
    await assert.rejects(e.confirmDeposit(key, '0x' + 'aa'.repeat(32)), /signature/);
  } finally { chain.close(); }
});

test('funds: a withdrawal debits the ledger and the treasury signs a USDT transfer to the wallet', async () => {
  const chain = await fakeChain();
  try {
    const e = createEngine(realCfg(chain.url, { VOUCH_TREASURY_KEY: TREASURY_SECRET }));
    assert.equal(e.fundsInfo().payouts, 'automatic'); assert.equal(e.fundsInfo().treasury_ata, associatedTokenAddress(TREASURY.address, USDT.mint));
    const { message } = e.authNonce(USER.address);
    const key = e.authenticate(e.authVerify(USER.address, signMsg(message, USER)).key);
    const dep = sig(0xaa); chain.txs[dep] = transferTx(USER.address, TREASURY.address, 40_000000n);
    await e.confirmDeposit(key, dep);
    await assert.rejects(e.requestWithdrawal(key, 0.5), /Minimum/);
    await assert.rejects(e.requestWithdrawal(key, 100), /Available balance/);
    const w = await e.requestWithdrawal(key, 12.25);
    assert.equal(w.status, 'sent'); assert.ok(w.tx_hash); assert.equal(w.balance, 27.75); assert.ok(w.explorer.includes('solscan.io/tx/'));
    // the wire transaction: signed by the treasury, creates the wallet's token account, transfers 12.25 USDT checked at 6 decimals
    assert.equal(chain.sent.length, 1);
    const tx = parseTransaction(fromBase64(chain.sent[0]));
    assert.equal(tx.signatures.length, 1); assert.equal(tx.accountKeys[0], TREASURY.address);
    assert.equal(verify(tx.messageBytes, tx.signatures[0], TREASURY.publicKey), true, 'signed by the treasury');
    assert.equal(encodeBase58(tx.signatures[0]), w.tx_hash);
    const [ata, xfer] = tx.instructions;
    assert.equal(tx.accountKeys[ata.programIdIndex], PROGRAMS.associatedToken); assert.equal(tx.accountKeys[ata.accounts[1]], associatedTokenAddress(USER.address, USDT.mint));
    assert.equal(tx.accountKeys[xfer.programIdIndex], PROGRAMS.token);
    assert.equal(xfer.data[0], 12); assert.equal(readU64le(xfer.data, 1), toUnits(12.25)); assert.equal(xfer.data[9], 6);
    assert.deepEqual(xfer.accounts.map((i) => tx.accountKeys[i]), [associatedTokenAddress(TREASURY.address, USDT.mint), USDT.mint, associatedTokenAddress(USER.address, USDT.mint), TREASURY.address]);
    // confirmed on-chain → paid
    chain.txs[w.tx_hash] = transferTx(TREASURY.address, USER.address, 12_250000n);
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
    const { message } = e.authNonce(USER.address);
    const key = e.authenticate(e.authVerify(USER.address, signMsg(message, USER)).key);
    const dep = sig(0xaa); chain.txs[dep] = transferTx(USER.address, TREASURY.address, 10_000000n);
    await e.confirmDeposit(key, dep);
    const w = await e.requestWithdrawal(key, 4);
    assert.equal(w.status, 'pending'); assert.equal(w.balance, 6); assert.equal(chain.sent.length, 0);
    assert.equal(e.listPendingWithdrawals()[0].id, w.id);
    const short = sig(0xd1); chain.txs[short] = transferTx(TREASURY.address, USER.address, 3_000000n);
    await assert.rejects(e.confirmPayout(w.id, short), /smaller/);
    const stranger = sig(0xd2); chain.txs[stranger] = transferTx(randomKeypair().address, USER.address, 4_000000n);
    await assert.rejects(e.confirmPayout(w.id, stranger), /not a treasury payout/);
    const full = sig(0xee); chain.txs[full] = transferTx(TREASURY.address, USER.address, 4_000000n);
    assert.equal((await e.confirmPayout(w.id, full)).status, 'paid');
  } finally { chain.close(); }
});

test('funds: a failed automatic payout gives the balance back', async () => {
  const chain = await fakeChain();
  try {
    const e = createEngine(realCfg(chain.url, { VOUCH_TREASURY_KEY: TREASURY_SECRET }));
    const { message } = e.authNonce(USER.address);
    const key = e.authenticate(e.authVerify(USER.address, signMsg(message, USER)).key);
    const dep = sig(0xaa); chain.txs[dep] = transferTx(USER.address, TREASURY.address, 10_000000n);
    await e.confirmDeposit(key, dep);
    e.cfg.chain = pumpConfig({ VOUCH_CHAIN_RPC: 'http://127.0.0.1:1' });   // unreachable node for the send
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
    assert.equal(funds.mode, 'real'); assert.equal(funds.treasury, TREASURY.address); assert.equal(funds.token.symbol, 'USDT'); assert.equal(funds.network, 'Solana'); assert.equal(funds.cluster, 'mainnet-beta');
    const n = await (await post('/v1/auth/nonce', { address: USER.address })).json();
    const v = await (await post('/v1/auth/verify', { address: USER.address, signature: signMsg(n.message, USER) })).json();
    const h = { Authorization: `Bearer ${v.key}` };
    const me = await (await fetch(`${base}/v1/me`, { headers: h })).json();
    assert.equal(me.wallet, USER.address); assert.equal(me.funds, 'real');
    const dep = sig(0xaa);
    assert.equal((await post('/v1/escrow/deposits/confirm', { tx_hash: dep }, h)).status, 202);
    chain.txs[dep] = transferTx(USER.address, TREASURY.address, 9_000000n);
    const c = await post('/v1/escrow/deposits/confirm', { tx_hash: dep }, h);
    assert.equal(c.status, 200); assert.equal((await c.json()).balance, 9);
    const w = await (await post('/v1/withdrawals', { amount: 2 }, h)).json();
    assert.equal(w.status, 'pending');
    assert.equal((await fetch(`${base}/v1/admin/withdrawals`)).status, 403);
    const pend = await (await fetch(`${base}/v1/admin/withdrawals`, { headers: { 'X-Admin-Token': 'adm' } })).json();
    assert.equal(pend.withdrawals[0].id, w.id);
    const tx = sig(0xff); chain.txs[tx] = transferTx(TREASURY.address, USER.address, 2_000000n);
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
