# Deploying the aloud web demo

How to get a stranger-accessible hosted aloud online: a static UI talking to
the hosted server (`@aloud/server`) over HTTPS, with accounts + credits.
Tracks `meditation-pal-a3u` (infra) under the `meditation-pal-bot` epic.

The deploy has **two halves**, deployed independently:

| Half | What | Where | TLS |
|---|---|---|---|
| **Server** | `@aloud/server` (Hono): auth, credit ledger, metered LLM/STT/TTS proxy | a small always-on box — **Fly.io** here (Render/any VPS also fine) | Fly terminates TLS |
| **UI** | `ui/dist` (static Vite build) | a static host (see [UI hosting](#ui-hosting--an-open-decision)) | host-provided |

They're stitched together by two settings: the UI is **built** with
`VITE_ALOUD_SERVER_URL` = the server's public origin, and the server is
**configured** with `ALOUD_CORS_ORIGINS` = the UI's public origin. Mic capture
needs a secure context, so both must be real HTTPS (the `cert.py` self-signed
cert is LAN-only and won't do here).

---

## Server (Fly.io)

Files: `ts/server/Dockerfile`, `ts/server/fly.toml`, and the manual
`.github/workflows/deploy-server.yml`. Everything runs from the **`ts/`
workspace root** because the server resolves `@aloud/core` (`../src`) at
runtime via tsx — the build context must include core's source.

### One-time setup

```bash
cd ts
# Create the app explicitly. Do NOT use `fly launch` here: it looks for fly.toml
# in the cwd (ts/), not server/, so --copy-config finds nothing and scaffolds a
# "blank app" with no build config.
fly apps create aloud-server                               # globally-unique name
fly volumes create aloud_data --size 1 --region sjc --app aloud-server   # durable ledger disk
```

> **Single volume on purpose.** Fly warns you to create two — say no. The ledger
> is one SQLite file pinned to one machine (see below); a second volume would
> mean a second, divergent ledger.

Then set the secrets (everything sensitive — never in `fly.toml`):

```bash
fly secrets set \
  ALOUD_SESSION_SECRET=$(openssl rand -hex 32) \
  GOOGLE_CLIENT_IDS=<your-web-oauth-client-id> \
  ANTHROPIC_API_KEY=sk-ant-... \
  GEMINI_API_KEY=... \
  FIREWORKS_API_KEY=... \
  GOOGLE_TTS_API_KEY=... \
  ALOUD_CORS_ORIGINS=https://<your-ui-host> \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  ALOUD_ADMIN_TOKEN=$(openssl rand -hex 32)
```

Required vs optional in production is enforced at boot (`loadConfig`, strict
mode): the server **refuses to start** without `ALOUD_SESSION_SECRET`,
`GOOGLE_CLIENT_IDS`, **`ALOUD_DB_PATH`** (set in `fly.toml` → the volume), and
≥1 provider key. Stripe/STT/TTS/admin are optional (features degrade or report
"not configured"). Full annotated list: `ts/server/.env.example` and the config
table in [ts-server.md](ts-server.md).

### Deploy

```bash
cd ts && fly deploy --config server/fly.toml
```

or run the **Deploy server (Fly)** GitHub Action (manual; needs a `FLY_API_TOKEN`
repo secret and a `production` environment). Verify:

```bash
curl https://<your-app>.fly.dev/health      # {"ok":true,"providers":[...],...}
```

### Durability & scale

The credit ledger is a SQLite file (`SqliteCreditsStore`, `node:sqlite`) on the
mounted volume at `/data/aloud.db`. This is the durable swap for the in-memory
dev store — **balances survive restarts/redeploys/suspends**. Because a Fly
volume binds to one machine, this app is **single-machine by design**
(`min_machines_running = 0`, `auto_stop = suspend` for cost). That's correct at
trial scale. To scale out later: implement `CreditsStore` over Postgres
(`ts/server/src/credits/store.ts` is the whole interface — the ledger logic on
top is storage-agnostic) and drop the `[mounts]` block.

### Render / VPS alternative

The Dockerfile is host-agnostic. On Render: a Docker web service, root
directory `ts`, Dockerfile path `server/Dockerfile`, a persistent disk mounted
at `/data`, and the same env vars. Any box with Node 22 can also run it
directly: `cd ts && npm ci && ALOUD_ENV=production ALOUD_DB_PATH=/var/lib/aloud/aloud.db npm run start -w @aloud/server` behind a TLS-terminating reverse proxy.

---

## UI hosting — an open decision

The UI is a static `ui/dist` (Vite). The catch: **this repo's GitHub Pages is
already in use** for the marketing/landing site (served from `/docs` on `main`
with a `CNAME` custom domain — see the "Landing site" note in
[dev-cheatsheet.md](dev-cheatsheet.md)). A repo gets one Pages site, so the app
UI can't naively co-deploy there. Two clean options:

1. **Subpath under the existing Pages site** — build the UI with
   `base: '/app/'` into `docs/app/`, so it serves at
   `https://<custom-domain>/app/`. Reuses the existing Pages + cert + domain;
   no new host. Cost: built assets get committed into `docs/` (today
   hand-written), and the SPA router in `ui/src/app.ts` needs a base-path
   (`/app`) so deep links and the History API resolve correctly.
2. **Separate static host** — Cloudflare Pages / Netlify / a CDN bucket on its
   own subdomain (e.g. `app.<domain>`). Keeps generated assets out of the
   marketing repo and the router at root (`base: '/'`, no change). Cost: a
   second host + a DNS record.

**This needs your call before wiring** — option 1 changes the Vite `base` and
the router, which would break in-app navigation if done blind, so I left it
for you. Once chosen, the build itself is one command:

```bash
cd ts
VITE_ALOUD_SERVER_URL=https://<your-app>.fly.dev npm run ui:build   # → ui/dist
# option 1: vite build with base '/app/' and outDir docs/app, then commit docs/app
# option 2: upload ui/dist to the static host
```

Whichever host you pick, set the server's `ALOUD_CORS_ORIGINS` to its origin so
the browser is allowed to call the API cross-origin.

---

## Wiring checklist

- [ ] Server deployed; `GET /health` returns `ok:true` with your providers.
- [ ] Volume mounted; `ALOUD_DB_PATH=/data/aloud.db` (balances persist across a
      `fly deploy`).
- [ ] Google OAuth web client id created; `GOOGLE_CLIENT_IDS` set on the server
      and the same id baked into the UI (`meditation-pal-rfb` wires the sign-in
      button — until then the UI uses the dev sign-in, which 404s in prod).
- [ ] UI built with `VITE_ALOUD_SERVER_URL` = the server origin.
- [ ] Server `ALOUD_CORS_ORIGINS` = the UI origin.
- [ ] Stripe live keys + webhook endpoint (`POST /cloud/v1/billing/webhook`)
      registered in the Stripe dashboard, if selling credits at launch.
- [ ] `ALOUD_ADMIN_TOKEN` set; spot-check `GET /cloud/v1/admin/metrics` for
      spend monitoring.

## Still open before charging real money

See [ts-server.md → Gaps](ts-server.md#gaps-before-a-real-deploy). The durable
store (this doc) is done; the remaining launch-blockers are real Google OAuth
in the UI (`meditation-pal-rfb`) and Stripe live keys (`meditation-pal-8sj`).
