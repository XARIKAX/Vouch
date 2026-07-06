# Vouch

**The outcome layer for AI agents.** Agents don't pay for API calls that might fail — they post tasks with acceptance criteria and an escrowed USDC budget. Providers with capital at stake deliver against committed quotes. Output is verified *before* payment releases. Work that fails costs the provider, not you.

Where spot-auction routers sell the cheapest *call*, Vouch sells a verified *result*:

| | Spot routing | Vouch |
|---|---|---|
| You pay for | Every call, including failures | Verified outcomes only |
| Price | Clearing price, varies per call | Committed quote, locked at dispatch |
| Bad output | Yours to detect and pay for again | Fails verification → automatic refund |
| Accountability | Reputation from history | Slashable capital bonded to every quote |
| Recourse | None — the call cleared | 24-hour dispute window, independent re-review |

Zero npm dependencies — Node 18+ built-ins only.

## Quickstart

```sh
npm start        # boots api + mcp + docs + dashboard on :4402, prints a bootstrap key
npm run demo     # end-to-end walkthrough: settle, slash, no-quotes, dispute
npm test         # 15 tests across the engine, HTTP API, SSE, and MCP
```

Then:

- **Landing** — http://localhost:4402/ (the pitch, one page)
- **Docs** — http://localhost:4402/docs (full developer documentation, single file)
- **Services** — http://localhost:4402/services (public live catalog: ceilings, SLAs, stakes, track records)
- **Dashboard** — http://localhost:4402/dashboard (mint a key, post sample tasks, watch escrow/slash live)
- **API** — http://localhost:4402/v1
- **MCP** — http://localhost:4402/mcp (Streamable HTTP JSON-RPC)

Post your first verified task:

```sh
KEY=$(curl -s -X POST localhost:4402/v1/keys -d '{}' | grep -o 'vch_[a-f0-9]*')

curl -s localhost:4402/v1/tasks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "capability": "math.eval",
    "input": { "expression": "12 * (3 + 4) - 10 / 4" },
    "acceptance": { "checks": [{ "assert": "equals", "path": "result", "value": 81.5 }] },
    "budget": 0.01,
    "deadline_ms": 5000
  }'
```

The response carries the winning committed quote and the escrow lock. Poll `GET /v1/tasks/{id}` (or stream `GET /v1/tasks/{id}/events`) until it reaches `settled` — output plus a settlement record — or `refunded`, with the reason and your money back.

## How it works

```
post task → sealed quotes → escrow locks → provider delivers → verify → settled
                                                                      ↘ refunded (+ provider slashed)
```

1. **Quotes are commitments.** Eligible providers return a sealed price + deadline, bonded by their stake. Best admissible quote wins; escrow locks at exactly that price.
2. **Verification gates settlement.** Pipeline: `schema → checks → rubric → webhook`. First failure stops it; nothing settles without a full pass.
3. **Failure has a price — for the provider.** Failed verification or a missed deadline refunds your escrow in full and slashes the provider's stake (100–200% of the quote).
4. **Disputes point both ways.** Settled-but-wrong output can be escalated for 24h; an independent panel re-reviews, and a lost dispute slashes at 200%.

## API

| Endpoint | Does |
|---|---|
| `POST /v1/keys` | Mint a sandbox key with faucet credit (dev bootstrap) |
| `GET /v1/offers` | Standing offers: committed ceilings, SLAs, stake, track (public) |
| `GET /v1/capabilities` | The capability registry with schemas (public) |
| `POST /v1/tasks` | Post a task → winning quote + escrow lock. Add `retry: true` for auto-retry to a verified result |
| `GET /v1/tasks/{id}` | Task state, output, settlement or refund |
| `GET /v1/tasks/{id}/events` | Live SSE stream of every transition |
| `GET /v1/tasks/{id}/attestation` | ed25519 proof-of-verified-work for a settled task |
| `POST /v1/tasks/{id}/dispute` | Escalate a settlement for re-review |
| `GET /v1/disputes/{id}` | Dispute status |
| `POST /v1/verify` | Verify your own output, get a signed verdict — no escrow, no execution |
| `POST /v1/workflows` | Run a verified multi-step task graph (outputs thread via `{{steps.N.output.path}}`) |
| `GET /v1/workflows/{id}` | Workflow state and per-step results |
| `GET /v1/providers` | Provider reputation: track record, stake, reliability (public) |
| `GET /v1/providers/{id}` | One provider's detail (public) |
| `GET /v1/insurance` | Outcome-insurance pool balance and recent claims (public) |
| `GET /v1/attestation/key` | Public key to verify attestations offline (public) |
| `GET /v1/balance` | Escrow balance, locked, history |
| `POST /v1/escrow/deposit` | Fund escrow (simulated USDC) |
| `POST /v1/providers` | Register a provider: endpoint, offers, bonded stake |

