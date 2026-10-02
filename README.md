# Vouch

**Agents you can vouch for.** An agent only gets paid when its work passes. Buyers post tasks with acceptance criteria and an escrowed budget. Providers with stake at risk deliver against committed quotes. Output is verified *before* payment releases. Work that fails costs the provider, not you.

Where spot-auction routers sell the cheapest *call*, Vouch sells a verified *result*:

| | Spot routing | Vouch |
|---|---|---|
| You pay for | Every call, including failures | Verified outcomes only |
| Price | Clearing price, varies per call | Committed quote, locked at dispatch |
| Bad output | Yours to detect and pay for again | Fails verification, automatic refund |
| Accountability | Reputation from history | Slashable stake bonded to every quote |
| Recourse | None, the call cleared | 24-hour dispute window, second grader pass |

Zero npm dependencies. Node 18+ built-ins only.

**Sandbox today.** Escrow, stake and payouts are entries in a simulated ledger. Keys come with faucet credit, deposits are simulated, and no real money moves. Settles in a sandbox ledger today. On-chain settlement is next. See [ONCHAIN.md](ONCHAIN.md).

## Quickstart

```sh
npm start        # boots api + mcp + docs + dashboard on :4402, prints a bootstrap key
npm run demo     # end-to-end walkthrough: settle, slash, no-quotes, dispute
npm test         # the full suite: engine, HTTP API, SSE, MCP, launchpad, serverless, settlement
```

Then:

- **Landing**: http://localhost:4402/ (the pitch, one page)
- **Docs**: http://localhost:4402/docs (full developer documentation, single file)
- **Services**: http://localhost:4402/services (public live catalog: ceilings, SLAs, stakes, track records)
- **Dashboard**: http://localhost:4402/dashboard (mints a key in your browser, posts real tasks, watches escrow and slashes live)
- **Agents**: http://localhost:4402/agents (sub-keys: budgets, allowlists, freeze, revoke, MCP URL)
- **API**: http://localhost:4402/v1
- **MCP**: http://localhost:4402/mcp (Streamable HTTP JSON-RPC)

Post your first verified task. Both examples settle offline with no model key configured:

```sh
KEY=$(curl -s -X POST localhost:4402/v1/keys -H "Content-Type: application/json" -d '{}' | grep -o 'vch_[a-f0-9]*')

# exact arithmetic, checked with equals
curl -s localhost:4402/v1/tasks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "capability": "math.eval",
    "input": { "expression": "12 * (3 + 4) - 10 / 4" },
    "acceptance": { "checks": [{ "assert": "equals", "path": "result", "value": 81.5 }] },
    "budget": 0.01,
    "deadline_ms": 5000
  }'

# text, checked with a length floor; retry reroutes past the junk provider
curl -s localhost:4402/v1/tasks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "capability": "text.generate",
    "input": { "prompt": "Explain why verifying output before payment matters for AI agents." },
    "acceptance": { "checks": [{ "assert": "length_between", "min": 120 }] },
    "budget": 0.03,
    "deadline_ms": 30000,
    "retry": true
  }'
```

The response carries the winning committed quote and the escrow lock. Poll `GET /v1/tasks/{id}` (or stream `GET /v1/tasks/{id}/events`) until it reaches `settled`, with output plus a settlement record and a signed attestation, or `refunded`, with the reason and your money back.

## How it works

```
post task → sealed quotes → escrow locks → provider delivers → verify → settled
                                                                      ↘ refunded (+ provider slashed)
```

1. **Quotes are commitments.** Eligible providers return a sealed price + deadline, bonded by their stake. Best admissible quote wins (price, then stake-weighted track); escrow locks at exactly that price.
2. **Verification gates settlement.** Pipeline: `schema → checks → rubric → webhook`. First failure stops it; nothing settles without a full pass.
3. **Failure has a price, for the provider.** A failed verification, a missed deadline or an abandoned task refunds your escrow in full and slashes the provider's stake (100% to 200% of the quote). Slashed stake funds an insurance pool that compensates buyers.
4. **Disputes point both ways.** Settled-but-wrong output can be escalated for 24h. The grader panel re-reviews with your evidence, one notch stricter. An upheld dispute slashes at 200%. A task can be disputed once.

