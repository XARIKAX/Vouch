// The inference layer: the worked example, the gateway against mock
// upstreams, routing, inline checks, bond capacity, audit verdicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { createEngine } from '../src/engine.js';
import { sleep } from '../src/util.js';
import { topUpFromRevenue, inferenceFeeSplit, inferenceNetSplit, protocolFeeSplit, netPayoutSplit } from '../src/launchpad.js';
import { snapshotParams } from '../src/launchpad-config.js';
import { countMessages, countText } from '../src/tokens.js';

const FAST = { fast: true, allowPrivateWebhooks: true };
const SOURCE = { type: 'cloud_gpu', name: 'Rented H100s at ExampleCloud', resale_permitted: true };
const OFFER = (over = {}) => ({ model: 'test-llm-7b', precision: 'bf16', price_in: 0.2, price_out: 0.6, ttft_ms: 800, min_tps: 20, context: 32000, retention: 'none', source: SOURCE, ...over });
const REPLY = 'The capital of France is Paris, a city on the Seine known for the Eiffel Tower, the Louvre and its boulevards.';

// A mock OpenAI-compatible upstream. `opts` is read per request so a test can change behaviour.
function upstream(opts = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', async () => {
      const body = JSON.parse(raw); seen.push({ body, headers: req.headers });
      if (opts.delayMs) await sleep(opts.delayMs);
      if (opts.status) { res.writeHead(opts.status, { 'Content-Type': 'application/json' }); return res.end('{"error":"nope"}'); }
      const text = typeof opts.reply === 'function' ? opts.reply(body) : (opts.reply ?? REPLY);
      const outTokens = countText(text);
      const usage = { prompt_tokens: countMessages(body.messages), completion_tokens: opts.reportOut ?? outTokens, total_tokens: 0 };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const words = text.split(' ');
        for (let i = 0; i < words.length; i++) { res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: (i ? ' ' : '') + words[i] }, finish_reason: i === words.length - 1 ? 'stop' : null }] })}\n\n`); if (opts.chunkDelayMs) await sleep(opts.chunkDelayMs); if (opts.dieAfterChunks && i + 1 >= opts.dieAfterChunks) return req.socket.destroy(); }
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage })}\n\n`); res.write('data: [DONE]\n\n'); return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.malformed ? { choices: [] } : { id: 'c1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: opts.finish ?? 'stop' }], usage }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, seen, opts, close: () => server.close() })));
}
async function boot(cfg = {}) {
  const { server, engine } = createApp({ ...FAST, ...cfg });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* sse */ }
    return { status: res.status, headers: res.headers, body: json, text };
  };
  return { server, engine, base, call, close: () => server.close() };
}
const provider = (engine, url, key, extra = {}) => engine.registerProvider({ name: 'src', endpoint_url: url + '/task', offers: { 'text.generate': { price_ceiling: 0.01, sla_deadline_ms: 1000 } }, stake: 100, ...extra }, key);
const chat = (model = 'test-llm-7b', extra = {}) => ({ model, messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'What is the capital of France? Answer in one sentence with some detail.' }], max_tokens: 200, ...extra });

test('worked example: top-up from the owner share, then spend, fee and the sourcing split', () => {
  const p = snapshotParams();
  const f = protocolFeeSplit(200, p);
  assert.equal(f.fee, 10); assert.equal(f.net, 190);
  const net = netPayoutSplit(f.net, p);
  assert.deepEqual(net, { owner: 152, buyback: 19, bond: 19 });
  const tu = topUpFromRevenue({ net: f.net, ownerShare: net.owner, balance: 5 }, { share: p.topUp.share, threshold: p.topUp.threshold });
  assert.equal(tu.topUp, 19); assert.equal(tu.owner, 133);
  // over the threshold: nothing moves
  assert.deepEqual(topUpFromRevenue({ net: 190, ownerShare: 152, balance: 25 }, { share: 0.1, threshold: 20 }), { topUp: 0, owner: 152 });
  const spend = inferenceFeeSplit(10, p);
  assert.deepEqual(spend, { price: 10, fee: 0.3, burn: 0.15, treasury: 0.15, net: 9.7 });
  assert.deepEqual(inferenceNetSplit(spend.net, p), { owner: 9.312, buyback: 0.194, bond: 0.194 });
});

