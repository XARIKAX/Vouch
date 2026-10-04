// First-party sourcing: the operator resells an OpenAI-compatible aggregator's
// whole catalog through the gateway. The aggregator's model list is read,
// every model becomes a bonded offer on a house provider at the upstream
// price plus the operator's margin, and the gateway proxies calls to the
// aggregator with the operator's key. Nothing here runs until an upstream URL
// and key are configured; the operator prepays the aggregator and a daily
// budget caps what the house will spend on it.
//
//   VOUCH_UPSTREAM_URL      https://openrouter.ai/api/v1 (default when OPENROUTER_API_KEY is set)
//   VOUCH_UPSTREAM_KEY      the aggregator key (OPENROUTER_API_KEY also read)
//   VOUCH_UPSTREAM_NAME     "OpenRouter" (admin-only; the public never sees the aggregator's name)
//   VOUCH_UPSTREAM_LABEL    "Vouch sourcing" (the house provider's public name)
//   VOUCH_UPSTREAM_MARGIN   0.10 (10% over the upstream price)
//   VOUCH_UPSTREAM_BOND     1000 (house bond, in ledger dollars)
//   VOUCH_UPSTREAM_BUDGET_USD  5 (what the house may spend upstream per UTC day)
//   VOUCH_UPSTREAM_RETENTION   none | retained (what the aggregator keeps; declared on every offer)
//   VOUCH_UPSTREAM_MODELS   optional regex; only matching model ids are offered
//   VOUCH_UPSTREAM_TTFT_MS / VOUCH_UPSTREAM_MIN_TPS  speed terms declared on every offer (8000 / 5)
//   VOUCH_UPSTREAM_REFRESH_MS  how often the catalog is re-read (6 hours)
import { sha256 } from './util.js';
import { fetchWithTimeout } from './netguard.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = () => Math.floor(Date.now() / DAY_MS);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export function upstreamConfig(env = process.env) {
  const key = env.VOUCH_UPSTREAM_KEY || env.OPENROUTER_API_KEY || '';
  const url = (env.VOUCH_UPSTREAM_URL || (env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : '')).replace(/\/$/, '');
  const name = env.VOUCH_UPSTREAM_NAME || (/openrouter/i.test(url) ? 'OpenRouter' : 'upstream aggregator');
  let models = null;
  if (env.VOUCH_UPSTREAM_MODELS) { try { models = new RegExp(env.VOUCH_UPSTREAM_MODELS, 'i'); } catch { models = null; } }
  return {
    enabled: !!(url && key),
    url, key, name,
    label: (env.VOUCH_UPSTREAM_LABEL || 'Vouch sourcing').slice(0, 60),
    margin: Math.min(5, Math.max(0, num(env.VOUCH_UPSTREAM_MARGIN, 0.10))),
    bond: Math.max(1, num(env.VOUCH_UPSTREAM_BOND, 1000)),
    budgetUsd: Math.max(0, num(env.VOUCH_UPSTREAM_BUDGET_USD, 5)),
    retention: env.VOUCH_UPSTREAM_RETENTION === 'retained' ? 'retained' : 'none',
    ttftMs: Math.max(1, Math.round(num(env.VOUCH_UPSTREAM_TTFT_MS, 8000))),
    minTps: Math.max(0, num(env.VOUCH_UPSTREAM_MIN_TPS, 5)),
    refreshMs: Math.max(60 * 1000, num(env.VOUCH_UPSTREAM_REFRESH_MS, 6 * 60 * 60 * 1000)),
    models,
  };
}

