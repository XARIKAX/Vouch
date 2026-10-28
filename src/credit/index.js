// Vouch Credit, engine side. Phase 1: the credit record.
//
// Every provider (a plain provider or a launched agent's provider) has a credit
// record built from the engine's own settlement flow: verified settlements,
// slashes and dispute losses, recorded here as they happen. The score is
// computed by src/credit/score.js, the mirror of the on-chain ScoreLib, over
// those events. When a provider links an ERC-8004 agentId and a credit chain
// is configured, the same events are posted to the CreditRegistry by the
// attester (src/credit/chain.js); the on-chain score is then the authoritative
// one and the report shows both.
//
// Subjects are provider ids (prv_…). An agent id (agt_…) resolves to its
// provider; a numeric id resolves through the identity links.
import { ApiError } from '../errors.js';
import { replay, score as scoreOf, breakdown, creditLine, tier, feeBps30d, decayed, WORK_HALF_LIFE, toUsdg, fromUsdg } from './score.js';
import { creditConfig, createCreditChain, linkMessage } from './chain.js';

export const CREDIT_LINE_CAP_USD = 1000;
export const MAX_EVENTS_IN_REPORT = 50;

export function createCredit({ state, persist, cfg, track = (p) => p }) {
  state.credit ??= {};
  state.credit.events ??= [];      // { id, kind, subject, ref, amount (USD), ts, days?, on_time? }
  state.credit.identities ??= {};  // subject -> { agent_id, chain_id, owner, verified, linked_at, by }
  state.credit.outbox ??= [];      // { event_id, subject, agent_id, status: 'pending'|'posted'|'failed', tx?, error?, attempts }
  const config = cfg.credit ?? creditConfig();
  let chain = null;           // lazily created on-chain client
  let chainError = null;
  const reports = new Map();  // subject -> replayed report (cache; dropped on write)
  const now = () => Math.floor(Date.now() / 1000);

  async function chainClient() {
    if (!config.enabled || chain || chainError) return chain;
    try { chain = await createCreditChain(config); } catch (e) { chainError = e.message; }
    return chain;
  }

  // ---- subjects ---------------------------------------------------------------

  function resolve(idOrAgentId) {
    const s = String(idOrAgentId ?? '');
    if (state.providers[s]) return s;
    if (state.agents[s]) return state.agents[s].providerId ?? s;
    if (/^\d+$/.test(s)) {
      const hit = Object.entries(state.credit.identities).find(([, v]) => String(v.agent_id) === s);
      if (hit) return hit[0];
    }
    throw new ApiError(404, 'not_found', `No provider, agent or linked agentId ${s}.`);
  }

  function eventsFor(subject) { return state.credit.events.filter((e) => e.subject === subject); }

  function reportFor(subject) {
    let r = reports.get(subject);
    if (!r) {
      r = replay(eventsFor(subject).map((e) => ({ ...e, amount: toUsdg(e.amount), ts: Math.floor(e.ts / 1000) })));
      reports.set(subject, r);
    }
    return r;
  }

  // ---- recording -----------------------------------------------------------------

  // kind: settlement | slash | dispute_loss (Phase 1: the work events)
  function record(kind, subject, ref, amount, extra = {}) {
    if (!subject || !state.providers[subject]) return null;
    const event = { id: `cev_${state.credit.events.length + 1}_${Date.now().toString(36)}`, kind, subject, ref: String(ref), amount: Number(amount) || 0, ts: Date.now(), ...extra };
    state.credit.events.push(event);
    reports.delete(subject);
    const link = state.credit.identities[subject];
    if (link) enqueue(event, link);
    return event;
  }

  function enqueue(event, link) {
    state.credit.outbox.push({ event_id: event.id, subject: event.subject, agent_id: link.agent_id, status: 'pending', attempts: 0 });
    if (config.enabled) track(flush());
  }

  // Post pending outbox entries, oldest first, one at a time (nonce order).
  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const client = await chainClient();
      if (!client?.canWrite) return { posted: 0, reason: client ? 'read-only: no attester key' : (chainError ?? config.reason) };
      let posted = 0;
      for (const item of state.credit.outbox.filter((o) => o.status === 'pending')) {
        const event = state.credit.events.find((e) => e.id === item.event_id);
        if (!event) { item.status = 'failed'; item.error = 'event missing'; continue; }
        item.attempts += 1;
        try {
          item.tx = await client.post(event, item.agent_id);
          item.status = 'posted'; item.posted_at = Date.now(); delete item.error; posted++;
        } catch (e) {
          item.error = String(e.reason ?? e.shortMessage ?? e.message).slice(0, 200);
          if (e.already || /AlreadyRecorded/.test(item.error)) { item.status = 'posted'; item.note = 'already recorded'; delete item.error; }
          else if (item.attempts >= 5) item.status = 'failed';
        }
        persist();
      }
      return { posted };
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // ---- identity ----------------------------------------------------------------------

  async function link(subject, body = {}, actor) {
    const agentId = String(body.agent_id ?? '').trim();
    if (!/^\d+$/.test(agentId)) throw new ApiError(400, 'invalid_input', 'agent_id must be an ERC-8004 agentId (an unsigned integer)');
    const taken = Object.entries(state.credit.identities).find(([s, v]) => v.agent_id === agentId && s !== subject);
    if (taken) throw new ApiError(409, 'identity_taken', `agentId ${agentId} is already linked to ${taken[0]}.`);
    const client = await chainClient();
    let verified = false, owner = body.address ?? null;
    if (client) {
      if (!body.signature) throw new ApiError(400, 'signature_required', `Sign "${linkMessage(subject, agentId)}" with the wallet that owns agentId ${agentId} and send it as signature.`);
      const v = await client.verifyLink(subject, agentId, body.signature);
      if (!v.ok) throw new ApiError(403, v.reason === 'unknown_agent' ? 'unknown_agent' : 'not_identity_owner', v.reason === 'unknown_agent' ? `agentId ${agentId} is not registered on chain ${config.chainId}.` : `The signature is not from the owner of agentId ${agentId}.`, { owner: v.owner ?? null });
      verified = true; owner = v.owner;
    }
    const linkRec = { agent_id: agentId, chain_id: config.chainId || null, owner, verified, linked_at: Date.now(), by: actor?.key?.id ?? (actor?.admin ? 'admin' : null) };
    state.credit.identities[subject] = linkRec;
    // Backfill: every event already on the record is posted under the new id.
    state.credit.outbox = state.credit.outbox.filter((o) => o.subject !== subject);
    for (const e of eventsFor(subject)) state.credit.outbox.push({ event_id: e.id, subject, agent_id: agentId, status: 'pending', attempts: 0 });
    persist();
    if (config.enabled) track(flush());
    return identityOf(subject);
  }

  function identityOf(subject) {
    const l = state.credit.identities[subject];
    if (!l) return null;
    const mine = state.credit.outbox.filter((o) => o.subject === subject);
    return { ...l, outbox: { pending: mine.filter((o) => o.status === 'pending').length, posted: mine.filter((o) => o.status === 'posted').length, failed: mine.filter((o) => o.status === 'failed').length } };
  }

  // ---- reads ---------------------------------------------------------------------------

  function scoreFor(subject, at = now()) { return Number(scoreOf(reportFor(subject), at)); }

  function summary(subject) {
    const r = reportFor(subject);
    const at = now();
    const b = breakdown(r, at);
    const recent = decayed(r.recentVolume, r.workUpdatedAt, at, WORK_HALF_LIFE);
    const link = identityOf(subject);
    return {
      subject, agent_id: link?.agent_id ?? null, verified_identity: link?.verified ?? false,
      score: b.score, tier: b.tier, fee_bps_30d: b.fee_bps_30d,
      credit_line_usd: fromUsdg(creditLine(b.score, recent, toUsdg(CREDIT_LINE_CAP_USD))),
      recent_volume_usd: b.recent_volume_usd, as_of: at,
    };
  }

  async function report(subject) {
    const r = reportFor(subject);
    const at = now();
    const s = summary(subject);
    const events = eventsFor(subject);
    const out = {
      ...s,
      points: breakdown(r, at).points,
      inputs: {
        settled_count: Number(r.settledCount), settled_volume_usd: fromUsdg(r.settledVolume),
        slash_count: Number(r.slashCount), slashed_volume_usd: fromUsdg(r.slashedVolume),
        dispute_loss_count: Number(r.disputeLossCount), dispute_loss_volume_usd: fromUsdg(r.disputeLossVolume),
        loans_repaid: Number(r.loansRepaid), loans_repaid_on_time: Number(r.loansRepaidOnTime), repaid_principal_days_usd: fromUsdg(r.repaidPrincipalDays),
        advances_repaid: Number(r.advancesRepaid), advances_repaid_volume_usd: fromUsdg(r.advancesRepaidVolume),
        defaults: Number(r.defaults), defaulted_volume_usd: fromUsdg(r.defaultedVolume), recoveries: Number(r.recoveries),
      },
      identity: identityOf(subject),
      events: events.slice(-MAX_EVENTS_IN_REPORT).map(({ subject: _s, ...e }) => e),
      events_total: events.length,
      chain: { enabled: config.enabled, chain_id: config.chainId || null, reason: config.reason },
    };
    // The chain is authoritative once the record is linked and readable.
    const client = await chainClient();
    if (client && out.agent_id) {
      try { out.chain.report = await client.report(out.agent_id); out.chain.score = out.chain.report.score; } catch (e) { out.chain.error = String(e.shortMessage ?? e.message).slice(0, 200); }
    }
    return out;
  }

  function line(subject) {
    const s = summary(subject);
    return {
      subject: s.subject, agent_id: s.agent_id, score: s.score, tier: s.tier, fee_bps_30d: s.fee_bps_30d,
      credit_line_usd: s.credit_line_usd, cap_usd: CREDIT_LINE_CAP_USD, recent_volume_usd: s.recent_volume_usd,
      basis: s.tier === 0 ? 'below tier 1 (score < 300): no line' : 'max(base line for the tier, half the recency-weighted settlement volume), capped',
      note: 'Phase 1 sizing only: borrowing is not open.',
    };
  }

  async function status() {
    const client = await chainClient();
    return {
      phase: 1,
      chain: {
        enabled: config.enabled, chain_id: config.chainId || null, rpc: config.rpc ? config.rpc.replace(/\/\/([^@/]+@)/, '//') : null, explorer: config.explorer,
        contracts: config.record ? { identity_registry: config.record.identityRegistry, usdg: config.record.usdg, credit_registry: config.record.creditRegistry || null, credit_pool: config.record.creditPool || null } : null,
        attester: client?.attesterAddress ?? null, can_write: !!client?.canWrite, reason: chainError ?? config.reason,
      },
      records: Object.keys(state.providers).filter((p) => eventsFor(p).length).length,
      events: state.credit.events.length,
      identities: Object.keys(state.credit.identities).length,
      outbox: { pending: state.credit.outbox.filter((o) => o.status === 'pending').length, posted: state.credit.outbox.filter((o) => o.status === 'posted').length, failed: state.credit.outbox.filter((o) => o.status === 'failed').length },
      score: { max: 1000, tiers: { 1: 300, 2: 550, 3: 800 }, fee_bps_30d: { 1: 300, 2: 200, 3: 100 }, credit_line_cap_usd: CREDIT_LINE_CAP_USD },
    };
  }

  return { config, resolve, record, flush, link, identityOf, scoreFor, summary, report, line, status, eventsFor, reportFor, tier, feeBps30d, linkMessage };
}
