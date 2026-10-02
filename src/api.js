import crypto from 'node:crypto';
import { ApiError } from './errors.js';
import { CAPABILITIES } from './catalog.js';
import * as broker from './broker.js';
import { checkThesis, THESIS_ACCEPTANCE, THESIS_CAPABILITY } from './thesis.js';

const MAX_BODY = 256 * 1024;

// Constant-time string compare for shared secrets (admin token).
export function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''));
  const B = Buffer.from(String(b ?? ''));
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Body is a JSON object or nothing. Arrays, strings, numbers and null are
// rejected with 400 so handlers can rely on `body.field` access.
const asObject = (v) => {
  if (v === undefined) return {};
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ApiError(400, 'invalid_input', 'Request body must be a JSON object.');
  }
  return v;
};

export function readBody(req) {
  // Serverless runtimes (e.g. Vercel's Node helpers) consume the request
  // stream before the handler runs and leave the parsed body on req.body.
  if (req.body !== undefined) {
    const b = req.body;
    if (b === null || b === '') return Promise.resolve({});
    if (Buffer.isBuffer(b) || typeof b === 'string') {
      try { return Promise.resolve(asObject(JSON.parse(b.toString('utf8')))); }
      catch (e) { return Promise.reject(e instanceof ApiError ? e : new ApiError(400, 'invalid_input', 'Request body is not valid JSON.')); }
    }
    try { return Promise.resolve(asObject(b)); } catch (e) { return Promise.reject(e); }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        // Stop reading but keep the socket so the 413 can be delivered; the
        // response path closes the connection once the reply is flushed.
        done = true;
        req.pause();
        reject(new ApiError(413, 'payload_too_large', 'Request body exceeds 256 KiB.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (!chunks.length) return resolve({});
      try { resolve(asObject(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch (e) { reject(e instanceof ApiError ? e : new ApiError(400, 'invalid_input', 'Request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

// Client address: first hop of X-Forwarded-For (what a proxy/edge sets), else
// the socket address. Anonymous rate limiting is keyed on this.
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  const first = typeof xff === 'string' ? xff.split(',')[0].trim() : Array.isArray(xff) ? String(xff[0] ?? '').split(',')[0].trim() : '';
  return first || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

// Token-bucket rate limiter per key (or per anonymous client IP). `buckets`
// can be injected so a serverless deployment keeps one map at module scope.
export function makeLimiter(engine, buckets = new Map()) {
  const prune = (now) => {
    if (buckets.size < 10000) return;
    for (const [k, b] of buckets) if (now - b.last > 120000) buckets.delete(k);
  };
  return function take(key) {
    const rpm = engine.cfg.rpm[key.tier] ?? engine.cfg.rpm.sandbox;
    const now = Date.now();
    prune(now);
    let b = buckets.get(key.id);
    if (!b) { b = { tokens: rpm, last: now }; buckets.set(key.id, b); }
    b.tokens = Math.min(rpm, b.tokens + ((now - b.last) / 60000) * rpm);
    b.last = now;
    if (b.tokens < 1) {
      const retryAfter = Math.ceil((1 - b.tokens) * (60000 / rpm) / 1000);
      throw new ApiError(429, 'rate_limited', 'Request rate exceeded.', { retry_after: retryAfter });
    }
    b.tokens -= 1;
    return {
      'X-RateLimit-Limit': String(rpm),
      'X-RateLimit-Remaining': String(Math.floor(b.tokens)),
      'X-RateLimit-Reset': String(Math.ceil((Date.now() + 60000) / 1000)),
    };
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Escrow-Ceiling-Remaining',
};
const CORS_PREFLIGHT = {
  ...CORS,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Token, X-Broker-Token',
  'Access-Control-Max-Age': '600',
};

export function createApi(engine, { buckets } = {}) {
  const limit = makeLimiter(engine, buckets);

  const send = (res, status, body, headers = {}) => {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...CORS,
      ...headers,
    });
    res.end(payload);
  };

  const fail = (res, err, req) => {
    const status = err instanceof ApiError ? err.status : (Number(err?.status) || 500);
    const code = err instanceof ApiError ? err.code
      : status === 503 ? 'broker_unconfigured' : status === 502 ? 'broker_unreachable'
      : status < 500 ? 'broker_error' : 'internal_error';
    let extra = err instanceof ApiError ? err.extra : {};
    let message = err.message;
    if (status >= 500 && !(err instanceof ApiError)) {
      // Unexpected failure: log the stack under an id the client can quote; never send it.
      const errorId = crypto.randomUUID();
      console.error(`vouch: request failed [${errorId}]:`, err);
      message = 'Internal error.';
      extra = { error_id: errorId };
    }
    const headers = {};
    if (code === 'rate_limited' && extra.retry_after) headers['Retry-After'] = String(extra.retry_after);
    if (status === 413) {
      headers.Connection = 'close';
      if (req) res.once('finish', () => { try { req.destroy(); } catch { /* already gone */ } });
    }
    send(res, status, { error: { code, message, ...extra } }, headers);
  };

  const bearer = (req) => /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
  const auth = (req) => engine.authenticate(bearer(req) ?? '');
  const anonKey = (req) => ({ id: `anon:${clientIp(req)}`, tier: 'sandbox' });
  const keyOrAnon = (req) => (req.headers.authorization ? auth(req) : anonKey(req));

  // The admin token is a deploy-time secret (VOUCH_ADMIN_TOKEN, or cfg.adminToken
  // for embedded use). No token configured means nobody is admin.
  const adminToken = () => process.env.VOUCH_ADMIN_TOKEN || engine.cfg.adminToken || '';
  const isAdmin = (req) => !!adminToken() && safeEqual(req.headers['x-admin-token'], adminToken());
  const adminOnly = (req) => {
    if (!isAdmin(req)) throw new ApiError(403, 'admin_required', 'A valid X-Admin-Token header is required.');
  };

  // Production can lock open key/provider minting and the faucet: set
  // VOUCH_LOCK_SIGNUP=1 and gate these behind the admin token. Left open in
  // the sandbox so the stack is usable out of the box.
  const adminGate = (req) => {
    if (process.env.VOUCH_LOCK_SIGNUP !== '1') return;
    if (isAdmin(req)) return;
    throw new ApiError(403, 'signup_locked', 'Open signup is disabled; an admin token is required to mint here.');
  };

  // Owner-only agent writes: the launching key's Bearer, or the admin token.
  const agentActor = (req) => {
    if (isAdmin(req)) return { admin: true, key: bearer(req) ? auth(req) : null };
    if (bearer(req)) return { admin: false, key: auth(req) };
    throw new ApiError(403, 'not_owner', 'Only the key that launched this agent (or an admin) may do that.');
  };

  const escrowHeader = (key) => ({
    'X-Escrow-Ceiling-Remaining': String(engine.balance(key).ceiling_remaining),
  });

  const intParam = (query, name, dflt) => {
    const raw = query.get(name);
    if (raw === null) return dflt;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : dflt;
  };

  // [method, pattern, handler(req, res, params, query)]
  const routes = [
    // Dev bootstrap: mint a sandbox key with faucet credit. In production this
    // lives behind the dashboard's own auth; it is open here so the stack is
    // usable out of the box.
    ['POST', /^\/v1\/keys$/, async (req, res) => {
      adminGate(req);
      const rl = limit(anonKey(req));
      const body = await readBody(req);
      const key = engine.createKey(typeof body.name === 'string' ? body.name : 'default', { owner: body.owner });
      send(res, 201, {
        id: key.id, key: key.token, tier: key.tier,
        note: 'Store this key — it is shown once. Faucet credit applied.',
      }, rl);
    }],

    // Who am I.
    ['GET', /^\/v1\/me$/, async (req, res) => {
      const key = auth(req);
      const rl = limit(key);
      send(res, 200, engine.me(key), rl);
    }],

    // Sub-agent wallets: a parent key mints capped, policy-bound sub-keys.
    ['POST', /^\/v1\/keys\/sub$/, async (req, res) => {
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      send(res, 201, engine.createSubKey(key, body), rl);
    }],

    ['GET', /^\/v1\/keys\/sub$/, async (req, res) => {
      const key = auth(req);
      const rl = limit(key);
      send(res, 200, { sub_keys: engine.listSubKeys(key) }, rl);
    }],

    ['POST', /^\/v1\/keys\/sub\/([a-z0-9_]+)\/revoke$/, async (req, res, [subId]) => {
      const key = auth(req);
      const rl = limit(key);
      send(res, 200, engine.revokeSubKey(key, subId), rl);
    }],

    // Freeze / unfreeze an agentic account (instant, reversible kill switch).
    // {frozen:true} freezes, {frozen:false} unfreezes; an omitted field means freeze.
    ['POST', /^\/v1\/keys\/sub\/([a-z0-9_]+)\/freeze$/, async (req, res, [subId]) => {
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      const frozen = body.frozen === undefined ? true : body.frozen === true;
      send(res, 200, engine.freezeSubKey(key, subId, frozen), rl);
    }],

    // Broker (Alpaca paper) — real market data + real *paper* orders when the
    // deployer sets ALPACA keys. Reads are open; order placement is gated by an
    // optional BROKER_ORDER_TOKEN so the public can't trade in your account,
    // and every order must carry a thesis that passes verification.
    ['GET', /^\/v1\/broker\/status$/, async (req, res) => {
      const rl = limit(keyOrAnon(req));
      send(res, 200, {
        ...broker.brokerStatus(),
        thesis: { capability: THESIS_CAPABILITY, acceptance: THESIS_ACCEPTANCE,
          shape: { direction: 'buy | sell | long | short', confidence: '0..1', rationale: 'string, 120+ characters' } },
      }, rl);
    }],
    ['GET', /^\/v1\/broker\/account$/, async (req, res) => { const rl = limit(keyOrAnon(req)); send(res, 200, await broker.account(), rl); }],
    ['GET', /^\/v1\/broker\/positions$/, async (req, res) => { const rl = limit(keyOrAnon(req)); send(res, 200, { positions: await broker.positions() }, rl); }],
    ['GET', /^\/v1\/broker\/quote$/, async (req, res, _p, query) => { const rl = limit(keyOrAnon(req)); send(res, 200, await broker.quote(query.get('symbol')), rl); }],
    ['POST', /^\/v1\/broker\/order$/, async (req, res) => {
      const rl = limit(keyOrAnon(req));
      if (!broker.orderTokenOk(req.headers['x-broker-token'])) {
        throw new ApiError(403, 'forbidden', 'A valid x-broker-token header is required to place orders.');
      }
      const body = await readBody(req);
      // No verified thesis, no order: the same validators /v1/verify runs.
      const verdict = await checkThesis(body.thesis, engine.cfg);
      if (!verdict.pass) {
        throw new ApiError(422, 'thesis_rejected', `The thesis did not pass verification (${verdict.failed?.validator ?? 'thesis'}).`, {
          failed: verdict.failed, verified_by: verdict.verified_by,
          required: { capability: THESIS_CAPABILITY, acceptance: THESIS_ACCEPTANCE },
        });
      }
      const order = await broker.placeOrder(body);
      send(res, 201, { ...order, thesis_verified_by: verdict.verified_by }, rl);
    }],

    // Provider registration is open in the dev sandbox (stake is a simulated
    // bond). In production this sits behind provider onboarding + real staking.
    ['POST', /^\/v1\/providers$/, async (req, res) => {
      adminGate(req);
      const rl = limit(keyOrAnon(req));
      const body = await readBody(req);
      const provider = engine.registerProvider(body);
      send(res, 201, provider, rl);
    }],

    // Provider reputation — public (endpoint_url only on the admin view).
    ['GET', /^\/v1\/providers$/, async (req, res) => {
      const rl = limit(keyOrAnon(req));
      send(res, 200, { providers: engine.listProviders({ admin: isAdmin(req) }) }, rl);
    }],

    ['GET', /^\/v1\/providers\/([a-z0-9_]+)$/, async (req, res, [providerId]) => {
      const rl = limit(keyOrAnon(req));
      send(res, 200, engine.getProvider(providerId, { admin: isAdmin(req) }), rl);
    }],

    // Insurance pool — public stats.
    ['GET', /^\/v1\/insurance$/, async (req, res) => {
      const rl = limit(keyOrAnon(req));
      send(res, 200, engine.insuranceStats(), rl);
    }],

    // Launchpad: launched agents (token-wrapped, supply-side providers).
    // Launching needs a Bearer key (recorded as owner_key_id); harvest, unbond,
    // withdraw and the sandbox price feed are owner-only (or admin). Reads are
    // public analytics.
    ['POST', /^\/v1\/agents$/, async (req, res) => {
      adminGate(req);
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      send(res, 201, engine.launchAgent(body, key), rl);
    }],

    ['GET', /^\/v1\/agents$/, async (req, res) => {
      const rl = limit(keyOrAnon(req));
      send(res, 200, { agents: engine.listAgents() }, rl);
    }],

    ['GET', /^\/v1\/agents\/([a-z0-9_]+)$/, async (req, res, [agentId]) => {
      const rl = limit(keyOrAnon(req));
      send(res, 200, engine.getAgent(agentId), rl);
    }],

    ['POST', /^\/v1\/agents\/([a-z0-9_]+)\/harvest$/, async (req, res, [agentId]) => {
      const actor = agentActor(req);
      const rl = limit(actor.key ?? anonKey(req));
      const body = await readBody(req);
      send(res, 200, engine.harvestFees(agentId, body.fee_amount ?? body.fee, actor), rl);
    }],

    ['POST', /^\/v1\/agents\/([a-z0-9_]+)\/unbond$/, async (req, res, [agentId]) => {
      const actor = agentActor(req);
      const rl = limit(actor.key ?? anonKey(req));
      const body = await readBody(req);
      send(res, 202, engine.requestUnbond(agentId, body.token_qty ?? body.tokenQty, actor), rl);
    }],

    ['POST', /^\/v1\/agents\/([a-z0-9_]+)\/withdraw$/, async (req, res, [agentId]) => {
      const actor = agentActor(req);
      const rl = limit(actor.key ?? anonKey(req));
      await readBody(req);
      send(res, 200, engine.withdrawUnbonded(agentId, actor), rl);
    }],

    // Sandbox price feed: move an agent token's TWAP / pool liquidity so you can
    // watch bond capacity reprice (and shrink) without a live pool.
    ['POST', /^\/v1\/agents\/([a-z0-9_]+)\/price$/, async (req, res, [agentId]) => {
      const actor = agentActor(req);
      const rl = limit(actor.key ?? anonKey(req));
      const body = await readBody(req);
      send(res, 200, engine.setAgentPrice(agentId, body, actor), rl);
    }],

    // Guardian: pause / resume token-bond slash execution. Admin only.
    ['GET', /^\/v1\/admin\/guardian$/, async (req, res) => {
      adminOnly(req);
      send(res, 200, engine.guardianStatus());
    }],
    ['POST', /^\/v1\/admin\/guardian$/, async (req, res) => {
      adminOnly(req);
      const body = await readBody(req);
      send(res, 200, engine.setGuardian({ paused: body.paused }));
    }],

    // Attestation public key — anyone can verify a receipt offline.
    // ?key_id= returns the key that signed an older receipt.
    ['GET', /^\/v1\/attestation\/key$/, async (req, res, _p, query) => {
      const rl = limit(keyOrAnon(req));
      send(res, 200, engine.attestorKey(query.get('key_id') ?? undefined), rl);
    }],

    // Verification-as-a-service: bring your own output, get a signed verdict.
    ['POST', /^\/v1\/verify$/, async (req, res) => {
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      const result = await engine.verifyOutput(key, body);
      send(res, 200, result, rl);
    }],

    // Verified workflows.
    ['POST', /^\/v1\/workflows$/, async (req, res) => {
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      send(res, 201, engine.createWorkflow(key, body), { ...rl, ...escrowHeader(key) });
    }],

    ['GET', /^\/v1\/workflows\/([a-z0-9_]+)$/, async (req, res, [wfId]) => {
      const key = auth(req);
      const rl = limit(key);
      send(res, 200, engine.getWorkflow(key, wfId), rl);
    }],

    ['GET', /^\/v1\/capabilities$/, async (req, res) => {
      const rl = limit(keyOrAnon(req));
      const capabilities = Object.entries(CAPABILITIES).map(([id, c]) => ({
        id, description: c.description, input_schema: c.input, output_schema: c.output,
      }));
      send(res, 200, { capabilities }, rl);
    }],

    ['GET', /^\/v1\/offers$/, async (req, res, _p, query) => {
      const rl = limit(keyOrAnon(req));
      const num = (name) => { const n = Number(query.get(name)); return Number.isFinite(n) ? n : undefined; };
      const offers = engine.offers({
        capability: query.get('capability') ?? undefined,
        max_price: query.has('max_price') ? num('max_price') : undefined,
        min_track: query.has('min_track') ? num('min_track') : undefined,
      });
      send(res, 200, { offers }, rl);
    }],

    // A cache hit answers 201 with the bare task; the task object carries
    // cached:true. An idempotent repost answers 200 with the existing task.
    ['POST', /^\/v1\/tasks$/, async (req, res) => {
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      const { task, reused } = engine.createTask(key, body);
      send(res, reused ? 200 : 201, task, { ...rl, ...escrowHeader(key) });
    }],

    ['GET', /^\/v1\/tasks$/, async (req, res, _p, query) => {
      const key = auth(req);
      const rl = limit(key);
      const tasks = engine.listTasks(key, intParam(query, 'limit', 30));
      send(res, 200, { tasks }, rl);
    }],

    ['GET', /^\/v1\/tasks\/([a-z0-9_]+)\/events$/, async (req, res, [taskId]) => {
      const key = auth(req);
      limit(key);
      const task = engine.getTask(key, taskId); // 404s before the stream opens
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...CORS,
      });
      const write = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
      for (const evt of task.events) write(evt);
      if (['settled', 'refunded'].includes(task.status)) return res.end();
      const unsub = engine.subscribe(taskId, (evt) => {
        write(evt);
        if (['settled', 'refunded'].includes(evt.status)) { unsub(); res.end(); }
      });
      req.on('close', unsub);
    }],

    ['GET', /^\/v1\/tasks\/([a-z0-9_]+)\/attestation$/, async (req, res, [taskId]) => {
      const key = auth(req);
      const rl = limit(key);
      send(res, 200, engine.getAttestation(key, taskId), rl);
    }],

    ['GET', /^\/v1\/tasks\/([a-z0-9_]+)$/, async (req, res, [taskId]) => {
      const key = auth(req);
      const rl = limit(key);
      send(res, 200, engine.getTask(key, taskId), rl);
    }],

    ['POST', /^\/v1\/tasks\/([a-z0-9_]+)\/dispute$/, async (req, res, [taskId]) => {
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      const dispute = engine.openDispute(key, taskId, body);
      send(res, 202, dispute, rl);
    }],

    ['GET', /^\/v1\/disputes\/([a-z0-9_]+)$/, async (req, res, [disputeId]) => {
      const key = auth(req);
      const rl = limit(key);
      send(res, 200, engine.getDispute(key, disputeId), rl);
    }],

    ['GET', /^\/v1\/balance$/, async (req, res) => {
      const key = auth(req);
      const rl = limit(key);
      send(res, 200, engine.balance(key), { ...rl, ...escrowHeader(key) });
    }],

    // The sandbox faucet. Locked together with signup in production.
    ['POST', /^\/v1\/escrow\/deposit$/, async (req, res) => {
      adminGate(req);
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      send(res, 200, engine.deposit(key, body.amount), rl);
    }],
  ];

  async function handle(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_PREFLIGHT);
      return res.end();
    }
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const m = pattern.exec(url.pathname);
      if (!m) continue;
      try {
        await handler(req, res, m.slice(1), url.searchParams);
      } catch (err) {
        fail(res, err, req);
      }
      return true;
    }
    fail(res, new ApiError(404, 'not_found', `No route ${req.method} ${url.pathname}.`), req);
    return true;
  }
  handle.limit = limit; // shared with the MCP server so tools/call is limited the same way
  return handle;
}
