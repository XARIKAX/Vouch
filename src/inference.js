// The inference layer: standing offers from providers to sell model calls,
// cheapest-admissible routing, offchain metering and billing against a
// buyer's compute balance or escrow account, inline checks, canary audits,
// and penalties. Mounted into the engine; the HTTP surface is gateway.js.
//
// The gateway stores billing metadata only: model, token counts, cost,
// timing, provider. Prompts and responses are never written here.
import { ApiError } from './errors.js';
import { assertPublicUrl } from './netguard.js';
import { snapshotParams } from './launchpad-config.js';
import { inferenceFeeSplit, inferenceNetSplit, inferenceReservation, haircutValue, trackWeight } from './launchpad.js';
import { countMessages, countCompletion, countText } from './tokens.js';

const SOURCE_TYPES = new Set(['own_hardware', 'cloud_gpu', 'vendor_api', 'reseller_agreement']);
const FORBIDDEN_SOURCES = /account credit|shared key|leaked|borrowed|free tier|trial credit/i;
const FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);
const CANARY_PROMPTS = [
  'Reply with exactly the five words: the quick brown fox jumps',
  'What is 17 multiplied by 23? Answer with the number only.',
  'List the first six prime numbers, comma separated, nothing else.',
  'Write the word "vouch" backwards. Reply with the result only.',
  'Name the chemical symbol for gold. Reply with the symbol only.',
];
const MAX_CALL_LOG = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export function createInference({ state, cfg, persist, money, id, track, applySlash, agentRawBond, syncAgentCapacity, agentOf }) {
  // offers are a top-level collection so the store merges them per record;
  // the call log and usage counters live under state.inference
  state.inferenceOffers ??= {};
  state.inference ??= { calls: [], usage: {} };
  state.inference.calls ??= []; state.inference.usage ??= {};
  const inf = { get offers() { return state.inferenceOffers; }, get calls() { return state.inference.calls; }, get usage() { return state.inference.usage; } };
  const P = () => snapshotParams(cfg.launchpadParams || {});
  const paramsFor = (provider) => { const a = agentOf(provider); return a?.params ?? P(); };

  // ---- offers ---------------------------------------------------------------
  const isUrl = (u) => /^https?:\/\//.test(String(u ?? ''));
  function validateOffer(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const model = String(b.model ?? '').trim();
    if (!model || model.length > 120) throw new ApiError(400, 'invalid_input', 'model is required: the exact model id this offer serves');
    const num = (k, { min = 0, int = false } = {}) => { const v = b[k]; if (!(typeof v === 'number' && Number.isFinite(v) && v >= min && (!int || Number.isInteger(v)))) throw new ApiError(400, 'invalid_input', `${k} must be a ${int ? 'non-negative integer' : 'non-negative number'}`); return v; };
    const price_in = num('price_in'), price_out = num('price_out');
    const ttft_ms = num('ttft_ms', { min: 1, int: true }), min_tps = num('min_tps');
    const context = num('context', { min: 1, int: true });
    const retention = b.retention === 'retained' ? 'retained' : b.retention === 'none' ? 'none' : null;
    if (!retention) throw new ApiError(400, 'invalid_input', 'retention must be "none" (the upstream host keeps no prompts) or "retained"');
    const src = b.source && typeof b.source === 'object' ? b.source : null;
    if (!src || !SOURCE_TYPES.has(src.type) || typeof src.name !== 'string' || src.name.trim().length < 3) {
      throw new ApiError(400, 'source_required', `source must state where the capacity comes from: { type: ${[...SOURCE_TYPES].join(' | ')}, name, resale_permitted: true }`);
    }
    if (src.resale_permitted !== true) throw new ApiError(400, 'source_not_resellable', 'Only capacity whose seller permits resale can be offered. Set source.resale_permitted to true only if that is so.');
    if (FORBIDDEN_SOURCES.test(src.name) || FORBIDDEN_SOURCES.test(String(src.note ?? ''))) throw new ApiError(400, 'source_forbidden', 'Resold account credits, shared keys and leaked keys cannot be offered.');
    if (!isUrl(b.endpoint_url)) throw new ApiError(400, 'invalid_input', 'endpoint_url must be the OpenAI-compatible base URL your provider serves (…/v1)');
    assertPublicUrl(b.endpoint_url, 'endpoint_url', { allowPrivate: !!cfg.allowPrivateWebhooks });
    const precision = b.precision ? String(b.precision).slice(0, 24) : null;
    const upstream_key = typeof b.upstream_key === 'string' && b.upstream_key ? b.upstream_key : null;
    return { model, precision, price_in: money(price_in), price_out: money(price_out), ttft_ms, min_tps, context, retention, source: { type: src.type, name: src.name.trim().slice(0, 120), resale_permitted: true, ...(src.url ? { url: String(src.url).slice(0, 200) } : {}) }, endpoint_url: String(b.endpoint_url).replace(/\/$/, ''), upstream_key };
  }
  // The house (first-party sourcing) attaches after construction: it tells
  // routing when the operator's upstream budget is spent and meters what the
  // house pays its aggregator per billed call.
  let house = null;
  const attachHouse = (h) => { house = h; };
  function postOffer(providerId, body, { persist: doPersist = true } = {}) {
    const p = state.providers[providerId];
    if (!p) throw new ApiError(404, 'not_found', `No provider ${providerId}.`);
    const v = validateOffer(body);
    // one offer per provider and model: posting again updates it
    const existing = Object.values(inf.offers).find((o) => o.provider === providerId && o.model === v.model && o.status !== 'delisted');
    const now = Date.now();
    if (existing) { Object.assign(existing, v, { updated_at: now }); if (doPersist) persist(); return publicOffer(existing); }
    const o = { id: id('inf'), provider: providerId, ...v, status: 'active', delist_reason: null, created_at: now, updated_at: now, stats: { calls: 0, billed: 0, strikes: 0, revenue: 0, canaries: 0, canary_fail: 0, window: [], speed: [], canary_log: [] } };
    inf.offers[o.id] = o;
    if (doPersist) persist();
    return publicOffer(o);
  }
  function delistOffer(offerId, reason = 'withdrawn') {
    const o = inf.offers[offerId];
    if (!o) throw new ApiError(404, 'not_found', `No offer ${offerId}.`);
    o.status = 'delisted'; o.delist_reason = reason; o.updated_at = Date.now();
    persist();
    return publicOffer(o);
  }
  const trimWindow = (o) => { const cut = Date.now() - P().inference.auditWindowMs; o.stats.window = o.stats.window.filter((e) => e.ts >= cut); o.stats.canary_log = o.stats.canary_log.filter((e) => e.ts >= cut); o.stats.speed = o.stats.speed.slice(-40); };
  const windowRevenue = (o) => { trimWindow(o); return money(o.stats.window.reduce((s, e) => s + e.revenue, 0)); };
  const providerWindowRevenue = (providerId) => money(Object.values(inf.offers).filter((o) => o.provider === providerId).reduce((s, o) => s + windowRevenue(o), 0));
  function publicOffer(o) {
    const p = state.providers[o.provider];
    const canaries = o.stats.canary_log.length, failed = o.stats.canary_log.filter((c) => !c.ok).length;
    return {
      id: o.id, provider: o.provider, provider_name: p?.name ?? null, track: p ? Math.round(p.track) : null, agent_id: p?.agentId ?? null,
      model: o.model, precision: o.precision, price_in: o.price_in, price_out: o.price_out, ttft_ms: o.ttft_ms, min_tps: o.min_tps, context: o.context, retention: o.retention,
      source: o.source, status: o.status, delist_reason: o.delist_reason, created_at: o.created_at, updated_at: o.updated_at,
      ...(o.display_name ? { display_name: o.display_name } : {}), ...(o.house ? { house: true } : {}),
      audit: { calls: o.stats.calls, billed: o.stats.billed, strikes: o.stats.strikes, canaries, passed: canaries - failed, failed, window_revenue: windowRevenue(o), identity_check: cfg.inference?.referenceHosts?.[o.model] ? 'reference' : 'weak' },
      bond: { free: freeBond(o.provider), reserved: inferenceReservation(providerWindowRevenue(o.provider), 0, paramsFor(p)) },
    };
  }
  const listOffers = ({ model, provider, include_delisted } = {}) => Object.values(inf.offers)
    .filter((o) => (include_delisted || o.status === 'active') && (!model || o.model === model) && (!provider || o.provider === provider))
    .map(publicOffer).sort((a, b) => a.model.localeCompare(b.model) || (a.price_in + a.price_out) - (b.price_in + b.price_out));
  // the price book: per model, the cheapest bonded offer with its record
  function priceBook() {
    const byModel = new Map();
    for (const o of listOffers()) { if (!byModel.has(o.model) || (o.price_in + o.price_out) < (byModel.get(o.model).price_in + byModel.get(o.model).price_out)) byModel.set(o.model, o); }
    return [...byModel.values()].map((o) => ({ model: o.model, precision: o.precision, price_in: o.price_in, price_out: o.price_out, provider: o.provider, provider_name: o.provider_name, track: o.track, offer: o.id, audit: o.audit, source: o.source, retention: o.retention, ttft_ms: o.ttft_ms, min_tps: o.min_tps, context: o.context, offers: listOffers({ model: o.model }).length, ...(o.display_name ? { display_name: o.display_name } : {}), ...(o.house ? { house: true } : {}) }));
  }
  // The offers that serve a requested model id: exact matches first; failing
  // that, a bare id matches an aggregator-prefixed one ("gpt-4o" → "openai/gpt-4o"),
  // so a client migrated in one change keeps its model names.
  function offersFor(model) {
    const active = Object.values(inf.offers).filter((o) => o.status === 'active');
    const exact = active.filter((o) => o.model === model);
    if (exact.length || model.includes('/')) return exact;
    return active.filter((o) => o.model.slice(o.model.lastIndexOf('/') + 1) === model);
  }

  // ---- bond capacity ----------------------------------------------------------
  function freeBond(providerId) {
    const p = state.providers[providerId]; if (!p) return 0;
    const a = agentOf(p);
    const value = a ? haircutValue(agentRawBond(a), a.params) : p.stake;
    return money(Math.max(0, value - p.stakeReserved));
  }
  const hasCapacity = (o, callCost) => freeBond(o.provider) + 1e-9 >= inferenceReservation(providerWindowRevenue(o.provider), callCost, paramsFor(state.providers[o.provider]));

  // ---- routing ----------------------------------------------------------------
  const estimateCost = (o, tokensIn, maxOut) => money((tokensIn * o.price_in + maxOut * o.price_out) / 1e6);
  function route({ model, tokensIn, maxOut, prefs = {} }) {
    const retention = prefs.retention === 'any' ? 'any' : P().inference.defaultRetention;
    const rejected = [];
    const ok = [];
    const houseBlocked = house?.budget.blocked() ?? null;
    for (const o of offersFor(model)) {
      const p = state.providers[o.provider]; if (!p) continue;
      const est = estimateCost(o, tokensIn, maxOut);
      const why = (r) => rejected.push({ offer: o.id, provider: o.provider, reason: r });
      if (houseBlocked && house.isHouse(o)) { why(houseBlocked); continue; }
      if (prefs.max_price_in != null && o.price_in > prefs.max_price_in) { why('price_in above ceiling'); continue; }
      if (prefs.max_price_out != null && o.price_out > prefs.max_price_out) { why('price_out above ceiling'); continue; }
      if (prefs.max_ttft_ms != null && o.ttft_ms > prefs.max_ttft_ms) { why('time to first token above limit'); continue; }
      if (prefs.min_tps != null && o.min_tps < prefs.min_tps) { why('tokens per second below floor'); continue; }
      if (prefs.min_track != null && p.track < prefs.min_track) { why('track below min_track'); continue; }
      if (retention === 'none' && o.retention !== 'none') { why('host retains prompts'); continue; }
      if (Array.isArray(prefs.providers) && prefs.providers.length && !prefs.providers.includes(o.provider)) { why('not on allowlist'); continue; }
      if (tokensIn + maxOut > o.context) { why('context too small'); continue; }
      if (!hasCapacity(o, est)) { why('provider at bond capacity'); continue; }
      ok.push({ offer: o, est });
    }
    ok.sort((a, b) => a.est - b.est || state.providers[b.offer.provider].track - state.providers[a.offer.provider].track);
    return { candidates: ok, rejected };
  }

  // ---- accounts & locks -------------------------------------------------------
  const accountIdOf = (key) => key.agentId ?? key.id;
  function reserve(key, amount) {
    const acct = state.accounts[accountIdOf(key)];
    if (!acct) throw new ApiError(402, 'compute_balance_empty', 'This account has no compute balance.');
    const available = money(acct.balance - acct.locked);
    if (amount > available + 1e-9) throw new ApiError(402, key.agentId ? 'compute_balance_empty' : 'escrow_insufficient', key.agentId ? `Compute balance is ${available}; this call could cost up to ${amount}. Top it up from job revenue or trading fees.` : `Escrow balance available is ${available}; this call could cost up to ${amount}.`, { available, required: amount });
    acct.locked = money(acct.locked + amount);
    return () => { acct.locked = money(Math.max(0, acct.locked - amount)); };
  }

  // ---- inline checks ----------------------------------------------------------
  // The response shape, the finish reason, the speed terms, and the reported
  // token counts against the gateway's own. Returns the first failure or null.
  function inlineCheck(o, { message, finish_reason, ttft_ms, tps, tokensOut, reported, stream }) {
    const content = message?.content, tools = message?.tool_calls;
    if ((typeof content !== 'string' || !content.trim()) && !(Array.isArray(tools) && tools.length)) return 'empty or malformed response';
    if (!FINISH.has(String(finish_reason ?? ''))) return `invalid finish reason "${finish_reason}"`;
    if (ttft_ms > o.ttft_ms * 1.5 + 250) return `time to first token ${ttft_ms} ms over the offer's ${o.ttft_ms} ms`;
    if (tokensOut >= 24 && tps != null && tps < o.min_tps * 0.7) return `${tps.toFixed(1)} tokens/s under the offer's ${o.min_tps}`;
    const tol = P().inference.tokenTolerance;
    if (reported?.completion_tokens != null && tokensOut > 0) { const d = Math.abs(reported.completion_tokens - tokensOut) / tokensOut; if (d > tol + 8 / tokensOut) return `reported ${reported.completion_tokens} completion tokens, gateway counted ${tokensOut}`; }
    void stream;
    return null;
  }
  const speedMissed = (o, { ttft_ms, tps, tokensOut }) => ttft_ms > o.ttft_ms || (tokensOut >= 24 && tps != null && tps < o.min_tps);

  // ---- billing ----------------------------------------------------------------
  function releaseHeld(p) {
    if (!p.earningsHeld?.length) return;
    const now = Date.now(), keep = [];
    for (const h of p.earningsHeld) { if (h.release_at <= now) p.earnings = money(p.earnings + h.amount); else keep.push(h); }
    p.earningsHeld = keep;
  }
  function recordCall(meta) {
    inf.calls.push(meta);
    if (inf.calls.length > MAX_CALL_LOG) inf.calls.splice(0, inf.calls.length - MAX_CALL_LOG);
  }
  function bump(usageKey, day, model, { cost = 0, tokensIn = 0, tokensOut = 0, calls = 1 }) {
    const u = (inf.usage[usageKey] ??= {}); const d = (u[day] ??= {}); const m = (d[model] ??= { calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 });
    m.calls += calls; m.tokens_in += tokensIn; m.tokens_out += tokensOut; m.cost = money(m.cost + cost);
  }
  // A completed, checked call: debit the buyer, fee, provider payout (held),
  // launched-agent routing, track, metadata.
  function bill({ key, payer, offer: o, tokensIn, tokensOut, reported, ttft_ms, tps, canary = false }) {
    const p = state.providers[o.provider];
    const params = paramsFor(p);
    const cost = money((tokensIn * o.price_in + tokensOut * o.price_out) / 1e6);
    const now = Date.now(), day = dayOf(now);
    let accountId = null;
    if (payer === 'treasury') { state.treasury.balance = money(state.treasury.balance - cost); }
    else {
      accountId = accountIdOf(key);
      const acct = state.accounts[accountId];
      acct.balance = money(acct.balance - cost);
      acct.history.push({ ts: now, kind: 'inference', amount: -cost, tx: id('call'), model: o.model, provider: o.provider });
      bump(accountId, day, o.model, { cost, tokensIn, tokensOut });
    }
    const f = inferenceFeeSplit(cost, params);
    state.treasury.balance = money(state.treasury.balance + f.treasury);
    state.treasury.burned = money(state.treasury.burned + f.burn);
    // the provider's net is held, then released; it stays slashable meanwhile
    p.earningsHeld ??= [];
    p.earningsHeld.push({ amount: f.net, release_at: now + params.inference.payoutHoldMs, offer: o.id });
    releaseHeld(p);
    const a = agentOf(p);
    let split = null;
    if (a) {
      split = inferenceNetSplit(f.net, a.params);
      a.ownerPaid = money(a.ownerPaid + split.owner);
      a.buyback = money(a.buyback + split.buyback); state.treasury.buyback = money(state.treasury.buyback + split.buyback);
      const twap = a.token.twapUsdg, bondTokens = twap > 0 ? money(split.bond / twap) : 0;
      a.bond.tokenQty = money(a.bond.tokenQty + bondTokens); a.bondToppedUp = money(a.bondToppedUp + split.bond);
      a.burned = money(a.burned + f.burn); a.treasuryPaid = money(a.treasuryPaid + f.treasury);
      a.ledger.push({ ts: now, kind: 'inference_revenue', price: cost, fee: f.fee, burn: f.burn, treasury: f.treasury, net: f.net, ...split, bondTokens, twap });
      // track: distinct paying buyers weigh, same-owner traffic does not
      const buyerOwner = key ? state.keys[key.id]?.owner ?? (key.agentId ? state.agents[key.agentId]?.owner : null) : null;
      const sameOwner = !!(a.owner && buyerOwner && buyerOwner === a.owner);
      const w = payer === 'treasury' ? 0 : trackWeight({ sameOwner, validators: ['checks'] });
      if (w > 0) { p.track = Math.min(100, p.track + 0.05 * w); a.counterparties ??= {}; a.counterparties[buyerOwner || accountId] = true; }
      syncAgentCapacity(a);
    } else if (payer !== 'treasury') p.track = Math.min(100, p.track + 0.05);
    o.stats.calls++; o.stats.billed++; o.stats.revenue = money(o.stats.revenue + f.net);
    o.stats.window.push({ ts: now, revenue: f.net });
    if (house?.isHouse(o)) house.budget.record(o, tokensIn, tokensOut);
    const meta = { id: id('call'), ts: now, account: accountId, agent_id: key?.agentId ?? null, provider: o.provider, offer: o.id, model: o.model, tokens_in: tokensIn, tokens_out: tokensOut, reported_in: reported?.prompt_tokens ?? null, reported_out: reported?.completion_tokens ?? null, cost, fee: f.fee, net: f.net, ttft_ms, tps: tps == null ? null : Math.round(tps * 10) / 10, status: 'billed', canary };
    recordCall(meta);
    persist();
    return { ...meta, split };
  }
  function strike(o, reason, extra = {}) {
    o.stats.calls++; o.stats.strikes++;
    const p = state.providers[o.provider];
    recordCall({ id: id('call'), ts: Date.now(), provider: o.provider, offer: o.id, model: o.model, status: 'failed', reason, cost: 0, ...extra });
    if (p) p.track = Math.max(0, p.track - 0.5);
    persist();
  }
  function noteSpeed(o, missed) { o.stats.speed.push(missed ? 1 : 0); o.stats.speed = o.stats.speed.slice(-40); }

  // ---- audit ------------------------------------------------------------------
  const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  function similar(a, b) {
    const A = new Set(normalize(a)), B = new Set(normalize(b));
    if (!A.size && !B.size) return 1;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    return inter / Math.max(A.size, B.size);
  }
  // Decide whether a canary should follow this call: the configured rate,
  // and a daily minimum spread over the day's traffic.
  function wantsCanary(o) {
    const p = P().inference, today = dayOf(Date.now());
    const todays = o.stats.canary_log.filter((c) => dayOf(c.ts) === today).length;
    if (todays < p.canaryMinPerDay && Math.random() < 0.25) return true;
    return Math.random() < p.canaryRate;
  }
  // The verdict over the rolling window. Returns the penalty applied, if any.
  function evaluate(o) {
    trimWindow(o);
    const p = P().inference, prov = state.providers[o.provider];
    if (!prov || o.status !== 'active') return null;
    const canaries = o.stats.canary_log, failed = canaries.filter((c) => !c.ok).length;
    const rev = windowRevenue(o);
    if (canaries.length >= p.substitutionMinCanaries && failed / canaries.length > p.substitutionFailRate) {
      const amount = applySlash(prov, rev, p.substitutionSlashMultiple, { reason: 'substitution', offer: o.id });
      prov.slashedCount++; prov.track = Math.max(0, prov.track - 15);
      o.status = 'delisted'; o.delist_reason = 'substitution'; o.updated_at = Date.now();
      persist();
      return { verdict: 'substitution', slashed: amount, failed, canaries: canaries.length };
    }
    const sp = o.stats.speed;
    if (sp.length >= 20 && sp.reduce((s, v) => s + v, 0) / sp.length > p.speedMissRate) {
      const amount = applySlash(prov, rev, p.speedMissSlashShare, { reason: 'speed', offer: o.id });
      prov.slashedCount++; prov.track = Math.max(0, prov.track - 5);
      o.status = 'delisted'; o.delist_reason = 'speed'; o.updated_at = Date.now();
      persist();
      return { verdict: 'speed', slashed: amount };
    }
    return null;
  }
  function recordCanary(o, ok, reason) { o.stats.canaries++; if (!ok) o.stats.canary_fail++; o.stats.canary_log.push({ ts: Date.now(), ok, reason }); persist(); return evaluate(o); }
  // A declared source found false: treated like substitution.
  function falseSource(offerId, note) {
    const o = inf.offers[offerId]; if (!o) throw new ApiError(404, 'not_found', `No offer ${offerId}.`);
    const prov = state.providers[o.provider], p = P().inference;
    const amount = applySlash(prov, windowRevenue(o), p.substitutionSlashMultiple, { reason: 'false_source', offer: o.id, note });
    prov.slashedCount++; prov.track = Math.max(0, prov.track - 15);
    o.status = 'delisted'; o.delist_reason = 'false_source'; o.updated_at = Date.now();
    persist();
    return { ...publicOffer(o), slashed: amount };
  }
  const canaryPrompt = (o) => { const i = (o.stats.canaries + o.stats.calls) % CANARY_PROMPTS.length; return CANARY_PROMPTS[i]; };
  const referenceFor = (model) => cfg.inference?.referenceHosts?.[model] ?? null;

  // ---- usage ------------------------------------------------------------------
  function usage(key, { days = 30 } = {}) {
    const acctId = accountIdOf(key), u = inf.usage[acctId] ?? {};
    const cut = dayOf(Date.now() - days * DAY_MS);
    const by_day = Object.entries(u).filter(([d]) => d >= cut).sort().map(([day, models]) => ({ day, models, cost: money(Object.values(models).reduce((s, m) => s + m.cost, 0)) }));
    const by_model = {};
    for (const { models } of by_day) for (const [m, v] of Object.entries(models)) { const t = (by_model[m] ??= { calls: 0, tokens_in: 0, tokens_out: 0, cost: 0 }); t.calls += v.calls; t.tokens_in += v.tokens_in; t.tokens_out += v.tokens_out; t.cost = money(t.cost + v.cost); }
    const acct = state.accounts[acctId];
    return { account: acctId, agent_id: key.agentId ?? null, balance: acct?.balance ?? 0, locked: acct?.locked ?? 0, by_day, by_model, total: money(by_day.reduce((s, d) => s + d.cost, 0)) };
  }
  function providerInference(providerId) {
    const p = state.providers[providerId]; if (!p) return null;
    releaseHeld(p);
    const offers = listOffers({ provider: providerId, include_delisted: true });
    const strikes = inf.calls.filter((c) => c.provider === providerId && c.status === 'failed').slice(-20).map((c) => ({ ts: c.ts, offer: c.offer, reason: c.reason }));
    return { offers, strikes, held: money((p.earningsHeld ?? []).reduce((s, h) => s + h.amount, 0)), window_revenue: providerWindowRevenue(providerId), bond_free: freeBond(providerId), bond_reserved: inferenceReservation(providerWindowRevenue(providerId), 0, paramsFor(p)), calls: inf.calls.filter((c) => c.provider === providerId).length };
  }

  return {
    postOffer, delistOffer, listOffers, priceBook, publicOffer, offersFor, attachHouse, route, estimateCost, reserve, inlineCheck, speedMissed, noteSpeed, bill, strike, wantsCanary, recordCanary, evaluate, falseSource, canaryPrompt, referenceFor, similar, usage, providerInference, releaseHeld, accountIdOf, freeBond,
    counts: { messages: countMessages, completion: countCompletion, text: countText },
    get offers() { return inf.offers; }, get calls() { return inf.calls; }, track,
  };
}
