// First-party sourcing: the house resells an aggregator's catalog through the gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { createEngine } from '../src/engine.js';
import { upstreamConfig, normalizeCatalog } from '../src/upstream.js';
import { countMessages, countText } from '../src/tokens.js';

const FAST = { fast: true, allowPrivateWebhooks: true };
const REPLY = 'The capital of France is Paris, a city on the Seine known for the Eiffel Tower, the Louvre and its boulevards.';

// A mock aggregator in OpenRouter's shape: /models with per-token string prices, /chat/completions.
function aggregator(models) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      seen.push({ path: req.url, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: models() }));
    }
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const body = JSON.parse(raw); seen.push({ path: req.url, body, headers: req.headers });
      const usage = { prompt_tokens: countMessages(body.messages), completion_tokens: countText(REPLY), total_tokens: 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }], usage }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/api/v1`, seen, close: () => server.close() })));
}
const CATALOG = [
  { id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' }, architecture: { output_modalities: ['text'] } },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta: Llama 3.3 70B', context_length: 131072, pricing: { prompt: '0.0000001', completion: '0.0000003' }, architecture: { output_modalities: ['text'] } },
  { id: 'openrouter/auto', name: 'Auto Router', context_length: 2000000, pricing: { prompt: '-1', completion: '-1' } },
  { id: 'some/image-model', name: 'Images only', context_length: 4096, pricing: { prompt: '0.000001', completion: '0.000001' }, architecture: { output_modalities: ['image'] } },
  { id: 'free/model:free', name: 'A free model', context_length: 8192, pricing: { prompt: '0', completion: '0' } },
];
const upCfg = (url, extra = {}) => upstreamConfig({ VOUCH_UPSTREAM_URL: url, VOUCH_UPSTREAM_KEY: 'sk-agg-test', VOUCH_UPSTREAM_NAME: 'MockRouter', VOUCH_UPSTREAM_MARGIN: '0.1', VOUCH_UPSTREAM_BUDGET_USD: '5', ...extra });
const chat = (model, extra = {}) => ({ model, messages: [{ role: 'user', content: 'What is the capital of France? Answer in one sentence with some detail.' }], max_tokens: 200, ...extra });

test('config: off until a URL and key are set; OPENROUTER_API_KEY alone selects OpenRouter', () => {
  assert.equal(upstreamConfig({}).enabled, false);
  assert.equal(upstreamConfig({ VOUCH_UPSTREAM_URL: 'https://x.example/v1' }).enabled, false);
  const or = upstreamConfig({ OPENROUTER_API_KEY: 'sk-or-v1-abc' });
  assert.equal(or.enabled, true); assert.equal(or.url, 'https://openrouter.ai/api/v1'); assert.equal(or.name, 'OpenRouter'); assert.equal(or.margin, 0.1);
  assert.equal(upstreamConfig({ OPENROUTER_API_KEY: 'k', VOUCH_UPSTREAM_MARGIN: '0.25' }).margin, 0.25);
});

test('catalog: per-token string prices become per-million offers; routers, non-text models and unpriced rows are skipped', () => {
  const rows = normalizeCatalog({ data: CATALOG });
  assert.deepEqual(rows.map((r) => r.id), ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct', 'free/model:free']);
  const gpt = rows[0];
  assert.equal(gpt.price_in, 2.5); assert.equal(gpt.price_out, 10); assert.equal(gpt.context, 128000); assert.equal(gpt.name, 'OpenAI: GPT-4o');
  assert.deepEqual(normalizeCatalog({ nope: 1 }), []);
});

test('sync: every priced model becomes a bonded offer on the house provider at the upstream price plus margin', async () => {
  let models = () => CATALOG;
  const agg = await aggregator(() => models());
  try {
    const engine = createEngine({ ...FAST, upstream: upCfg(agg.url) });
    const info = await engine.syncUpstream();
    assert.equal(info.enabled, true); assert.equal(info.models, 3); assert.equal(info.stale, false); assert.equal(info.label, 'Vouch sourcing');
    assert.equal(agg.seen[0].headers.authorization, 'Bearer sk-agg-test', 'the catalog is read with the operator key');
    const book = engine.priceBook();
    const gpt = book.find((m) => m.model === 'openai/gpt-4o');
    assert.equal(gpt.price_in, 2.75); assert.equal(gpt.price_out, 11); assert.equal(gpt.house, true); assert.equal(gpt.display_name, 'OpenAI: GPT-4o');
    assert.equal(gpt.source.type, 'reseller_agreement'); assert.match(gpt.source.name, /Vouch sourcing/); assert.equal(gpt.retention, 'none');
    assert.ok(!JSON.stringify(engine.priceBook()).includes('MockRouter'), 'the aggregator is never named in public');
    assert.ok(!JSON.stringify(engine.upstreamInfo()).includes('MockRouter'));
    assert.equal(engine.upstreamInfo({ admin: true }).name, 'MockRouter');
    const p = engine.getProvider(info.provider);
    assert.equal(p.stake, 1000); assert.equal(p.name, 'Vouch sourcing'); assert.equal(p.inference.active, 3);
    // the second sync inside the refresh window is a no-op; a forced one re-reads
    const reads = agg.seen.length;
    await engine.syncUpstream(); assert.equal(agg.seen.length, reads);
    models = () => CATALOG.slice(1);
    const again = await engine.syncUpstream({ force: true });
    assert.equal(again.models, 2);
    const gone = engine.listInferenceOffers({ include_delisted: true }).find((o) => o.model === 'openai/gpt-4o');
    assert.equal(gone.status, 'delisted'); assert.equal(gone.delist_reason, 'left_catalog');
    assert.equal(engine.priceBook().length, 2);
  } finally { agg.close(); }
});

test('sync: an unreachable aggregator records the error and leaves the book as it was', async () => {
  const engine = createEngine({ ...FAST, upstream: upCfg('http://127.0.0.1:9/api/v1') });
  const info = await engine.syncUpstream();
  assert.equal(info.enabled, true); assert.equal(info.models, 0); assert.equal(info.stale, true);
  assert.match(engine.upstreamInfo({ admin: true }).error, /unreachable|fetch|ECONNREFUSED/i);
  assert.equal(engine.upstream.due(), false, 'a failed attempt is not retried immediately');
});

test('gateway: a call on a house model is proxied to the aggregator with the operator key, billed with margin, and metered against the house budget', async () => {
  const agg = await aggregator(() => CATALOG);
  const { server, engine } = createApp({ ...FAST, upstream: upCfg(agg.url) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, { key, body, headers = {} } = {}) => { const r = await fetch(base + path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    // the first price book request after a cold start waits for the catalog
    const book = await call('GET', '/v1/inference/pricebook');
    assert.equal(book.body.models.length, 3); assert.equal(book.body.upstream.models, 3);
    const buyer = engine.createKey('b');
    const r = await call('POST', '/v1/chat/completions', { key: buyer.token, body: chat('openai/gpt-4o') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.vouch.provider, engine.upstream.providerId());
    const up = agg.seen.find((s) => s.body);
    assert.equal(up.headers.authorization, 'Bearer sk-agg-test'); assert.equal(up.body.model, 'openai/gpt-4o'); assert.ok(!('vouch' in up.body));
    // the bare id routes to the prefixed house offer, and the upstream sees the full id
    const alias = await call('POST', '/v1/chat/completions', { key: buyer.token, body: chat('gpt-4o') });
    assert.equal(alias.status, 200, JSON.stringify(alias.body)); assert.equal(alias.body.vouch.model, 'openai/gpt-4o');
    assert.equal(agg.seen.filter((s) => s.body).at(-1).body.model, 'openai/gpt-4o');
    // billed at the marked-up price; the house metered its own cost underneath
    const u = r.body.usage, cost = (u.prompt_tokens * 2.75 + u.completion_tokens * 11) / 1e6;
    assert.ok(Math.abs(r.body.vouch.cost - cost) < 1e-6, `${r.body.vouch.cost} vs ${cost}`);
    const pub = (await call('GET', '/v1/inference/upstream')).body;
    assert.equal(pub.models, 3); assert.equal(pub.label, 'Vouch sourcing'); assert.ok(!('budget' in pub) && !('name' in pub) && !('margin' in pub), 'budget, aggregator and margin are admin-only');
    engine.cfg.adminToken = 'adm';
    const info = (await call('GET', '/v1/inference/upstream', { headers: { 'X-Admin-Token': 'adm' } })).body;
    assert.equal(info.name, 'MockRouter'); assert.equal(info.margin, 0.1);
    // two buyer calls, plus at most one treasury-paid canary the gateway may have slipped in
    assert.ok(info.budget.calls_today >= 2 && info.budget.calls_today <= 3, String(info.budget.calls_today));
    assert.ok(info.budget.today_usd > 0 && info.budget.today_usd < r.body.vouch.cost * 3);
    // a spent house budget takes the house out of routing with a stated reason
    engine.state.inference.upstream.spend.usd = 5;
    const blocked = await call('POST', '/v1/chat/completions', { key: buyer.token, body: chat('openai/gpt-4o') });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, 'no_offers');
    assert.ok(blocked.body.error.rejected.some((x) => /house upstream budget/.test(x.reason)));
    const status = (await call('GET', '/v1/status')).body;
    assert.equal(status.upstream.paused, true); assert.ok(!('budget' in status.upstream));
    // admin resync; anyone else is refused
    engine.cfg.adminToken = '';
    assert.equal((await call('POST', '/v1/admin/inference/upstream/sync')).status, 403);
    engine.cfg.adminToken = 'adm';
    const synced = await call('POST', '/v1/admin/inference/upstream/sync', { headers: { 'X-Admin-Token': 'adm' } });
    assert.equal(synced.status, 200); assert.equal(synced.body.models, 3);
  } finally { server.close(); agg.close(); }
});

test('gateway: with no upstream configured nothing changes: no house provider, the book is whatever providers post', async () => {
  const engine = createEngine({ ...FAST, upstream: upstreamConfig({}) });
  assert.deepEqual(await engine.syncUpstream(), { enabled: false });
  assert.deepEqual(engine.upstreamInfo(), { enabled: false });
  assert.ok(!Object.values(engine.state.providers).some((p) => p.house));
  assert.equal(engine.inference.offersFor('gpt-4o').length, 0);
});