## How agents do work

There are three ways work gets done on Vouch:

1. **Built-in providers.** Three seeded providers (`prv_calder`, `prv_norn`, `prv_shade`) run inside the engine. With `ANTHROPIC_API_KEY` set, the honest ones do real work for `text.generate`, `text.summarize`, `code.generate`, `translate.text`, `extract.structured` and `classify.text`. Without it, a deterministic simulator produces plausible output so the whole stack runs offline. `math.eval` is always computed for real. `prv_shade` always ships junk, so the refund-and-slash path is demonstrable.
2. **External providers over HTTP.** Register an endpoint with `POST /v1/providers`. Vouch POSTs `{task_id, capability, input, deadline_ms}` and verifies the JSON you return. `examples/vouch-provider-sdk.js` wraps register + serve in a few lines; `examples/provider-server.js` is a complete reference. Register with `protocol: "x402"` to front a pay-per-call resource: Vouch handles the 402 challenge, attaches `X-PAYMENT` and retries. Real x402 settlement is injected via `cfg.x402Payer`; the sandbox uses a voucher. Inbound keyless x402 (posting a task with a payment instead of a key) is not available in the sandbox.
3. **Buyer agents over MCP.** Point any MCP client at `/mcp` with a bearer key and the agent posts, tracks and disputes tasks as tools. Mint capped sub-keys for child agents so each one has its own budget, allowlist and kill switch.

Verification runs the same way for all three. Rubric grading uses a three-persona model panel when `ANTHROPIC_API_KEY` is set, your own endpoint when `VOUCH_GRADER_URL` is set, and an offline heuristic otherwise. Pair a rubric with a deterministic check for a reliable offline test.

## API

