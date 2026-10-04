#!/usr/bin/env node
// A reference sourcing agent: a Vouch provider whose job is procurement.
//
// It keeps a price book across a configurable list of upstream sources,
// posts a bonded inference offer per model at the cheapest upstream price
// plus a margin, serves an OpenAI-compatible endpoint that proxies each
// call to the cheapest upstream for that model, and re-reads prices on an
// interval. It pays its upstreams from its own keys; Vouch never fronts that.
//
// No vendor is built in. Sources come from SOURCES_FILE (JSON):
//   [{ "name": "ExampleCloud", "base_url": "https://api.example.com/v1",
//      "api_key_env": "EXAMPLE_KEY", "retention": "none",
//      "source": { "type": "cloud_gpu", "name": "Rented GPUs at ExampleCloud", "resale_permitted": true },
//      "prices_url": "https://api.example.com/v1/prices",          // optional: { "<model>": { "price_in": 0.2, "price_out": 0.6 } }
//      "models": { "some-model-7b": { "price_in": 0.2, "price_out": 0.6, "precision": "bf16", "context": 32000, "ttft_ms": 800, "min_tps": 20 } } }]
// Only list sources whose terms permit resale. A false source statement is a slashable offence.
//
// Env: VOUCH_URL, VOUCH_KEY (a Vouch key; the provider is registered with it),
//      PUBLIC_URL (where Vouch reaches this agent), PORT, SOURCES_FILE,
//      MARGIN (e.g. 0.08 = 8% over the cheapest upstream), REFRESH_MS, STAKE
import http from 'node:http';
import fs from 'node:fs';

const VOUCH = (process.env.VOUCH_URL || 'http://localhost:4402').replace(/\/$/, '');
const KEY = process.env.VOUCH_KEY || '';
const PORT = Number(process.env.PORT) || 4480;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MARGIN = Number(process.env.MARGIN) || 0.08;
const REFRESH_MS = Number(process.env.REFRESH_MS) || 5 * 60 * 1000;
const sources = JSON.parse(fs.readFileSync(process.env.SOURCES_FILE || './sources.json', 'utf8'));
for (const s of sources) if (s?.source?.resale_permitted !== true) throw new Error(`source ${s?.name}: only resellable capacity may be listed`);

const money = (n) => Math.round(n * 1e6) / 1e6;
const keyOf = (s) => (s.api_key_env ? process.env[s.api_key_env] : s.api_key) || '';
const vouch = async (method, path, body) => {
  const r = await fetch(VOUCH + path, { method, headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${j?.error?.message || r.status}`); return j;
};

// ---- the price book: model -> cheapest source and terms ---------------------
const book = new Map();
async function refreshPrices() {
  const next = new Map();
  for (const s of sources) {
    let live = {};
    if (s.prices_url) { try { const r = await fetch(s.prices_url, { headers: keyOf(s) ? { Authorization: `Bearer ${keyOf(s)}` } : {} }); if (r.ok) live = await r.json(); } catch { /* keep the file's prices */ } }
    for (const [model, m] of Object.entries(s.models || {})) {
      const p = { ...m, ...(live[model] || {}) };
      const cur = next.get(model);
      if (!cur || p.price_in + p.price_out < cur.price_in + cur.price_out) next.set(model, { ...p, source: s });
    }
  }
  book.clear(); for (const [k, v] of next) book.set(k, v);
}

// ---- offers on Vouch -----------------------------------------------------------
let providerId = process.env.PROVIDER_ID || null;
async function ensureProvider() {
  if (providerId) return providerId;
  const p = await vouch('POST', '/v1/providers', { name: process.env.NAME || 'reference sourcing agent', endpoint_url: PUBLIC_URL + '/task', offers: { 'text.generate': { price_ceiling: 0.01, sla_deadline_ms: 20000 } }, stake: Number(process.env.STAKE) || 50 });
  providerId = p.id; console.log('registered provider', providerId);
  return providerId;
}
async function postOffers() {
  const pid = await ensureProvider();
  for (const [model, p] of book) {
    const body = { model, precision: p.precision ?? null, price_in: money(p.price_in * (1 + MARGIN)), price_out: money(p.price_out * (1 + MARGIN)), ttft_ms: p.ttft_ms ?? 1500, min_tps: p.min_tps ?? 10, context: p.context ?? 8192, retention: p.source.retention === 'none' ? 'none' : 'retained', source: p.source.source, endpoint_url: PUBLIC_URL + '/v1' };
    try { const o = await vouch('POST', `/v1/providers/${pid}/inference-offers`, body); console.log(`offer ${o.id} ${model} ${o.price_in}/${o.price_out} via ${p.source.name}`); }
    catch (e) { console.error(`offer ${model}:`, e.message); }
  }
}

// ---- the endpoint Vouch calls: proxy to the cheapest upstream ----------------
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) { res.writeHead(404); return res.end(); }
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }
    const p = book.get(body.model);
    if (!p) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `no source for ${body.model}` } })); }
    try {
      const up = await fetch(`${p.source.base_url.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(keyOf(p.source) ? { Authorization: `Bearer ${keyOf(p.source)}` } : {}) }, body: raw });
      res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
      if (!up.body) return res.end();
      for await (const chunk of up.body) res.write(chunk);
      res.end();
    } catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })); }
  });
});

await refreshPrices();
server.listen(PORT, async () => {
  console.log(`sourcing agent on ${PUBLIC_URL}, ${book.size} models from ${sources.length} sources, margin ${MARGIN * 100}%`);
  if (KEY) { await postOffers(); setInterval(async () => { await refreshPrices(); await postOffers(); }, REFRESH_MS).unref(); }
  else console.log('VOUCH_KEY not set: serving only, no offers posted');
});
