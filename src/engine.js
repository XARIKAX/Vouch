import { id, txHash, hash01, money, clamp, sha256, sleep } from './util.js';
import { CAPABILITIES, validateInput } from './catalog.js';
import { seedProviders, runExecutor } from './providers.js';
import { verify, gradeRubric, validateAcceptance } from './verification.js';
import { createStore } from './store.js';

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
    persistPath: null,
    store: null,           // injected store (serverless); overrides persistPath
    recoveryGraceMs: 0,    // boot recovery skips in-flight tasks younger than this
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
  };
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
    if (!key) throw new ApiError(401, 'unauthorized', 'Missing, invalid, or revoked key.');
    return key;
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
    acct.locked = money(acct.locked - task.quote.price);
    p.earnings = money(p.earnings + task.quote.price);
    p.stakeReserved = money(Math.max(0, p.stakeReserved - task.quote.stake_reserved));
    p.settledCount++;
    p.track = clamp(p.track + 0.2, 0, 100);
    const entry = { ts: Date.now(), kind: 'settle', amount: -task.quote.price, task: task.id, tx: txHash() };
    acct.history.push(entry);
    return entry.tx;
  }

  function refundEscrow(task, reason) {
    const acct = state.accounts[task.keyId];
    acct.locked = money(acct.locked - task.quote.price);
    acct.balance = money(acct.balance + task.quote.price);
    acct.lockedToday = money(Math.max(0, acct.lockedToday - task.quote.price));
    const entry = { ts: Date.now(), kind: 'refund', amount: task.quote.price, task: task.id, reason, tx: txHash() };
    acct.history.push(entry);
    return entry.tx;
  }

  function slashProvider(task, multiple) {
    const p = state.providers[task.quote.provider];
    const amount = money(task.quote.price * multiple);
    p.stake = money(Math.max(0, p.stake - amount));
    p.stakeReserved = money(Math.max(0, p.stakeReserved - task.quote.stake_reserved));
    p.slashedCount++;
    p.track = clamp(p.track - 15, 0, 100);
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
    const slashed = slashProvider(task, multiple);
    const refundTx = refundEscrow(task, reason);
    terminalize(task, 'refunded', {
      refund: { reason, detail, tx: refundTx },
      slash: { provider: p.id, amount: slashed },
    });
  }

  async function runTask(task) {
    const startedAt = Date.now();
    // Commitment enforcement: the quoted deadline is a hard timer, not a hint.
    task.timer = setTimeout(() => {
      if (!TERMINAL.has(task.status)) {
        refundTask(task, 'deadline_missed', `no verified output within the quoted ${task.quote.deadline_ms} ms`);
      }
    }, task.quote.deadline_ms + (cfg.fast ? 250 : 1000));

    const provider = state.providers[task.quote.provider];
    let output;
    try {
      output = await runExecutor(provider, task, cfg);
    } catch (e) {
      output = { error: e.message };
    }
    if (TERMINAL.has(task.status)) return;

    if (output?.error) {
      return refundTask(task, 'provider_abandoned', output.error);
    }
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

    if (!verdict.pass) {
      return refundTask(task, 'verification_failed', `${verdict.failed.validator}: ${verdict.failed.detail}`);
    }

    task.output = output;
    const settleTx = settleEscrow(task);
    terminalize(task, 'settled', {
      output,
      settlement: {
        provider: task.quote.provider,
        price: task.quote.price,
        verified_by: verdict.verified_by,
        elapsed_ms: Date.now() - startedAt,
        escrow_tx: settleTx,
        settled_at: Date.now(),
      },
    });
  }

  function createTask(key, body) {
    const { capability, input, acceptance = {}, budget, deadline_ms, min_track, webhook_url, idempotency_key } = body ?? {};

    if (idempotency_key) {
      const existing = Object.values(state.tasks).find(
        (t) => t.keyId === key.id && t.idempotency_key === idempotency_key
      );
      if (existing) return { task: publicTask(existing), reused: true };
    }

    if (!CAPABILITIES[capability]) {
      throw new ApiError(404, 'unknown_capability', `No capability "${capability}" in the catalog.`);
    }
    const inputCheck = validateInput(capability, input ?? {});
    if (!inputCheck.ok) throw new ApiError(400, 'invalid_input', inputCheck.detail);
    const acceptCheck = validateAcceptance(acceptance);
    if (!acceptCheck.ok) throw new ApiError(400, 'invalid_acceptance', acceptCheck.detail);
    if (!(budget > 0)) throw new ApiError(400, 'invalid_input', 'budget must be a positive USDC amount');
    if (!Number.isInteger(deadline_ms) || deadline_ms <= 0) {
      throw new ApiError(400, 'invalid_input', 'deadline_ms must be a positive integer');
    }

    const task = {
      id: id('tsk'), keyId: key.id, capability, input,
      acceptance, budget, deadline_ms, min_track, webhook_url, idempotency_key,
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

    const acct = state.accounts[key.id];
    if (acct.balance < winner.price) {
      throw new ApiError(402, 'escrow_insufficient', 'Balance below the lowest admissible quote. Top up or raise the ceiling.', {
        required: winner.price, balance: acct.balance,
      });
    }
    if (acct.lockedToday + winner.price > cfg.dailyCeiling[key.tier]) {
      throw new ApiError(402, 'escrow_insufficient', 'Daily escrow ceiling reached for this key.', {
        ceiling: cfg.dailyCeiling[key.tier], locked_today: acct.lockedToday,
      });
    }

    const provider = state.providers[winner.provider];
    provider.stakeReserved = money(provider.stakeReserved + winner.price);
    const escrowTx = lockEscrow(key.id, winner.price);

    task.quote = {
      provider: winner.provider, price: winner.price,
      deadline_ms: winner.deadline_ms, stake_reserved: winner.price,
    };
    task.escrow = { locked: winner.price, tx: escrowTx };
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
    const { name, endpoint_url, offers: offered, stake } = body ?? {};
    if (!name || typeof name !== 'string') {
      throw new ApiError(400, 'invalid_input', 'name is required');
    }
    if (!/^https?:\/\//.test(endpoint_url ?? '')) {
      throw new ApiError(400, 'invalid_input', 'endpoint_url must be an http(s) URL your provider serves');
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
      id: id('prv'), name, endpoint_url,
      offers: Object.fromEntries(Object.entries(offered).map(([cap, o]) =>
        [cap, { price_ceiling: money(o.price_ceiling), sla_deadline_ms: o.sla_deadline_ms }])),
      stake: bonded, stakeReserved: 0, earnings: 0,
      track: 50, settledCount: 0, slashedCount: 0,
    };
    state.providers[provider.id] = provider;
    persist();
    return provider;
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
    offers, createTask, getTask, listTasks, subscribe, publicTask,
    openDispute, getDispute, registerProvider,
  };
}
