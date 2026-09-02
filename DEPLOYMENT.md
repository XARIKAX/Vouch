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

## Production hardening checklist

The sandbox defaults (open key minting, in-memory state, heuristic grading)
make the stack usable out of the box but are **not** production settings.
Before real traffic:

1. **Persist state.** Serverless: attach Upstash Redis and set
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (without them, state
   resets on every cold start). Server mode: mount a volume at `/data`.
2. **Lock signup.** Set `VOUCH_LOCK_SIGNUP=1` and `VOUCH_ADMIN_TOKEN=…` so
   `POST /v1/keys` and `POST /v1/providers` require an `X-Admin-Token` header.
   Otherwise anyone can mint faucet-funded keys — fine for a demo, not for real
   value.
3. **Real grading.** Set `ANTHROPIC_API_KEY` so rubric verification uses the
   Claude panel instead of the offline heuristic.
4. **Stable attestations.** Set `VOUCH_ATTEST_KEY` (a PKCS8 ed25519 PEM) so
   proof-of-verified-work signatures stay valid across restarts/instances;
   otherwise a fresh key is generated per boot and old receipts stop verifying.
5. **On-chain settlement** (optional, when ready): deploy `contracts/VouchEscrow.sol`
   and wire the engine onto the settlement adapter — see `ONCHAIN.md`. Until
   then escrow/stake are a simulated bond.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `VOUCH_PORT` | Listen port (server mode) | `4402` |
| `VOUCH_STATE` | State file path (server mode) | `data/state.json` (Docker: `/data/state.json`) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Serverless state store (`KV_REST_API_*` also accepted) | unset → in-memory |
| `VOUCH_STATE_KEY` | Redis key for the state snapshot | `vouch:state` |
| `VOUCH_LOCK_SIGNUP` | `1` = gate key/provider minting behind `X-Admin-Token` | unset (open) |
| `VOUCH_ADMIN_TOKEN` | Admin token accepted when signup is locked | unset |
| `VOUCH_ATTEST_KEY` | PKCS8 ed25519 PEM for stable attestation signing | unset → ephemeral per boot |
| `ANTHROPIC_API_KEY` | Claude grading panel | unset → offline heuristic |
| `VOUCH_GRADER_MODEL` | Grader model override | engine default |
| `VOUCH_GRADER_URL` | Custom webhook grader | unset |
| `VOUCH_ANTHROPIC_BASE_URL` | Anthropic API base URL | `https://api.anthropic.com` |
| `VOUCH_EPHEMERAL` | `1` = in-memory state (dev only) | unset |
| `VOUCH_FAST` | `1` = fast timings (dev only) | unset |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` | Alpaca **paper** API keys — enables real market data + real paper orders on `/trade` | unset → simulated only |
| `ALPACA_BASE_URL` | Alpaca trading host (must be the **paper** host) | `https://paper-api.alpaca.markets` |
| `ALPACA_DATA_URL` | Alpaca market-data host | `https://data.alpaca.markets` |
| `BROKER_ORDER_TOKEN` | If set, `POST /v1/broker/order` requires a matching `x-broker-token` (stops the public trading in your account) | unset → order route open |

### Enabling real (paper) trading on `/trade`

1. Create a free Alpaca account and generate **paper** API keys (no real money, no funding needed).
2. Set `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` in your host's env vars, and (recommended) a `BROKER_ORDER_TOKEN`.
3. Redeploy. The **Alpaca (paper)** data source on `/trade` unlocks itself; the agent then trades real market data with real paper orders — still gated by a verified thesis. Leave `ALPACA_BASE_URL` on the paper host: the adapter refuses to run against the live (real-money) endpoint. Vouch is not a broker-dealer; live real-money trading is out of scope here.
