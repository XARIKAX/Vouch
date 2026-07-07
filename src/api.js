import { ApiError } from './engine.js';
import { CAPABILITIES } from './catalog.js';

const MAX_BODY = 256 * 1024;

// Catalog browsing is public — anonymous callers share one sandbox-tier bucket.
const ANON_KEY = { id: 'anon', tier: 'sandbox' };

export function readBody(req) {
  // Serverless runtimes (e.g. Vercel's Node helpers) consume the request
  // stream before the handler runs and leave the parsed body on req.body.
  if (req.body !== undefined) {
    const b = req.body;
    if (b === null || b === '') return Promise.resolve({});
    if (Buffer.isBuffer(b) || typeof b === 'string') {
      try { return Promise.resolve(JSON.parse(b.toString('utf8'))); }
      catch { return Promise.reject(new ApiError(400, 'invalid_input', 'Request body is not valid JSON.')); }
    }
    return Promise.resolve(b);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'payload_too_large', 'Request body exceeds 256 KiB.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'invalid_input', 'Request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

// Token-bucket rate limiter per key.
function makeLimiter(engine) {
  const buckets = new Map();
  return function take(key) {
    const rpm = engine.cfg.rpm[key.tier];
    const now = Date.now();
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

export function createApi(engine) {
  const limit = makeLimiter(engine);

  const send = (res, status, body, headers = {}) => {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    });
    res.end(payload);
  };

  const fail = (res, err) => {
    const status = err instanceof ApiError ? err.status : 500;
    const code = err instanceof ApiError ? err.code : 'internal_error';
    const extra = err instanceof ApiError ? err.extra : {};
    const headers = code === 'rate_limited' && extra.retry_after ? { 'Retry-After': String(extra.retry_after) } : {};
    send(res, status, { error: { code, message: err.message, ...extra } }, headers);
  };

  const auth = (req) => {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
    return engine.authenticate(m?.[1] ?? '');
  };

  const escrowHeader = (key) => ({
    'X-Escrow-Ceiling-Remaining': String(engine.balance(key).ceiling_remaining),
  });

  // [method, pattern, handler(req, res, params, query)]
  const routes = [
    // Dev bootstrap: mint a sandbox key with faucet credit. In production this
    // lives behind the dashboard's own auth; it is open here so the stack is
    // usable out of the box.
    ['POST', /^\/v1\/keys$/, async (req, res) => {
      const body = await readBody(req);
      const key = engine.createKey(body.name ?? 'default');
      send(res, 201, {
        id: key.id, key: key.token, tier: key.tier,
        note: 'Store this key — it is shown once. Faucet credit applied.',
      });
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

    // Provider registration is open in the dev sandbox (stake is a simulated
    // bond). In production this sits behind provider onboarding + real staking.
    ['POST', /^\/v1\/providers$/, async (req, res) => {
      const body = await readBody(req);
      const provider = engine.registerProvider(body);
      send(res, 201, provider);
    }],

    // Provider reputation — public.
    ['GET', /^\/v1\/providers$/, async (req, res) => {
      const key = req.headers.authorization ? auth(req) : ANON_KEY;
      const rl = limit(key);
      send(res, 200, { providers: engine.listProviders() }, rl);
    }],

    ['GET', /^\/v1\/providers\/([a-z0-9_]+)$/, async (req, res, [providerId]) => {
      const key = req.headers.authorization ? auth(req) : ANON_KEY;
      const rl = limit(key);
      send(res, 200, engine.getProvider(providerId), rl);
    }],

    // Insurance pool — public stats.
    ['GET', /^\/v1\/insurance$/, async (req, res) => {
      const key = req.headers.authorization ? auth(req) : ANON_KEY;
      const rl = limit(key);
      send(res, 200, engine.insuranceStats(), rl);
    }],

    // Attestation public key — anyone can verify a receipt offline.
    ['GET', /^\/v1\/attestation\/key$/, async (req, res) => {
      send(res, 200, engine.attestorKey());
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
      const key = req.headers.authorization ? auth(req) : ANON_KEY;
      const rl = limit(key);
      const capabilities = Object.entries(CAPABILITIES).map(([id, c]) => ({
        id, description: c.description, input_schema: c.input, output_schema: c.output,
      }));
      send(res, 200, { capabilities }, rl);
    }],

    ['GET', /^\/v1\/offers$/, async (req, res, _p, query) => {
      const key = req.headers.authorization ? auth(req) : ANON_KEY;
      const rl = limit(key);
      const offers = engine.offers({
        capability: query.get('capability') ?? undefined,
        max_price: query.has('max_price') ? Number(query.get('max_price')) : undefined,
        min_track: query.has('min_track') ? Number(query.get('min_track')) : undefined,
      });
      send(res, 200, { offers }, rl);
    }],

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
      const tasks = engine.listTasks(key, Number(query.get('limit') ?? 30));
      send(res, 200, { tasks }, rl);
    }],

    ['GET', /^\/v1\/tasks\/([a-z0-9_]+)\/events$/, async (req, res, [taskId]) => {
      const key = auth(req);
      const task = engine.getTask(key, taskId); // 404s before the stream opens
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
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

    ['POST', /^\/v1\/escrow\/deposit$/, async (req, res) => {
      const key = auth(req);
      const rl = limit(key);
      const body = await readBody(req);
      send(res, 200, engine.deposit(key, body.amount), rl);
    }],
  ];

  return async function handle(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      return res.end();
    }
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const m = pattern.exec(url.pathname);
      if (!m) continue;
      try {
        await handler(req, res, m.slice(1), url.searchParams);
      } catch (err) {
        fail(res, err);
      }
      return true;
    }
    fail(res, new ApiError(404, 'not_found', `No route ${req.method} ${url.pathname}.`));
    return true;
  };
}