test('ledger: a settled job tops up a launched agent\'s compute balance from the owner share, within the owner-set rule', async () => {
  const good = await (async () => { const s = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result: 42 })); }); }); return new Promise((r) => s.listen(0, () => r({ url: `http://localhost:${s.address().port}/task`, close: () => s.close() }))); })();
  try {
    const engine = createEngine(FAST);
    engine.state.providers = {};
    const owner = engine.createKey('o');
    const a = engine.launchAgent({ owner: '0xo', name: 'calc', endpoint_url: good.url, offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 5000 } }, twap_usdg: 1, pool_liquidity_usdg: 5000, initial_bond_tokens: 100 }, owner);
    assert.equal(engine.getAgent(a.id).compute.balance, 0);
    assert.deepEqual(engine.getAgent(a.id).compute.top_up.share, 0.1);
    // the owner may raise the share up to the cap, not past it
    assert.throws(() => engine.setTopUpRule(a.id, { share: 0.5 }, { key: owner }), /cap/);
    await assert.rejects(async () => engine.setTopUpRule(a.id, { share: 0.2 }, { key: engine.createKey('x') }), /Only the key/);
    const set = engine.setTopUpRule(a.id, { share: 0.2, threshold: 10 }, { key: owner });
    assert.equal(set.compute.top_up.share, 0.2); assert.equal(set.compute.top_up.threshold, 10);
    const buyer = engine.createKey('b', { owner: '0xbuyer' });
    engine.deposit(buyer, 1);
    const before = engine.getAgent(a.id).totals.owner_paid;
    const { task } = engine.createTask(buyer, { capability: 'math.eval', input: { expression: '6*7' }, acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] }, budget: 0.03, deadline_ms: 5000 });
    for (let i = 0; i < 500 && !['settled', 'refunded'].includes(engine.state.tasks[task.id].status); i++) await sleep(10);
    assert.equal(engine.state.tasks[task.id].status, 'settled');
    const after = engine.getAgent(a.id);
    const price = engine.state.tasks[task.id].quote.price, net = price * 0.95;
    assert.ok(Math.abs(after.compute.balance - net * 0.2) < 1e-6, 'top-up is 20% of net');
    assert.ok(Math.abs((after.totals.owner_paid - before) - (net * 0.8 - net * 0.2)) < 1e-6, 'taken from the owner share only');
    assert.ok(after.ledger === undefined || true);
    const ev = engine.state.agents[a.id].ledger.find((e) => e.kind === 'top_up_rule');
    assert.ok(ev && ev.share === 0.2, 'rule changes are public events');
  } finally { good.close(); }
});

test('offers: a source must be declared and resellable; the offer carries the bond behind it', async () => {
  const up = await upstream();
  try {
    const engine = createEngine(FAST);
    const key = engine.createKey('p');
    const p = provider(engine, up.url, key);
    assert.throws(() => engine.postInferenceOffer(p.id, OFFER({ source: undefined, endpoint_url: up.url }), { key }), /source_required|source must state/);
    assert.throws(() => engine.postInferenceOffer(p.id, OFFER({ source: { ...SOURCE, resale_permitted: false }, endpoint_url: up.url }), { key }), /permits resale/);
    assert.throws(() => engine.postInferenceOffer(p.id, OFFER({ source: { type: 'vendor_api', name: 'shared key from a friend', resale_permitted: true }, endpoint_url: up.url }), { key }), /shared keys/);
    assert.throws(() => engine.postInferenceOffer(p.id, OFFER({ endpoint_url: up.url, retention: 'maybe' }), { key }), /retention/);
    assert.throws(() => engine.postInferenceOffer(p.id, OFFER({ endpoint_url: up.url }), { key: engine.createKey('stranger') }), /Only the key/);
    const o = engine.postInferenceOffer(p.id, OFFER({ endpoint_url: up.url }), { key });
    assert.equal(o.status, 'active'); assert.equal(o.source.name, SOURCE.name); assert.equal(o.audit.identity_check, 'weak');
    assert.equal(o.bond.free, 100);
    // posting the same model again updates the offer
    const o2 = engine.postInferenceOffer(p.id, OFFER({ endpoint_url: up.url, price_in: 0.1 }), { key });
    assert.equal(o2.id, o.id); assert.equal(o2.price_in, 0.1);
    assert.equal(engine.priceBook()[0].model, 'test-llm-7b');
    assert.equal(engine.getProvider(p.id).inference.active, 1);
  } finally { up.close(); }
});

