// Vercel serverless entrypoint. vercel.json rewrites every path here; the
// app's own router (server.js) sees the original URL and dispatches as usual.
//
// Serverless differences from `node server.js`:
//   - State lives in Upstash Redis (REST, zero-dep) instead of a local file.
//     Without UPSTASH_REDIS_REST_URL/_TOKEN (or KV_REST_API_*), state is
//     in-memory per instance and lost on every cold start — demo only.
//   - Each invocation loads a fresh snapshot, runs the request plus all
//     background work it spawned (engine.drain()), then flushes one write.
//   - Boot recovery gets a grace window so a task still running inside a
//     concurrent invocation is not refunded as abandoned.
//
// Modules load lazily inside the handler so that an import-time failure
// (missing traced file, bad runtime, etc.) surfaces as a readable stack
// trace in the response instead of an opaque FUNCTION_INVOCATION_FAILED.

const RECOVERY_GRACE_MS = 10 * 60 * 1000;
let modules = null;
let warnedEphemeral = false;

export default async function vercelHandler(req, res) {
  try {
    modules ??= await Promise.all([
      import('../server.js'),
      import('../src/store-upstash.js'),
    ]);
    const [{ createApp }, { createUpstashStore }] = modules;

    const remote = createUpstashStore();
    if (!remote && !warnedEphemeral) {
      warnedEphemeral = true;
      console.warn('vouch: no Redis configured — state is in-memory and lost on every cold start. '
        + 'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or add the Upstash integration).');
    }

    let overrides = { persistPath: null };
    if (remote) {
      const snapshot = await remote.load();
      overrides = {
        store: { load: () => snapshot, save: remote.save },
        recoveryGraceMs: RECOVERY_GRACE_MS,
      };
    }

    const { engine, handler } = createApp(overrides);

    // First boot against an empty store: mint the bootstrap key exactly once.
    // The token is printed to the function logs (Vercel dashboard → Logs) and
    // persists via the flush below, so later invocations skip this branch.
    if (remote && Object.keys(engine.state.keys).length === 0) {
      const bootstrap = engine.createKey('bootstrap');
      console.log(`vouch: bootstrap key (sandbox tier, shown once): ${bootstrap.token}`);
    }

    await handler(req, res);
    await engine.drain();
    if (remote) {
      // A failed flush loses this invocation's writes but must not turn an
      // already-sent response into a crash.
      await remote.flush().catch((e) => console.error(`vouch: state flush failed: ${e.message}`));
    }
  } catch (err) {
    modules = null; // retry module load on the next invocation
    console.error('vouch: serverless handler failed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    try { res.end(`vouch: serverless handler failed\n\n${err?.stack ?? err}`); } catch { /* already closed */ }
  }
}
