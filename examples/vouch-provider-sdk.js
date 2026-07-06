// Vouch Provider SDK — a zero-dependency helper for standing up a staked
// provider. Register capabilities with handler functions; the SDK bonds your
// stake on the network, serves an HTTP endpoint, and routes each dispatched
// task to the matching handler. Return the output object to submit it for
// verification; throw or return { error } to abandon (and get slashed).
//
//   import { createProvider } from './vouch-provider-sdk.js';
//   const provider = createProvider({
//     name: 'Acme Text',
//     stake: 50,
//     handlers: {
//       'text.generate': async ({ input }) => ({ text: await myModel(input.prompt) }),
//     },
//   });
//   await provider.start();   // registers + listens
//
import http from 'node:http';

export function createProvider(opts = {}) {
  const vouchUrl = (opts.vouchUrl ?? process.env.VOUCH_URL ?? 'http://localhost:4402').replace(/\/$/, '');
  const name = opts.name ?? 'SDK Provider';
  const port = Number(opts.port ?? process.env.PROVIDER_PORT ?? 4501);
  const host = opts.host ?? process.env.PROVIDER_HOST ?? `http://localhost:${port}`;
  const handlers = opts.handlers ?? {};
  const stake = opts.stake ?? 25;
  // Per-capability commercial terms; sensible defaults if the caller omits them.
  const offers = opts.offers ?? Object.fromEntries(
    Object.keys(handlers).map((cap) => [cap, { price_ceiling: 0.02, sla_deadline_ms: 10000 }])
  );

  let server;

  async function register() {
    const res = await fetch(`${vouchUrl}/v1/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, endpoint_url: `${host}/task`, offers, stake }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`registration failed: ${body.error?.message ?? res.status}`);
    return body; // { id, track, stake, ... }
  }

  function serve() {
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/task') { res.writeHead(404); return res.end(); }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        let out;
        try {
          const task = JSON.parse(raw);
          const handler = handlers[task.capability];
          out = handler ? await handler(task) : { error: `unsupported capability ${task.capability}` };
        } catch (e) {
          out = { error: e.message };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out ?? { error: 'handler returned nothing' }));
      });
    });
    return new Promise((resolve) => server.listen(port, resolve));
  }

  return {
    async start() {
      await serve();
      const me = await register();
      return me;
    },
    stop() { return new Promise((r) => (server ? server.close(r) : r())); },
  };
}
