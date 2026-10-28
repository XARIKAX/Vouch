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

export function createCredit({ state, persist, cfg, track = (p) => p, ledger = null }) {
  state.credit ??= {};
  state.credit.events ??= [];      // { id, kind, subject, ref, amount (USD), ts, days?, on_time? }
  state.credit.identities ??= {};  // subject -> { agent_id, chain_id, owner, verified, linked_at, by }
  state.credit.outbox ??= [];      // { event_id, subject, agent_id, status: 'pending'|'posted'|'failed', tx?, error?, attempts }
  state.credit.loans ??= {};       // loan_id -> { subject, agent_id, settlement_ref, borrowed_at, principal_usd, fee_usd, due_at, tx, repayments: [] }
  state.credit.payouts ??= {};     // settlement ref -> { subject, amount_usd, tx, repaid_usd, forwarded_usd, at }
  const config = cfg.credit ?? creditConfig();
  let chain = null;           // lazily created on-chain client
  let chainError = null;
  const reports = new Map();  // subject -> replayed report (cache; dropped on write)
  // The chain's score, when the identity is linked and the chain was read: the
  // authoritative figure. The local replay uses the engine's own timestamps, so
  // it can differ from the chain by a point of decay rounding.
  const chainScores = new Map(); // subject -> { score, at }
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

  // kind: settlement | slash | dispute_loss (the work events, posted by the
  // attester) | repayment | advance_repayment | default | recovery (loan events,
  // which happen on the pool and are mirrored here so the engine's own score
  // matches the chain's; never posted).
  const LOAN_KINDS = new Set(['repayment', 'advance_repayment', 'default', 'recovery']);
  function record(kind, subject, ref, amount, extra = {}) {
    if (!subject || !state.providers[subject]) return null;
    const event = { id: `cev_${state.credit.events.length + 1}_${Date.now().toString(36)}`, kind, subject, ref: String(ref), amount: Number(amount) || 0, ts: Date.now(), ...extra };
    state.credit.events.push(event);
    reports.delete(subject);
    const link = state.credit.identities[subject];
    if (link && !LOAN_KINDS.has(kind)) enqueue(event, link);
    return event;
  }

  // Mirror the pool's loan outcomes into the local record, once each: a repaid
  // advance, a repaid loan, a default (anyone may mark one on-chain), a recovery.
  async function syncLoans(subject) {
    const link = state.credit.identities[subject];
    const client = await chainClient();
    if (!link || !client?.hasPool) return [];
    let chainLoans;
    try { chainLoans = await client.loansOf(link.agent_id); } catch { return []; }
    const have = (kind, ref) => state.credit.events.some((e) => e.subject === subject && e.kind === kind && e.ref === ref);
    const added = [];
    for (const l of chainLoans) {
      const ts = { }; // the chain's timestamps are not exposed per transition; recorded now
      if ((l.status === 'defaulted' || l.status === 'recovered') && !have('default', l.loan_id)) added.push(record('default', subject, l.loan_id, l.principal_usd, { loan_id: l.loan_id, ...ts }));
      if (l.status === 'recovered' && !have('recovery', l.loan_id)) added.push(record('recovery', subject, l.loan_id, l.principal_usd, { loan_id: l.loan_id }));
      if (l.status === 'repaid') {
        if (l.kind === 'advance' && !have('advance_repayment', l.loan_id)) added.push(record('advance_repayment', subject, l.loan_id, l.principal_usd, { loan_id: l.loan_id }));
        if (l.kind !== 'advance' && !have('repayment', l.loan_id)) added.push(record('repayment', subject, l.loan_id, l.principal_usd, { loan_id: l.loan_id, days: l.term_days, on_time: true }));
      }
    }
    if (added.length) persist();
    try { noteChainScore(subject, await client.score(link.agent_id)); } catch { /* best effort */ }
    return added;
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
          try { noteChainScore(item.subject, await client.score(item.agent_id)); } catch { /* read-back is best effort */ }
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

  function localScore(subject, at = now()) { return Number(scoreOf(reportFor(subject), at)); }
  // The score used for quotes and reads: the chain's when known, else the local replay.
  function scoreFor(subject, at = now()) {
    const c = chainScores.get(subject);
    return c && state.credit.identities[subject] ? c.score : localScore(subject, at);
  }
  function noteChainScore(subject, score) { if (Number.isFinite(score)) chainScores.set(subject, { score, at: Date.now() }); }

  function summary(subject) {
    const r = reportFor(subject);
    const at = now();
    const b = breakdown(r, at);
    const recent = decayed(r.recentVolume, r.workUpdatedAt, at, WORK_HALF_LIFE);
    const link = identityOf(subject);
    const c = link ? chainScores.get(subject) : null;
    const score = c ? c.score : b.score;
    return {
      subject, agent_id: link?.agent_id ?? null, verified_identity: link?.verified ?? false,
      score, engine_score: b.score, source: c ? 'chain' : 'engine', tier: tier(score), fee_bps_30d: Number(feeBps30d(score)),
      credit_line_usd: fromUsdg(creditLine(score, recent, toUsdg(CREDIT_LINE_CAP_USD))),
      recent_volume_usd: b.recent_volume_usd, as_of: at,
    };
  }

  async function report(subject) {
    await syncLoans(subject);
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
      try {
        out.chain.report = await client.report(out.agent_id); out.chain.score = out.chain.report.score;
        noteChainScore(subject, out.chain.score);
        Object.assign(out, summary(subject)); // re-read with the chain's score in hand
        out.points = breakdown(r, at).points;
      } catch (e) { out.chain.error = String(e.shortMessage ?? e.message).slice(0, 200); }
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
      phase: client?.hasPool ? 2 : 1,
      borrowing: !!client?.hasPool && !!client?.canWrite,
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
      loans: Object.keys(state.credit.loans).length, payouts: Object.keys(state.credit.payouts).length,
    };
  }

  // ---- Phase 2: advances against pending settlements -------------------------------
  // The pool lives on-chain; the engine is the attester and the treasury. An
  // advance is drawn by the agent's owner through the engine (the pool lets the
  // attester act for the agent) and the cash lands in the identity owner's
  // wallet. A payout routes the settlement's proceeds through the pool: the
  // engine debits the owner's ledger balance, the treasury pays USDG into the
  // pool, the pool repays the loan first and forwards the rest to the wallet.

  async function poolClient() {
    const client = await chainClient();
    if (!client) throw new ApiError(409, 'credit_chain_off', `No credit chain: ${chainError ?? config.reason}.`);
    if (!client.hasPool) throw new ApiError(409, 'no_pool', `No credit pool is deployed on chain ${config.chainId}.`);
    return client;
  }
  function linkedAgentId(subject) {
    const link = state.credit.identities[subject];
    if (!link) throw new ApiError(409, 'no_identity', `${subject} has no ERC-8004 agentId linked. POST /v1/credit/identity/${subject} first.`);
    return link.agent_id;
  }
  const settlementEvent = (ref) => state.credit.events.find((e) => e.kind === 'settlement' && e.ref === String(ref));

  async function poolInfo() {
    const client = await chainClient();
    const info = client?.hasPool ? await client.poolInfo() : null;
    return { enabled: !!info, chain_id: config.chainId || null, reason: info ? null : (chainError ?? (client ? 'no pool deployed' : config.reason)), pool: info };
  }

  async function settlement(ref) {
    const ev = settlementEvent(ref);
    if (!ev) throw new ApiError(404, 'not_found', `No settlement ${ref} on the credit record.`);
    const client = await chainClient();
    const out = { settlement_ref: ev.ref, subject: ev.subject, agent_id: state.credit.identities[ev.subject]?.agent_id ?? null, amount_usd: ev.amount, price_usd: ev.price ?? ev.amount, settled_at: ev.ts, payout_at: ev.payout_at ?? null, payout: state.credit.payouts[ev.ref] ?? null, chain: null };
    if (client?.hasPool) { try { out.chain = await client.settlement(ev.ref); } catch (e) { out.chain_error = String(e.shortMessage ?? e.message); } }
    return out;
  }

  async function quoteAdvance(subject, ref) {
    const client = await poolClient();
    const agentId = linkedAgentId(subject);
    const ev = settlementEvent(ref);
    if (!ev || ev.subject !== subject) throw new ApiError(404, 'not_found', `No settlement ${ref} for ${subject}.`);
    try { return { settlement_ref: ev.ref, agent_id: agentId, ...(await client.quoteAdvance(agentId, ev.ref)) }; }
    catch (e) { throw new ApiError(409, 'not_borrowable', `The pool refused a quote: ${e.reason ?? e.shortMessage ?? e.message}`, { settlement_ref: ev.ref }); }
  }

  async function borrow(subject, body = {}, actor) {
    const path = String(body.path ?? 'advance');
    if (path !== 'advance') throw new ApiError(501, 'not_implemented', `Borrowing path "${path}" is not open yet; only "advance" (against a pending settlement) is.`);
    const client = await poolClient();
    if (!client.canWrite) throw new ApiError(503, 'attester_read_only', 'The attester has no key; it cannot draw an advance for you.');
    const agentId = linkedAgentId(subject);
    const ref = String(body.settlement_id ?? body.settlement_ref ?? '');
    const ev = settlementEvent(ref);
    if (!ev || ev.subject !== subject) throw new ApiError(404, 'not_found', `No settlement ${ref || '(none given)'} for ${subject}.`);
    const posted = state.credit.outbox.find((o) => o.event_id === ev.id && o.status === 'posted');
    if (!posted) { await flush(); if (!state.credit.outbox.find((o) => o.event_id === ev.id && o.status === 'posted')) throw new ApiError(409, 'not_attested', `Settlement ${ref} is not attested on-chain yet.`); }
    let quote;
    try { quote = await client.quoteAdvance(agentId, ev.ref); }
    catch (e) { throw new ApiError(409, 'not_borrowable', `The pool refused the advance: ${e.reason ?? e.shortMessage ?? e.message}`, { settlement_ref: ev.ref }); }
    let res;
    try { res = await client.advance(agentId, ev.ref); }
    catch (e) { throw new ApiError(502, 'chain_error', `The advance transaction failed: ${e.reason ?? e.shortMessage ?? e.message}`); }
    const loan = { loan_id: res.loan_id, subject, agent_id: agentId, path, settlement_ref: ev.ref, borrowed_at: Date.now(), principal_usd: res.principal_usd ?? quote.principal_usd, fee_usd: res.fee_usd ?? quote.fee_usd, due_at: res.due_at, borrower: res.borrower, tx: res.tx, by: actor?.key?.id ?? (actor?.admin ? 'admin' : null), repayments: [] };
    state.credit.loans[loan.loan_id] = loan;
    persist();
    return { ...loan, quote, chain: await client.loan(loan.loan_id) };
  }

  // Route a settlement's proceeds through the pool. The owner asks for it (or
  // an admin, or the engine's own sweep once the payout date has passed).
  async function payout(ref, authorize) {
    const ev = settlementEvent(ref);
    if (!ev) throw new ApiError(404, 'not_found', `No settlement ${ref} on the credit record.`);
    if (typeof authorize === 'function') authorize(ev.subject);
    if (state.credit.payouts[ev.ref]) throw new ApiError(409, 'already_paid', `Settlement ${ref} was already paid out.`, state.credit.payouts[ev.ref]);
    const client = await poolClient();
    if (!client.canWrite) throw new ApiError(503, 'attester_read_only', 'The attester has no key; the treasury cannot pay.');
    const agentId = linkedAgentId(ev.subject);
    const onChain = await client.settlement(ev.ref);
    if (!onChain) throw new ApiError(409, 'not_attested', `Settlement ${ref} is not attested on-chain yet.`);
    if (onChain.paid || onChain.voided) throw new ApiError(409, 'settlement_closed', `Settlement ${ref} is already ${onChain.paid ? 'paid' : 'voided'} on-chain.`);
    const treasury = await client.treasuryUsdg();
    if (treasury + 1e-9 < ev.amount) throw new ApiError(503, 'treasury_short', `The treasury holds ${treasury} USDG; this payout needs ${ev.amount}.`, { treasury_usdg_usd: treasury, required_usd: ev.amount });
    if (!ledger) throw new ApiError(500, 'no_ledger', 'The credit layer has no ledger access.');
    const debit = ledger.debit(ev.subject, ev.amount, 'credit_payout', { settlement_ref: ev.ref });
    let res;
    try { res = await client.settleProceeds(ev.ref); }
    catch (e) { ledger.refund(ev.subject, ev.amount, 'credit_payout_refund'); throw new ApiError(502, 'chain_error', `The payout transaction failed: ${e.reason ?? e.shortMessage ?? e.message}`); }
    const rec = { settlement_ref: ev.ref, subject: ev.subject, agent_id: agentId, amount_usd: ev.amount, debited: debit, tx: res.tx, repaid_usd: res.repaid_usd, forwarded_usd: res.forwarded_usd, to: res.to, at: Date.now() };
    state.credit.payouts[ev.ref] = rec;
    if (onChain.loan_id && state.credit.loans[onChain.loan_id]) state.credit.loans[onChain.loan_id].repayments.push({ at: rec.at, amount_usd: res.repaid_usd, via: 'payout', tx: res.tx });
    persist();
    await syncLoans(ev.subject);
    return { ...rec, loan: onChain.loan_id ? await client.loan(onChain.loan_id) : null };
  }

  async function repay(subject, body = {}, actor) {
    const client = await poolClient();
    if (!client.canWrite) throw new ApiError(503, 'attester_read_only', 'The attester has no key; the treasury cannot pay.');
    const loanId = String(body.loan_id ?? '');
    const loan = await client.loan(loanId);
    if (!loan) throw new ApiError(404, 'not_found', `No loan ${loanId || '(none given)'}.`);
    if (loan.agent_id !== linkedAgentId(subject)) throw new ApiError(403, 'not_owner', `Loan ${loanId} belongs to another agent.`);
    if (!['active', 'defaulted'].includes(loan.status)) throw new ApiError(409, 'loan_closed', `Loan ${loanId} is ${loan.status}.`);
    const amount = body.amount === undefined ? loan.owed_usd : Number(body.amount);
    if (!(amount > 0) || !Number.isFinite(amount)) throw new ApiError(400, 'invalid_input', 'amount must be a positive USDT amount');
    const pay = Math.min(amount, loan.owed_usd);
    const treasury = await client.treasuryUsdg();
    if (treasury + 1e-9 < pay) throw new ApiError(503, 'treasury_short', `The treasury holds ${treasury} USDG; this repayment needs ${pay}.`);
    if (!ledger) throw new ApiError(500, 'no_ledger', 'The credit layer has no ledger access.');
    ledger.debit(subject, pay, 'credit_repayment', { loan_id: loanId });
    let res;
    try { res = await client.repay(loanId, pay); }
    catch (e) { ledger.refund(subject, pay, 'credit_repayment_refund'); throw new ApiError(502, 'chain_error', `The repayment transaction failed: ${e.reason ?? e.shortMessage ?? e.message}`); }
    const rec = state.credit.loans[loanId] ??= { loan_id: loanId, subject, agent_id: loan.agent_id, repayments: [] };
    rec.repayments.push({ at: Date.now(), amount_usd: pay, via: 'repay', tx: res.tx, by: actor?.key?.id ?? (actor?.admin ? 'admin' : null) });
    persist();
    await syncLoans(subject);
    return { loan_id: loanId, paid_usd: pay, tx: res.tx, loan: res.loan };
  }

  async function loans(subject) {
    await syncLoans(subject);
    const link = state.credit.identities[subject];
    const local = Object.values(state.credit.loans).filter((l) => l.subject === subject);
    const client = await chainClient();
    let chain = null;
    if (client?.hasPool && link) { try { chain = await client.loansOf(link.agent_id); } catch (e) { chain = { error: String(e.shortMessage ?? e.message) }; } }
    return { subject, agent_id: link?.agent_id ?? null, loans: Array.isArray(chain) ? chain.map((c) => ({ ...c, record: local.find((l) => l.loan_id === c.loan_id) ?? null })) : local, chain_error: chain && !Array.isArray(chain) ? chain.error : null, exposure_usd: Array.isArray(chain) ? chain.filter((c) => c.status === 'active').reduce((a, c) => a + c.remaining_principal_usd, 0) : null };
  }

  return { config, resolve, record, flush, link, identityOf, scoreFor, localScore, summary, report, line, status, eventsFor, reportFor, tier, feeBps30d, linkMessage, poolInfo, settlement, quoteAdvance, borrow, payout, repay, loans, syncLoans, chainClient };
}
