import { id, txHash, hash01, money, clamp, sha256, sleep } from './util.js';
import { CAPABILITIES, validateInput } from './catalog.js';
import { seedProviders, runExecutor } from './providers.js';
import { verify, gradeRubric, validateAcceptance } from './verification.js';
import { createStore } from './store.js';
import { createAttestor } from './attest.js';
import { snapshotParams } from './launchpad-config.js';
import { splitFees, bondValue, bondCapacity, protocolFeeSplit, netPayoutSplit } from './launchpad.js';

// ---------------------------------------------------------------------------
// ApiError carries the HTTP status and the error code from the docs.
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const TERMINAL = new Set(['settled', 'refunded']);

export function createEngine(cfg = {}) {
  cfg = {
    fast: false,
    faucet: 5,
    dailyCeiling: { sandbox: 5, startup: 500, scale: Infinity },
    rpm: { sandbox: 60, startup: 600, scale: 6000 },
    disputeWindowMs: 24 * 60 * 60 * 1000,
    graderUrl: process.env.VOUCH_GRADER_URL || null,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    anthropicBaseUrl: process.env.VOUCH_ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    graderModel: process.env.VOUCH_GRADER_MODEL || 'claude-opus-4-8',
    execModel: process.env.VOUCH_EXEC_MODEL || null,
    persistPath: null,
    store: null,           // injected store (serverless); overrides persistPath
    recoveryGraceMs: 0,    // boot recovery skips in-flight tasks younger than this
    maxAttempts: 4,        // hard cap on auto-retry attempts per task
    insuranceRate: 0.5,    // failure compensation as a fraction of the task price
    maxConsensus: 3,       // cap on parallel providers for consensus execution
    cachePriceRate: 0.1,   // cache-hit price as a fraction of the cheapest quote
    attestKey: process.env.VOUCH_ATTEST_KEY || null,
    ...cfg,
  };

  const store = cfg.store ?? createStore(cfg.persistPath);
  const loaded = store.load();
  const state = loaded ?? {
    keys: {},       // keyId -> { id, tokenHash, name, tier, createdAt }
    accounts: {},   // keyId -> { balance, locked, lockedToday, history: [] }
    providers: {},  // providerId -> { stake, stakeReserved, track, earnings, ... }
    tasks: {},      // taskId -> task
    disputes: {},   // disputeId -> dispute
    workflows: {},  // workflowId -> workflow
    insurance: { balance: 0, funded: 0, claims: [] }, // outcome-guarantee pool
  };
  // Forward-compat with state files predating these fields.
  state.workflows ??= {};
  state.insurance ??= { balance: 0, funded: 0, claims: [] };
  state.cache ??= {}; // verified-output cache: fingerprint -> { output, attestation, ... }
  state.agents ??= {};   // launchpad: agentId -> launched-agent record
  state.treasury ??= { balance: 0, burned: 0, buyback: 0 }; // protocol treasury (USDG)
  const attestor = createAttestor(cfg);
  const persist = () => store.save(state);
  if (!loaded) { seedProviders(state); persist(); }

  const subscribers = new Map(); // taskId -> Set<fn(event)>

  // Background work (task runs, dispute reviews, webhooks) is fire-and-forget
  // in server mode but must complete before a serverless invocation returns.
  // Every background promise is tracked here; drain() awaits them all.
  const inflight = new Set();
  const track = (p) => {
    inflight.add(p);
    p.catch(() => {}).finally(() => inflight.delete(p));
    return p;
  };
  async function drain() {
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  // ---- accounts & keys ----------------------------------------------------

  function createKey(name = 'default') {
    const token = id('vch');
    const key = { id: id('key'), tokenHash: sha256(token), name, tier: 'sandbox', createdAt: Date.now() };
    state.keys[key.id] = key;
    state.accounts[key.id] = {
      balance: cfg.faucet, locked: 0, lockedToday: 0,
      history: [{ ts: Date.now(), kind: 'faucet', amount: cfg.faucet, tx: txHash() }],
    };
    persist();
    return { ...key, token }; // the plaintext token exists only in this return value
  }

  function authenticate(token) {
    const h = sha256(token ?? '');
    const key = Object.values(state.keys).find((k) => k.tokenHash === h);
    if (!key || key.revoked) throw new ApiError(401, 'unauthorized', 'Missing, invalid, or revoked key.');
    return key;
  }

  // ---- sub-agent wallets ---------------------------------------------------
  // A parent key mints capped, policy-bound sub-keys for the child agents it
  // spawns: a fixed budget transferred from the parent, an optional capability
  // allowlist, and instant revocation. A child can never exceed its wallet or
  // touch capabilities outside its allowlist.
  function createSubKey(parent, body = {}) {
    if (parent.parent) throw new ApiError(403, 'forbidden', 'Sub-keys cannot mint their own sub-keys.');
    const fund = Number(body.fund) || 0;
    if (!(fund > 0)) throw new ApiError(400, 'invalid_input', 'fund must be a positive USDC amount to transfer to the sub-key');
    const pacct = state.accounts[parent.id];
    if (pacct.balance < fund) throw new ApiError(402, 'escrow_insufficient', 'Parent balance below the requested sub-key funding.', { required: fund, balance: pacct.balance });
    const allow = Array.isArray(body.allow) ? body.allow.filter((c) => CAPABILITIES[c]) : null;
    const perTaskCap = Number(body.per_task_cap) > 0 ? money(Number(body.per_task_cap)) : null;

    const token = id('vch');
    const key = {
      id: id('key'), tokenHash: sha256(token), name: body.name ?? 'sub-agent',
      tier: parent.tier, createdAt: Date.now(),
      parent: parent.id, allow, revoked: false, frozen: false, perTaskCap,
    };
    state.keys[key.id] = key;
    pacct.balance = money(pacct.balance - fund);
    pacct.history.push({ ts: Date.now(), kind: 'sub_fund', amount: -fund, sub: key.id, tx: txHash() });
    state.accounts[key.id] = {
      balance: money(fund), locked: 0, lockedToday: 0,
      history: [{ ts: Date.now(), kind: 'sub_grant', amount: fund, parent: parent.id, tx: txHash() }],
    };
    persist();
    return { id: key.id, key: token, parent: parent.id, fund: money(fund), allow, per_task_cap: perTaskCap, frozen: false };
  }

  function listSubKeys(parent) {
    return Object.values(state.keys)
      .filter((k) => k.parent === parent.id)
      .map((k) => ({ id: k.id, name: k.name, allow: k.allow, revoked: !!k.revoked, frozen: !!k.frozen,
        per_task_cap: k.perTaskCap ?? null,
        balance: state.accounts[k.id]?.balance ?? 0, createdAt: k.createdAt }));
  }

  // Freeze / unfreeze an agentic account (sub-key). A frozen account can hold a
  // balance but cannot post new tasks — an instant, reversible kill switch.
  function freezeSubKey(parent, subId, frozen = true) {
    const sub = state.keys[subId];
    if (!sub || sub.parent !== parent.id) throw new ApiError(404, 'not_found', `No account ${subId} under this key.`);
    sub.frozen = !!frozen;
    persist();
    return { id: subId, frozen: sub.frozen };
  }

  function revokeSubKey(parent, subId) {
    const sub = state.keys[subId];
    if (!sub || sub.parent !== parent.id) throw new ApiError(404, 'not_found', `No sub-key ${subId} under this parent.`);
    if (sub.revoked) return { id: subId, revoked: true, refunded: 0 };
    sub.revoked = true;
    // Return the sub-key's unspent (unlocked) balance to the parent.
    const sacct = state.accounts[sub.id];
    const refund = money(sacct.balance);
    sacct.balance = 0;
    const pacct = state.accounts[parent.id];
    pacct.balance = money(pacct.balance + refund);
    pacct.history.push({ ts: Date.now(), kind: 'sub_revoke_refund', amount: refund, sub: sub.id, tx: txHash() });
    persist();
    return { id: subId, revoked: true, refunded: refund };
  }

  // ---- semantic cache ------------------------------------------------------
  // An identical, already-verified task can be served from cache: same output,
  // same signed proof, instantly, at a small fraction of the price — no auction,
  // no provider round-trip. Safe precisely because the cached output already
  // passed verification against the same acceptance criteria.
  const cacheKey = (capability, input, acceptance) =>
    sha256(capability + ' ' + canonicalStr(input) + ' ' + canonicalStr(acceptance));
  function canonicalStr(v) {
    if (Array.isArray(v)) return '[' + v.map(canonicalStr).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalStr(v[k])).join(',') + '}';
    return JSON.stringify(v ?? null);
  }
  function cachePut(task, verdict) {
    const fp = cacheKey(task.capability, task.input, task.acceptance);
    state.cache[fp] = {
      output: task.output, attestation: task.attestation,
      capability: task.capability, verified_by: verdict.verified_by,
      ts: Date.now(), hits: 0,
    };
    const keys = Object.keys(state.cache);
    if (keys.length > 500) delete state.cache[keys[0]]; // simple bound
  }

  function deposit(key, amount) {
    if (!(amount > 0)) throw new ApiError(400, 'invalid_input', 'amount must be a positive number');
    const capped = Math.min(amount, 100); // simulated faucet cap
    const acct = state.accounts[key.id];
    acct.balance = money(acct.balance + capped);
    const entry = { ts: Date.now(), kind: 'deposit', amount: capped, tx: txHash() };
    acct.history.push(entry);
    persist();
    return { balance: acct.balance, credited: capped, tx: entry.tx };
  }

  function balance(key) {
    const acct = state.accounts[key.id];
    return {
      balance: acct.balance,
      locked: acct.locked,
      daily_ceiling: cfg.dailyCeiling[key.tier],
      ceiling_remaining: money(Math.max(0, cfg.dailyCeiling[key.tier] - acct.lockedToday)),
      history: acct.history.slice(-20),
    };
  }

  // ---- offers & quoting ---------------------------------------------------

  function offers({ capability, max_price, min_track } = {}) {
    const out = [];
    for (const p of Object.values(state.providers)) {
      for (const [cap, offer] of Object.entries(p.offers)) {
        if (capability && !cap.startsWith(capability)) continue;
        if (max_price !== undefined && offer.price_ceiling > max_price) continue;
        if (min_track !== undefined && p.track < min_track) continue;
        out.push({
          capability: cap,
          provider: p.id,
          price_ceiling: offer.price_ceiling,
          sla_deadline_ms: offer.sla_deadline_ms,
          stake_available: money(p.stake - p.stakeReserved),
          track: Math.round(p.track),
          input_schema: CAPABILITIES[cap].input,
          output_schema: CAPABILITIES[cap].output,
        });
      }
    }
    return out.sort((a, b) => a.capability.localeCompare(b.capability) || a.price_ceiling - b.price_ceiling);
  }

  // Sealed quotes: each eligible provider commits a price at or under its
  // standing ceiling and a deadline at or under its SLA, deterministic per
  // (provider, task) so runs are reproducible.
  function collectQuotes(task) {
    const quotes = [];
    for (const p of Object.values(state.providers)) {
      const offer = p.offers[task.capability];
      if (!offer) continue;
      const price = money(offer.price_ceiling * (0.7 + 0.25 * hash01(p.id + task.id + 'price')));
      const deadline_ms = Math.floor(offer.sla_deadline_ms * (0.8 + 0.2 * hash01(p.id + task.id + 'dl')));
      quotes.push({
        provider: p.id, price, deadline_ms,
        track: p.track, stake_available: money(p.stake - p.stakeReserved),
      });
    }
    return quotes;
  }

  function admissible(task, q) {
    if (q.price > task.budget) return 'budget';
    if (q.deadline_ms > task.deadline_ms) return 'deadline';
    if (task.min_track !== undefined && q.track < task.min_track) return 'min_track';
    if (q.stake_available < q.price) return 'stake';
    return null;
  }

  // ---- escrow & stake movements (single-writer invariants) ----------------

  function lockEscrow(keyId, amount) {
    const acct = state.accounts[keyId];
    acct.balance = money(acct.balance - amount);
    acct.locked = money(acct.locked + amount);
    acct.lockedToday = money(acct.lockedToday + amount);
    const entry = { ts: Date.now(), kind: 'lock', amount, tx: txHash() };
    acct.history.push(entry);
    return entry.tx;
  }

  function settleEscrow(task) {
    const acct = state.accounts[task.keyId];
    const p = state.providers[task.quote.provider];
    // The full escrow was locked up front; the winning provider is paid its
    // quoted price and any surplus (e.g. a cheaper retry provider) returns to
    // the agent. locked === price in the common single-attempt case.
    const locked = task.escrow?.locked ?? task.quote.price;
    const surplus = money(Math.max(0, locked - task.quote.price));
    acct.locked = money(acct.locked - locked);
    if (surplus > 0) acct.balance = money(acct.balance + surplus);
    p.earnings = money(p.earnings + task.quote.price);
    p.stakeReserved = money(Math.max(0, p.stakeReserved - task.quote.stake_reserved));
    p.settledCount++;
    p.track = clamp(p.track + 0.2, 0, 100);
    const entry = { ts: Date.now(), kind: 'settle', amount: -task.quote.price, task: task.id, tx: txHash() };
    acct.history.push(entry);
    // Launchpad: if this provider is a launched agent, route its revenue
    // (protocol fee + owner/buyback/bond). Non-launchpad providers are untouched.
    if (p.agentId && state.agents[p.agentId]) routeAgentRevenue(state.agents[p.agentId], task.quote.price);
    return entry.tx;
  }

  function refundEscrow(task, reason) {
    const acct = state.accounts[task.keyId];
    const locked = task.escrow?.locked ?? task.quote.price;
    acct.locked = money(acct.locked - locked);
    acct.balance = money(acct.balance + locked);
    acct.lockedToday = money(Math.max(0, acct.lockedToday - locked));
    const entry = { ts: Date.now(), kind: 'refund', amount: locked, task: task.id, reason, tx: txHash() };
    acct.history.push(entry);
    return entry.tx;
  }

  function slashQuote(quote, multiple) {
    const p = state.providers[quote.provider];
    const amount = money(quote.price * multiple);
    p.stake = money(Math.max(0, p.stake - amount));
    p.stakeReserved = money(Math.max(0, p.stakeReserved - quote.stake_reserved));
    p.slashedCount++;
    p.track = clamp(p.track - 15, 0, 100);
    // Slashed stake capitalizes the outcome-insurance pool.
    state.insurance.balance = money(state.insurance.balance + amount);
    state.insurance.funded = money(state.insurance.funded + amount);
    return amount;
  }

  function slashProvider(task, multiple) {
    const p = state.providers[task.quote.provider];
    const amount = money(task.quote.price * multiple);
    p.stake = money(Math.max(0, p.stake - amount));
    p.stakeReserved = money(Math.max(0, p.stakeReserved - task.quote.stake_reserved));
    p.slashedCount++;
    p.track = clamp(p.track - 15, 0, 100);
    // Slashed stake capitalizes the outcome-insurance pool.
    state.insurance.balance = money(state.insurance.balance + amount);
    state.insurance.funded = money(state.insurance.funded + amount);
    return amount;
  }

  // ---- task lifecycle -----------------------------------------------------

  function emit(task, event) {
    const entry = { ts: Date.now(), ...event };
    task.events.push(entry);
    for (const fn of subscribers.get(task.id) ?? []) fn(entry);
  }

  function subscribe(taskId, fn) {
    if (!subscribers.has(taskId)) subscribers.set(taskId, new Set());
    subscribers.get(taskId).add(fn);
    return () => subscribers.get(taskId)?.delete(fn);
  }

  function publicTask(task) {
    const { keyId, timer, ...rest } = task;
    return rest;
  }

  async function notifyWebhook(task) {
    if (!task.webhook_url) return;
    try {
      await fetch(task.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(publicTask(task)),
      });
    } catch { /* webhooks are best-effort */ }
  }

  function terminalize(task, status, fields) {
    if (TERMINAL.has(task.status)) return false;
    if (task.timer) clearTimeout(task.timer);
    task.status = status;
    Object.assign(task, fields);
    emit(task, { status, ...fields });
    track(notifyWebhook(task));
    persist();
    return true;
  }

  function refundTask(task, reason, detail) {
    const p = state.providers[task.quote.provider];
    const multiple = reason === 'provider_abandoned' ? 1.5 : reason === 'dispute_upheld' ? 2 : 1;
    // Compensation draws from the pool as it stands *before* this task's own
    // slash tops it up — a fresh pool has nothing to pay out yet.
    const comp = payInsurance(task, reason);
    const slashed = slashProvider(task, multiple);
    const refundTx = refundEscrow(task, reason);
    terminalize(task, 'refunded', {
      refund: { reason, detail, tx: refundTx },
      slash: { provider: p.id, amount: slashed },
      ...(comp ? { compensation: comp } : {}),
      ...(task.attempts?.length ? { attempts: task.attempts } : {}),
    });
  }

  // Outcome insurance: on a failed task the agent gets its escrow back (cost
  // $0) and, on top of that, a compensation payout from the pool for the wasted
  // round-trip — funded by the stake just slashed from providers.
  function payInsurance(task, reason) {
    const rate = cfg.insuranceRate;
    if (!(rate > 0)) return null;
    const comp = money(Math.min(state.insurance.balance, task.quote.price * rate));
    if (!(comp > 0)) return null;
    const acct = state.accounts[task.keyId];
    state.insurance.balance = money(state.insurance.balance - comp);
    acct.balance = money(acct.balance + comp);
    const tx = txHash();
    acct.history.push({ ts: Date.now(), kind: 'insurance', amount: comp, task: task.id, tx });
    state.insurance.claims.push({ ts: Date.now(), task: task.id, reason, amount: comp });
    if (state.insurance.claims.length > 200) state.insurance.claims.shift();
    return { amount: comp, tx };
  }

  // Next-best provider for a retry: admissible, not already tried, and priced
  // at or under the escrow already locked (so no additional funds are needed).
  function pickRetryQuote(task) {
    const tried = new Set((task.attempts ?? []).map((a) => a.provider));
    const cap = task.escrow?.locked ?? task.budget;
    const quotes = collectQuotes(task).filter(
      (q) => !tried.has(q.provider) && admissible(task, q) === null && q.price <= cap
    );
    if (!quotes.length) return null;
    quotes.sort((a, b) => a.price - b.price || (b.track * b.stake_available) - (a.track * a.stake_available));
    return quotes[0];
  }

  function reserveProvider(task, q) {
    const p = state.providers[q.provider];
    p.stakeReserved = money(p.stakeReserved + q.price);
    task.quote = { provider: q.provider, price: q.price, deadline_ms: q.deadline_ms, stake_reserved: q.price };
  }

  async function runTask(task) {
    const startedAt = Date.now();
    task.attempts = task.attempts ?? [];
    // Deadline: with auto-retry the agent's deadline_ms caps the whole loop;
    // otherwise the single committed quote governs.
    const deadlineBudget = task.retry ? task.deadline_ms : task.quote.deadline_ms;
    task.timer = setTimeout(() => {
      if (!TERMINAL.has(task.status)) {
        refundTask(task, 'deadline_missed', `no verified output within ${deadlineBudget} ms`);
      }
    }, deadlineBudget + (cfg.fast ? 250 : 1000));

    while (true) {
      const provider = state.providers[task.quote.provider];
      let output;
      try {
        output = await runExecutor(provider, task, cfg);
      } catch (e) {
        output = { error: e.message };
      }
      if (TERMINAL.has(task.status)) return;

      let failure = null;
      if (output?.error) {
        failure = { reason: 'provider_abandoned', detail: output.error };
      } else {
        task.status = 'submitted';
        emit(task, { status: 'submitted' });

        task.status = 'verifying';
        const validators = ['schema'];
        if (task.acceptance.checks?.length) validators.push('checks');
        if (task.acceptance.rubric) validators.push('rubric');
        if (task.acceptance.webhook) validators.push('webhook');
        emit(task, { status: 'verifying', validators });

        const verdict = await verify(task, output, cfg);
        if (TERMINAL.has(task.status)) return;

        if (verdict.pass) {
          task.output = output;
          const settleTx = settleEscrow(task);
          const settlement = {
            provider: task.quote.provider,
            price: task.quote.price,
            verified_by: verdict.verified_by,
            elapsed_ms: Date.now() - startedAt,
            attempts: task.attempts.length + 1,
            escrow_tx: settleTx,
            settled_at: Date.now(),
          };
          // Portable proof-of-verified-work.
          task.attestation = attestor.attest('settlement', {
            task_id: task.id,
            capability: task.capability,
            provider: task.quote.provider,
            price: task.quote.price,
            verified_by: verdict.verified_by,
            output_sha256: sha256(JSON.stringify(output)),
            settled_at: settlement.settled_at,
          });
          cachePut(task, verdict);
          terminalize(task, 'settled', { output, settlement, attestation: task.attestation });
          return;
        }
        failure = { reason: 'verification_failed', detail: `${verdict.failed.validator}: ${verdict.failed.detail}` };
      }

      // Failure. Retry to a fresh provider if enabled and one is available;
      // otherwise refund + slash + insure.
      task.attempts.push({ provider: task.quote.provider, ...failure });
      const next = (task.retry && task.attempts.length < task.maxAttempts) ? pickRetryQuote(task) : null;
      if (next) {
        slashProvider(task, failure.reason === 'provider_abandoned' ? 1.5 : 1);
        reserveProvider(task, next);
        emit(task, { status: 'retrying', attempt: task.attempts.length, next_provider: next.provider, reason: failure.reason });
        task.status = 'dispatched';
        continue;
      }
      return refundTask(task, failure.reason, failure.detail);
    }
  }

  // Consensus: run the chosen providers in parallel, verify each, settle the
  // cheapest that passed, slash every one that failed, and release the unpaid
  // passers' stake without penalty (they did honest work, just weren't picked).
  async function runConsensusTask(task) {
    const startedAt = Date.now();
    task.timer = setTimeout(() => {
      if (!TERMINAL.has(task.status)) refundTask(task, 'deadline_missed', `no verified output within ${task.deadline_ms} ms`);
    }, task.deadline_ms + (cfg.fast ? 250 : 1000));

    const runs = await Promise.all(task.consensusQuotes.map(async (q) => {
      const probe = { ...task, quote: q };
      let output;
      try { output = await runExecutor(state.providers[q.provider], probe, cfg); }
      catch (e) { output = { error: e.message }; }
      if (output?.error) return { q, pass: false, reason: 'provider_abandoned', output };
      const verdict = await verify(probe, output, cfg);
      return { q, pass: verdict.pass, verdict, output, reason: verdict.pass ? null : 'verification_failed' };
    }));
    if (TERMINAL.has(task.status)) return;

    const passers = runs.filter((r) => r.pass).sort((a, b) => a.q.price - b.q.price || b.q.track - a.q.track);
    for (const l of runs.filter((r) => !r.pass)) slashQuote(l.q, l.reason === 'provider_abandoned' ? 1.5 : 1);

    if (!passers.length) {
      const comp = payInsurance(task, 'verification_failed');
      const refundTx = refundEscrow(task, 'consensus_failed');
      return terminalize(task, 'refunded', {
        refund: { reason: 'consensus_failed', detail: `all ${runs.length} providers failed verification`, tx: refundTx },
        consensus: { dispatched: runs.length, passed: 0 },
        ...(comp ? { compensation: comp } : {}),
      });
    }

    const win = passers[0];
    // Release the runner-up passers' reservations with a small track bump.
    for (const p of passers.slice(1)) {
      const pr = state.providers[p.q.provider];
      pr.stakeReserved = money(Math.max(0, pr.stakeReserved - p.q.stake_reserved));
      pr.track = clamp(pr.track + 0.1, 0, 100);
    }
    task.quote = win.q;
    task.output = win.output;
    const settleTx = settleEscrow(task);
    const settlement = {
      provider: win.q.provider, price: win.q.price, verified_by: win.verdict.verified_by,
      elapsed_ms: Date.now() - startedAt,
      consensus: { dispatched: runs.length, passed: passers.length },
      escrow_tx: settleTx, settled_at: Date.now(),
    };
    task.attestation = attestor.attest('settlement', {
      task_id: task.id, capability: task.capability, provider: win.q.provider, price: win.q.price,
      verified_by: win.verdict.verified_by, output_sha256: sha256(JSON.stringify(win.output)),
      consensus: passers.length, settled_at: settlement.settled_at,
    });
    cachePut(task, win.verdict);
    terminalize(task, 'settled', { output: win.output, settlement, attestation: task.attestation });
  }

  // Serve an identical, already-verified task instantly from cache.
  function serveFromCache(key, meta, hit) {
    const acct = state.accounts[key.id];
    const quotes = collectQuotes({ id: 'probe', capability: meta.capability, input: meta.input });
    const floor = quotes.length ? Math.min(...quotes.map((q) => q.price)) : meta.budget;
    const price = money(Math.max(0.000001, floor * cfg.cachePriceRate));
    if (price > meta.budget || acct.balance < price) return null;
    acct.balance = money(acct.balance - price);
    acct.history.push({ ts: Date.now(), kind: 'cache', amount: -price, tx: txHash() });
    const task = {
      id: id('tsk'), keyId: key.id, capability: meta.capability, input: meta.input, acceptance: meta.acceptance,
      budget: meta.budget, deadline_ms: meta.deadline_ms, status: 'settled', createdAt: Date.now(), events: [],
      cached: true, output: hit.output, attestation: hit.attestation,
      settlement: {
        provider: 'cache', price, verified_by: hit.verified_by, cached: true,
        source_attested_at: hit.attestation?.payload?.attested_at ?? null, settled_at: Date.now(),
      },
    };
    hit.hits = (hit.hits ?? 0) + 1;
    state.tasks[task.id] = task;
    emit(task, { status: 'settled', cached: true });
    persist();
    return publicTask(task);
  }

  function createTask(key, body) {
    const { capability, input, acceptance = {}, budget, deadline_ms, min_track, webhook_url, idempotency_key, retry, consensus, cache } = body ?? {};

    if (idempotency_key) {
      const existing = Object.values(state.tasks).find(
        (t) => t.keyId === key.id && t.idempotency_key === idempotency_key
      );
      if (existing) return { task: publicTask(existing), reused: true };
    }

    if (!CAPABILITIES[capability]) {
      throw new ApiError(404, 'unknown_capability', `No capability "${capability}" in the catalog.`);
    }
    // Sub-agent / agentic-account policy.
    if (key.frozen) {
      throw new ApiError(403, 'account_frozen', 'This agentic account is frozen — unfreeze it to post tasks.');
    }
    // A capped sub-key may only touch its allowlisted capabilities.
    if (key.allow && !key.allow.includes(capability)) {
      throw new ApiError(403, 'capability_not_allowed', `This account may not post "${capability}".`, { allow: key.allow });
    }
    // Per-task spend cap: no single task may exceed the account's ceiling.
    if (key.perTaskCap != null && Number(budget) > key.perTaskCap) {
      throw new ApiError(403, 'per_task_cap_exceeded', `Task budget $${budget} exceeds this account's per-task cap of $${key.perTaskCap}.`, { per_task_cap: key.perTaskCap });
    }
    const inputCheck = validateInput(capability, input ?? {});
    if (!inputCheck.ok) throw new ApiError(400, 'invalid_input', inputCheck.detail);
    const acceptCheck = validateAcceptance(acceptance);
    if (!acceptCheck.ok) throw new ApiError(400, 'invalid_acceptance', acceptCheck.detail);
    if (!(budget > 0)) throw new ApiError(400, 'invalid_input', 'budget must be a positive USDC amount');
    if (!Number.isInteger(deadline_ms) || deadline_ms <= 0) {
      throw new ApiError(400, 'invalid_input', 'deadline_ms must be a positive integer');
    }

    // Semantic cache: an identical, already-verified task can be served
    // instantly from cache at a fraction of the price. Opt-in via cache:true.
    if (cache === true) {
      const hit = state.cache[cacheKey(capability, input ?? {}, acceptance)];
      if (hit) {
        const served = serveFromCache(key, { capability, input, acceptance, budget, deadline_ms }, hit);
        if (served) return { task: served, reused: false, cached: true };
      }
    }

    // Auto-retry: on failure, reroute to the next-best provider (within the
    // committed escrow) until the output verifies or attempts run out. Opt-in:
    // retry:true, or retry:{ max_attempts:N }.
    const retryOn = retry === true || (retry && typeof retry === 'object');
    const maxAttempts = retryOn
      ? Math.max(2, Math.min(cfg.maxAttempts, Number(retry?.max_attempts) || cfg.maxAttempts))
      : 1;
    // Consensus: dispatch to N providers in parallel and settle the best that
    // passes verification. Opt-in via consensus:N (2..maxConsensus).
    const consensusN = consensus ? Math.max(2, Math.min(cfg.maxConsensus, Number(consensus) || 0)) : 1;

    const task = {
      id: id('tsk'), keyId: key.id, capability, input,
      acceptance, budget, deadline_ms, min_track, webhook_url, idempotency_key,
      retry: retryOn, maxAttempts, attempts: [], consensus: consensusN > 1 ? consensusN : undefined,
      status: 'quoting', createdAt: Date.now(), events: [],
    };

    const quotes = collectQuotes(task);
    const scored = quotes.map((q) => ({ q, miss: admissible(task, q) }));
    const admissibleQuotes = scored.filter((s) => !s.miss).map((s) => s.q);

    if (!admissibleQuotes.length) {
      const nearest = quotes.sort((a, b) => a.price - b.price)[0];
      throw new ApiError(409, 'no_quotes', 'No provider quoted within budget, deadline, and min_track.', {
        nearest_miss: nearest
          ? { provider: nearest.provider, price: nearest.price, deadline_ms: nearest.deadline_ms,
              track: nearest.track, violated: admissible(task, nearest) ?? 'stake' }
          : null,
      });
    }

    // Rank: price ascending, tie-broken by stake-weighted track record.
    admissibleQuotes.sort((a, b) => a.price - b.price || (b.track * b.stake_available) - (a.track * a.stake_available));
    const winner = admissibleQuotes[0];

    // A retry-enabled task locks its full committed budget so it can reroute
    // to a pricier-but-better provider; only the winner is paid, the surplus is
    // refunded on settlement. A plain task locks exactly the winning quote.
    const acct = state.accounts[key.id];
    // Retry and consensus both lock the full budget for headroom; a plain task
    // locks exactly the winning quote.
    const lockAmount = (retryOn || consensusN > 1) ? money(budget) : winner.price;
    if (acct.balance < lockAmount) {
      throw new ApiError(402, 'escrow_insufficient', 'Balance below the escrow required for this task. Top up or lower the budget.', {
        required: lockAmount, balance: acct.balance,
      });
    }
    if (acct.lockedToday + lockAmount > cfg.dailyCeiling[key.tier]) {
      throw new ApiError(402, 'escrow_insufficient', 'Daily escrow ceiling reached for this key.', {
        ceiling: cfg.dailyCeiling[key.tier], locked_today: acct.lockedToday,
      });
    }

    const escrowTx = lockEscrow(key.id, lockAmount);
    task.escrow = { locked: lockAmount, tx: escrowTx };
    task.quote = {
      provider: winner.provider, price: winner.price,
      deadline_ms: winner.deadline_ms, stake_reserved: winner.price,
    };

    if (consensusN > 1) {
      // Reserve stake for the top-N and run them in parallel.
      const chosen = admissibleQuotes.slice(0, consensusN).map((q) => ({
        provider: q.provider, price: q.price, deadline_ms: q.deadline_ms, track: q.track, stake_reserved: q.price,
      }));
      for (const q of chosen) state.providers[q.provider].stakeReserved = money(state.providers[q.provider].stakeReserved + q.price);
      task.consensusQuotes = chosen;
      task.status = 'dispatched';
      state.tasks[task.id] = task;
      emit(task, { status: 'dispatched', consensus: chosen.map((q) => q.provider) });
      persist();
      track(runConsensusTask(task));
      return { task: publicTask(task), reused: false };
    }

    state.providers[winner.provider].stakeReserved = money(state.providers[winner.provider].stakeReserved + winner.price);
    task.status = 'dispatched';
    state.tasks[task.id] = task;
    emit(task, { status: 'dispatched', quote: task.quote });
    persist();

    track(runTask(task)); // fire and forget; observable via events, awaitable via drain()

    return { task: publicTask(task), reused: false };
  }

  function getTask(key, taskId) {
    const task = state.tasks[taskId];
    if (!task || task.keyId !== key.id) throw new ApiError(404, 'not_found', `No task ${taskId}.`);
    return publicTask(task);
  }

  function listTasks(key, limit = 30) {
    return Object.values(state.tasks)
      .filter((t) => t.keyId === key.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(publicTask);
  }

  // ---- launchpad: launched agents, token bond, revenue routing ------------
  // An "agent" here is a supply-side, token-wrapped provider (distinct from the
  // demand-side API keys also called "agents"). Its slashable bond is the
  // platform token, valued in USDG. A launched agent's linked provider reuses
  // the existing reservation machinery: we set provider.stake to the agent's
  // bond *capacity* (haircut value / reservationMultiple), so the engine's
  // 1x-price reservation is exactly the brief's 200%-of-price against haircut.

  function agentRawBond(agent) {
    return bondValue({
      tokenQty: Math.max(0, agent.bond.tokenQty - (agent.unbonding?.tokenQty ?? 0)),
      twapUsdg: agent.token.twapUsdg,
      poolLiquidityUsdg: agent.token.poolLiquidityUsdg,
    }, agent.params);
  }
  // Keep the linked provider's usable stake in sync with bond capacity.
  function syncAgentCapacity(agent) {
    if (!agent.providerId) return;
    const p = state.providers[agent.providerId];
    if (!p) return;
    const cap = bondCapacity(agentRawBond(agent), agent.params);
    // Never drop below what open quotes already reserve (no liquidation of live work).
    p.stake = money(Math.max(cap, p.stakeReserved));
  }

  function publicAgent(a) {
    const raw = agentRawBond(a);
    return {
      id: a.id, owner: a.owner, created_at: a.createdAt,
      token: { symbol: a.token.symbol, address: a.token.address, twap_usdg: a.token.twapUsdg, pool_liquidity_usdg: a.token.poolLiquidityUsdg },
      bond: { token_qty: a.bond.tokenQty, raw_value_usdg: raw, haircut_value_usdg: money(raw * a.params.bondHaircut), capacity_usdg: bondCapacity(raw, a.params) },
      operating_usdg: state.accounts[a.id]?.balance ?? 0,
      provider_id: a.providerId,
      unbonding: a.unbonding ? { token_qty: a.unbonding.tokenQty, requested_at: a.unbonding.requestedAt, release_at: a.unbonding.releaseAt } : null,
      totals: { creator_paid: a.creatorPaid, owner_paid: a.ownerPaid, buyback: a.buyback, burned: a.burned, treasury_paid: a.treasuryPaid, bond_topped_up: a.bondToppedUp },
      params: a.params,
    };
  }

  // One transaction: create the agent, snapshot its (immutable) params, and
  // optionally register its provider endpoint. Cannot quote until it has an
  // endpoint and bond capacity.
  function launchAgent(body = {}) {
    const params = snapshotParams(body.params);
    const agentId = id('agt');
    state.accounts[agentId] = { balance: 0, locked: 0, lockedToday: 0, history: [] };
    const agent = {
      id: agentId, owner: body.owner ?? 'owner', createdAt: Date.now(),
      token: {
        symbol: body.symbol ?? params.platformToken.symbol, address: body.token_address ?? null,
        twapUsdg: Number(body.twap_usdg) > 0 ? Number(body.twap_usdg) : 1,
        poolLiquidityUsdg: Number(body.pool_liquidity_usdg) || 0,
      },
      bond: { tokenQty: Number(body.initial_bond_tokens) || 0 },
      providerId: null, params,
      creatorPaid: 0, ownerPaid: 0, buyback: 0, burned: 0, treasuryPaid: 0, bondToppedUp: 0,
      ledger: [], unbonding: null,
    };
    if (body.endpoint_url && body.offers) {
      const prov = registerProvider({ name: body.name ?? `agent ${agentId}`, endpoint_url: body.endpoint_url, offers: body.offers, stake: 0, protocol: body.protocol });
      prov.agentId = agentId; agent.providerId = prov.id;
    }
    state.agents[agentId] = agent;
    syncAgentCapacity(agent);
    persist();
    return publicAgent(agent);
  }

  // Permissionless: harvest `feeAmount` of pool fees and split per the agent's
  // snapshot — bond staked, operating credited (spend-only USDG), creator and
  // treasury paid.
  function harvestFees(agentId, feeAmount) {
    const agent = state.agents[agentId];
    if (!agent) throw new ApiError(404, 'not_found', `No agent ${agentId}.`);
    const amt = Number(feeAmount);
    if (!(amt > 0)) throw new ApiError(400, 'invalid_input', 'feeAmount must be positive');
    const s = splitFees(amt, agent.params);
    if (agent.token.twapUsdg > 0) agent.bond.tokenQty = money(agent.bond.tokenQty + s.bond / agent.token.twapUsdg);
    const acct = state.accounts[agentId];
    acct.balance = money(acct.balance + s.operating);
    acct.history.push({ ts: Date.now(), kind: 'harvest_operating', amount: s.operating, tx: txHash() });
    agent.creatorPaid = money(agent.creatorPaid + s.creator);
    agent.treasuryPaid = money(agent.treasuryPaid + s.treasury);
    state.treasury.balance = money(state.treasury.balance + s.treasury);
    agent.ledger.push({ ts: Date.now(), kind: 'harvest', fee: amt, ...s });
    syncAgentCapacity(agent);
    persist();
    return { agent: agentId, fee: amt, split: s, bond_capacity_usdg: bondCapacity(agentRawBond(agent), agent.params) };
  }

  // On a launched agent's settled task: protocol fee (burn/treasury) out of the
  // payout, then net routed owner / token-buyback / bond top-up.
  function routeAgentRevenue(agent, settledPrice) {
    const f = protocolFeeSplit(settledPrice, agent.params);
    state.treasury.balance = money(state.treasury.balance + f.treasury);
    state.treasury.burned = money(state.treasury.burned + f.burn);
    agent.burned = money(agent.burned + f.burn);
    agent.treasuryPaid = money(agent.treasuryPaid + f.treasury);
    const net = netPayoutSplit(f.net, agent.params);
    agent.ownerPaid = money(agent.ownerPaid + net.owner);
    agent.buyback = money(agent.buyback + net.buyback);
    state.treasury.buyback = money(state.treasury.buyback + net.buyback);
    if (agent.token.twapUsdg > 0) agent.bond.tokenQty = money(agent.bond.tokenQty + net.bond / agent.token.twapUsdg);
    agent.bondToppedUp = money(agent.bondToppedUp + net.bond);
    agent.ledger.push({ ts: Date.now(), kind: 'revenue', price: f.price, fee: f.fee, burn: f.burn, treasury: f.treasury, net: f.net, ...net });
    syncAgentCapacity(agent);
  }

  // Owner requests unbonding; the amount can't back new quotes and stays
  // slashable until the cooldown passes. Public event.
  function requestUnbond(agentId, tokenQty) {
    const agent = state.agents[agentId];
    if (!agent) throw new ApiError(404, 'not_found', `No agent ${agentId}.`);
    const qty = Math.min(Number(tokenQty) || 0, agent.bond.tokenQty);
    if (!(qty > 0)) throw new ApiError(400, 'invalid_input', 'tokenQty must be positive');
    agent.unbonding = { tokenQty: qty, requestedAt: Date.now(), releaseAt: Date.now() + agent.params.unbondingCooldownMs };
    agent.ledger.push({ ts: Date.now(), kind: 'unbond_request', tokenQty: qty, release_at: agent.unbonding.releaseAt });
    syncAgentCapacity(agent);
    persist();
    return publicAgent(agent);
  }

  // Sandbox price feed: move an agent token's TWAP / liquidity. A price drop
  // shrinks capacity (no liquidation); open tasks continue.
  function setAgentPrice(agentId, { twap_usdg, pool_liquidity_usdg } = {}) {
    const agent = state.agents[agentId];
    if (!agent) throw new ApiError(404, 'not_found', `No agent ${agentId}.`);
    if (twap_usdg !== undefined) agent.token.twapUsdg = Math.max(0, Number(twap_usdg) || 0);
    if (pool_liquidity_usdg !== undefined) agent.token.poolLiquidityUsdg = Math.max(0, Number(pool_liquidity_usdg) || 0);
    syncAgentCapacity(agent);
    persist();
    return publicAgent(agent);
  }

  function getAgent(agentId) {
    const a = state.agents[agentId];
    if (!a) throw new ApiError(404, 'not_found', `No agent ${agentId}.`);
    return publicAgent(a);
  }
  function listAgents() { return Object.values(state.agents).map(publicAgent); }

  // ---- disputes -----------------------------------------------------------

  async function resolveDispute(dispute, task) {
    // Independent re-review: a fresh grader panel (disjoint seeds), one notch
    // stricter, considering the disputant's evidence.
    const rubric = task.acceptance.rubric ?? 'the output faithfully satisfies the task input';
    const { pass } = await gradeRubric(task, task.output, rubric, cfg, 1);
    const evidenceWeight = dispute.evidence && Object.keys(dispute.evidence).length > 0;
    const recheck = await verify(task, task.output, cfg);
    const upheld = !pass || !recheck.pass || (evidenceWeight && hash01(dispute.id) < 0.25);

    const p = state.providers[task.quote.provider];
    if (upheld) {
      dispute.status = 'upheld';
      const slashed = slashProvider(task, 2);
      const acct = state.accounts[task.keyId];
      acct.balance = money(acct.balance + task.quote.price);
      acct.history.push({ ts: Date.now(), kind: 'clawback_refund', amount: task.quote.price, task: task.id, tx: txHash() });
      task.status = 'refunded';
      task.refund = { reason: 'dispute_upheld', detail: dispute.reason, tx: txHash() };
      emit(task, { status: 'refunded', refund: task.refund, slash: { provider: p.id, amount: slashed } });
    } else {
      dispute.status = 'rejected';
      p.earnings = money(p.earnings + task.quote.price); // clawed funds release back
      task.status = 'settled';
      emit(task, { status: 'settled', dispute: { id: dispute.id, outcome: 'rejected' } });
    }
    dispute.resolvedAt = Date.now();
    persist();
    track(notifyWebhook(task));
  }

  function openDispute(key, taskId, body) {
    const task = state.tasks[taskId];
    if (!task || task.keyId !== key.id) throw new ApiError(404, 'not_found', `No task ${taskId}.`);
    if (task.status !== 'settled') {
      throw new ApiError(409, 'not_disputable', `Only settled tasks can be disputed; task is ${task.status}.`);
    }
    if (Date.now() - task.settlement.settled_at > cfg.disputeWindowMs) {
      throw new ApiError(410, 'dispute_window_closed', 'Disputes close 24 h after settlement.');
    }
    if (!body?.reason) throw new ApiError(400, 'invalid_input', 'a dispute requires a reason');

    const dispute = {
      id: id('dsp'), taskId, keyId: key.id,
      reason: body.reason, evidence: body.evidence ?? null,
      status: 'reviewing', openedAt: Date.now(),
    };
    state.disputes[dispute.id] = dispute;

    // Claw the settled payment back into escrow pending re-review.
    const p = state.providers[task.quote.provider];
    p.earnings = money(p.earnings - task.quote.price);
    task.status = 'disputed';
    emit(task, { status: 'disputed', dispute: { id: dispute.id, reason: dispute.reason } });

    track(sleep(cfg.fast ? 50 : 1500).then(() => resolveDispute(dispute, task)));
    return dispute;
  }

  function getDispute(key, disputeId) {
    const d = state.disputes[disputeId];
    if (!d || d.keyId !== key.id) throw new ApiError(404, 'not_found', `No dispute ${disputeId}.`);
    return d;
  }

  // ---- provider registration ---------------------------------------------

  function registerProvider(body) {
    const { name, endpoint_url, offers: offered, stake, protocol = 'http' } = body ?? {};
    if (!name || typeof name !== 'string') {
      throw new ApiError(400, 'invalid_input', 'name is required');
    }
    if (!/^https?:\/\//.test(endpoint_url ?? '')) {
      throw new ApiError(400, 'invalid_input', 'endpoint_url must be an http(s) URL your provider serves');
    }
    if (!['http', 'x402'].includes(protocol)) {
      throw new ApiError(400, 'invalid_input', 'protocol must be "http" or "x402"');
    }
    if (!offered || typeof offered !== 'object' || !Object.keys(offered).length) {
      throw new ApiError(400, 'invalid_input', 'offers must map at least one capability to { price_ceiling, sla_deadline_ms }');
    }
    for (const [cap, o] of Object.entries(offered)) {
      if (!CAPABILITIES[cap]) throw new ApiError(404, 'unknown_capability', `No capability "${cap}" in the catalog.`);
      if (!(o?.price_ceiling > 0)) throw new ApiError(400, 'invalid_input', `offers.${cap}.price_ceiling must be a positive USDC amount`);
      if (!Number.isInteger(o?.sla_deadline_ms) || o.sla_deadline_ms <= 0) {
        throw new ApiError(400, 'invalid_input', `offers.${cap}.sla_deadline_ms must be a positive integer`);
      }
    }
    // Simulated bond, capped like the escrow faucet. On-chain staking replaces this.
    const bonded = Math.min(Math.max(Number(stake) || 0, 1), 1000);
    const provider = {
      id: id('prv'), name, endpoint_url, protocol,
      offers: Object.fromEntries(Object.entries(offered).map(([cap, o]) =>
        [cap, { price_ceiling: money(o.price_ceiling), sla_deadline_ms: o.sla_deadline_ms }])),
      stake: bonded, stakeReserved: 0, earnings: 0,
      track: 50, settledCount: 0, slashedCount: 0,
    };
    state.providers[provider.id] = provider;
    persist();
    return provider;
  }

  // ---- provider reputation (public) ---------------------------------------

  function publicProvider(p) {
    const reliability = p.settledCount + p.slashedCount > 0
      ? money(p.settledCount / (p.settledCount + p.slashedCount)) : null;
    return {
      id: p.id, name: p.name, endpoint_url: p.endpoint_url, protocol: p.protocol ?? 'native',
      track: Math.round(p.track), stake: p.stake, stake_available: money(p.stake - p.stakeReserved),
      earnings: p.earnings, settled: p.settledCount, slashed: p.slashedCount,
      reliability, capabilities: Object.keys(p.offers), offers: p.offers,
    };
  }
  function listProviders() {
    return Object.values(state.providers)
      .map(publicProvider)
      .sort((a, b) => b.track - a.track || b.stake - a.stake);
  }
  function getProvider(id) {
    const p = state.providers[id];
    if (!p) throw new ApiError(404, 'not_found', `No provider ${id}.`);
    return publicProvider(p);
  }

  function insuranceStats() {
    return {
      pool_balance: state.insurance.balance,
      total_funded: state.insurance.funded,
      claims_paid: state.insurance.claims.length,
      recent_claims: state.insurance.claims.slice(-10),
    };
  }

  function getAttestation(key, taskId) {
    const task = state.tasks[taskId];
    if (!task || task.keyId !== key.id) throw new ApiError(404, 'not_found', `No task ${taskId}.`);
    if (!task.attestation) throw new ApiError(409, 'not_attestable', `Task ${taskId} has no attestation (status ${task.status}).`);
    return { attestation: task.attestation, public_key: attestor.publicKeyPem };
  }
  function attestorKey() {
    return { alg: 'ed25519', key_id: attestor.keyId, public_key: attestor.publicKeyPem };
  }

  // ---- verification-as-a-service ------------------------------------------
  // Verify an output the caller already has (from any source) and hand back a
  // signed attestation — no escrow, no execution, no provider.
  async function verifyOutput(key, body) {
    const { capability, input = {}, output, acceptance = {} } = body ?? {};
    if (!CAPABILITIES[capability]) throw new ApiError(404, 'unknown_capability', `No capability "${capability}" in the catalog.`);
    if (output === undefined || output === null) throw new ApiError(400, 'invalid_input', 'output is required');
    const acceptCheck = validateAcceptance(acceptance);
    if (!acceptCheck.ok) throw new ApiError(400, 'invalid_acceptance', acceptCheck.detail);

    const synthetic = { id: id('vrf'), capability, input, acceptance };
    const verdict = await verify(synthetic, output, cfg);
    const attestation = verdict.pass
      ? attestor.attest('verification', {
          capability, verified_by: verdict.verified_by,
          output_sha256: sha256(JSON.stringify(output)),
        })
      : null;
    return {
      pass: verdict.pass,
      verified_by: verdict.verified_by ?? null,
      failed: verdict.failed ?? null,
      attestation,
    };
  }

  // ---- verified workflows --------------------------------------------------
  // Sequential task graph: each step is a normal task; later steps can splice
  // earlier verified outputs via {{steps.N.output.path}} refs. The chain stops
  // at the first step that doesn't settle.
  const REF = /\{\{\s*steps\.(\d+)\.output([.\w[\]]*)\s*\}\}/g;
  function resolveRefs(value, ctx) {
    if (typeof value === 'string') {
      return value.replace(REF, (_m, i, path) => {
        let cur = ctx.steps[Number(i)]?.output;
        for (const key of path.split(/[.[\]]/).filter(Boolean)) cur = cur?.[key];
        return cur ?? '';
      });
    }
    if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ctx));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, ctx)]));
    }
    return value;
  }
  function publicWorkflow(wf) {
    const { keyId, ...rest } = wf;
    return rest;
  }
  function whenSettled(taskId) {
    const t = state.tasks[taskId];
    if (!t) return Promise.resolve(null);
    if (TERMINAL.has(t.status)) return Promise.resolve(t);
    return new Promise((resolve) => {
      const un = subscribe(taskId, (evt) => {
        if (evt.status === 'settled' || evt.status === 'refunded') { un(); resolve(state.tasks[taskId]); }
      });
    });
  }
  async function runWorkflow(wf, key, steps) {
    const ctx = { steps: [] };
    for (let i = 0; i < steps.length; i++) {
      let created;
      try {
        created = createTask(key, resolveRefs(steps[i], ctx));
      } catch (e) {
        wf.status = 'failed';
        wf.failure = { step: i, error: e.message };
        persist();
        return;
      }
      wf.steps.push({ index: i, taskId: created.task.id, status: created.task.status });
      const done = await whenSettled(created.task.id);
      const entry = wf.steps[wf.steps.length - 1];
      entry.status = done?.status ?? 'unknown';
      ctx.steps.push({ output: done?.output ?? null, status: done?.status });
      if (!done || done.status !== 'settled') {
        wf.status = 'failed';
        wf.failure = { step: i, taskId: created.task.id, reason: done?.refund?.reason ?? 'unknown' };
        persist();
        return;
      }
    }
    wf.status = 'completed';
    wf.output = ctx.steps.at(-1)?.output ?? null;
    persist();
  }
  function createWorkflow(key, body) {
    const steps = body?.steps;
    if (!Array.isArray(steps) || !steps.length) {
      throw new ApiError(400, 'invalid_input', 'steps must be a non-empty array of task bodies');
    }
    if (steps.length > 12) throw new ApiError(400, 'invalid_input', 'a workflow is capped at 12 steps');
    const wf = { id: id('wkf'), keyId: key.id, status: 'running', steps: [], createdAt: Date.now() };
    state.workflows[wf.id] = wf;
    persist();
    track(runWorkflow(wf, key, steps));
    return publicWorkflow(wf);
  }
  function getWorkflow(key, wfId) {
    const wf = state.workflows[wfId];
    if (!wf || wf.keyId !== key.id) throw new ApiError(404, 'not_found', `No workflow ${wfId}.`);
    return publicWorkflow(wf);
  }

  // ---- boot recovery --------------------------------------------------------
  // Restored in-flight tasks have lost their timers and executor promises;
  // treat them as abandoned so escrow is made whole and stake answers for it.
  // recoveryGraceMs spares recent tasks: on serverless, a task loaded as
  // in-flight may still be running inside a concurrent invocation.

  if (loaded) {
    for (const task of Object.values(state.tasks)) {
      if (!TERMINAL.has(task.status) && task.status !== 'disputed' && task.quote
          && Date.now() - task.createdAt >= cfg.recoveryGraceMs) {
        refundTask(task, 'provider_abandoned', 'platform restarted while the task was in flight');
      }
    }
    persist();
  }

  return {
    cfg, state, drain,
    createKey, authenticate, deposit, balance,
    createSubKey, listSubKeys, revokeSubKey, freezeSubKey,
    offers, createTask, getTask, listTasks, subscribe, publicTask,
    openDispute, getDispute, registerProvider,
    listProviders, getProvider, insuranceStats, getAttestation, attestorKey,
    verifyOutput, createWorkflow, getWorkflow,
    launchAgent, harvestFees, requestUnbond, setAgentPrice, getAgent, listAgents,
  };
}
