# Deploying Vouch

Vouch is a **long-running Node HTTP server** (`http.createServer` + `server.listen`)
that persists all state to a JSON file on disk (`VOUCH_STATE`, default
`data/state.json`). It must run on a platform that supports persistent
processes and a writable volume.

> **It cannot run on Vercel (or any serverless platform) as-is.** There is no
> exported function entrypoint, no `api/` directory, and no `vercel.json`, and
> the serverless filesystem is read-only/ephemeral so state writes fail. Every
> request on Vercel crashes with `500 FUNCTION_INVOCATION_FAILED`.

The `Dockerfile` in the repo root is production-ready: `node:22-alpine`,
listens on `4402`, expects a volume at `/data`, health check at `/health`.

## Option A — Railway (recommended, dashboard-only)

`railway.json` in the repo root configures the build (Dockerfile) and health
check automatically.

1. Sign in at [railway.app](https://railway.app) → **New Project** →
   **Deploy from GitHub repo** → select `xarikax/vouch`, branch `main`.
   Railway detects the `Dockerfile` and builds it.
2. Open the service → **Variables** and add:
   - `ANTHROPIC_API_KEY` — enables the Claude grading panel (omitting it
     falls back to the offline heuristic grader).
   - Optionally `VOUCH_GRADER_MODEL`, `VOUCH_GRADER_URL`,
     `VOUCH_ANTHROPIC_BASE_URL`.
   - Do **not** set `VOUCH_EPHEMERAL`.
3. Service → **Settings → Volumes** (or right-click the service on the
   canvas → *Attach volume*): mount path **`/data`**. This is where
   `state.json` lives — without it, state is lost on every redeploy.
4. Service → **Settings → Networking → Generate Domain**. If asked for a
   port, enter **4402**.
5. Verify: `https://<generated-domain>/health` should return
   `{"ok":true,"tasks":0}`, and `/`, `/docs`, `/services`, `/dashboard`
   should render.
6. Check the deploy logs for the **bootstrap key** — it is printed once on
   first boot with an empty state file. Store it somewhere safe.

## Option B — Fly.io (CLI-based)

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

## DNS cutover (moving the domain off Vercel)

1. On the new host, add the custom domain:
   - **Railway:** service → Settings → Networking → **Custom Domain** →
     enter the domain. Railway shows a CNAME target like
     `<something>.up.railway.app`.
   - **Fly:** `fly certs add <domain>` and follow the printed instructions.
2. At your DNS registrar, edit the domain's record:
   - Subdomain (e.g. `www` or `app`): change the CNAME to the target from
     step 1.
   - Apex/root domain: use ALIAS/ANAME/flattened-CNAME to the same target,
     or the A/AAAA IPs the host provides (Fly prints them; Railway supports
     apex via CNAME flattening on most registrars).
3. In the **Vercel dashboard → vouch project → Settings → Domains**, remove
   the domain so Vercel stops answering for it, then pause/delete the Vercel
   project.
4. Wait for the DNS TTL to expire (typically 5–60 min), then verify
   `https://<domain>/health` returns `{"ok":true,...}` and the certificate
   is issued by the new host.

## State migration

There is nothing to migrate from Vercel: the serverless filesystem never
persisted `state.json`, so no keys, escrows, or tasks survived there. The
new deployment starts fresh and prints a new bootstrap key on first boot.
Previously distributed API keys are invalid and must be reissued.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `VOUCH_PORT` | Listen port | `4402` |
| `VOUCH_STATE` | State file path | `data/state.json` (Docker: `/data/state.json`) |
| `ANTHROPIC_API_KEY` | Claude grading panel | unset → offline heuristic |
| `VOUCH_GRADER_MODEL` | Grader model override | engine default |
| `VOUCH_GRADER_URL` | Custom webhook grader | unset |
| `VOUCH_ANTHROPIC_BASE_URL` | Anthropic API base URL | `https://api.anthropic.com` |
| `VOUCH_EPHEMERAL` | `1` = in-memory state (dev only — loses everything on restart) | unset |
| `VOUCH_FAST` | `1` = fast timings (dev only) | unset |
