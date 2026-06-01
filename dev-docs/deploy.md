# Deploying the aloud web demo

How to get a stranger-accessible aloud cloud online: a static UI talking to
the aloud cloud (`@aloud/server`) over HTTPS, with accounts + credits.
Tracks `meditation-pal-a3u` (infra) under the `meditation-pal-bot` epic.

The deploy has **two halves**, deployed independently:

| Half | What | Where | TLS |
|---|---|---|---|
| **Server** | `@aloud/server` (Hono): auth, credit ledger, metered LLM/STT/TTS proxy | a small always-on box — **Fly.io** here (Render/any VPS also fine) | Fly terminates TLS |
| **UI** | `ui/dist` (static Vite build) | a static host (see [UI hosting](#ui-hosting--an-open-decision)) | host-provided |

They're stitched together by two settings: the UI is **built** with
`VITE_ALOUD_CLOUD_URL` = the server's public origin, and the server is
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
fly apps create aloud-cloud                               # globally-unique name
fly volumes create aloud_data --size 1 --region sjc --app aloud-cloud   # durable ledger disk
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

## UI hosting (aloud.rest/app)

**Decided** (meditation-pal-sgp): the browser app is a **subpath under the
existing GitHub Pages site** — built with Vite `base: '/app/'` into `docs/app/`,
so it serves at `https://aloud.rest/app/` alongside the marketing site at `/`.
Reuses the existing Pages + cert + domain; the SPA router is base-path aware
(`ui/src/route-base.ts`) and `docs/404.html` carries the deep-link redirect.

### Deploy (recommended): the workflow

Run the **Deploy web app (UI → docs/app)** GitHub Action
(`.github/workflows/deploy-web.yml`, manual). It builds the hosted UI and commits
the result into `docs/app/` on the branch you run it from; Pages publishes
`docs/` automatically. One-time: set two repo **Variables** (Settings → Secrets
and variables → Actions → Variables):

- `ALOUD_CLOUD_URL` — the hosted `/cloud` origin (e.g. `https://aloud-cloud.fly.dev`).
- `GOOGLE_CLIENT_ID` — the web OAuth client id (= `GOOGLE_CLIENT_IDS` on the
  server). Not secret; it's baked into the public client. **Optional now**: the
  UI also discovers the client id at runtime from the server's public
  `GET /cloud/v1/config` (capabilities probe → `setRuntimeGoogleClientId`), so
  sign-in works on any install — desktop/local included — that points at a
  Google-configured server, even with nothing baked in. Baking it just lets the
  button paint before the probe resolves.

### Deploy (manual fallback)

```bash
cd ts
VITE_ALOUD_CLOUD_URL=https://aloud-cloud.fly.dev \
  VITE_GOOGLE_CLIENT_ID=<web-oauth-client-id> \
  npm run ui:build:hosted          # → repo-root docs/app/
git add docs/app && git commit -m "build hosted app" && git push
```

Either way, the server's `ALOUD_CORS_ORIGINS` must include the UI origin
(`https://aloud.rest`) so the browser may call the API cross-origin.

> The dev/desktop build (`npm run ui:build`, base `/` → `ui/dist`) is untouched;
> only `ui:build:hosted` (base `/app/`) writes `docs/app`.

---

## Sign-in methods (meditation-pal-s75)

Three methods, all behind the one account model (accounts ↔ identities). The UI
discovers which OAuth methods to show at runtime from `/cloud/v1/config`, so
nothing needs baking into the build.

- **Email/password** — always on, zero config. New email accounts get **no free
  credits** until they connect Google or Apple (the anti-farming lever,
  meditation-pal-116).
- **Google** — set `GOOGLE_CLIENT_IDS` (see below). Trusted → connecting unlocks
  the free grant.
- **Apple** — set `APPLE_CLIENT_IDS`. Trusted, same as Google.

### Sign in with Apple — one-time Apple Developer setup

You have an Apple Developer membership; this is what to create (all in
[developer.apple.com](https://developer.apple.com) → Certificates, IDs & Profiles):

> **Bundle ID vs Services ID — you are not stuck with your existing bundle id.**
> Apple uses two different identifier *types*, and the `aud` of the token differs
> by platform: a **native** iOS app's token is `aud` = the **App ID / bundle id**
> (your existing `app.aloud.meditation`); a **web** sign-in's token is `aud` = a
> separate **Services ID**. Identifiers must be globally unique, so the Services
> ID can't be the same string as the bundle id — make a new one (e.g.
> `app.aloud.meditation.web`). Keep `app.aloud.meditation` for the future native
> app; create the Services ID for the web flow now. `APPLE_CLIENT_IDS` accepts
> BOTH (comma-separated) — the server verifies a token whose `aud` matches any of
> them, so one server handles web + native.

1. **App ID** (Identifiers → +, type App): you already have `app.aloud.meditation`
   — just confirm **Sign in with Apple** is enabled on it (Edit → Capabilities).
2. **Services ID** (Identifiers → +, type Services IDs) — THIS is the web client
   id the browser uses. Give it a new, unique identifier, e.g.
   `app.aloud.meditation.web`. Enable **Sign in with Apple**, click **Configure**:
   - **Primary App ID**: `app.aloud.meditation`.
   - **Domains**: `aloud.rest`.
   - **Return URLs**: the exact app origin + base path the browser posts back to —
     `https://aloud.rest/app/` (the UI uses `window.location.origin + BASE_URL`).
     Add `https://localhost:4649/` too if you want to test Apple locally.
3. Set the server secret to the **Services ID** (add the bundle id later when the
   native app ships): `fly secrets set APPLE_CLIENT_IDS=app.aloud.meditation.web`
   — or both: `APPLE_CLIENT_IDS=app.aloud.meditation.web,app.aloud.meditation`.
   That's all the server needs — it verifies Apple's token against Apple's public
   JWKS; **no private key or client-secret JWT is required** for this verify-only,
   popup web flow.
4. Redeploy. The Apple button now appears wherever the UI reaches the server (the
   client reads the Services ID from `/cloud/v1/config` — the first id in
   `APPLE_CLIENT_IDS`, so list the **web Services ID first**).

> Note: Apple's web popup requires HTTPS and an exact Return URL match — a
> mismatch is the usual "it silently won't open" cause. The id token's `email`
> may be a private-relay address, and Apple omits it on repeat sign-ins (the
> identity is already linked by then, so that's fine).

---

## Wiring checklist

- [ ] Server deployed; `GET /health` returns `ok:true` with your providers.
- [ ] Volume mounted; `ALOUD_DB_PATH=/data/aloud.db` (balances persist across a
      `fly deploy`).
- [ ] Google OAuth web client id created; `GOOGLE_CLIENT_IDS` set on the server.
      The UI then serves the sign-in button to any install via `/cloud/v1/config`
      (baking `VITE_GOOGLE_CLIENT_ID` is optional — it only avoids a one-probe
      delay). Without `GOOGLE_CLIENT_IDS` the client falls back to dev sign-in,
      which 404s in prod.
- [ ] (Optional) Apple Services ID created + `APPLE_CLIENT_IDS` set (see
      "Sign in with Apple" above). Email/password needs no setup.
- [ ] UI built with `VITE_ALOUD_CLOUD_URL` = the server origin.
- [ ] Server `ALOUD_CORS_ORIGINS` = the UI origin.
- [ ] Stripe live keys + webhook endpoint (`POST /cloud/v1/billing/webhook`)
      registered in the Stripe dashboard, if selling credits at launch.
- [ ] `ALOUD_ADMIN_TOKEN` set; spot-check `GET /cloud/v1/admin/metrics` for
      spend monitoring.

## Still open before charging real money

See [ts-server.md → Gaps](ts-server.md#gaps-before-a-real-deploy). The durable
store (this doc) is done; the remaining launch-blockers are real Google OAuth
in the UI (`meditation-pal-rfb`) and Stripe live keys (`meditation-pal-8sj`).