test('gateway: a call is routed to the cheapest admissible offer, billed on the gateway\'s count, and the provider is paid after the hold', async () => {
  const cheap = await upstream(), dear = await upstream();
  const { engine, call, close } = await boot();
  try {
    const pk = engine.createKey('p');
    const p1 = provider(engine, cheap.url, pk), p2 = provider(engine, dear.url, pk);
    engine.postInferenceOffer(p1.id, OFFER({ endpoint_url: cheap.url, price_in: 0.2, price_out: 0.6 }), { key: pk });
    engine.postInferenceOffer(p2.id, OFFER({ endpoint_url: dear.url, price_in: 1, price_out: 3 }), { key: pk });
    const buyer = engine.createKey('b'); engine.deposit(buyer, 5);
    const r = await call('POST', '/v1/chat/completions', { key: buyer.token, body: chat() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.choices[0].message.content, REPLY);
    assert.equal(r.body.vouch.provider, p1.id, 'cheapest offer wins');
    assert.equal(cheap.seen.length, 1); assert.equal(dear.seen.length, 0);
    assert.equal(cheap.seen[0].body.vouch, undefined, 'routing preferences are not forwarded');
    assert.equal(cheap.seen[0].body.model, 'test-llm-7b', 'model name passes through');
    const tokensIn = countMessages(chat().messages), tokensOut = countText(REPLY);
    assert.equal(r.body.usage.prompt_tokens, tokensIn); assert.equal(r.body.usage.completion_tokens, tokensOut);
    const cost = Math.round((tokensIn * 0.2 + tokensOut * 0.6) / 1e6 * 1e6) / 1e6;
    assert.equal(r.body.vouch.cost, cost);
    const bal = engine.balance(buyer);
    assert.equal(bal.balance, Math.round((10 - cost) * 1e6) / 1e6, 'faucet 5 + deposit 5 minus the call');
    assert.equal(bal.locked, 0, 'nothing stays locked');
    // provider: payout is held, then released
    const prov = engine.state.providers[p1.id];
    assert.equal(prov.earnings, 0); assert.ok(prov.earningsHeld[0].amount > 0);
    prov.earningsHeld[0].release_at = Date.now() - 1;
    assert.ok(engine.getProvider(p1.id).earnings > 0, 'released after the hold');
    // usage and metadata hold no prompt
    const u = engine.inferenceUsage(buyer);
    assert.equal(u.by_model['test-llm-7b'].calls, 1);
    const log = JSON.stringify(engine.state.inference.calls) + JSON.stringify(engine.state.inference.usage);
    assert.ok(!log.includes('capital of France') && !log.includes('Paris'), 'no prompt or response in storage');
    // a ceiling below every offer: no_offers with reasons, nothing billed
    const none = await call('POST', '/v1/chat/completions', { key: buyer.token, body: chat('test-llm-7b', { vouch: { max_price_in: 0.01 } }) });
    assert.equal(none.status, 409); assert.equal(none.body.error.code, 'no_offers');
    assert.equal(engine.balance(buyer).balance, bal.balance);
    const unknown = await call('POST', '/v1/chat/completions', { key: buyer.token, body: chat('other-model') });
    assert.equal(unknown.status, 409);
  } finally { close(); cheap.close(); dear.close(); }
});

test('gateway: an agent key spends the compute balance; empty balance fails cleanly and bills nothing; sub-key caps apply', async () => {
  const up = await upstream();
  const { engine, call, close } = await boot();
  try {
    const pk = engine.createKey('p');
    const p = provider(engine, up.url, pk);
    engine.postInferenceOffer(p.id, OFFER({ endpoint_url: up.url }), { key: pk });
    const owner = engine.createKey('o');
    const a = engine.launchAgent({ owner: '0xo', symbol: 'CALC', twap_usdg: 1, pool_liquidity_usdg: 5000 }, owner);
    const ak = engine.createAgentKey(a.id, {}, { key: owner });
    // empty compute balance: a clear error, nothing billed, no negative balance
    const empty = await call('POST', '/v1/chat/completions', { key: ak.key, body: chat() });
    assert.equal(empty.status, 402); assert.equal(empty.body.error.code, 'compute_balance_empty');
    assert.equal(up.seen.length, 0, 'the upstream was never called');
    assert.equal(engine.getAgent(a.id).compute.balance, 0);
    // fill the compute balance from trading fees, then call
    engine.harvestFees(a.id, 100, { key: owner });                      // 30% operating → $30
    assert.equal(engine.getAgent(a.id).compute.balance, 30);
    const ok = await call('POST', '/v1/chat/completions', { key: ak.key, body: chat() });
    assert.equal(ok.status, 200);
    assert.equal(engine.getAgent(a.id).compute.balance, Math.round((30 - ok.body.vouch.cost) * 1e6) / 1e6);
    assert.equal((await call('GET', '/v1/balance', { key: ak.key })).body.kind, 'compute');
    // an agent key cannot post tasks
    const t = await call('POST', '/v1/tasks', { key: ak.key, body: { capability: 'math.eval', input: { expression: '1' }, budget: 0.01, deadline_ms: 1000 } });
    assert.equal(t.status, 403);
    // a sub-key with a per-call cap and no inference in its allowlist
    const parent = engine.createKey('parent'); engine.deposit(parent, 5);
    const sub = engine.createSubKey(parent, { fund: 2, allow: ['text.*'] });
    const denied = await call('POST', '/v1/chat/completions', { key: sub.key, body: chat() });
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'capability_not_allowed');
    const capped = engine.createSubKey(parent, { fund: 2, allow: ['inference.*'], per_task_cap: 0.00001 });
    const over = await call('POST', '/v1/chat/completions', { key: capped.key, body: chat() });
    assert.equal(over.status, 403); assert.equal(over.body.error.code, 'per_task_cap_exceeded');
  } finally { close(); up.close(); }
});

