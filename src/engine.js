import { id, txHash, hash01, money, clamp, sha256, sleep } from './util.js';
import { CAPABILITIES, validateInput } from './catalog.js';
import { seedProviders, runExecutor } from './providers.js';
import { modelBacked } from './execute-claude.js';
import { ponsConfig, buildLaunchIntent, verifyLaunch, readCurve, readCreatorFees, pairFor } from './chain/pons.js';
import { createRpc } from './chain/rpc.js';
import { verify, gradeRubric, validateAcceptance } from './verification.js';
import { createStore } from './store.js';
import { createAttestor, canonical } from './attest.js';
import { snapshotParams } from './launchpad-config.js';
import { splitFees, bondValue, bondCapacity, protocolFeeSplit, netPayoutSplit, slashPlan, slashBase, trackWeight } from './launchpad.js';
import { ApiError } from './errors.js';
import { assertPublicUrl, fetchWithTimeout } from './netguard.js';

// ApiError is re-exported so `import { ApiError } from './engine.js'` keeps working.
export { ApiError };

const TERMINAL = new Set(['settled', 'refunded']);
const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = () => Math.floor(Date.now() / DAY_MS);

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
    // The judge/executor model is a deploy-time setting. Without it the
    // offline heuristic grader and the sandbox simulator are used.
    graderModel: process.env.VOUCH_GRADER_MODEL || null,
    execModel: process.env.VOUCH_EXEC_MODEL || null,
    // When native providers execute through a real model, their quoted
    // deadline is at least this: a model answer plus a cold start takes far
    // longer than the sandbox simulator's seed SLAs. Not applied in fast mode.
    modelSlaMs: Number(process.env.VOUCH_MODEL_SLA_MS) || 20000,
    // Image generation: a URL-based image API (keyless by default), on
    // whenever real model execution is on, unless switched off.
    imageProvider: process.env.VOUCH_IMAGE_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'pollinations' : 'none'),
    imageBaseUrl: process.env.VOUCH_IMAGE_BASE_URL || 'https://image.pollinations.ai',
    imageModel: process.env.VOUCH_IMAGE_MODEL || 'flux',
    persistPath: null,
    store: null,           // injected store (serverless); overrides persistPath
    recoveryGraceMs: 0,    // boot recovery skips in-flight work younger than this
    maxAttempts: 4,        // hard cap on auto-retry attempts per task
    insuranceRate: 0.5,    // failure compensation as a fraction of the task price
    maxConsensus: 3,       // cap on parallel providers for consensus execution
    cachePriceRate: 0.1,   // cache-hit price as a fraction of the cheapest quote
    attestKey: process.env.VOUCH_ATTEST_KEY || null,
    allowPrivateWebhooks: false, // let webhook_url / acceptance.webhook point at private hosts (tests)
    // Token launches on Pons (Robinhood Chain). The engine only prepares and
    // verifies; wallets sign. `chain` carries the RPC, factory, explorer.
    chain: ponsConfig(),
    chainRefreshMs: 60 * 1000,   // how often a live agent's price is re-read from its curve
    ...cfg,
  };

  const store = cfg.store ?? createStore(cfg.persistPath);
  const loaded = store.load();
  const state = loaded ?? {
    keys: {},       // keyId -> { id, tokenHash, name, tier, createdAt }
    accounts: {},   // keyId -> { balance, locked, lockedToday, lockedDay, history: [] }
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
  state.launchpad ??= { paused: false, pending_slashes: [] }; // guardian + queued token-bond slashes
  state.launchpad.pending_slashes ??= [];
  state.attest ??= {};   // attestation key material: generated key persisted here, plus every public key ever used

  // Attestation key: the configured PEM wins; otherwise the key generated on
  // first boot is persisted in state so receipts keep verifying across
  // restarts and serverless invocations. Every public key ever used is kept
  // so an old receipt can be checked against the key that signed it.
  const attestor = createAttestor({ ...cfg, attestKey: cfg.attestKey || state.attest.private_key_pem || null });
  // 'configured' (env key), 'invalid' (env key rejected, generated used), or 'generated' / 'state'.
  cfg.attestSource = cfg.attestKey ? attestor.source : (state.attest.private_key_pem ? 'state' : 'generated');
  cfg.attestDetail = attestor.detail ?? null;
  // A read-only invocation must not write the snapshot back (on serverless
  // every poll would race the writer that carries a settlement), so boot only
  // marks the state dirty when it actually changed something.
  let bootDirty = false;
  if ((!cfg.attestKey || attestor.source === 'invalid') && state.attest.private_key_pem !== attestor.privateKeyPem) {
    state.attest.private_key_pem = attestor.privateKeyPem;
    bootDirty = true;
  }
  state.attest.public_keys ??= {};
  if (state.attest.public_keys[attestor.keyId] !== attestor.publicKeyPem) {
    state.attest.public_keys[attestor.keyId] = attestor.publicKeyPem;
    bootDirty = true;
  }
  // Escrow counters can never be negative. A snapshot written before the
  // three-way merge existed may carry one; repair it and say so.
  for (const [id, acct] of Object.entries(state.accounts ?? {})) {
    for (const f of ['locked', 'lockedToday']) {
      if (typeof acct[f] === 'number' && acct[f] < 0) {
        console.warn(`vouch: account ${id} had ${f} ${acct[f]}; reset to 0`);
        acct[f] = 0; bootDirty = true;
      }
    }
  }

  const persist = () => store.save(state);
  const flush = () => store.flush?.();
  if (!loaded) { seedProviders(state); persist(); }

  const subscribers = new Map(); // taskId -> Set<fn(event)>
  // Deadline timers live beside the state, never inside it, so snapshots carry
  // no runtime handles and user data named "timer" is left alone.
  const timers = new Map(); // taskId -> Timeout
  const armTimer = (task, ms, fn) => {
    clearTimer(task);
    const t = setTimeout(() => { timers.delete(task.id); fn(); }, ms);
    t.unref?.();
    timers.set(task.id, t);
  };
  const clearTimer = (task) => {
    const t = timers.get(task.id);
    if (t) { clearTimeout(t); timers.delete(task.id); }
  };

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

  const newAccount = (balance, history) => ({ balance, locked: 0, lockedToday: 0, lockedDay: utcDay(), history });

  function createKey(name = 'default', opts = {}) {
    const token = id('vch');
    const key = { id: id('key'), tokenHash: sha256(token), name, tier: 'sandbox', createdAt: Date.now() };
    // Optional owner wallet: lets the launchpad detect self-dealing (a buyer and
    // a launched agent funded by the same owner earn that agent zero reputation).
    if (opts.owner) key.owner = String(opts.owner);
    state.keys[key.id] = key;
    state.accounts[key.id] = newAccount(cfg.faucet, [{ ts: Date.now(), kind: 'faucet', amount: cfg.faucet, tx: txHash() }]);
    persist();
    return { ...key, token }; // the plaintext token exists only in this return value
  }

  function authenticate(token) {
    const h = sha256(token ?? '');
    const key = Object.values(state.keys).find((k) => k.tokenHash === h);
    if (!key || key.revoked) throw new ApiError(401, 'unauthorized', 'Missing, invalid, or revoked key.');
    return key;
  }

  // Who am I: the identity a page or agent needs to compare ownership.
  function me(key) {
    return {
      key_id: key.id, name: key.name, tier: key.tier, owner: key.owner ?? null,
      parent: key.parent ?? null, frozen: !!key.frozen, allow: key.allow ?? null,
      per_task_cap: key.perTaskCap ?? null, created_at: key.createdAt,
    };
  }

  // ---- sub-agent wallets ---------------------------------------------------
  // A parent key mints capped, policy-bound sub-keys for the child agents it
  // spawns: a fixed budget transferred from the parent, an optional capability
  // allowlist (exact ids or `prefix.*`), and instant revocation. A child can
  // never exceed its wallet or touch capabilities outside its allowlist.
  function capabilityAllowed(allow, cap) {
    return allow.some((a) => a === cap || (a.endsWith('.*') && cap.startsWith(a.slice(0, -1))));
  }
  function normalizeAllow(allow) {
    if (allow === undefined || allow === null) return null;
    if (!Array.isArray(allow) || !allow.every((a) => typeof a === 'string')) {
      throw new ApiError(400, 'invalid_input', 'allow must be an array of capability ids or prefixes like "text.*"');
    }
    for (const a of allow) {
      const ok = CAPABILITIES[a] || (a.endsWith('.*') && Object.keys(CAPABILITIES).some((c) => c.startsWith(a.slice(0, -1))));
      if (!ok) throw new ApiError(400, 'invalid_input', `allow entry "${a}" matches no capability in the catalog`, { entry: a });
    }
    return [...new Set(allow)];
  }

  function createSubKey(parent, body = {}) {
    if (parent.parent) throw new ApiError(403, 'forbidden', 'Sub-keys cannot mint their own sub-keys.');
    if (!body || typeof body !== 'object') throw new ApiError(400, 'invalid_input', 'body must be a JSON object');
    const fund = Number(body.fund) || 0;
    if (!(fund > 0)) throw new ApiError(400, 'invalid_input', 'fund must be a positive USDC amount to transfer to the sub-key');
    const allow = normalizeAllow(body.allow);
    let perTaskCap = null;
    if (body.per_task_cap !== undefined && body.per_task_cap !== null) {
      const cap = Number(body.per_task_cap);
      if (!(typeof body.per_task_cap === 'number' || typeof body.per_task_cap === 'string') || !Number.isFinite(cap) || cap <= 0) {
        throw new ApiError(400, 'invalid_input', 'per_task_cap must be a positive USDC amount');
      }
      perTaskCap = money(cap);
    }
    const pacct = state.accounts[parent.id];
    if (pacct.balance < fund) throw new ApiError(402, 'escrow_insufficient', 'Parent balance below the requested sub-key funding.', { required: fund, balance: pacct.balance });

    const token = id('vch');
    const key = {
      id: id('key'), tokenHash: sha256(token), name: typeof body.name === 'string' ? body.name : 'sub-agent',
      tier: parent.tier, createdAt: Date.now(),
      parent: parent.id, allow, revoked: false, frozen: false, perTaskCap,
    };
    if (parent.owner) key.owner = parent.owner; // self-dealing detection sees through delegation
    state.keys[key.id] = key;
    pacct.balance = money(pacct.balance - fund);
    pacct.history.push({ ts: Date.now(), kind: 'sub_fund', amount: -fund, sub: key.id, tx: txHash() });
    state.accounts[key.id] = newAccount(money(fund), [{ ts: Date.now(), kind: 'sub_grant', amount: fund, parent: parent.id, tx: txHash() }]);
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
    sub.frozen = frozen === true;
    persist();
    return { id: subId, frozen: sub.frozen };
  }

  function revokeSubKey(parent, subId) {
    const sub = state.keys[subId];
    if (!sub || sub.parent !== parent.id) throw new ApiError(404, 'not_found', `No sub-key ${subId} under this parent.`);
    if (sub.revoked) return { id: subId, revoked: true, refunded: 0 };
    sub.revoked = true;
    // Return the sub-key's unspent (unlocked) balance to the parent. Anything
    // still locked in escrow follows later via creditAccount(), which routes a
    // revoked account's refunds, surplus and compensation to the parent.
    const sacct = state.accounts[sub.id];
    const refund = money(sacct.balance);
    sacct.balance = 0;
    const pacct = state.accounts[parent.id];
    pacct.balance = money(pacct.balance + refund);
    pacct.history.push({ ts: Date.now(), kind: 'sub_revoke_refund', amount: refund, sub: sub.id, tx: txHash() });
    persist();
    return { id: subId, revoked: true, refunded: refund };
  }

  // Credit `amount` to a key's account. A revoked sub-key no longer holds
  // funds, so its later refunds / surplus / compensation land on the parent.
  function creditAccount(keyId, amount, entry) {
    const key = state.keys[keyId];
    const target = key?.revoked && key.parent && state.accounts[key.parent] ? key.parent : keyId;
    const acct = state.accounts[target];
    acct.balance = money(acct.balance + amount);
    const rec = { ts: Date.now(), ...entry, amount, tx: entry.tx ?? txHash() };
    if (target !== keyId) rec.from_sub = keyId;
    acct.history.push(rec);
    return rec.tx;
  }

  // ---- daily escrow ceiling -------------------------------------------------
  // lockedToday counts escrow locked during the current UTC day and resets
  // when the day rolls. Sub-keys share their parent's ceiling: the root
  // account's counter is the one checked.
  function rollDay(acct) {
    const d = utcDay();
    if (acct.lockedDay !== d) { acct.lockedDay = d; acct.lockedToday = 0; }
    return acct;
  }
  function rootAccountId(keyId) {
    const key = state.keys[keyId];
    return key?.parent && state.accounts[key.parent] ? key.parent : keyId;
  }
  function ceilingAccount(keyId) { return rollDay(state.accounts[rootAccountId(keyId)]); }
  function bumpLockedToday(keyId, delta) {
    const own = rollDay(state.accounts[keyId]);
    own.lockedToday = money(Math.max(0, own.lockedToday + delta));
    const rootId = rootAccountId(keyId);
    if (rootId !== keyId) {
      const root = rollDay(state.accounts[rootId]);
      root.lockedToday = money(Math.max(0, root.lockedToday + delta));
    }
  }

  // ---- semantic cache ------------------------------------------------------
  // An identical, already-verified task can be served from cache: same output,
  // instantly, at a small fraction of the price — no auction, no provider
  // round-trip. Safe precisely because the cached output already passed
  // verification against the same acceptance criteria. The served task gets
  // its own signed attestation that names the source task.
  const cacheKey = (capability, input, acceptance) =>
    sha256(capability + '\u0000' + canonical(input) + '\u0000' + canonical(acceptance));
  function cachePut(task, verdict) {
    const fp = cacheKey(task.capability, task.input, task.acceptance);
    state.cache[fp] = {
      output: task.output, attestation: task.attestation, task_id: task.id,
      capability: task.capability, verified_by: verdict.verified_by,
      ts: Date.now(), hits: 0,
    };
    const keys = Object.keys(state.cache);
    if (keys.length > 500) delete state.cache[keys[0]]; // simple bound
  }
  function cacheEvict(task) {
    const fp = cacheKey(task.capability, task.input, task.acceptance);
    const hit = state.cache[fp];
    if (!hit) return false;
    delete state.cache[fp];
    return true;
  }

  function deposit(key, amount) {
    if (key.parent) throw new ApiError(403, 'forbidden', 'Sub-keys are funded by their parent; deposit to the parent key instead.');
    if (!(typeof amount === 'number' && Number.isFinite(amount) && amount > 0)) throw new ApiError(400, 'invalid_input', 'amount must be a positive number');
    const capped = Math.min(amount, 100); // simulated faucet cap
    const acct = state.accounts[key.id];
    acct.balance = money(acct.balance + capped);
    const entry = { ts: Date.now(), kind: 'deposit', amount: capped, tx: txHash() };
    acct.history.push(entry);
    persist();
    return { balance: acct.balance, credited: capped, tx: entry.tx };
  }

  function balance(key) {
    const acct = rollDay(state.accounts[key.id]);
    const ceiling = ceilingAccount(key.id);
    return {
      balance: acct.balance,
      locked: acct.locked,
      daily_ceiling: cfg.dailyCeiling[key.tier],
      ceiling_remaining: money(Math.max(0, cfg.dailyCeiling[key.tier] - ceiling.lockedToday)),
      locked_today: ceiling.lockedToday,
      ceiling_resets_at: (utcDay() + 1) * DAY_MS,
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
    // Native providers doing real model work cannot promise the simulator's
    // seed SLAs; their quote is floored at cfg.modelSlaMs so a buyer who sets
    // a shorter deadline gets an honest 409 instead of a refund later.
    const floor = (!cfg.fast && modelBacked(cfg, task.capability)) ? cfg.modelSlaMs : 0;
    for (const p of Object.values(state.providers)) {
      const offer = p.offers[task.capability];
      if (!offer) continue;
      const price = money(offer.price_ceiling * (0.7 + 0.25 * hash01(p.id + task.id + 'price')));
      const native = !p.endpoint_url && p.protocol !== 'x402';
      const deadline_ms = Math.max(native ? floor : 0, Math.floor(offer.sla_deadline_ms * (0.8 + 0.2 * hash01(p.id + task.id + 'dl'))));
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
    bumpLockedToday(keyId, amount);
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
    if (surplus > 0) {
      creditAccount(task.keyId, surplus, { kind: 'surplus', task: task.id });
      bumpLockedToday(task.keyId, -surplus); // only what was actually spent counts against the ceiling
    }
    p.earnings = money(p.earnings + task.quote.price);
    p.stakeReserved = money(Math.max(0, p.stakeReserved - task.quote.stake_reserved));
    p.settledCount++;
    // Reputation bump. Non-launchpad providers keep the flat bump. Launched
    // agents earn it weighted by the counterparty: self-dealing (same owner
    // wallet on both sides) earns zero, rubric-only work earns reduced weight,
    // deterministic checks / webhook earn full weight. This is how the
    // launchpad resists an agent farming its own reputation.
    const agent = p.agentId ? state.agents[p.agentId] : null;
    if (agent) {
      const validators = ['schema'];
      if (task.acceptance?.checks?.length) validators.push('checks');
      if (task.acceptance?.rubric) validators.push('rubric');
      if (task.acceptance?.webhook) validators.push('webhook');
      const buyerOwner = state.keys[task.keyId]?.owner;
      const sameOwner = !!(agent.owner && buyerOwner && buyerOwner === agent.owner);
      const w = trackWeight({ sameOwner, validators });
      p.track = clamp(p.track + 0.2 * w, 0, 100);
      agent.settledCount = (agent.settledCount ?? 0) + 1;
      if (w > 0) {
        agent.counterparties ??= {};
        agent.counterparties[buyerOwner || task.keyId] = true;
      }
    } else {
      p.track = clamp(p.track + 0.2, 0, 100);
    }
    const entry = { ts: Date.now(), kind: 'settle', amount: -task.quote.price, task: task.id, tx: txHash() };
    acct.history.push(entry);
    // Launchpad: if this provider is a launched agent, route its revenue
    // (protocol fee + owner/buyback/bond). Non-launchpad providers are untouched.
    if (agent) routeAgentRevenue(agent, task.quote.price, task.id);
    return entry.tx;
  }

  function refundEscrow(task, reason) {
    const acct = state.accounts[task.keyId];
    const locked = task.escrow?.locked ?? task.quote.price;
    acct.locked = money(acct.locked - locked);
    bumpLockedToday(task.keyId, -locked);
    return creditAccount(task.keyId, locked, { kind: 'refund', task: task.id, reason });
  }

  // Slash `priceUsdg * multiple` off a provider's collateral. A launched agent
  // is slashed in its platform token at TWAP, capped (per-verdict max multiple
  // and a rolling-window cap, both from slashPlan) and QUEUED behind the
  // pending-slash delay with a guardian freeze; its token-bond capacity
  // reprices when the slash executes. A normal provider is slashed flat off
  // its USDG stake immediately. Either way the slashed USDG value capitalizes
  // the insurance pool when funds move.
  function applySlash(p, priceUsdg, multiple, meta = {}) {
    const agent = p.agentId ? state.agents[p.agentId] : null;
    if (agent) return queueAgentSlash(agent, priceUsdg, multiple, meta);
    const amount = money(priceUsdg * multiple);
    p.stake = money(Math.max(0, p.stake - amount));
    state.insurance.balance = money(state.insurance.balance + amount);
    state.insurance.funded = money(state.insurance.funded + amount);
    return amount;
  }

  function penalize(p, price, multiple, meta, { releaseReserved = true, reserved = 0 } = {}) {
    if (releaseReserved) p.stakeReserved = money(Math.max(0, p.stakeReserved - reserved));
    const amount = applySlash(p, price, multiple, meta);
    p.slashedCount++;
    p.track = clamp(p.track - 15, 0, 100);
    return amount;
  }

  // Slash the holder of a consensus quote (releases its reservation).
  function slashQuote(quote, multiple, meta = {}, opts = {}) {
    const p = state.providers[quote.provider];
    return penalize(p, quote.price, multiple, meta, { releaseReserved: opts.release !== false, reserved: quote.stake_reserved });
  }

  // Slash the task's committed provider (releases its reservation).
  function slashProvider(task, multiple, reason) {
    const p = state.providers[task.quote.provider];
    return penalize(p, task.quote.price, multiple, { taskId: task.id, reason }, { reserved: task.quote.stake_reserved });
  }

  // Dispute slash: the task already settled, so its reservation was released
  // at settlement. This variant never touches stakeReserved (a second release
  // would under-count what open quotes still hold).
  function slashForDispute(task) {
    const p = state.providers[task.quote.provider];
    return penalize(p, task.quote.price, 2, { taskId: task.id, reason: 'dispute_upheld' }, { releaseReserved: false });
  }

  // ---- task lifecycle -----------------------------------------------------

  function emit(task, event) {
    const entry = { ts: Date.now(), ...event };
    task.events.push(entry);
    for (const fn of subscribers.get(task.id) ?? []) fn(entry);
    persist(); // every transition is a snapshot change: a serverless live flush can publish it
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

  // Webhooks fire on TERMINAL states only: settled, refunded (including a
  // refund produced by an upheld dispute) and a cache-served settlement. The
  // intermediate transitions (dispatched, submitted, verifying, retrying,
  // disputed) are observable on the SSE stream, never pushed.
  async function notifyWebhook(task) {
    if (!task.webhook_url) return;
    try {
      await fetchWithTimeout(task.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(publicTask(task)),
      });
    } catch { /* webhooks are best-effort */ }
  }

  function terminalize(task, status, fields) {
    if (TERMINAL.has(task.status)) return false;
    clearTimer(task);
    task.status = status;
    Object.assign(task, fields);
    emit(task, { status, ...fields });
    track(notifyWebhook(task));
    persist();
    return true;
  }

  // Refund a failed task. `slash: false` is for failures that are not the
  // provider's fault (platform restart, buyer criteria that could not run):
  // escrow is made whole, the reservation is released, no penalty, no payout.
  function refundTask(task, reason, detail, { slash = true } = {}) {
    if (TERMINAL.has(task.status)) return false;
    const p = state.providers[task.quote.provider];
    // Release what this task holds, exactly once (a consensus task holds one
    // reservation per quoted provider).
    if (task.consensusQuotes) releaseConsensus(task);
    else if (p) p.stakeReserved = money(Math.max(0, p.stakeReserved - task.quote.stake_reserved));
    let slashed = null;
    let comp = null;
    if (slash && p) {
      const multiple = reason === 'provider_abandoned' ? 1.5 : reason === 'dispute_upheld' ? 2 : 1;
      // Compensation draws from the pool as it stands *before* this task's own
      // slash tops it up — a fresh pool has nothing to pay out yet.
      comp = payInsurance(task, reason);
      slashed = { provider: p.id, amount: penalize(p, task.quote.price, multiple, { taskId: task.id, reason }, { releaseReserved: false }) };
    }
    const refundTx = refundEscrow(task, reason);
    return terminalize(task, 'refunded', {
      refund: { reason, detail, tx: refundTx },
      slash: slashed,
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
    state.insurance.balance = money(state.insurance.balance - comp);
    const tx = creditAccount(task.keyId, comp, { kind: 'insurance', task: task.id });
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

  function settleTask(task, output, verdict, startedAt, extra = {}) {
    task.output = output;
    const settleTx = settleEscrow(task);
    const settlement = {
      provider: task.quote.provider,
      price: task.quote.price,
      verified_by: verdict.verified_by,
      elapsed_ms: Date.now() - startedAt,
      ...extra,
      escrow_tx: settleTx,
      settled_at: Date.now(),
    };
    // Portable proof-of-verified-work. Hashes are over canonical JSON so key
    // order never changes a digest.
    task.attestation = attestor.attest('settlement', {
      task_id: task.id,
      capability: task.capability,
      provider: task.quote.provider,
      price: task.quote.price,
      verified_by: verdict.verified_by,
      output_sha256: sha256(canonical(output)),
      input_sha256: sha256(canonical(task.input ?? {})),
      acceptance_sha256: sha256(canonical(task.acceptance ?? {})),
      ...(extra.consensus ? { consensus: extra.consensus.passed } : {}),
      settled_at: settlement.settled_at,
    });
    cachePut(task, verdict);
    terminalize(task, 'settled', { output, settlement, attestation: task.attestation });
  }

  async function runTask(task) {
    const startedAt = Date.now();
    task.attempts = task.attempts ?? [];
    // Deadline: with auto-retry the agent's deadline_ms caps the whole loop;
    // otherwise the single committed quote governs. The timer covers the
    // provider's delivery only; it is cleared the moment output arrives so
    // verification time (graders, webhooks) can never produce a deadline miss.
    const loopBudget = task.retry ? task.deadline_ms : null;
    const missed = () => {
      if (!TERMINAL.has(task.status)) {
        refundTask(task, 'deadline_missed', `no output within ${loopBudget ?? task.quote.deadline_ms} ms`);
      }
    };

    while (true) {
      let attemptMs = task.quote.deadline_ms;
      if (loopBudget != null) attemptMs = Math.min(attemptMs, loopBudget - (Date.now() - startedAt));
      if (attemptMs <= 0) return missed();
      armTimer(task, attemptMs + (cfg.fast ? 250 : 1000), missed);

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
        clearTimer(task); // delivered on time
        task.status = 'submitted';
        task.output = output; // visible from delivery on, so a live view can show the work before the verdict
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
          return settleTask(task, output, verdict, startedAt, { attempts: task.attempts.length + 1 });
        }
        if (verdict.failed.criteria_error) {
          // The buyer's own criteria could not run. Not the provider's fault:
          // refund without a slash.
          return refundTask(task, 'criteria_error', `${verdict.failed.validator}: ${verdict.failed.detail}`, { slash: false });
        }
        failure = { reason: 'verification_failed', detail: `${verdict.failed.validator}: ${verdict.failed.detail}` };
      }

      // Failure. Retry to a fresh provider if enabled and one is available;
      // otherwise refund + slash + insure.
      task.attempts.push({ provider: task.quote.provider, ...failure });
      const next = (task.retry && task.attempts.length < task.maxAttempts) ? pickRetryQuote(task) : null;
      if (next) {
        clearTimer(task);
        slashProvider(task, failure.reason === 'provider_abandoned' ? 1.5 : 1, failure.reason);
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
  // Every reservation a consensus task holds is released exactly once, on
  // whichever path ends the task (settle, all-fail, deadline, boot recovery).
  function releaseConsensus(task) {
    if (!task.consensusQuotes || task.consensusReleased) return;
    for (const q of task.consensusQuotes) {
      const p = state.providers[q.provider];
      if (p) p.stakeReserved = money(Math.max(0, p.stakeReserved - q.stake_reserved));
    }
    task.consensusReleased = true;
  }

  function consensusDeadline(task) {
    if (TERMINAL.has(task.status)) return;
    const delivered = new Set(task.consensusDelivered ?? []);
    releaseConsensus(task);
    // Only providers that never delivered are penalized; one that delivered
    // in time but was held up by a slow peer keeps its stake.
    const slashes = task.consensusQuotes
      .filter((q) => !delivered.has(q.provider))
      .map((q) => ({ provider: q.provider, amount: slashQuote(q, 1, { taskId: task.id, reason: 'deadline_missed' }, { release: false }) }));
    const refundTx = refundEscrow(task, 'deadline_missed');
    terminalize(task, 'refunded', {
      refund: { reason: 'deadline_missed', detail: `no verified output within ${task.deadline_ms} ms`, tx: refundTx },
      slash: slashes[0] ?? null,
      slashes,
      consensus: { dispatched: task.consensusQuotes.length, passed: 0, delivered: delivered.size },
    });
  }

  async function runConsensusTask(task) {
    const startedAt = Date.now();
    task.consensusDelivered = [];
    armTimer(task, task.deadline_ms + (cfg.fast ? 250 : 1000), () => consensusDeadline(task));

    const runs = await Promise.all(task.consensusQuotes.map(async (q) => {
      const probe = { ...task, quote: q };
      let output;
      try { output = await runExecutor(state.providers[q.provider], probe, cfg); }
      catch (e) { output = { error: e.message }; }
      if (output?.error) return { q, pass: false, reason: 'provider_abandoned', output };
      task.consensusDelivered.push(q.provider);
      // Once every provider has delivered, verification time is no longer the
      // providers' problem (same rule as the single-provider path).
      if (task.consensusDelivered.length === task.consensusQuotes.length) clearTimer(task);
      const verdict = await verify(probe, output, cfg);
      return { q, pass: verdict.pass, verdict, output, reason: verdict.pass ? null : 'verification_failed' };
    }));
    if (TERMINAL.has(task.status)) { releaseConsensus(task); return; }
    clearTimer(task);

    const passers = runs.filter((r) => r.pass).sort((a, b) => a.q.price - b.q.price || b.q.track - a.q.track);
    // Every reservation comes off here, once; penalties below do not release again.
    releaseConsensus(task);
    for (const l of runs.filter((r) => !r.pass)) {
      slashQuote(l.q, l.reason === 'provider_abandoned' ? 1.5 : 1, { taskId: task.id, reason: l.reason }, { release: false });
    }

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
    // Runner-up passers earn a small track bump (honest work, just not selected).
    for (const p of passers.slice(1)) {
      const pr = state.providers[p.q.provider];
      pr.track = clamp(pr.track + 0.1, 0, 100);
    }
    // The winner is paid through the normal settlement path, which releases
    // its own reservation; re-add it so that release nets to zero.
    const winner = state.providers[win.q.provider];
    winner.stakeReserved = money(winner.stakeReserved + win.q.stake_reserved);
    task.quote = win.q;
    settleTask(task, win.output, win.verdict, startedAt, { consensus: { dispatched: runs.length, passed: passers.length } });
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
    const taskId = id('tsk');
    const settledAt = Date.now();
    const attestation = attestor.attest('settlement', {
      task_id: taskId, capability: meta.capability, provider: 'cache', price,
      verified_by: hit.verified_by,
      output_sha256: sha256(canonical(hit.output)),
      input_sha256: sha256(canonical(meta.input ?? {})),
      acceptance_sha256: sha256(canonical(meta.acceptance ?? {})),
      cached: true, source_task_id: hit.task_id ?? null, source_key_id: hit.attestation?.key_id ?? null,
      settled_at: settledAt,
    });
    const task = {
      id: taskId, keyId: key.id, capability: meta.capability, input: meta.input, acceptance: meta.acceptance,
      budget: meta.budget, deadline_ms: meta.deadline_ms, status: 'settled', createdAt: settledAt, events: [],
      ...(meta.idempotency_key ? { idempotency_key: meta.idempotency_key } : {}),
      ...(meta.webhook_url ? { webhook_url: meta.webhook_url } : {}),
      cached: true, output: hit.output, attestation, source_attestation: hit.attestation ?? null,
      source_task_id: hit.task_id ?? null,
      settlement: {
        provider: 'cache', price, verified_by: hit.verified_by, cached: true,
        source_task_id: hit.task_id ?? null,
        source_attested_at: hit.attestation?.payload?.attested_at ?? null, settled_at: settledAt,
      },
    };
    hit.hits = (hit.hits ?? 0) + 1;
    state.tasks[task.id] = task;
    emit(task, { status: 'settled', cached: true });
    track(notifyWebhook(task)); // a cache hit is a terminal state
    persist();
    return publicTask(task);
  }

  function createTask(key, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'body must be a JSON object');
    const { capability, input, acceptance = {}, budget, deadline_ms, min_track, webhook_url, idempotency_key, retry, consensus, cache } = body;

    // A revoked key cannot act, even through a workflow created before revocation.
    if (key.revoked) throw new ApiError(403, 'account_revoked', 'This key has been revoked.');

    if (idempotency_key) {
      const existing = Object.values(state.tasks).find(
        (t) => t.keyId === key.id && t.idempotency_key === idempotency_key
      );
      if (existing) return { task: publicTask(existing), reused: true, ...(existing.cached ? { cached: true } : {}) };
    }

    if (!CAPABILITIES[capability]) {
      throw new ApiError(404, 'unknown_capability', `No capability "${capability}" in the catalog.`);
    }
    // Sub-agent / agentic-account policy.
    if (key.frozen) {
      throw new ApiError(403, 'account_frozen', 'This agentic account is frozen — unfreeze it to post tasks.');
    }
    // A capped sub-key may only touch its allowlisted capabilities.
    if (key.allow && !capabilityAllowed(key.allow, capability)) {
      throw new ApiError(403, 'capability_not_allowed', `This account may not post "${capability}".`, { allow: key.allow });
    }
    // Per-task spend cap: no single task may exceed the account's ceiling.
    if (key.perTaskCap != null && Number(budget) > key.perTaskCap) {
      throw new ApiError(403, 'per_task_cap_exceeded', `Task budget $${budget} exceeds this account's per-task cap of $${key.perTaskCap}.`, { per_task_cap: key.perTaskCap });
    }
    const inputCheck = validateInput(capability, input ?? {});
    if (!inputCheck.ok) throw new ApiError(400, 'invalid_input', inputCheck.detail);
    const acceptCheck = validateAcceptance(acceptance, cfg);
    if (!acceptCheck.ok) throw new ApiError(400, 'invalid_acceptance', acceptCheck.detail);
    if (!(typeof budget === 'number' && Number.isFinite(budget) && budget > 0)) throw new ApiError(400, 'invalid_input', 'budget must be a positive USDC amount');
    if (!Number.isInteger(deadline_ms) || deadline_ms <= 0) {
      throw new ApiError(400, 'invalid_input', 'deadline_ms must be a positive integer');
    }
    if (min_track !== undefined && !(typeof min_track === 'number' && Number.isFinite(min_track))) {
      throw new ApiError(400, 'invalid_input', 'min_track must be a number');
    }
    if (webhook_url !== undefined && webhook_url !== null) {
      assertPublicUrl(webhook_url, 'webhook_url', { allowPrivate: !!cfg.allowPrivateWebhooks });
    }

    // Semantic cache: an identical, already-verified task can be served
    // instantly from cache at a fraction of the price. Opt-in via cache:true.
    if (cache === true) {
      const hit = state.cache[cacheKey(capability, input ?? {}, acceptance)];
      if (hit) {
        const served = serveFromCache(key, { capability, input, acceptance, budget, deadline_ms, idempotency_key, webhook_url }, hit);
        if (served) return { task: served, reused: false, cached: true };
      }
    }

    // Auto-retry: on failure, reroute to the next-best provider (within the
    // committed escrow) until the output verifies or attempts run out. Opt-in:
    // retry:true, or retry:{ max_attempts:N } (1 means a single attempt).
    const retryOn = retry === true || (retry && typeof retry === 'object');
    const maxAttempts = retryOn
      ? Math.max(1, Math.min(cfg.maxAttempts, Number(retry?.max_attempts) || cfg.maxAttempts))
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

    // Retry and consensus both lock the full budget for headroom (a reroute may
    // land on a pricier-but-better provider; only the winner is paid and the
    // surplus returns on settlement). A plain task locks exactly the winning quote.
    const acct = state.accounts[key.id];
    const lockAmount = (retryOn || consensusN > 1) ? money(budget) : winner.price;
    if (acct.balance < lockAmount) {
      throw new ApiError(402, 'escrow_insufficient', 'Balance below the escrow required for this task. Top up or lower the budget.', {
        required: lockAmount, balance: acct.balance,
      });
    }
    const ceiling = ceilingAccount(key.id);
    if (ceiling.lockedToday + lockAmount > cfg.dailyCeiling[key.tier]) {
      throw new ApiError(402, 'escrow_insufficient', 'Daily escrow ceiling reached for this key.', {
        ceiling: cfg.dailyCeiling[key.tier], locked_today: ceiling.lockedToday, resets_at: (utcDay() + 1) * DAY_MS,
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
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 30;
    return Object.values(state.tasks)
      .filter((t) => t.keyId === key.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, n)
      .map((t) => ({
        ...publicTask(t),
        // Convenience fields for list views (the nested objects stay as they are).
        provider: t.settlement?.provider ?? t.quote?.provider ?? null,
        verified_by: t.settlement?.verified_by ?? null,
      }));
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
  // Cooldowns and delays shrink in fast mode so the full lifecycle is testable.
  const agentDelay = (ms) => (cfg.fast ? Math.min(ms, 100) : ms);

  const publicPendingSlash = (ps) => ({
    id: ps.id, agent_id: ps.agent_id, task_id: ps.task_id, reason: ps.reason,
    price_usdg: ps.price_usdg, multiple: ps.multiple, amount_usdg: ps.amount_usdg, token_qty: ps.token_qty,
    capped: ps.capped, queued_at: ps.queued_at, execute_after: ps.execute_after, status: ps.status,
    executed_at: ps.executed_at ?? null,
  });
  const pendingFor = (agentId) => state.launchpad.pending_slashes.filter((s) => s.agent_id === agentId && s.status === 'pending');

  function publicAgent(a) {
    const raw = agentRawBond(a);
    const pending = pendingFor(a.id);
    return {
      id: a.id, owner: a.owner, owner_key_id: a.ownerKeyId ?? null, name: a.name ?? null, created_at: a.createdAt,
      token: { symbol: a.token.symbol, address: a.token.address, twap_usdg: a.token.twapUsdg, pool_liquidity_usdg: a.token.poolLiquidityUsdg },
      bond: { token_qty: a.bond.tokenQty, raw_value_usdg: raw, haircut_value_usdg: money(raw * a.params.bondHaircut), capacity_usdg: bondCapacity(raw, a.params) },
      operating_usdg: state.accounts[a.id]?.balance ?? 0,
      provider_id: a.providerId,
      unbonding: a.unbonding ? { token_qty: a.unbonding.tokenQty, requested_at: a.unbonding.requestedAt, release_at: a.unbonding.releaseAt } : null,
      pending_slash_usdg: money(pending.reduce((s, p) => s + p.amount_usdg, 0)),
      pending_slashes: pending.map(publicPendingSlash),
      totals: {
        creator_paid: a.creatorPaid, owner_paid: a.ownerPaid, buyback: a.buyback,
        burned: a.burned, treasury_paid: a.treasuryPaid, bond_topped_up: a.bondToppedUp,
        slashed_usdg: a.slashedUsdg ?? 0, settled_count: a.settledCount ?? 0,
        distinct_counterparties: Object.keys(a.counterparties ?? {}).length,
      },
      params: a.params,
      chain: a.chain ? publicChain(a.chain) : null,
    };
  }
  function publicChain(c) {
    const { intent, ...rest } = c;
    return { ...rest, intent: intent ? { chain_id: intent.chain_id, network: intent.network, to: intent.to, data: intent.data, value_wei: intent.value_wei, value_note: intent.value_note, launch_fee_selector: intent.launch_fee_selector, params: intent.params, explorer: intent.explorer } : null };
  }

  function mustAgent(agentId) {
    const agent = state.agents[agentId];
    if (!agent) throw new ApiError(404, 'not_found', `No agent ${agentId}.`);
    return agent;
  }
  // Owner-only writes. `actor` is { key, admin } from the API layer; internal
  // callers pass nothing and are trusted. Agents launched before ownership was
  // recorded have no owner key, so only an admin may act on them.
  function assertAgentActor(agent, actor) {
    if (actor === undefined) return;
    if (actor?.admin) return;
    if (agent.ownerKeyId && actor?.key && actor.key.id === agent.ownerKeyId) return;
    throw new ApiError(403, 'not_owner', 'Only the key that launched this agent (or an admin) may do that.', { owner_key_id: agent.ownerKeyId ?? null });
  }

  // One transaction: create the agent, snapshot its (immutable, platform-set)
  // params, and optionally register its provider endpoint. Cannot quote until
  // it has an endpoint and bond capacity. Risk params in the request body are
  // ignored: they come from launchpad-config only.
  function launchAgent(body = {}, ownerKey = null) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'body must be a JSON object');
    const params = snapshotParams();
    const agentId = id('agt');
    // Register the endpoint first: a validation failure must leave no orphan account.
    let prov = null;
    if (body.endpoint_url || body.offers) {
      prov = registerProvider({ name: body.name ?? `agent ${agentId}`, endpoint_url: body.endpoint_url, offers: body.offers, stake: 0, protocol: body.protocol });
    }
    const agent = {
      id: agentId, owner: body.owner ?? ownerKey?.owner ?? 'owner', ownerKeyId: ownerKey?.id ?? null,
      name: typeof body.name === 'string' ? body.name : null, createdAt: Date.now(),
      token: {
        symbol: typeof body.symbol === 'string' && body.symbol ? body.symbol.slice(0, 12) : params.platformToken.symbol,
        address: body.token_address ?? null,
        twapUsdg: Number(body.twap_usdg) > 0 ? Number(body.twap_usdg) : 1,
        poolLiquidityUsdg: Math.max(0, Number(body.pool_liquidity_usdg) || 0),
      },
      bond: { tokenQty: Math.max(0, Number(body.initial_bond_tokens) || 0) },
      providerId: null, params,
      creatorPaid: 0, ownerPaid: 0, buyback: 0, burned: 0, treasuryPaid: 0, bondToppedUp: 0,
      ledger: [], unbonding: null,
    };
    // A real launch on Pons: prepare the transaction for the launcher's wallet.
    // The token has no price until the launch is confirmed on-chain.
    if (body.launch && typeof body.launch === 'object') {
      if (body.launch.venue && body.launch.venue !== 'pons') throw new ApiError(400, 'invalid_input', 'launch.venue must be "pons"');
      let intent;
      try {
        intent = buildLaunchIntent({ ...body.launch, agent_id: agentId, symbol: agent.token.symbol, name: agent.name ?? body.launch.name, description: body.launch.description ?? body.description, logo: body.launch.logo ?? body.logo }, cfg.chain);
      } catch (e) { throw new ApiError(400, e.code === 'invalid_input' ? 'invalid_input' : 'launch_error', e.message); }
      agent.token.twapUsdg = 0; agent.token.poolLiquidityUsdg = 0;
      agent.chain = { venue: 'pons', network: cfg.chain.network, chain_id: cfg.chain.chainId, status: 'awaiting_signature', created_at: Date.now(), intent, wallet: body.launch.wallet };
    }
    if (prov) { prov.agentId = agentId; agent.providerId = prov.id; }
    state.accounts[agentId] = newAccount(0, []);
    state.agents[agentId] = agent;
    syncAgentCapacity(agent);
    persist();
    return publicAgent(agent);
  }

  // The launcher's wallet sent the transaction: verify the receipt, record
  // the token and curve, start pricing from the curve. Owner-only.
  async function confirmLaunch(agentId, txHash, actor) {
    const agent = mustAgent(agentId);
    assertAgentActor(agent, actor);
    if (!agent.chain) throw new ApiError(409, 'not_a_chain_launch', 'This agent was not launched on-chain.');
    if (agent.chain.status === 'live') return publicAgent(agent);
    const rpc = createRpc(cfg.chain.rpc);
    let launch;
    try { launch = await verifyLaunch(rpc, txHash, cfg.chain); }
    catch (e) { throw new ApiError(e.code === 'invalid_input' ? 400 : e.code ? 409 : 502, e.code ?? 'chain_unreachable', e.message); }
    if (!launch) { agent.chain.status = 'pending'; agent.chain.tx_hash = txHash; persist(); return { ...publicAgent(agent), pending: true }; }
    if (agent.chain.wallet && launch.deployer.toLowerCase() !== agent.chain.wallet.toLowerCase()) {
      throw new ApiError(409, 'wrong_wallet', 'The launch was sent from a different wallet than the one this agent was prepared for.', { expected: agent.chain.wallet, deployer: launch.deployer });
    }
    const pair = pairFor(cfg.chain, launch.pair_token);
    agent.chain = { ...agent.chain, status: 'live', tx_hash: txHash, confirmed_at: Date.now(), ...launch, pair: pair.symbol, creator_fee_recipient: agent.chain.intent?.params?.creator_fee_recipient ?? null };
    agent.token.address = launch.token;
    persist();
    await refreshAgentChain(agentId, { force: true });
    return publicAgent(agent);
  }

  // Re-read price, liquidity and creator fees from the curve; swallow RPC
  // failures (the last good reading stays, with the error noted).
  async function refreshAgentChain(agentId, { force = false } = {}) {
    const agent = state.agents[agentId];
    if (!agent?.chain || agent.chain.status !== 'live') return null;
    if (!force && agent.chain.refreshed_at && Date.now() - agent.chain.refreshed_at < cfg.chainRefreshMs) return agent.chain.curve_state ?? null;
    const rpc = createRpc(cfg.chain.rpc);
    const pair = pairFor(cfg.chain, agent.chain.pair_token);
    try {
      const curve = await readCurve(rpc, agent.chain.curve, pair);
      let fees = null;
      try { if (agent.chain.creator_fee_recipient) fees = await readCreatorFees(rpc, cfg.chain.factory, agent.chain.creator_fee_recipient, pair); } catch { /* optional */ }
      const usd = pair.symbol === 'USDG' ? 1 : (pair.symbol === 'ETH' && cfg.chain.ethUsd) ? cfg.chain.ethUsd : null;
      agent.chain.curve_state = curve;          // `curve` stays the curve contract's address
      agent.chain.creator_fees = fees;
      // curve tokens are priced in millionths of a cent: keep significant digits, not 6 decimals
      agent.chain.price_usd = usd != null ? Number((curve.price_quote * usd).toPrecision(12)) : null;
      agent.chain.liquidity_usd = usd != null ? money(curve.real_quote_reserve * usd) : null;
      agent.chain.refreshed_at = Date.now();
      agent.chain.error = null;
      // the sandbox bond is valued from the real curve from now on
      agent.token.twapUsdg = agent.chain.price_usd ?? 0;
      agent.token.poolLiquidityUsdg = agent.chain.liquidity_usd ?? 0;
      syncAgentCapacity(agent);
      persist();
    } catch (e) {
      agent.chain.error = String(e.message).slice(0, 200);
      agent.chain.refreshed_at = Date.now();
      persist();
    }
    return agent.chain.curve_state ?? null;
  }
  async function refreshStaleChains() {
    const live = Object.values(state.agents).filter((a) => a.chain?.status === 'live' && (!a.chain.refreshed_at || Date.now() - a.chain.refreshed_at >= cfg.chainRefreshMs));
    await Promise.allSettled(live.slice(0, 10).map((a) => refreshAgentChain(a.id)));
  }

  // Harvest `feeAmount` of pool fees and split per the agent's snapshot — bond
  // staked, operating credited (spend-only USDG), creator and treasury paid.
  function harvestFees(agentId, feeAmount, actor) {
    const agent = mustAgent(agentId);
    assertAgentActor(agent, actor);
    const amt = Number(feeAmount);
    if (!(amt > 0) || !Number.isFinite(amt)) throw new ApiError(400, 'invalid_input', 'feeAmount must be positive');
    if (!(agent.token.twapUsdg > 0)) throw new ApiError(400, 'invalid_input', 'the token has no price (TWAP is 0); the bond share cannot be staked');
    const s = splitFees(amt, agent.params);
    agent.bond.tokenQty = money(agent.bond.tokenQty + s.bond / agent.token.twapUsdg);
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
  function routeAgentRevenue(agent, settledPrice, taskId = null) {
    const f = protocolFeeSplit(settledPrice, agent.params);
    state.treasury.balance = money(state.treasury.balance + f.treasury);
    state.treasury.burned = money(state.treasury.burned + f.burn);
    agent.burned = money(agent.burned + f.burn);
    agent.treasuryPaid = money(agent.treasuryPaid + f.treasury);
    const net = netPayoutSplit(f.net, agent.params);
    agent.ownerPaid = money(agent.ownerPaid + net.owner);
    agent.buyback = money(agent.buyback + net.buyback);
    state.treasury.buyback = money(state.treasury.buyback + net.buyback);
    const twap = agent.token.twapUsdg;
    const bondTokens = twap > 0 ? money(net.bond / twap) : 0;
    agent.bond.tokenQty = money(agent.bond.tokenQty + bondTokens);
    agent.bondToppedUp = money(agent.bondToppedUp + net.bond);
    agent.ledger.push({ ts: Date.now(), kind: 'revenue', taskId, price: f.price, fee: f.fee, burn: f.burn, treasury: f.treasury, net: f.net, ...net, bondTokens, twap });
    syncAgentCapacity(agent);
  }

  // An upheld dispute unwinds the revenue a settled task routed: owner,
  // buyback, bond top-up, burn and treasury all come back off the books.
  function reverseAgentRevenue(agent, task) {
    const rev = agent.ledger.find((e) => e.kind === 'revenue' && e.taskId === task.id && !e.reversed);
    if (!rev) return null;
    rev.reversed = true;
    agent.ownerPaid = money(agent.ownerPaid - rev.owner);
    agent.buyback = money(agent.buyback - rev.buyback);
    agent.bondToppedUp = money(agent.bondToppedUp - rev.bond);
    agent.bond.tokenQty = money(Math.max(0, agent.bond.tokenQty - (rev.bondTokens ?? 0)));
    agent.burned = money(agent.burned - rev.burn);
    agent.treasuryPaid = money(agent.treasuryPaid - rev.treasury);
    state.treasury.balance = money(state.treasury.balance - rev.treasury);
    state.treasury.burned = money(state.treasury.burned - rev.burn);
    state.treasury.buyback = money(state.treasury.buyback - rev.buyback);
    agent.ledger.push({ ts: Date.now(), kind: 'revenue_reversed', taskId: task.id, price: rev.price, owner: rev.owner, buyback: rev.buyback, bond: rev.bond, burn: rev.burn, treasury: rev.treasury });
    syncAgentCapacity(agent);
    return rev;
  }

  // Queue a slash of a launched agent's token bond for a bad outcome. Sized in
  // USDG off the FULL bond at TWAP (unbonding tokens included, no liquidity
  // floor), taken in platform token, and double-capped: a single verdict can
  // never exceed maxSlashMultiple x price, and no more than rollingSlashCap of
  // bond value can be slashed within a rolling window. Funds move only after
  // pendingSlashMs (instantly in fast mode) and never while the guardian has
  // paused. Returns the USDG value queued.
  function queueAgentSlash(agent, priceUsdg, multiple, meta = {}) {
    const now = Date.now();
    const windowMs = agent.params.rollingSlashWindowMs;
    agent.slashWindow = (agent.slashWindow ?? []).filter((e) => now - e.ts < windowMs);
    const slashedInWindowUsdg = money(agent.slashWindow.reduce((a, e) => a + e.amountUsdg, 0));
    const plan = slashPlan({
      priceUsdg, multiple,
      twapUsdg: agent.token.twapUsdg,
      bondRawValueUsdg: slashBase({ tokenQty: agent.bond.tokenQty, twapUsdg: agent.token.twapUsdg }),
      slashedInWindowUsdg,
    }, agent.params);
    agent.slashWindow.push({ ts: now, amountUsdg: plan.amountUsdg });
    const delay = cfg.fast ? 0 : agent.params.pendingSlashMs; // fast mode: funds move at once (unless paused)
    const ps = {
      id: id('slh'), agent_id: agent.id, provider_id: agent.providerId, task_id: meta.taskId ?? null, reason: meta.reason ?? null,
      price_usdg: priceUsdg, multiple, amount_usdg: plan.amountUsdg, token_qty: plan.tokenQty, capped: plan.capped,
      queued_at: now, execute_after: now + delay, status: 'pending',
    };
    state.launchpad.pending_slashes.push(ps);
    agent.ledger.push({ ts: now, kind: 'slash_queued', slash_id: ps.id, price: priceUsdg, multiple, ...plan, execute_after: ps.execute_after });
    if (delay > 0) {
      const t = setTimeout(() => { if (processPendingSlashes() > 0) persist(); }, delay);
      t.unref?.();
    }
    processPendingSlashes(); // applies now in fast mode (unless the guardian paused)
    return plan.amountUsdg;
  }

  function executePendingSlash(ps) {
    const agent = state.agents[ps.agent_id];
    if (!agent) { ps.status = 'void'; return; }
    const qty = Math.min(ps.token_qty, agent.bond.tokenQty);
    agent.bond.tokenQty = money(agent.bond.tokenQty - qty);
    // The slash eats into an unbonding request first: nothing in flight escapes it.
    if (agent.unbonding && agent.unbonding.tokenQty > agent.bond.tokenQty) agent.unbonding.tokenQty = agent.bond.tokenQty;
    agent.slashedUsdg = money((agent.slashedUsdg ?? 0) + ps.amount_usdg);
    state.insurance.balance = money(state.insurance.balance + ps.amount_usdg);
    state.insurance.funded = money(state.insurance.funded + ps.amount_usdg);
    ps.status = 'executed';
    ps.executed_at = Date.now();
    agent.ledger.push({ ts: ps.executed_at, kind: 'slash', slash_id: ps.id, price: ps.price_usdg, multiple: ps.multiple, amountUsdg: ps.amount_usdg, tokenQty: qty, capped: ps.capped });
    syncAgentCapacity(agent);
  }

  // Execute every due pending slash. Called on queue, on unpause, on boot and
  // lazily from the launchpad reads so serverless deployments (no timers) make
  // progress too. Returns how many executed.
  function processPendingSlashes() {
    if (state.launchpad.paused) return 0;
    const now = Date.now();
    let n = 0;
    for (const ps of state.launchpad.pending_slashes) {
      if (ps.status === 'pending' && ps.execute_after <= now) { executePendingSlash(ps); n++; }
    }
    const list = state.launchpad.pending_slashes;
    if (list.length > 500) {
      const keep = list.filter((s) => s.status === 'pending');
      const done = list.filter((s) => s.status !== 'pending').slice(-200);
      state.launchpad.pending_slashes = [...done, ...keep];
    }
    return n;
  }

  // Guardian: pause freezes slash execution (queued slashes wait); unpause
  // releases everything that is due.
  function guardianStatus() {
    const pending = state.launchpad.pending_slashes.filter((s) => s.status === 'pending');
    return {
      paused: !!state.launchpad.paused,
      pending_slashes: pending.length,
      pending_slash_usdg: money(pending.reduce((s, p) => s + p.amount_usdg, 0)),
      queue: pending.map(publicPendingSlash),
    };
  }
  function setGuardian({ paused } = {}) {
    if (typeof paused !== 'boolean') throw new ApiError(400, 'invalid_input', 'paused must be true or false');
    state.launchpad.paused = paused;
    if (!paused) processPendingSlashes();
    persist();
    return guardianStatus();
  }

  // Owner requests unbonding; the amount can't back new quotes and stays
  // slashable until the cooldown passes. A second request adds to the first
  // and restarts the cooldown for the combined amount. Public event.
  function requestUnbond(agentId, tokenQty, actor) {
    const agent = mustAgent(agentId);
    assertAgentActor(agent, actor);
    const add = Number(tokenQty) || 0;
    if (!(add > 0)) throw new ApiError(400, 'invalid_input', 'tokenQty must be positive');
    const qty = Math.min(money((agent.unbonding?.tokenQty ?? 0) + add), agent.bond.tokenQty);
    if (!(qty > 0)) throw new ApiError(409, 'nothing_to_unbond', 'The bond holds no tokens.');
    const now = Date.now();
    agent.unbonding = { tokenQty: qty, requestedAt: now, releaseAt: now + agentDelay(agent.params.unbondingCooldownMs) };
    agent.ledger.push({ ts: now, kind: 'unbond_request', tokenQty: qty, release_at: agent.unbonding.releaseAt });
    syncAgentCapacity(agent);
    persist();
    return publicAgent(agent);
  }

  // After the cooldown the owner withdraws the unbonded tokens. The amount is
  // whatever survived slashing in the meantime.
  function withdrawUnbonded(agentId, actor) {
    const agent = mustAgent(agentId);
    assertAgentActor(agent, actor);
    if (!agent.unbonding) throw new ApiError(409, 'nothing_unbonding', 'No unbonding request is open for this agent.');
    if (Date.now() < agent.unbonding.releaseAt) {
      throw new ApiError(409, 'unbond_cooldown', 'The unbonding cooldown has not passed yet.', { release_at: agent.unbonding.releaseAt });
    }
    processPendingSlashes();
    const qty = money(Math.min(agent.unbonding.tokenQty, agent.bond.tokenQty));
    agent.bond.tokenQty = money(agent.bond.tokenQty - qty);
    agent.unbonding = null;
    agent.withdrawnTokens = money((agent.withdrawnTokens ?? 0) + qty);
    agent.ledger.push({ ts: Date.now(), kind: 'unbond_withdraw', tokenQty: qty });
    syncAgentCapacity(agent);
    persist();
    return { ...publicAgent(agent), withdrawn_token_qty: qty };
  }

  // Sandbox price feed: move an agent token's TWAP / liquidity. A price drop
  // shrinks capacity (no liquidation); open tasks continue.
  function setAgentPrice(agentId, { twap_usdg, pool_liquidity_usdg } = {}, actor) {
    const agent = mustAgent(agentId);
    assertAgentActor(agent, actor);
    if (agent.chain?.status === 'live') throw new ApiError(409, 'chain_priced', 'This token is priced from its on-chain curve; the sandbox price feed is disabled for it.');
    if (twap_usdg !== undefined) agent.token.twapUsdg = Math.max(0, Number(twap_usdg) || 0);
    if (pool_liquidity_usdg !== undefined) agent.token.poolLiquidityUsdg = Math.max(0, Number(pool_liquidity_usdg) || 0);
    syncAgentCapacity(agent);
    persist();
    return publicAgent(agent);
  }

  function getAgent(agentId) {
    const a = mustAgent(agentId);
    if (processPendingSlashes() > 0) persist();
    return publicAgent(a);
  }
  function listAgents() {
    if (processPendingSlashes() > 0) persist();
    return Object.values(state.agents).map(publicAgent);
  }

  // ---- disputes -----------------------------------------------------------

  function publicDispute(d) {
    const { keyId, ...rest } = d;
    return rest;
  }

  async function resolveDispute(dispute, task) {
    if (dispute.status !== 'reviewing') return;
    // Independent re-review. The deterministic validators the buyer declared
    // (schema, checks, webhook, and the rubric panel when one exists) run
    // again with the disputant's reason and evidence attached; a rubric task
    // additionally faces a fresh panel (disjoint seeds), one notch stricter.
    // Without a rubric only the deterministic checks decide: the offline
    // heuristic has no business judging a {"result": 2}.
    const context = { dispute: { reason: dispute.reason, evidence: dispute.evidence } };
    const recheck = await verify(task, task.output, cfg, context);
    let panel = { pass: true };
    if (task.acceptance?.rubric) panel = await gradeRubric(task, task.output, task.acceptance.rubric, cfg, 1, context);
    const upheld = !recheck.pass || !panel.pass;
    dispute.review = {
      recheck: recheck.pass, ...(recheck.failed ? { failed: recheck.failed } : {}),
      ...(task.acceptance?.rubric ? { panel: panel.pass, panel_votes: panel.passes } : {}),
      evidence_considered: !!(dispute.evidence && Object.keys(dispute.evidence).length),
    };

    const p = state.providers[task.quote.provider];
    if (upheld) {
      dispute.status = 'upheld';
      const slashed = slashForDispute(task);
      // The payment was clawed off the provider's earnings when the dispute
      // opened; it now returns to the buyer. refund.tx is the history tx.
      const tx = creditAccount(task.keyId, task.quote.price, { kind: 'clawback_refund', task: task.id });
      const agent = p.agentId ? state.agents[p.agentId] : null;
      if (agent) reverseAgentRevenue(agent, task);
      const evicted = cacheEvict(task); // nobody is served a disputed output from cache
      task.status = 'refunded';
      task.refund = { reason: 'dispute_upheld', detail: dispute.reason, tx };
      task.slash = { provider: p.id, amount: slashed };
      task.dispute = { id: dispute.id, outcome: 'upheld', cache_evicted: evicted };
      emit(task, { status: 'refunded', refund: task.refund, slash: task.slash, dispute: task.dispute });
    } else {
      dispute.status = 'rejected';
      p.earnings = money(p.earnings + task.quote.price); // clawed funds release back
      task.status = 'settled';
      task.dispute = { id: dispute.id, outcome: 'rejected' };
      emit(task, { status: 'settled', dispute: task.dispute });
    }
    dispute.resolvedAt = Date.now();
    persist();
    track(notifyWebhook(task)); // terminal state reached again
  }

  function openDispute(key, taskId, body) {
    const task = state.tasks[taskId];
    if (!task || task.keyId !== key.id) throw new ApiError(404, 'not_found', `No task ${taskId}.`);
    if (task.cached) {
      throw new ApiError(409, 'not_disputable', 'A cache-served task cannot be disputed; it reused an output that already passed verification.', {
        source_task_id: task.source_task_id ?? null,
      });
    }
    const prior = Object.values(state.disputes).find((d) => d.taskId === taskId);
    if (prior) {
      throw new ApiError(409, 'not_disputable', `Task ${taskId} has already been disputed (${prior.status}).`, {
        dispute_id: prior.id, outcome: prior.status,
      });
    }
    if (task.status !== 'settled') {
      throw new ApiError(409, 'not_disputable', `Only settled tasks can be disputed; task is ${task.status}.`);
    }
    if (Date.now() - task.settlement.settled_at > cfg.disputeWindowMs) {
      throw new ApiError(410, 'dispute_window_closed', 'Disputes close 24 h after settlement.');
    }
    if (!body || typeof body !== 'object') throw new ApiError(400, 'invalid_input', 'body must be a JSON object');
    if (!body.reason || typeof body.reason !== 'string') throw new ApiError(400, 'invalid_input', 'a dispute requires a reason');
    if (body.evidence !== undefined && body.evidence !== null && (typeof body.evidence !== 'object' || Array.isArray(body.evidence))) {
      throw new ApiError(400, 'invalid_input', 'evidence must be an object');
    }

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
    persist();

    track(sleep(cfg.fast ? 50 : 1500).then(() => resolveDispute(dispute, task)));
    return publicDispute(dispute);
  }

  function getDispute(key, disputeId) {
    const d = state.disputes[disputeId];
    if (!d || d.keyId !== key.id) throw new ApiError(404, 'not_found', `No dispute ${disputeId}.`);
    return publicDispute(d);
  }

  // ---- provider registration ---------------------------------------------

  function registerProvider(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'body must be a JSON object');
    const { name, endpoint_url, offers: offered, stake, protocol = 'http' } = body;
    if (!name || typeof name !== 'string') {
      throw new ApiError(400, 'invalid_input', 'name is required');
    }
    if (!/^https?:\/\//.test(endpoint_url ?? '')) {
      throw new ApiError(400, 'invalid_input', 'endpoint_url must be an http(s) URL your provider serves');
    }
    if (!['http', 'x402'].includes(protocol)) {
      throw new ApiError(400, 'invalid_input', 'protocol must be "http" or "x402"');
    }
    if (!offered || typeof offered !== 'object' || Array.isArray(offered) || !Object.keys(offered).length) {
      throw new ApiError(400, 'invalid_input', 'offers must map at least one capability to { price_ceiling, sla_deadline_ms }');
    }
    for (const [cap, o] of Object.entries(offered)) {
      if (!CAPABILITIES[cap]) throw new ApiError(404, 'unknown_capability', `No capability "${cap}" in the catalog.`);
      if (!(typeof o?.price_ceiling === 'number' && o.price_ceiling > 0 && Number.isFinite(o.price_ceiling))) {
        throw new ApiError(400, 'invalid_input', `offers.${cap}.price_ceiling must be a positive USDC amount`);
      }
      if (!Number.isInteger(o?.sla_deadline_ms) || o.sla_deadline_ms <= 0) {
        throw new ApiError(400, 'invalid_input', `offers.${cap}.sla_deadline_ms must be a positive integer`);
      }
    }
    // Simulated bond, capped like the escrow faucet. Omitted → the $1 minimum;
    // present but not a non-negative number → 400. On-chain staking replaces this.
    let bonded = 1;
    if (stake !== undefined && stake !== null) {
      if (typeof stake !== 'number' || !Number.isFinite(stake) || stake < 0) {
        throw new ApiError(400, 'invalid_input', 'stake must be a non-negative USDC amount');
      }
      bonded = Math.min(Math.max(stake, 1), 1000);
    }
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
  // endpoint_url is operational detail: it is returned to the registrant and
  // to admins, not in the public listing.
  function publicProvider(p, { admin = false } = {}) {
    const reliability = p.settledCount + p.slashedCount > 0
      ? money(p.settledCount / (p.settledCount + p.slashedCount)) : null;
    return {
      id: p.id, name: p.name, ...(admin ? { endpoint_url: p.endpoint_url } : {}), protocol: p.protocol ?? 'native',
      track: Math.round(p.track), stake: p.stake, stake_available: money(p.stake - p.stakeReserved),
      earnings: p.earnings, settled: p.settledCount, slashed: p.slashedCount,
      reliability, capabilities: Object.keys(p.offers), offers: p.offers,
      ...(p.agentId ? { agent_id: p.agentId } : {}),
    };
  }
  function listProviders(opts = {}) {
    return Object.values(state.providers)
      .map((p) => publicProvider(p, opts))
      .sort((a, b) => b.track - a.track || b.stake - a.stake);
  }
  function getProvider(providerId, opts = {}) {
    const p = state.providers[providerId];
    if (!p) throw new ApiError(404, 'not_found', `No provider ${providerId}.`);
    return publicProvider(p, opts);
  }

  function insuranceStats() {
    return {
      pool_balance: state.insurance.balance,
      total_funded: state.insurance.funded,
      balance: state.insurance.balance,     // alias
      funded: state.insurance.funded,       // alias
      claims_paid: state.insurance.claims.length,
      recent_claims: state.insurance.claims.slice(-10),
    };
  }

  // The public key that signed a receipt, looked up by its key_id: a receipt
  // signed before a key rotation still verifies against the key that made it.
  function publicKeyFor(keyId) {
    return state.attest.public_keys?.[keyId] ?? null;
  }
  function getAttestation(key, taskId) {
    const task = state.tasks[taskId];
    if (!task || task.keyId !== key.id) throw new ApiError(404, 'not_found', `No task ${taskId}.`);
    if (!task.attestation) throw new ApiError(409, 'not_attestable', `Task ${taskId} has no attestation (status ${task.status}).`);
    const pub = publicKeyFor(task.attestation.key_id) ?? attestor.publicKeyPem;
    return {
      attestation: task.attestation, public_key: pub, key_id: task.attestation.key_id,
      current_key_id: attestor.keyId,
      ...(task.source_attestation ? { source_attestation: task.source_attestation } : {}),
    };
  }
  function attestorKey(keyId) {
    const keys = Object.entries(state.attest.public_keys ?? {}).map(([key_id, public_key]) => ({ key_id, public_key }));
    if (keyId) {
      const pub = publicKeyFor(keyId);
      if (!pub) throw new ApiError(404, 'not_found', `No attestation key ${keyId}.`);
      return { alg: 'ed25519', key_id: keyId, public_key: pub, current: keyId === attestor.keyId, keys };
    }
    return { alg: 'ed25519', key_id: attestor.keyId, public_key: attestor.publicKeyPem, keys };
  }

  // ---- verification-as-a-service ------------------------------------------
  // Verify an output the caller already has (from any source) and hand back a
  // signed attestation — no escrow, no execution, no provider.
  async function verifyOutput(key, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'body must be a JSON object');
    const { capability, input = {}, output, acceptance = {} } = body;
    if (!CAPABILITIES[capability]) throw new ApiError(404, 'unknown_capability', `No capability "${capability}" in the catalog.`);
    if (output === undefined || output === null) throw new ApiError(400, 'invalid_input', 'output is required');
    const acceptCheck = validateAcceptance(acceptance, cfg);
    if (!acceptCheck.ok) throw new ApiError(400, 'invalid_acceptance', acceptCheck.detail);

    const synthetic = { id: id('vrf'), capability, input, acceptance };
    const verdict = await verify(synthetic, output, cfg);
    const attestation = verdict.pass
      ? attestor.attest('verification', {
          capability, verified_by: verdict.verified_by,
          output_sha256: sha256(canonical(output)),
          input_sha256: sha256(canonical(input ?? {})),
          acceptance_sha256: sha256(canonical(acceptance ?? {})),
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
  // at the first step that doesn't settle. The step bodies are kept on the
  // workflow (spec) so a chain cut off by a restart can resume.
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
    const { keyId, spec, ...rest } = wf;
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
  async function runWorkflow(wf, key, steps, startIndex = 0, ctx = { steps: [] }) {
    for (let i = startIndex; i < steps.length; i++) {
      let created;
      try {
        created = createTask(key, resolveRefs(steps[i], ctx));
      } catch (e) {
        wf.status = 'failed';
        wf.failure = { step: i, error: e.message, code: e.code ?? null };
        persist();
        return;
      }
      wf.steps.push({ index: i, taskId: created.task.id, status: created.task.status });
      persist();
      const done = await whenSettled(created.task.id);
      const entry = wf.steps[wf.steps.length - 1];
      entry.status = done?.status ?? 'unknown';
      ctx.steps[i] = { output: done?.output ?? null, status: done?.status };
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'body must be a JSON object');
    if (key.revoked) throw new ApiError(403, 'account_revoked', 'This key has been revoked.');
    const steps = body.steps;
    if (!Array.isArray(steps) || !steps.length) {
      throw new ApiError(400, 'invalid_input', 'steps must be a non-empty array of task bodies');
    }
    if (steps.length > 12) throw new ApiError(400, 'invalid_input', 'a workflow is capped at 12 steps');
    if (!steps.every((s) => s && typeof s === 'object' && !Array.isArray(s))) {
      throw new ApiError(400, 'invalid_input', 'each workflow step must be a task body object');
    }
    const wf = { id: id('wkf'), keyId: key.id, status: 'running', steps: [], spec: steps, createdAt: Date.now() };
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

  // Resume a workflow that was running when the platform restarted. Settled
  // steps are kept; the step cut off by the restart (refunded as
  // platform_restart by boot recovery) is re-posted; anything else that
  // failed ends the chain with its real reason.
  async function resumeWorkflow(wf) {
    const key = state.keys[wf.keyId];
    if (!key || !Array.isArray(wf.spec)) {
      wf.status = 'failed';
      wf.failure = { reason: 'platform_restart', detail: 'workflow could not be resumed (no step spec in the snapshot)' };
      persist();
      return;
    }
    const ctx = { steps: [] };
    let next = 0;
    for (const entry of wf.steps) {
      const t = state.tasks[entry.taskId];
      if (t?.status === 'settled') {
        entry.status = 'settled';
        ctx.steps[entry.index] = { output: t.output, status: 'settled' };
        next = entry.index + 1;
        continue;
      }
      if (t?.status === 'refunded' && t.refund?.reason === 'platform_restart') {
        entry.status = 'refunded';
        entry.superseded = true; // re-run below
        next = entry.index;
        break;
      }
      wf.status = 'failed';
      wf.failure = { step: entry.index, taskId: entry.taskId, reason: t?.refund?.reason ?? t?.status ?? 'unknown' };
      persist();
      return;
    }
    wf.resumed = (wf.resumed ?? 0) + 1;
    wf.resumedAt = Date.now();
    persist();
    return runWorkflow(wf, key, wf.spec, next, ctx);
  }

  // ---- boot recovery --------------------------------------------------------
  // Restored in-flight work has lost its timers and promises. Tasks are
  // refunded WITHOUT a slash (reason platform_restart: the provider did not
  // fail, the platform did), consensus reservations are released, disputes
  // still under review are re-scheduled, running workflows resume, and due
  // token-bond slashes execute. recoveryGraceMs spares recent work: on
  // serverless, something loaded as in-flight may still be running inside a
  // concurrent invocation.

  if (loaded) {
    const now = Date.now();
    const stale = (ts) => now - (ts ?? 0) >= cfg.recoveryGraceMs;
    let touched = bootDirty;
    for (const task of Object.values(state.tasks)) {
      if (TERMINAL.has(task.status) || task.status === 'disputed' || !task.quote || !stale(task.createdAt)) continue;
      if (task.consensusQuotes) releaseConsensus(task);
      refundTask(task, 'platform_restart', 'platform restarted while the task was in flight', { slash: false });
      touched = true;
    }
    for (const d of Object.values(state.disputes)) {
      if (d.status !== 'reviewing' || !stale(d.openedAt)) continue;
      const task = state.tasks[d.taskId];
      if (task && task.quote) track(resolveDispute(d, task));
      else { d.status = 'void'; d.resolvedAt = now; }
      touched = true;
    }
    for (const wf of Object.values(state.workflows)) {
      if (wf.status === 'running' && stale(wf.createdAt)) track(resumeWorkflow(wf));
    }
    if (processPendingSlashes() > 0) touched = true;
    if (touched) persist();
  }

  return {
    cfg, state, drain, flush,
    createKey, authenticate, me, deposit, balance,
    createSubKey, listSubKeys, revokeSubKey, freezeSubKey,
    offers, createTask, getTask, listTasks, subscribe, publicTask,
    openDispute, getDispute, registerProvider,
    listProviders, getProvider, insuranceStats, getAttestation, attestorKey,
    verifyOutput, createWorkflow, getWorkflow,
    launchAgent, harvestFees, requestUnbond, withdrawUnbonded, setAgentPrice, getAgent, listAgents,
    confirmLaunch, refreshAgentChain, refreshStaleChains,
    guardianStatus, setGuardian, processPendingSlashes,
  };
}
