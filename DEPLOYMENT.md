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
   `https://<domain>/v1/status?probe=1` goes one step further: it makes one
   minimal call per configured model and reports `model_probe.exec.ok` and
   `model_probe.grader.ok`, with the API's own error text when a key is
   rejected or a model id does not exist. Every task also carries an
   `execution` record (`mode: "model"` or `"simulated"`, plus `model_error`)
   so a silent fallback to the sandbox simulator is visible per task.
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
5. **On-chain settlement** of task escrow is not available yet: the engine
   settles on a sandbox ledger. Real USDT deposits and withdrawals on Solana
   and pump.fun token launches are available; see `ONCHAIN.md`.

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
| `VOUCH_IMAGE_PROVIDER` | Real image generation for `image.generate` through a keyless, URL-based image API; verification fetches the picture and the vision grader panel judges it against the prompt. `none` returns a labelled placeholder | `pollinations` when `ANTHROPIC_API_KEY` is set |
| `VOUCH_IMAGE_BASE_URL` / `VOUCH_IMAGE_MODEL` | Image API base URL and model name | `https://image.pollinations.ai` / `flux` |
| `VOUCH_MODEL_SLA_MS` | Minimum deadline the built-in text providers quote when they execute through a real model (a buyer's `deadline_ms` below it gets a 409 with the nearest quote) | `20000` |
| `VOUCH_GRADER_URL` | Custom webhook grader | unset |
| `VOUCH_CHAIN_RPC` | Solana JSON-RPC endpoint: verifying launches, reading curves, checking transfers, sending payouts. Use a dedicated provider in production | `https://api.mainnet-beta.solana.com` |
| `VOUCH_CHAIN_EXPLORER` / `VOUCH_PUMP_PROGRAM` | Override the explorer and the pump.fun program id | `https://solscan.io` / pump.fun mainnet |
| `VOUCH_PUBLIC_URL` | This deployment's public origin; token metadata URIs point here | `https://www.vouchagents.com` |
| `VOUCH_CREATOR_FEE_RECIPIENT` | The creator set on every launch prepared here; its creator vault collects the fees (the future on-chain bond vault) | unset → the launcher's wallet |
| `VOUCH_SOL_USD` / `VOUCH_SOL_USD_URL` / `VOUCH_SOL_USD_PATH` | A fixed SOL rate, or a JSON URL of your choice read every minute with a dot path to the number; without one SOL-paired bonds have no USD value | unset |
| `VOUCH_REAL_FUNDS` | `1` with a treasury address switches the deployment to real USDT on Solana: no faucet, simulated deposits off, on-chain deposits and withdrawals on | unset (sandbox credits) |
| `VOUCH_TREASURY_ADDRESS` | The Solana wallet that receives deposits and pays withdrawals | unset |
| `VOUCH_TREASURY_KEY` | Secret key of the treasury wallet (base58 as wallets export it) for automatic payouts; without it withdrawals wait for an operator payout confirmed through `/v1/admin/withdrawals` | unset |
| `VOUCH_USDT_MINT` / `VOUCH_TOKEN_SYMBOL` / `VOUCH_TOKEN_DECIMALS` | The settlement token | USDT on Solana / `USDT` / `6` |
| `VOUCH_MIN_WITHDRAWAL` / `VOUCH_MAX_WITHDRAWAL` | Per-request withdrawal limits in USDT | `1` / `1000` |
| `VOUCH_MODEL_BUDGET_USD` | Daily model spend cap; past it, or on a credit error, model calls pause until the next day and tasks run on the simulator and heuristic grader | `5` |
| `OPENROUTER_API_KEY` | The house source for the inference gateway: every priced text model OpenRouter lists becomes a bonded offer, proxied with this key. `VOUCH_UPSTREAM_URL` / `VOUCH_UPSTREAM_KEY` / `VOUCH_UPSTREAM_NAME` select another OpenAI-compatible aggregator | unset (no house source) |
| `VOUCH_UPSTREAM_MARGIN` / `VOUCH_UPSTREAM_BUDGET_USD` | Margin over the upstream price on house offers; what the house may pay upstream per UTC day | `0.10` / `5` |
| `VOUCH_UPSTREAM_LABEL` | The house provider's public name. The aggregator is never named in public; margin, budget and errors are shown to admins only (`X-Admin-Token` on `GET /v1/inference/upstream` or `/v1/status`) | `Vouch sourcing` |
| `VOUCH_UPSTREAM_RETENTION` / `VOUCH_UPSTREAM_MODELS` | What the aggregator keeps, declared on every house offer (`none` or `retained`; must match its data policy); an optional regex limiting which model ids are offered | `none` / all |
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

## Going to production: real funds, accounts, capacity

The sandbox and production are the same code with three switches.

### 1. Real USDT in and out, on Solana

1. Create a treasury wallet on Solana (Phantom, Solflare or a CLI keypair). Fund it with a little SOL for fees, and send it a token's worth of USDT once so its USDT token account exists.
2. Set `VOUCH_REAL_FUNDS=1` and `VOUCH_TREASURY_ADDRESS=<that wallet>`. From then on new keys get no faucet credit, `POST /v1/escrow/deposit` is refused, and the console shows **Deposit USDT** and **Withdraw** instead of the sandbox faucet.
3. Deposits: the console asks the server for the transfer instruction (`POST /v1/escrow/deposits/intent`), compiles it, simulates it, and the wallet signs and sends it; then `POST /v1/escrow/deposits/confirm { tx_hash }` with the signature. The server reads the confirmed transaction, checks from its token balance changes that USDT moved from the signed-in wallet to the treasury, and credits the ledger once.
4. Withdrawals: `POST /v1/withdrawals { amount }` debits the ledger and goes back to the signed-in wallet.
   - With `VOUCH_TREASURY_KEY` set, the server signs and sends the transfer itself (a legacy transaction that creates the wallet's USDT account if it is missing and does a checked transfer; zero dependencies) and the request is `sent`, then `paid` once the transaction is checked. If the send fails, the balance is returned and the request is `failed`.
   - Without it, the request is `pending`. An operator lists `GET /v1/admin/withdrawals`, pays from the treasury wallet, and posts the signature to `POST /v1/admin/withdrawals/{id}/paid`; the server verifies the transfer on-chain before marking it paid.
5. Only wallet-signed-in accounts can deposit or withdraw: a deposit is credited to the wallet that sent it, and a withdrawal goes only to that wallet. Anonymous sandbox keys cannot move real money.
6. Use a dedicated RPC provider (`VOUCH_CHAIN_RPC`); the public endpoint is rate-limited and will refuse bursts.

Start a real-funds deployment from an empty state (a new `VOUCH_STATE_KEY`): sandbox balances must never become withdrawable, and state written before the move to Solana holds wallets of another chain.

### 2. Accounts

Wallet sign-in works in both modes. `POST /v1/auth/nonce` returns a message, the wallet signs it (a Solana message signature, no transaction, no cost), and `POST /v1/auth/verify` with the base58 signature returns the account's key: a new account the first time, and a fresh key for the same account afterwards, which is how a lost key is recovered. The console's **Sign in with wallet** button does the whole exchange with any Wallet Standard wallet (Phantom, Solflare, Backpack and others). Set `VOUCH_LOCK_SIGNUP=1` on a production deployment so anonymous keys can no longer be minted and every account is a wallet.

### 3. Capacity

- **Model spend.** `VOUCH_MODEL_BUDGET_USD` caps model spend per UTC day. Past the cap, or when the API reports the account is out of credit, model calls pause and tasks run on the simulator and the heuristic grader instead of timing out and refunding. `GET /v1/status` reports `spend` (today's dollars, calls, tokens, whether calls are paused and why) and the console shows a banner. Top up the model account and raise the budget as volume grows.
- **The house source.** With `OPENROUTER_API_KEY` set, the gateway offers every model OpenRouter lists at the upstream price plus `VOUCH_UPSTREAM_MARGIN`. The first inference or price book request after a cold start reads the catalog (a few seconds); after that it is re-read every six hours in the background, or now with `POST /v1/admin/inference/upstream/sync`. Buyers pay the ledger; the house pays OpenRouter from the prepaid balance behind the key, so keep `VOUCH_UPSTREAM_BUDGET_USD` at what you are willing to spend upstream per day. In the sandbox, buyers spend faucet credits against your real balance: keep the budget small until real funds are on. Enable OpenRouter's data policy that excludes providers who retain prompts, or set `VOUCH_UPSTREAM_RETENTION=retained`, so the declaration on house offers is true.
- **Hosting.** The hobby plan limits functions to 60 seconds and deployments to a daily cap. Move to Vercel Pro before real traffic: longer functions (raise `maxDuration` in `vercel.json`), no deployment cap, and usage alerts.
- **State.** One Redis key with compare-and-set merging is fine for a sandbox. For real traffic put the state on a Redis instance with persistence and backups enabled, keep `VOUCH_STATE_KEY` per environment, and watch the `store` field in `/v1/status` for merge errors.
- **Secrets.** `VOUCH_TREASURY_KEY`, `VOUCH_ADMIN_TOKEN`, `VOUCH_ATTEST_KEY` and `ANTHROPIC_API_KEY` live in the host's encrypted environment only. Rotate the treasury key by moving the treasury: set a new address and key, and sweep the old wallet.