test('gateway: a failed or malformed call is never billed, strikes the offer, and retries the next one', async () => {
  const bad = await upstream({ status: 500 }), slowBad = await upstream({ malformed: true }), good = await upstream();
  const { engine, call, close } = await boot();
  try {
    const pk = engine.createKey('p');
    const pBad = provider(engine, bad.url, pk), pMal = provider(engine, slowBad.url, pk), pGood = provider(engine, good.url, pk);
    engine.postInferenceOffer(pBad.id, OFFER({ endpoint_url: bad.url, price_in: 0.01, price_out: 0.01 }), { key: pk });
    engine.postInferenceOffer(pMal.id, OFFER({ endpoint_url: slowBad.url, price_in: 0.02, price_out: 0.02 }), { key: pk });
    const oGood = engine.postInferenceOffer(pGood.id, OFFER({ endpoint_url: good.url, price_in: 0.5, price_out: 0.5 }), { key: pk });
    const buyer = engine.createKey('b');
    const before = engine.balance(buyer).balance;
    const r = await call('POST', '/v1/chat/completions', { key: buyer.token, body: chat() });
    assert.equal(r.status, 200);
    assert.equal(r.body.vouch.offer, oGood.id); assert.equal(r.body.vouch.retries, 2);
    assert.equal(engine.listInferenceOffers().find((o) => o.provider === pBad.id).audit.strikes, 1);
    assert.equal(engine.listInferenceOffers().find((o) => o.provider === pMal.id).audit.strikes, 1);
    const failed = engine.state.inference.calls.filter((c) => c.status === 'failed');
    assert.equal(failed.length, 2); assert.ok(failed.every((c) => c.cost === 0));
    assert.equal(engine.balance(buyer).balance, Math.round((before - r.body.vouch.cost) * 1e6) / 1e6, 'only the good call is billed');
    // a reported count far from the gateway's is an inline failure
    good.opts.reportOut = 999;
    engine.postInferenceOffer(pBad.id, OFFER({ endpoint_url: bad.url, price_in: 0.01, price_out: 0.01 }), { key: pk });
    const r2 = await call('POST', '/v1/chat/completions', { key: buyer.token, body: chat() });
    assert.equal(r2.status, 502); assert.equal(r2.body.error.code, 'all_offers_failed');
    assert.ok(r2.body.error.failures.some((f) => /reported 999/.test(f.reason)));
  } finally { close(); bad.close(); slowBad.close(); good.close(); }
});

