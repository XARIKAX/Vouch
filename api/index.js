// Vercel serverless entrypoint. vercel.json rewrites every path here; the
// app's own router (server.js) sees the original URL and dispatches as usual.
//
// Serverless differences from `node server.js`:
//   - State lives in Upstash Redis (REST, zero-dep) instead of a local file.
//     Each invocation loads a fresh snapshot, runs the request plus all
//     background work it spawned (engine.drain()), then flushes one
//     compare-and-set write (see store-upstash.js for the conflict path).
//   - Without UPSTASH_REDIS_REST_URL/_TOKEN (or KV_REST_API_*) the app is
//     created ONCE at module scope and kept for the life of the instance:
//     state is in-memory and lost on a cold start — demo only.
//   - The rate limiter's buckets live at module scope either way, so limits
//     hold across invocations that land on the same instance.
//   - Boot recovery gets a grace window so a task still running inside a
//     concurrent invocation is not refunded as abandoned.
//   - A failure answers a generic 500 with an error id; the stack goes to the
//     function logs, never to the client.
//
// Modules load lazily inside the handler so that an import-time failure
// (missing traced file, bad runtime, etc.) surfaces in the logs instead of an
// opaque FUNCTION_INVOCATION_FAILED.

import crypto from 'node:crypto';

const RECOVERY_GRACE_MS = 10 * 60 * 1000;
const limiterBuckets = new Map();
let modules = null;
let localApp = null;      // module-scope app when no remote store is configured
let warnedEphemeral = false;

export default async function vercelHandler(req, res) {
  try {
    modules ??= await Promise.all([
      import('../server.js'),
      import('../src/store-upstash.js'),
    ]);
    const [{ createApp }, { createUpstashStore }] = modules;

    const remote = createUpstashStore();
    if (!remote) {
      if (!warnedEphemeral) {
        warnedEphemeral = true;
        console.warn('vouch: no Redis configured — state is in-memory and lost on every cold start. '
          + 'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or add the Upstash integration).');
      }
      localApp ??= createApp({ persistPath: null, limiterBuckets });
      await localApp.handler(req, res);
      await localApp.engine.drain();
      return;
    }

    const snapshot = await remote.load();
    const { engine, handler } = createApp({
      store: { load: () => snapshot, save: remote.save },
      recoveryGraceMs: RECOVERY_GRACE_MS,
      limiterBuckets,
    });

    // First boot against an empty store: mint the bootstrap key exactly once.
    // The token is printed to the function logs (Vercel dashboard → Logs) and
    // persists via the flush below, so later invocations skip this branch.
    if (Object.keys(engine.state.keys).length === 0) {
      const bootstrap = engine.createKey('bootstrap');
      console.log(`vouch: bootstrap key (sandbox tier, shown once): ${bootstrap.token}`);
    }

    await handler(req, res);
    await engine.drain();
    // A failed flush loses this invocation's writes but must not turn an
    // already-sent response into a crash.
    await remote.flush().catch((e) => console.error(`vouch: state flush failed: ${e.message}`));
  } catch (err) {
    modules = null; // retry module load on the next invocation
    const errorId = crypto.randomUUID();
    console.error(`vouch: serverless handler failed [${errorId}]:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    try { res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Internal error.', error_id: errorId } })); } catch { /* already closed */ }
  }
}