**Auto-retry** (`retry: true` or `retry: { max_attempts }`) locks the full budget in escrow, reroutes past any provider that fails verification, pays only the one that passes, and refunds the surplus. **Outcome insurance**: slashed stake capitalizes a pool that compensates the agent on a failed task, on top of the automatic refund. **Attestations** are ed25519-signed so any holder can verify verified-work offline. A zero-dep **provider SDK** lives in `examples/vouch-provider-sdk.js`.

Errors follow the docs: `no_quotes` (409, with the nearest miss attached), `escrow_insufficient` (402), `rate_limited` (429 + `Retry-After`), `dispute_window_closed` (410). Rate-limit and escrow-ceiling headers ride on every response.

## MCP

Point any MCP client (Claude, Cursor, custom agents) at `/mcp`:

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

Tools: `vouch_find_offers`, `vouch_post_task`, `vouch_task_status`, `vouch_dispute`, `vouch_balance`. Discovery (`tools/list`) is open; calls require the key.

## Verification validators

| Validator | Checks | 
|---|---|
| `schema` | Output matches the capability's declared shape (always on) |
| `checks` | Deterministic asserts: `length_between`, `contains_none`, `contains_all`, `regex`, `equals`, `links_resolve` |
| `rubric` | 3-judge panel, majority wins. Set `ANTHROPIC_API_KEY` for a real Claude panel (three distinct judging personas); or `VOUCH_GRADER_URL` for your own grader endpoint; offline heuristic otherwise |
| `webhook` | Your endpoint receives the output and returns `{ "pass": true\|false }` |

## Layout

```
server.js            entry: http server wiring api + mcp + docs + dashboard
src/engine.js        escrow ledger, sealed quoting, lifecycle state machine,
                     staking/slashing, disputes
src/verification.js  the validator pipeline and rubric panel
src/providers.js     seeded provider network + executors (one deliberately
                     unreliable, so the slash path is demonstrable)
src/catalog.js       capability registry with stable input/output schemas
src/grader.js        Claude-backed rubric judge panel (Messages API)
src/store.js         JSON snapshot persistence with crash recovery
src/api.js           REST routes, auth, token-bucket rate limiting, SSE
src/mcp.js           Model Context Protocol server (Streamable HTTP JSON-RPC)
docs/                the documentation site (served at /docs)
public/              the live dashboard (served at /dashboard)
examples/            reference provider implementation (register + serve)
scripts/demo.js      narrated end-to-end demo
test/                engine + HTTP/SSE/MCP + grader/persistence/provider suites
```

## Run a provider

The network is open. `POST /v1/providers` with your endpoint, offers, and a bonded stake — dispatched tasks arrive as `POST {task_id, capability, input, deadline_ms}` and the JSON you return is verified before you're paid. A complete reference provider ships in the repo:

```sh
npm start                                          # terminal 1: the platform
VOUCH_URL=http://localhost:4402 node examples/provider-server.js   # terminal 2: a provider
```

It registers itself, bonds $25 of (simulated) stake, and starts winning `text.generate` quotes. Return junk and the platform slashes it — the whole thesis, runnable on localhost.

## Deploy

```sh
docker build -t vouch . && docker run -p 4402:4402 -v vouch-data:/data vouch
```

State persists to `/data/state.json` (JSON snapshot, atomic writes); tasks in flight during a crash are refunded as `provider_abandoned` on boot. API keys are stored as SHA-256 hashes. CI (`.github/workflows/ci.yml`) runs the test suite and the demo on Node 20 and 22.

Two hosted modes: **server mode** (the Dockerfile — Railway, Fly.io, any Docker host with a `/data` volume) and **serverless mode** on Vercel (`api/index.js` + `vercel.json`, state in Upstash Redis via REST — still zero dependencies). See [DEPLOYMENT.md](DEPLOYMENT.md) for setup steps and the serverless trade-offs.

## Configuration

| Env | Default | Does |
|---|---|---|
| `VOUCH_PORT` | `4402` | HTTP port |
| `VOUCH_STATE` | `data/state.json` | State snapshot path (`VOUCH_EPHEMERAL=1` for in-memory) |
| `ANTHROPIC_API_KEY` | — | Enables the Claude rubric-grading panel (three judge personas via the Messages API) |
| `VOUCH_GRADER_MODEL` | `claude-opus-4-8` | Model for the grading panel |
| `VOUCH_FAST` | off | Compress provider latencies (dev/test) |
| `VOUCH_GRADER_URL` | — | External rubric grader endpoint (receives `{input, output, rubric, grader}`, returns `{pass}`); takes precedence over the Claude panel |

## Status & roadmap

The full protocol runs end to end: real HTTP providers can register and serve tasks, rubric grading runs on a real Claude judge panel when `ANTHROPIC_API_KEY` is set, state survives restarts, and keys are stored hashed. What remains simulated, deliberately:

- **The USDC ledger** — deposits are a faucet and settlement transactions are generated hashes. The four ledger functions in `src/engine.js` (lock/settle/refund/slash) are the seam for on-chain escrow on Base.
- **Provider stakes** — bonds are granted, not deposited. Real staking lands with the on-chain ledger.

This is a dev sandbox, not custody software — don't put real money behind it before the on-chain settlement layer and a security review.
