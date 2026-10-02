import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEngine } from './src/engine.js';
import { createApi } from './src/api.js';
import { createMcp } from './src/mcp.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const PAGES = {
  '/': 'public/index.html', '/index.html': 'public/index.html',
  '/docs': 'docs/index.html', '/docs/': 'docs/index.html',
  '/dashboard': 'public/dashboard.html', '/services': 'public/services.html',
  '/providers': 'public/providers.html', '/agents': 'public/agents.html',
  '/launchpad': 'public/launchpad.html', '/agent': 'public/agent.html',
  '/trade': 'public/trade.html', '/verify': 'public/verify.html', '/metrics': 'public/metrics.html',
  '/task': 'public/task.html',
};
const ASSET_TYPES = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
};

const jsonError = (res, status, code, message, extra = {}) => {
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  try { res.end(JSON.stringify({ error: { code, message, ...extra } })); } catch { /* socket gone */ }
};

export function createApp(cfgOverrides = {}) {
  const { limiterBuckets, ...engineCfg } = cfgOverrides;
  const engine = createEngine({
    fast: process.env.VOUCH_FAST === '1',
    ...engineCfg,
  });
  const api = createApi(engine, { buckets: limiterBuckets });
  const mcp = createMcp(engine, { limit: api.limit });

  const staticFile = async (res, rel, type) => {
    try {
      const body = await readFile(path.join(ROOT, rel));
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  };

  const route = async (req, res) => {
    // A malformed request target (e.g. "//[") must be a 400, never a crash.
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return jsonError(res, 400, 'invalid_url', 'Malformed request URL.'); }

    if (url.pathname.startsWith('/v1/')) return api(req, res, url);
    if (url.pathname === '/mcp') return mcp(req, res);
    if (PAGES[url.pathname]) return staticFile(res, PAGES[url.pathname], 'text/html; charset=utf-8');
    if (url.pathname === '/og.png') return staticFile(res, 'public/og.png', 'image/png');
    // Shared design-system assets (CSS/JS/fonts/images), safe-pathed under /assets.
    if (url.pathname.startsWith('/assets/')) {
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { return jsonError(res, 400, 'invalid_url', 'Malformed asset path.'); }
      const assetsDir = path.join(ROOT, 'public', 'assets') + path.sep;
      const safe = path.resolve(ROOT, 'public', '.' + path.posix.normalize(decoded));
      if (!safe.startsWith(assetsDir)) { res.writeHead(403); return res.end('forbidden'); }
      const ext = path.extname(safe).toLowerCase();
      return staticFile(res, path.relative(ROOT, safe), ASSET_TYPES[ext] ?? 'application/octet-stream');
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tasks: Object.keys(engine.state.tasks).length }));
    }
    res.writeHead(302, { Location: '/' });
    res.end();
  };

  // Every request runs under a catch: a handler bug answers 500 and the
  // process keeps serving.
  const handler = async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      // The stack goes to the log under an id the client can quote; never to the client.
      const errorId = crypto.randomUUID();
      console.error(`vouch: request handler failed [${errorId}]:`, err);
      jsonError(res, 500, 'internal_error', 'Internal error.', { error_id: errorId });
    }
  };

  const server = http.createServer((req, res) => { handler(req, res).catch(() => {}); });
  return { server, engine, handler };
}

// Entry point: `node server.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.VOUCH_PORT ?? process.env.PORT ?? 4402);
  const persistPath = process.env.VOUCH_EPHEMERAL === '1'
    ? null
    : (process.env.VOUCH_STATE ?? path.join(ROOT, 'data', 'state.json'));
  const { server, engine } = createApp({ persistPath });
  const restored = Object.keys(engine.state.keys).length > 0;
  const bootstrap = restored ? null : engine.createKey('bootstrap');

  // Graceful shutdown: write the pending snapshot before the process exits.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  vouch: ${signal} received, flushing state…`);
    try { engine.flush(); } catch (e) { console.error(`vouch: flush failed: ${e.message}`); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(port, () => {
    console.log(`
  ✓ vouch — the outcome layer for AI agents
    api        http://localhost:${port}/v1
    mcp        http://localhost:${port}/mcp
    docs       http://localhost:${port}/docs
    services   http://localhost:${port}/services
    dashboard  http://localhost:${port}/dashboard

    state      ${persistPath ?? 'in-memory (VOUCH_EPHEMERAL=1)'}
    grading    ${engine.cfg.anthropicKey && engine.cfg.graderModel ? `model panel (${engine.cfg.graderModel})` : engine.cfg.graderUrl ? 'custom webhook' : 'offline heuristic — set ANTHROPIC_API_KEY and VOUCH_GRADER_MODEL for real grading'}
${bootstrap ? `
    bootstrap key (sandbox tier, $${engine.cfg.faucet} escrow faucet — shown once):
    ${bootstrap.token}
` : '    state restored — existing keys remain valid\n'}`);
  });
}
