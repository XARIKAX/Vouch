import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createEngine } from './src/engine.js';
import { createApi } from './src/api.js';
import { createMcp } from './src/mcp.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function createApp(cfgOverrides = {}) {
  const engine = createEngine({
    fast: process.env.VOUCH_FAST === '1',
    ...cfgOverrides,
  });
  const api = createApi(engine);
  const mcp = createMcp(engine);

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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/v1/')) return api(req, res, url);
    if (url.pathname === '/mcp') return mcp(req, res);
    if (url.pathname === '/docs' || url.pathname === '/docs/') return staticFile(res, 'docs/index.html', 'text/html; charset=utf-8');
    if (url.pathname === '/dashboard') return staticFile(res, 'public/dashboard.html', 'text/html; charset=utf-8');
    if (url.pathname === '/services') return staticFile(res, 'public/services.html', 'text/html; charset=utf-8');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tasks: Object.keys(engine.state.tasks).length }));
    }
    res.writeHead(302, { Location: '/docs' });
    res.end();
  });

  return { server, engine };
}

// Entry point: `node server.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.VOUCH_PORT ?? 4402);
  const { server, engine } = createApp();
  const bootstrap = engine.createKey('bootstrap');
  server.listen(port, () => {
    console.log(`
  ✓ vouch — the outcome layer for AI agents
    api        http://localhost:${port}/v1
    mcp        http://localhost:${port}/mcp
    docs       http://localhost:${port}/docs
    services   http://localhost:${port}/services
    dashboard  http://localhost:${port}/dashboard

    bootstrap key (sandbox tier, $${engine.cfg.faucet} escrow faucet — shown once):
    ${bootstrap.token}
`);
  });
}
