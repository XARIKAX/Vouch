// Vercel serverless entrypoint. vercel.json rewrites every path here; the
// app's own router (server.js) sees the original URL and dispatches as usual.
//
// Serverless differences from `node server.js`:
//   - State lives in Redis instead of a local file: Upstash over REST, or any
//     Redis via REDIS_URL (Vercel's Redis integration), both zero-dep.
//     Each invocation loads a fresh snapshot and runs the request. The
//     request's own changes are flushed (one compare-and-set write) BEFORE
//     the response is finished, so a poll that lands on another instance a
//     moment later already sees the new task. The background work the
//     request spawned (execution, grading, dispute review: engine.drain())
//     then runs under Vercel's request context (the same hook the
//     @vercel/functions `waitUntil` helper uses) and flushes a second write
//     with the outcome. Without that hook (local tests, other hosts) the
//     background work is awaited inline instead.
//   - Without a Redis configured (UPSTASH_REDIS_REST_URL/_TOKEN, KV_REST_API_*,
//     or REDIS_URL) the app is
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
const liveFlushMs = () => Number(process.env.VOUCH_LIVE_FLUSH_MS) || 600;
const limiterBuckets = new Map();
let modules = null;
let localApp = null;      // module-scope app when no remote store is configured
let warnedEphemeral = false;

// Vercel keeps a function alive past the response for any promise handed to
// the request context's waitUntil (what `@vercel/functions` wraps). Without
// it the instance may be frozen the moment the response ends and the
// background work would only progress when a later request thaws it.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
export function runInBackground(promise) {
  const ctx = globalThis[REQUEST_CONTEXT]?.get?.();
  if (typeof ctx?.waitUntil === 'function') { ctx.waitUntil(promise); return null; }
  return promise;
}

export default async function vercelHandler(req, res) {
  try {
    modules ??= await Promise.all([
      import('../server.js'),
      import('../src/store-upstash.js'),
    ]);
    const [{ createApp }, { createRemoteStore }] = modules;

    const remote = createRemoteStore();
    if (!remote) {
      if (!warnedEphemeral) {
        warnedEphemeral = true;
        console.warn('vouch: no Redis configured — state is in-memory and lost on every cold start. '
          + 'Add a Redis integration (REDIS_URL) or set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
      }
      localApp ??= createApp({ persistPath: null, limiterBuckets });
      await localApp.handler(req, res);
      await runInBackground(localApp.engine.drain());
      return;
    }

    // A Redis that cannot be reached must not take the whole site down: fall
    // back to the in-memory app for this invocation and say so on /v1/status.
    let snapshot;
    try {
      snapshot = await remote.load();
    } catch (e) {
      remote.close?.();
      const reason = String(e.message).replace(/\/\/[^@\s]*@/g, '//***@');
      console.error(`vouch: remote state store unavailable (${remote.path}): ${reason}`);
      localApp ??= createApp({ persistPath: null, limiterBuckets });
      localApp.engine.cfg.storeError = reason;
      await localApp.handler(req, res);
      await runInBackground(localApp.engine.drain());
      return;
    }
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

    // A failed flush loses this invocation's writes but must never turn an
    // already-sent response into a crash.
    const flush = () => remote.flush().catch((e) => console.error(`vouch: state flush failed: ${e.message}`));

    // Persist what the request changed BEFORE the client sees the reply:
    // res.end is held until the write lands. The response body is already
    // complete at that point, so the client only waits one Redis round trip.
    let ended = null;
    const realEnd = res.end.bind(res);
    res.end = (...args) => {
      ended ??= flush().then(() => realEnd(...args));
      return res;
    };
    await handler(req, res);
    await (ended ?? flush());

    // Then the background work and the flush that carries its outcome. While
    // the work runs, intermediate transitions (dispatched, delivered,
    // verifying) are flushed every VOUCH_LIVE_FLUSH_MS (default 600) so a
    // console polling from another instance watches the task move in near
    // real time. flush() is a no-op when nothing changed.
    const live = setInterval(flush, liveFlushMs());
    live.unref?.();
    await runInBackground(
      engine.drain().then(flush).finally(() => { clearInterval(live); remote.close?.(); })
    );
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