// Read an aggregator's model list. OpenRouter's shape is the reference:
// { data: [{ id, name, context_length, pricing: { prompt, completion } (USD per token, strings),
//            architecture: { output_modalities }, top_provider: { context_length } }] }
// Any OpenAI-compatible /models listing works; models without a price are
// skipped, since an offer needs one.
export function normalizeCatalog(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  const out = [];
  for (const m of rows) {
    const id = String(m?.id ?? '').trim();
    if (!id || id.length > 120) continue;
    const pricing = m?.pricing ?? {};
    const pIn = Number(pricing.prompt), pOut = Number(pricing.completion);
    if (!Number.isFinite(pIn) || !Number.isFinite(pOut) || pIn < 0 || pOut < 0) continue; // dynamic routers price as -1
    const mods = m?.architecture?.output_modalities;
    if (Array.isArray(mods) && mods.length && !mods.includes('text')) continue;
    const context = Number(m?.context_length ?? m?.top_provider?.context_length) || 8192;
    const name = typeof m?.name === 'string' ? m.name.slice(0, 120) : id;
    out.push({ id, name, price_in: pIn * 1e6, price_out: pOut * 1e6, context: Math.max(1, Math.round(context)) });
  }
  return out;
}

export async function fetchCatalog(cfg) {
  const res = await fetchWithTimeout(`${cfg.url}/models`, { headers: { Accept: 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) } }, 20000);
  if (!res.ok) throw new Error(`${cfg.name} /models answered ${res.status}`);
  return normalizeCatalog(await res.json());
}