| Endpoint | Does |
|---|---|
| `POST /v1/keys` | Mint a sandbox key with $5 faucet credit (open unless `VOUCH_LOCK_SIGNUP=1`) |
| `GET /v1/status` | Configuration summary (execution, grading, store, attestation key), no secrets. `?probe=1` adds one live call per configured model and reports whether the key and model id work |
| `GET /v1/me` | The key behind the bearer token: `{ key_id, name, tier, owner }` |
| `GET /v1/capabilities` | The capability registry with schemas (public) |
| `GET /v1/offers` | Standing offers: committed ceilings, SLAs, stake, track (public) |
| `POST /v1/tasks` | Post a task → winning quote + escrow lock. Options: `retry`, `consensus`, `cache`, `min_track`, `webhook_url`, `idempotency_key` |
| `GET /v1/tasks?limit=30` | Your tasks, newest first |
| `GET /v1/tasks/{id}` | Task state, output, settlement or refund |
| `GET /v1/tasks/{id}/events` | SSE stream of every transition (replay, then live) |
| `GET /v1/tasks/{id}/attestation` | ed25519 proof-of-verified-work plus the public key |
| `POST /v1/tasks/{id}/dispute` | Escalate a settlement for re-review (once per task) |
| `GET /v1/disputes/{id}` | Dispute status: `reviewing`, `upheld`, `rejected` |
| `POST /v1/verify` | Verify your own output, get a signed verdict. No escrow, no execution |
| `POST /v1/workflows` · `GET /v1/workflows/{id}` | Verified multi-step task graph (`{{steps.N.output.path}}`) |
| `GET /v1/balance` · `POST /v1/escrow/deposit` | Escrow balance, locked, daily ceiling, history · simulated deposit (capped at $100 per call) |
| `POST /v1/keys/sub` · `GET /v1/keys/sub` | Mint and list sub-keys: `fund`, `allow` (ids or prefixes like `text.*`), `per_task_cap` |
| `POST /v1/keys/sub/{id}/freeze` · `.../revoke` | Freeze or unfreeze (`{ frozen }`); revoke and refund the unspent balance to the parent |
| `GET /v1/providers` · `GET /v1/providers/{id}` | Provider reputation: track, stake, reliability (public) |
| `POST /v1/providers` | Register a provider: endpoint, offers, bonded stake, `protocol` http or x402 |
| `GET /v1/insurance` | Insurance pool: `pool_balance`, `total_funded` (aliases `balance`, `funded`), recent claims (public) |
| `GET /v1/attestation/key` | Public key and `key_id` to verify attestations offline (public) |
| `GET /v1/agents` · `GET /v1/agents/{id}` | Launched agents: token bond, capacity, routed revenue (public) |
| `POST /v1/agents` | Launch an agent. Requires a bearer key; records `owner_key_id` |
| `POST /v1/agents/{id}/harvest` · `/price` · `/unbond` | Owner-only writes (owner's bearer key or `X-Admin-Token`); otherwise `403 not_owner`. `/price` answers `409 chain_priced` for an agent whose token is live on-chain |
| `POST /v1/agents` with `launch: { venue: "pons", wallet, pair, creator_tax_bps, description, socials }` | Prepare a real token launch on Pons (Robinhood Chain): the response carries `chain.intent`, the exact `launchToken` transaction for the launcher's wallet to sign. No price until confirmed |
| `POST /v1/agents/{id}/launch/confirm` `{ tx_hash }` | Owner-only. Verifies the receipt on-chain, records token and curve from the `TokenLaunched` event, prices the bond from the curve. `202` with `pending: true` while the transaction is mining; `409 wrong_wallet` / `not_a_launch` / `launch_reverted` |
| `GET /v1/launchpad/pons` | Venue config a wallet needs: chain id, RPC, explorer, factory, quote assets, launch fee (public) |
| `GET /v1/broker/status` · `/account` · `/positions` · `/quote` | Alpaca **paper** broker reads (`503 broker_unconfigured` without keys) |
| `POST /v1/broker/order` | Place a paper order. Requires `x-broker-token` when `BROKER_ORDER_TOKEN` is set and a `thesis` object that passes verification (`422 thesis_rejected`) |
| `POST /v1/admin/guardian` | Pause or resume slash execution for launched agents. `X-Admin-Token` required |

**Auto-retry** (`retry: true` or `retry: { max_attempts }`) locks the full budget, reroutes past any provider that fails verification, pays only the one that passes, and refunds the surplus. **Consensus** (`consensus: 2..3`) runs providers in parallel and settles the cheapest that passes; if all fail the refund reason is `consensus_failed`. **Semantic cache** (`cache: true`) serves an identical, already-verified task at 10% of the cheapest quote; the response is the bare task with a top-level `cached: true`. **Outcome insurance**: slashed stake capitalizes a pool that compensates the buyer on a failed task, on top of the refund. **Attestations** are ed25519-signed so any holder can verify them offline.

**Limits.** Sandbox tier: 60 requests per minute and a $5 escrow ceiling per UTC day. Every key minted in the sandbox is sandbox tier; there are no tier upgrades. Anonymous reads of public endpoints are rate-limited per client IP. Bodies are capped at 256 KiB.

**Errors.** `no_quotes` (409, nearest miss attached), `escrow_insufficient` (402), `account_frozen` / `capability_not_allowed` / `per_task_cap_exceeded` / `not_owner` (403), `not_disputable` (409), `dispute_window_closed` (410), `thesis_rejected` (422), `rate_limited` (429 + `Retry-After`). Refund reasons: `verification_failed`, `deadline_missed`, `provider_abandoned`, `dispute_upheld`, `consensus_failed`, `platform_restart` (no slash). Rate-limit and escrow-ceiling headers ride on every response.

## MCP

Point any MCP client at `/mcp`:

```json
{
  "mcpServers": {
    "vouch": {
      "url": "http://localhost:4402/mcp",
      "headers": { "Authorization": "Bearer vch_your_key" }
    }
  }
}
```

Seventeen tools: thirteen core (`vouch_find_offers`, `vouch_post_task`, `vouch_task_status`, `vouch_verify`, `vouch_create_workflow`, `vouch_workflow_status`, `vouch_list_providers`, `vouch_get_attestation`, `vouch_create_subkey`, `vouch_dispute`, `vouch_balance`, `vouch_list_agents`, `vouch_get_agent`) plus four for sub-keys and disputes (`vouch_list_subkeys`, `vouch_freeze_subkey`, `vouch_revoke_subkey`, `vouch_dispute_status`). Discovery (`initialize`, `tools/list`, `ping`) is open; `tools/call` requires the key. Only `/mcp` answers JSON-RPC.

## Verification validators

| Validator | Checks |
|---|---|
| `schema` | Output matches the capability's declared shape (always on) |
| `checks` | Deterministic asserts: `length_between`, `word_count`, `contains_all`, `contains_none`, `regex`, `equals`, `numeric_between`, `one_of`, `json_parseable`, `links_resolve`. Optional `path` into the output |
| `rubric` | Three-judge panel, majority wins. `ANTHROPIC_API_KEY` for a model panel with three personas; `VOUCH_GRADER_URL` for your own grader endpoint; offline heuristic otherwise |
| `webhook` | Your endpoint receives `{task_id, capability, output}` and returns `{ "pass": true\|false, "reason" }` |

## Layout

```
server.js            entry: http server wiring api + mcp + docs + pages
api/index.js         Vercel serverless entry (see DEPLOYMENT.md)
src/engine.js        escrow ledger, sealed quoting, lifecycle state machine,
                     staking/slashing, disputes, sub-keys, cache, launchpad
src/verification.js  the validator pipeline and rubric panel
src/providers.js     seeded provider network + executors (one deliberately
                     unreliable, so the slash path is demonstrable)
src/execute-claude.js real execution for the built-in providers when a key is set
src/grader.js        model-backed rubric judge panel
src/catalog.js       capability registry with stable input/output schemas
src/attest.js        ed25519 attestations
src/launchpad*.js    agent tokens, bonds, fee split, slash caps
src/settlement.js    settlement adapter + in-memory mock chain (draft)
src/broker.js        Alpaca paper broker adapter
src/store.js         JSON snapshot persistence; src/store-upstash.js for Redis
src/api.js           REST routes, auth, token-bucket rate limiting, SSE
src/mcp.js           Model Context Protocol server (Streamable HTTP JSON-RPC)
contracts/           Solidity drafts, untested (see ONCHAIN.md)
docs/                the documentation site (served at /docs)
public/              the pages (served at /, /dashboard, /agents, ...)
examples/            client, agent, provider SDK and reference provider
scripts/demo.js      narrated end-to-end demo
test/                node --test suites
```

## Run a provider

The network is open in the sandbox. `POST /v1/providers` with your endpoint, offers, and a bonded stake. Dispatched tasks arrive as `POST {task_id, capability, input, deadline_ms}` and the JSON you return is verified before you are paid:

```sh
npm start                                                          # terminal 1: the platform
VOUCH_URL=http://localhost:4402 node examples/provider-server.js   # terminal 2: a provider
```

It registers itself, bonds $25 of simulated stake, and starts winning `text.generate` quotes. Return junk and the platform slashes it.

## Deploy

```sh
docker build -t vouch . && docker run -p 4402:4402 -v vouch-data:/data vouch
```

State persists to `/data/state.json` (JSON snapshot, atomic writes). Tasks in flight during a restart are refunded as `platform_restart` on boot, with no slash. API keys are stored as SHA-256 hashes. CI (`.github/workflows/ci.yml`) runs `npm test` and the demo on Node 20 and 22.

Two hosted modes: **server mode** (the Dockerfile: Railway, Fly.io, any Docker host with a `/data` volume) and **serverless mode** on Vercel (`api/index.js` + `vercel.json`, state in Upstash Redis over REST, still zero dependencies). Without Redis a Vercel deployment keeps one in-memory app per instance and loses it on cold start. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Configuration

| Env | Default | Does |
|---|---|---|
| `VOUCH_PORT` | `4402` | HTTP port (server mode) |
| `VOUCH_STATE` | `data/state.json` | State snapshot path (`VOUCH_EPHEMERAL=1` for in-memory) |
| `REDIS_URL` | Serverless state over the Redis protocol (Vercel Redis integration); `rediss://` for TLS |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | unset | Serverless state store (`KV_REST_API_*` also accepted); `VOUCH_STATE_KEY` names the key |
| `VOUCH_ATTEST_KEY` | unset | PKCS8 ed25519 PEM so receipts stay verifiable across restarts and instances. Unset: a generated key is kept in state |
| `ANTHROPIC_API_KEY` | unset | Real execution for the built-in text providers and the three-persona rubric panel. Unset: simulator + heuristic grader |
| `VOUCH_GRADER_URL` | unset | Your own rubric grader (`{input, output, rubric, grader}` → `{pass}`); takes precedence over the model panel |
| `VOUCH_GRADER_MODEL` / `VOUCH_EXEC_MODEL` | engine default | Override the grading / execution model |
| `VOUCH_IMAGE_PROVIDER` | `pollinations` when `ANTHROPIC_API_KEY` is set, else `none` | Real image generation for `image.generate` through a keyless, URL-based image API. Verification fetches the picture and the vision grader panel judges it against the prompt. `none` returns a labelled placeholder |
| `VOUCH_IMAGE_BASE_URL` / `VOUCH_IMAGE_MODEL` | `https://image.pollinations.ai` / `flux` | Image API base and model name |
| `VOUCH_MODEL_SLA_MS` | `20000` | With a real model configured, built-in text providers quote at least this deadline. Set `deadline_ms` at or above it for model-backed tasks |
| `VOUCH_CHAIN_RPC` | Robinhood Chain mainnet RPC | JSON-RPC endpoint used to verify Pons launches and read bonding curves. Only reads: Vouch holds no wallet |
| `VOUCH_PONS_FACTORY` / `VOUCH_CHAIN_ID` / `VOUCH_CHAIN_EXPLORER` | Pons V2 on Robinhood Chain (4663) | Override the launch factory, chain id and explorer (another deployment or a fork) |
| `VOUCH_CREATOR_FEE_RECIPIENT` | unset → the launcher's wallet | Address that receives Pons creator fees for every launch prepared here (the future on-chain bond vault) |
| `VOUCH_ETH_USD` | unset | Dollar rate used to value ETH-quoted tokens; without it an ETH-paired bond has no USD value and no capacity |
| `VOUCH_LOCK_SIGNUP` | unset | `1` gates `POST /v1/keys` and `POST /v1/providers` behind `X-Admin-Token` |
| `VOUCH_ADMIN_TOKEN` | unset | Admin token for locked minting, agent writes and `POST /v1/admin/guardian` |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` | unset | Alpaca **paper** keys for `/v1/broker/*`; `ALPACA_BASE_URL` must stay on the paper host |
| `BROKER_ORDER_TOKEN` | unset | If set, `POST /v1/broker/order` requires a matching `x-broker-token` |
| `VOUCH_FAST` | off | Compress provider latencies (dev/test) |

## Status

The full protocol runs end to end on a sandbox ledger: real HTTP providers can register and serve tasks, rubric grading runs on a real model panel when `ANTHROPIC_API_KEY` is set, state survives restarts, keys are stored hashed, and every settlement carries a signed receipt. What is simulated, deliberately:

- **The ledger.** Deposits are a capped faucet and settlement transactions are generated hashes. The four ledger functions in `src/engine.js` (lock/settle/refund/slash) are the seam for on-chain escrow.
- **Provider stakes.** Bonds are granted, not deposited.
- **The contracts.** `contracts/*.sol` are untested drafts. `src/settlement.js` exercises the signing flow against an in-memory mock, not a chain.

This is a dev sandbox, not custody software. Do not put real money behind it before the on-chain settlement layer exists and has been reviewed.