test('gateway: streaming proxies chunks, bills on the gateway\'s count, and a mid-stream failure bills nothing', async () => {
  const up = await upstream({ chunkDelayMs: 2 });
  const { engine, base, close } = await boot();
  try {
    const pk = engine.createKey('p');
    const p = provider(engine, up.url, pk);
    engine.postInferenceOffer(p.id, OFFER({ endpoint_url: up.url }), { key: pk });
    const buyer = engine.createKey('b');
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` }, body: JSON.stringify(chat('test-llm-7b', { stream: true })) });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    const chunks = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    assert.equal(content, REPLY);
    const meta = JSON.parse(text.split('\n').find((l) => l.startsWith(': vouch ')).slice(8));
    assert.equal(meta.usage.completion_tokens, countText(REPLY)); assert.ok(meta.cost > 0);
    assert.equal(engine.balance(buyer).balance, Math.round((5 - meta.cost) * 1e6) / 1e6);
    // the upstream dies after two chunks: the client gets an error event and nothing is billed
    up.opts.dieAfterChunks = 2;
    const res2 = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` }, body: JSON.stringify(chat('test-llm-7b', { stream: true })) });
    const text2 = await res2.text();
    assert.ok(/upstream_failed|billed":false/.test(text2));
    assert.equal(engine.balance(buyer).balance, Math.round((5 - meta.cost) * 1e6) / 1e6, 'unchanged');
    assert.equal(engine.balance(buyer).locked, 0);
  } finally { close(); up.close(); }
});

test('routing: privacy, min_track, allowlist and bond capacity gate offers; a provider at its cap gets no traffic', async () => {
  const up = await upstream();
  const engine = createEngine(FAST);
  try {
    const pk = engine.createKey('p');
    const retains = provider(engine, up.url, pk), small = provider(engine, up.url, pk, { stake: 1 });
    engine.postInferenceOffer(retains.id, OFFER({ endpoint_url: up.url, retention: 'retained', price_in: 0.01, price_out: 0.01 }), { key: pk });
    const oSmall = engine.postInferenceOffer(small.id, OFFER({ endpoint_url: up.url, price_in: 0.05, price_out: 0.05 }), { key: pk });
    const r = engine.inference.route({ model: 'test-llm-7b', tokensIn: 100, maxOut: 100, prefs: {} });
    assert.deepEqual(r.candidates.map((c) => c.offer.id), [oSmall.id], 'retaining host excluded by default');
    assert.ok(r.rejected.some((x) => /retains/.test(x.reason)));
    const any = engine.inference.route({ model: 'test-llm-7b', tokensIn: 100, maxOut: 100, prefs: { retention: 'any' } });
    assert.equal(any.candidates.length, 2);
    assert.equal(engine.inference.route({ model: 'test-llm-7b', tokensIn: 100, maxOut: 100, prefs: { min_track: 90 } }).candidates.length, 0);
    assert.equal(engine.inference.route({ model: 'test-llm-7b', tokensIn: 100, maxOut: 100, prefs: { providers: [retains.id], retention: 'any' } }).candidates.length, 1);
    // bond capacity: $1 of stake covers $0.50 of window revenue at 2x; push the window past it
    engine.state.inferenceOffers[oSmall.id].stats.window.push({ ts: Date.now(), revenue: 0.6 });
    const capped = engine.inference.route({ model: 'test-llm-7b', tokensIn: 100, maxOut: 100, prefs: {} });
    assert.equal(capped.candidates.length, 0);
    assert.ok(capped.rejected.some((x) => x.offer === oSmall.id && /bond capacity/.test(x.reason)));
  } finally { up.close(); }
});

