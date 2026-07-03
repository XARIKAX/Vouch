import { ApiError } from './engine.js';

const MAX_BODY = 256 * 1024;

export function readBody(req) {
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

    ['GET', /^\/v1\/offers$/, async (req, res, _p, query) => {
      const key = auth(req);
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
