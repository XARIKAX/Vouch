# Deploying Vouch

Vouch runs in two modes:

- **Server mode** (`node server.js` / the `Dockerfile`) — a long-running HTTP
  server persisting state to a JSON file (`VOUCH_STATE`). For any host that
  runs persistent processes with a writable volume: Railway, Fly.io, Render,
  any Docker host.
- **Serverless mode** (`api/index.js` + `vercel.json`) — the same app wrapped
  as a Vercel function, persisting state to Upstash Redis over its REST API
  (still zero npm dependencies). Each invocation loads the state snapshot,
  runs the request and writes its changes back before the reply is finished.
  The background work the request spawned (task execution, verification,
  dispute review — `engine.drain()`) then runs under Vercel's request
  context, the same hook the `waitUntil` helper uses, and writes a second
  time with the outcome. Polling from any instance sees the task at once.

> Plain Vercel with no Redis configured still works. The function creates
> the app once per warm instance and keeps it in memory, so keys, escrows and
> tasks survive between requests on that instance and are lost on every cold
> start or when traffic lands on another instance. Demo only; the function
> logs a warning.

Settlement in both modes is a sandbox ledger. No real funds move. Settles in
a sandbox ledger today. On-chain settlement is next.

## Option A — Vercel (serverless)

1. Push/merge this code to the branch Vercel deploys (usually `main`). The
   repo-root `vercel.json` routes every path to `api/index.js`, bundles the
   HTML pages, and pins region `lhr1`.
2. **Add Redis** — in the Vercel dashboard: project → **Storage** →
   **Create Database**. Either integration works:
   - **Redis** (Vercel's native integration, free 30 MB plan): injects
     `REDIS_URL`. The app speaks the Redis wire protocol itself, no package
     needed. `rediss://` (TLS) URLs are supported.
   - **Upstash Redis**: injects `UPSTASH_REDIS_REST_URL` /
     `UPSTASH_REDIS_REST_TOKEN` (legacy `KV_REST_API_URL` / `KV_REST_API_TOKEN`
     also work) and the app uses the REST API.
   Connect the database to the project with the Production environment
   ticked. If both are present, Upstash REST is used.
3. Add `VOUCH_ATTEST_KEY` (a PKCS8 ed25519 PEM) so attestation receipts stay
   verifiable across invocations and instances. Without it the engine keeps a
   generated key in its state snapshot, which only holds while the snapshot
   does. Required for durable receipts.
4. Add `ANTHROPIC_API_KEY` (project → Settings → Environment Variables) for
   real execution by the built-in providers and the model grading panel;
   without it the simulator and the offline heuristic grader run.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the new env vars apply.
6. Verify `https://<domain>/health` returns `{"ok":true,...}` and `/`,
   `/docs`, `/services`, `/dashboard` render. `/mcp` answers JSON-RPC.
   `https://<domain>/v1/status` reports what is configured without exposing
   secrets: `execution: "model"` and `grading: "model"` mean the key and
   model variables were picked up; `attestation_key: "configured"` means
   `VOUCH_ATTEST_KEY` is set; `store: "remote"` means Redis is connected.
7. First boot against an empty store mints the **bootstrap key** and prints
   it once to the function logs (project → Logs, look for
   `vouch: bootstrap key`). Store it safely.

### Serverless caveats

- `vercel.json` sets `maxDuration: 60`. A task's whole lifecycle (executor +
  verification + grading) must finish within it, so keep quoted
  `deadline_ms` well under 60 s. Raise it in `vercel.json` only if your plan
  allows a longer function duration.
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
2. Open the service → **Variables** and add `VOUCH_ATTEST_KEY`,
   `ANTHROPIC_API_KEY` and any optional overrides. Do **not** set
   `VOUCH_EPHEMERAL`.
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
fly secrets set VOUCH_ATTEST_KEY="$(cat attest.pem)" ANTHROPIC_API_KEY=...
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
   Otherwise anyone can mint faucet-funded keys: fine for a demo, not for real
   value. The same token authorizes launched-agent writes in place of the
   owner's key and `POST /v1/admin/guardian`.
3. **Real execution and grading.** Set `ANTHROPIC_API_KEY` so the built-in
   providers do real work for text capabilities and rubric verification uses
   the model panel instead of the offline heuristic.
4. **Durable attestations.** Set `VOUCH_ATTEST_KEY` (a PKCS8 ed25519 PEM) so
   proof-of-verified-work signatures stay valid across restarts and instances.
   Without it the engine persists a generated key inside its state snapshot;
   lose the snapshot and old receipts stop verifying against
   `GET /v1/attestation/key`. Generate one with
   `node -e "console.log(require('crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))"`.
5. **On-chain settlement** is not available yet. `contracts/*.sol` are
   untested drafts and the engine settles on a sandbox ledger. See
   `ONCHAIN.md` for the plan.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `VOUCH_PORT` | Listen port (server mode) | `4402` |
| `VOUCH_STATE` | State file path (server mode) | `data/state.json` (Docker: `/data/state.json`) |
| `REDIS_URL` | Serverless state store over the Redis protocol (Vercel Redis integration, Redis Cloud; `rediss://` for TLS) | unset |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Serverless state store over Upstash REST (`KV_REST_API_*` also accepted; takes precedence over `REDIS_URL`) | unset → in-memory |
| `VOUCH_STATE_KEY` | Redis key for the state snapshot | `vouch:state` |
| `VOUCH_LOCK_SIGNUP` | `1` = gate key/provider minting behind `X-Admin-Token` | unset (open) |
| `VOUCH_ADMIN_TOKEN` | Admin token for locked minting, launched-agent writes and `POST /v1/admin/guardian` | unset |
| `VOUCH_ATTEST_KEY` | PKCS8 ed25519 PEM for durable attestation signing | unset → generated key kept in state |
| `ANTHROPIC_API_KEY` | Real execution for built-in text providers + model grading panel | unset → simulator + offline heuristic |
| `VOUCH_GRADER_MODEL` / `VOUCH_EXEC_MODEL` | Grading / execution model override | engine default |
| `VOUCH_MODEL_SLA_MS` | Minimum deadline the built-in text providers quote when they execute through a real model (a buyer's `deadline_ms` below it gets a 409 with the nearest quote) | `20000` |
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
3. Redeploy. The **Alpaca (paper)** data source on `/trade` unlocks itself; the agent then trades real market data with real paper orders, still gated by a verified thesis. Every `POST /v1/broker/order` must carry a `thesis` object that passes the server's checks (`json_parseable`, a regex on `direction` and `confidence`, `length_between` 120); otherwise it is rejected with `422 thesis_rejected` before the broker is called. Leave `ALPACA_BASE_URL` on the paper host: the adapter refuses to run against the live (real-money) endpoint. Vouch is not a broker-dealer; live real-money trading is out of scope here.
