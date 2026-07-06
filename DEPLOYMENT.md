# Deploying Vouch

Vouch runs in two modes:

- **Server mode** (`node server.js` / the `Dockerfile`) — a long-running HTTP
  server persisting state to a JSON file (`VOUCH_STATE`). For any host that
  runs persistent processes with a writable volume: Railway, Fly.io, Render,
  any Docker host.
- **Serverless mode** (`api/index.js` + `vercel.json`) — the same app wrapped
  as a Vercel function, persisting state to Upstash Redis over its REST API
  (still zero npm dependencies). Each invocation loads the state snapshot,
  runs the request **and all background work it spawned** (task execution,
  verification, dispute review — `engine.drain()`), then flushes one write.

> Plain Vercel with no Redis configured still works, but state is in-memory
> per instance and lost on every cold start — keys, escrows, and tasks
> evaporate. Demo only; the function logs a warning.

## Option A — Vercel (serverless)

1. Push/merge this code to the branch Vercel deploys (usually `main`). The
   repo-root `vercel.json` routes every path to `api/index.js`, bundles the
   HTML pages, and pins region `lhr1`.
2. **Add Redis** — in the Vercel dashboard: project → **Storage** →
   **Create Database / Marketplace** → **Upstash Redis** (free tier is fine)
   → connect it to the project. This auto-injects
   `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (legacy
   `KV_REST_API_URL`/`KV_REST_API_TOKEN` names also work). To wire it
   manually instead, create a database at [upstash.com](https://upstash.com)
   and set those two env vars under project → Settings → Environment
   Variables.
3. Add `ANTHROPIC_API_KEY` (project → Settings → Environment Variables) for
   the Claude grading panel; without it grading falls back to the offline
   heuristic.
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new env vars apply.
5. Verify `https://<domain>/health` returns `{"ok":true,...}` and `/`,
   `/docs`, `/services`, `/dashboard` render.
6. First boot against an empty store mints the **bootstrap key** and prints
   it once to the function logs (project → Logs, look for
   `vouch: bootstrap key`). Store it safely.

### Serverless caveats

- `vercel.json` sets `maxDuration: 300`. A task's whole lifecycle (executor +
  verification + grading) must finish within it, so keep quoted
  `deadline_ms` well under that. If your plan rejects 300, lower it to 60.
- Task-event SSE (`GET /v1/tasks/:id/events`) replays events and closes for
  finished tasks; it cannot stream live progress across invocations.
- Rate-limit buckets are per warm instance, not global.
- State writes are last-write-wins per invocation. Concurrent writes to the
  same key can race; a 10-minute recovery grace window keeps parallel
  invocations from refunding each other's in-flight tasks. Fine for the
  sandbox tier — real-money scale wants server mode (or a transactional
  store).

## Option B — Railway (server mode, dashboard-only)

`railway.json` in the repo root configures the build (Dockerfile) and health
check automatically.

1. Sign in at [railway.app](https://railway.app) → **New Project** →
   **Deploy from GitHub repo** → select `xarikax/vouch`, branch `main`.
   Railway detects the `Dockerfile` and builds it.
2. Open the service → **Variables** and add `ANTHROPIC_API_KEY` (and any
   optional overrides). Do **not** set `VOUCH_EPHEMERAL`.
3. Service → **Settings → Volumes**: mount path **`/data`** — this is where
   `state.json` lives; without it, state is lost on every redeploy.
4. Service → **Settings → Networking → Generate Domain** (port **4402** if
   asked).
5. Verify `https://<generated-domain>/health`; grab the bootstrap key from
   the deploy logs on first boot.

## Option C — Fly.io (server mode, CLI)

`fly.toml` in the repo root is preconfigured (region `lhr`, volume at
`/data`, single machine — the volume is attached to one machine, so do not
scale out).

```sh
fly launch --copy-config --no-deploy   # creates the app, keeps fly.toml
fly volumes create vouch_data --region lhr --size 1
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly deploy
fly logs        # grab the bootstrap key on first boot
```

## DNS cutover (only when changing hosts)

Staying on Vercel with the domain already attached needs no DNS changes. To
move to Railway/Fly:

1. Add the custom domain on the new host (Railway: Settings → Networking →
   Custom Domain; Fly: `fly certs add <domain>`) and note the CNAME target.
2. At your registrar, point the domain's CNAME (or ALIAS/ANAME for an apex)
   at that target.
3. Remove the domain from the old host so it stops answering, and wait out
   the DNS TTL (typically 5–60 min).

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `VOUCH_PORT` | Listen port (server mode) | `4402` |
| `VOUCH_STATE` | State file path (server mode) | `data/state.json` (Docker: `/data/state.json`) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Serverless state store (`KV_REST_API_*` also accepted) | unset → in-memory |
| `VOUCH_STATE_KEY` | Redis key for the state snapshot | `vouch:state` |
| `ANTHROPIC_API_KEY` | Claude grading panel | unset → offline heuristic |
| `VOUCH_GRADER_MODEL` | Grader model override | engine default |
| `VOUCH_GRADER_URL` | Custom webhook grader | unset |
| `VOUCH_ANTHROPIC_BASE_URL` | Anthropic API base URL | `https://api.anthropic.com` |
| `VOUCH_EPHEMERAL` | `1` = in-memory state (dev only) | unset |
| `VOUCH_FAST` | `1` = fast timings (dev only) | unset |