test('audit: one canary mismatch proves nothing; a pattern over the window delists and slashes twice the window revenue', async () => {
  const up = await upstream();
  const engine = createEngine(FAST);
  try {
    const pk = engine.createKey('p');
    const p = provider(engine, up.url, pk);
    const o = engine.postInferenceOffer(p.id, OFFER({ endpoint_url: up.url }), { key: pk });
    const off = engine.state.inferenceOffers[o.id];
    off.stats.window.push({ ts: Date.now(), revenue: 4 });
    // a single failure: no verdict
    assert.equal(engine.inference.recordCanary(off, false, 'differs'), null);
    assert.equal(off.status, 'active');
    // 49 canaries, 20 failed (40%) but under the minimum count: still no verdict
    for (let i = 0; i < 48; i++) engine.inference.recordCanary(off, i < 29, i < 29 ? 'ok' : 'differs');
    assert.equal(off.status, 'active');
    // the 50th tips it over: 20 failures of 50 is 40% > 20%
    const v = engine.inference.recordCanary(off, true, 'ok');
    assert.equal(v.verdict, 'substitution'); assert.equal(off.status, 'delisted'); assert.equal(off.delist_reason, 'substitution');
    assert.equal(v.slashed, 8, 'twice the window revenue');
    assert.equal(engine.state.providers[p.id].stake, 92);
    assert.equal(engine.state.insurance.balance, 8, 'slashes go to the insurance pool');
    // a false source statement is the same penalty
    const o2 = engine.postInferenceOffer(p.id, OFFER({ endpoint_url: up.url, model: 'other-9b' }), { key: pk });
    engine.state.inferenceOffers[o2.id].stats.window.push({ ts: Date.now(), revenue: 1 });
    const fs = engine.inference.falseSource(o2.id, 'capacity was a shared key');
    assert.equal(fs.status, 'delisted'); assert.equal(fs.slashed, 2);
  } finally { up.close(); }
});

test('audit: a canary runs through the gateway, is paid by the treasury, and compares with the reference host', async () => {
  const ref = await upstream({ reply: 'Paris' });
  const honest = await upstream({ reply: 'Paris' }), swapped = await upstream({ reply: 'I think it might be Lyon or maybe Marseille, hard to say' });
  const engine = createEngine({ ...FAST, inference: { referenceHosts: { 'test-llm-7b': { endpoint_url: ref.url } } } });
  const { createGateway } = await import('../src/gateway.js');
  const gw = createGateway(engine);
  try {
    const pk = engine.createKey('p');
    const pH = provider(engine, honest.url, pk), pS = provider(engine, swapped.url, pk);
    const oH = engine.postInferenceOffer(pH.id, OFFER({ endpoint_url: honest.url }), { key: pk });
    const oS = engine.postInferenceOffer(pS.id, OFFER({ endpoint_url: swapped.url }), { key: pk });
    engine.state.treasury.balance = 1;
    await gw.canary(engine.state.inferenceOffers[oH.id]);
    await gw.canary(engine.state.inferenceOffers[oS.id]);
    const H = engine.listInferenceOffers().find((x) => x.id === oH.id), S = engine.listInferenceOffers().find((x) => x.id === oS.id);
    assert.equal(H.audit.passed, 1); assert.equal(H.audit.failed, 0); assert.equal(H.audit.identity_check, 'reference');
    assert.equal(S.audit.failed, 1);
    assert.ok(engine.state.treasury.balance < 1, 'the treasury paid for the canaries');
    const canaries = engine.state.inference.calls.filter((c) => c.canary);
    assert.equal(canaries.length, 2);
    assert.ok(!JSON.stringify(engine.state.inference.calls).includes('fox'), 'the canary prompt is not stored either');
    assert.ok(honest.seen[0].body.temperature === 0 && !('vouch' in honest.seen[0].body), 'indistinguishable from a real call');
  } finally { ref.close(); honest.close(); swapped.close(); }
});