export function createUpstream({ state, cfg, inference, persist, money }) {
  const up = cfg.upstream ?? upstreamConfig();
  state.inference ??= {};
  const rec = () => (state.inference.upstream ??= { provider: null, synced_at: 0, models: 0, error: null, spend: { day: utcDay(), usd: 0, calls: 0, total_usd: 0 } });
  // one house provider per upstream URL, the same id on every instance so
  // concurrent cold starts converge on one record
  const providerId = () => `prv_house_${sha256(up.url).slice(0, 10)}`;
  const isHouse = (o) => up.enabled && o?.provider === providerId();
  const round = (n) => money ? money(n) : Math.round(n * 1e6) / 1e6;
  // The public face of the house: its label, never the aggregator. The
  // declared source is true and generic; the aggregator's name is admin-only.
  const publicSource = () => ({ type: 'reseller_agreement', name: `${up.label}: upstream capacity at the best price on the net, resold under its terms`, resale_permitted: true });
  // the offer terms that, when changed, make the posted offers stale
  const signature = () => sha256([up.label, up.margin, up.retention, up.ttftMs, up.minTps, String(up.models ?? '')].join('|')).slice(0, 12);

  function ensureProvider() {
    const pid = providerId();
    let p = state.providers[pid];
    if (!p) {
      p = { id: pid, name: up.label, endpoint_url: up.url, protocol: 'http', offers: {}, stake: up.bond, stakeReserved: 0, earnings: 0, track: 50, settledCount: 0, slashedCount: 0, house: true };
      state.providers[pid] = p;
    } else { p.stake = Math.max(up.bond, p.stakeReserved); p.house = true; p.endpoint_url = up.url; p.name = up.label; }
    return p;
  }

  let inflight = null;
  // Read the catalog and make every priced model an offer: upstream price
  // plus margin, the operator's declared speed and retention terms, the
  // aggregator as the declared source. Models that left the catalog are
  // delisted; duplicates from concurrent syncs are folded into the oldest.
  async function sync({ force = false } = {}) {
    if (!up.enabled) return { enabled: false };
    if (inflight) return inflight;
    const r = rec();
    if (!force && r.synced_at && r.sig === signature() && Date.now() - r.synced_at < up.refreshMs) return info();
    inflight = (async () => {
      try {
        const catalog = (await fetchCatalog(up)).filter((m) => !up.models || up.models.test(m.id));
        if (!catalog.length) throw new Error(`${up.name} listed no priced text models`);
        const p = ensureProvider();
        const source = publicSource();
        const seen = new Set();
        for (const m of catalog) {
          seen.add(m.id);
          const posted = inference.postOffer(p.id, {
            model: m.id, precision: null, price_in: round(m.price_in * (1 + up.margin)), price_out: round(m.price_out * (1 + up.margin)),
            ttft_ms: up.ttftMs, min_tps: up.minTps, context: m.context, retention: up.retention, source, endpoint_url: up.url, upstream_key: up.key,
          }, { persist: false });
          const o = state.inferenceOffers[posted.id];
          o.cost_in = round(m.price_in); o.cost_out = round(m.price_out); o.display_name = m.name; o.house = true;
        }
        // fold duplicates (two instances posting the same model at once) and delist what left
        const mine = Object.values(state.inferenceOffers).filter((o) => o.provider === p.id && o.status !== 'delisted').sort((a, b) => a.created_at - b.created_at);
        const kept = new Set();
        for (const o of mine) {
          if (!seen.has(o.model)) { o.status = 'delisted'; o.delist_reason = 'left_catalog'; o.updated_at = Date.now(); continue; }
          if (kept.has(o.model)) { o.status = 'delisted'; o.delist_reason = 'duplicate'; o.updated_at = Date.now(); continue; }
          kept.add(o.model);
        }
        Object.assign(r, { provider: p.id, synced_at: Date.now(), models: kept.size, error: null, sig: signature() });
        persist();
        return info();
      } catch (e) {
        r.error = String(e?.message ?? e); r.synced_at = r.synced_at || 0; r.last_attempt = Date.now();
        persist();
        return info();
      } finally { inflight = null; }
    })();
    return inflight;
  }
  // true when a sync should run: never run, or older than the refresh interval
  const due = () => {
    if (!up.enabled) return false;
    const r = rec(); const last = Math.max(r.synced_at || 0, r.last_attempt || 0);
    if (!r.synced_at && !r.last_attempt) return true;
    if (r.synced_at && r.sig !== signature() && Date.now() - (r.last_attempt || 0) >= 60 * 1000) return true; // the terms changed: repost
    return Date.now() - last >= (r.synced_at ? up.refreshMs : 60 * 1000);
  };
  // kick a sync in the background when one is due; never blocks a request
  function ensureFresh(track = (p) => p) { if (due() && !inflight) track(sync()); }

  // the house's own daily upstream budget, in what it pays the aggregator
  const roll = (s) => { if (s.day !== utcDay()) { s.day = utcDay(); s.usd = 0; s.calls = 0; } };
  const budget = {
    blocked() { if (!up.enabled) return null; const s = rec().spend; roll(s); return up.budgetUsd > 0 && s.usd >= up.budgetUsd ? 'house upstream budget spent for today' : null; },
    record(o, tokensIn, tokensOut) {
      const s = rec().spend; roll(s);
      const usd = ((tokensIn * (o.cost_in ?? 0)) + (tokensOut * (o.cost_out ?? 0))) / 1e6;
      s.usd = round(s.usd + usd); s.total_usd = round((s.total_usd ?? 0) + usd); s.calls++;
    },
  };

  // Public: the house exists, how many models it sources, when the book was
  // last read, whether it is paused. Admin adds the aggregator, the margin,
  // the budget and the last error.
  function info({ admin = false } = {}) {
    if (!up.enabled) return { enabled: false };
    const r = rec(); roll(r.spend);
    const pub = { enabled: true, label: up.label, provider: r.provider, models: r.models, retention: up.retention, synced_at: r.synced_at ? new Date(r.synced_at).toISOString() : null, paused: !!budget.blocked(), stale: !r.synced_at || !!r.error };
    if (!admin) return pub;
    return { ...pub, name: up.name, url: up.url, margin: up.margin, error: r.error, budget: { today_usd: r.spend.usd, budget_usd: up.budgetUsd, calls_today: r.spend.calls, total_usd: r.spend.total_usd ?? 0, blocked: budget.blocked() } };
  }

  return { config: up, sync, due, ensureFresh, info, budget, isHouse, providerId };
}