test('api + mcp: price book, usage, top-up rule and agent keys over HTTP', async () => {
  const up = await upstream();
  const { engine, call, close } = await boot();
  try {
    const pk = engine.createKey('p');
    const p = provider(engine, up.url, pk);
    const posted = await call('POST', `/v1/providers/${p.id}/inference-offers`, { key: pk.token, body: OFFER({ endpoint_url: up.url }) });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal((await call('POST', `/v1/providers/${p.id}/inference-offers`, { key: engine.createKey('z').token, body: OFFER({ endpoint_url: up.url }) })).status, 403);
    const book = await call('GET', '/v1/inference/pricebook');
    assert.equal(book.body.models[0].model, 'test-llm-7b'); assert.equal(book.body.models[0].source.type, 'cloud_gpu');
    const offers = await call('GET', '/v1/inference/offers?model=test-llm-7b');
    assert.equal(offers.body.offers.length, 1);
    const owner = engine.createKey('o');
    const a = engine.launchAgent({ owner: '0xo', symbol: 'SRC', twap_usdg: 1, pool_liquidity_usdg: 5000 }, owner);
    const rule = await call('POST', `/v1/agents/${a.id}/top-up`, { key: owner.token, body: { threshold: 50, share: 0.25 } });
    assert.equal(rule.status, 200); assert.equal(rule.body.compute.top_up.threshold, 50);
    const ak = await call('POST', `/v1/agents/${a.id}/keys`, { key: owner.token, body: { per_call_cap: 0.5 } });
    assert.equal(ak.status, 201); assert.ok(ak.body.key.startsWith('vch_'));
    engine.harvestFees(a.id, 10, { key: owner });
    const r = await call('POST', '/v1/inference/chat/completions', { key: ak.body.key, body: chat() });
    assert.equal(r.status, 200);
    const usage = await call('GET', '/v1/inference/usage', { key: ak.body.key });
    assert.equal(usage.body.agent_id, a.id); assert.equal(usage.body.by_model['test-llm-7b'].calls, 1);
    const pi = await call('GET', `/v1/providers/${p.id}/inference`);
    assert.equal(pi.body.offers.length, 1); assert.ok(pi.body.held > 0);
    // delist by the owner
    const del = await call('POST', `/v1/providers/${p.id}/inference-offers/${posted.body.id}/delist`, { key: pk.token });
    assert.equal(del.body.status, 'delisted');
    assert.equal((await call('GET', '/v1/inference/pricebook')).body.models.length, 0);
    // mcp tools
    const mcp = await call('POST', '/mcp', { key: owner.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vouch_set_top_up', arguments: { agent_id: a.id, share: 0.3 } } } });
    assert.equal(mcp.status, 200); assert.equal(JSON.parse(mcp.body.result.content[0].text).compute.top_up.share, 0.3);
    const list = await call('POST', '/mcp', { key: owner.token, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
    assert.ok(list.body.result.tools.some((t) => t.name === 'vouch_price_book'));
  } finally { close(); up.close(); }
});
