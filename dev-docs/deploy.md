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
**configured** with `ALOUD_CORS_ORIGINS` = every origin a client calls from.
That's the web UI origin **plus the desktop webview origins** — the Tauri app
calls the same hosted server cross-origin from `tauri://localhost` (macOS /
Linux) and `http://tauri.localhost` (Windows), so leaving those out breaks
sign-in/credits on desktop only (a failure mode that's invisible in browser
testing). Mic capture needs a secure context, so the web halves must be real
HTTPS (the `cert.py` self-signed cert is LAN-only and won't do here).

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
  OPENAI_API_KEY=sk-... \
  GEMINI_API_KEY=... \
  GOOGLE_TTS_API_KEY=... \
  ALOUD_CORS_ORIGINS='https://<your-ui-host>,tauri://localhost,http://tauri.localhost' \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  ALOUD_ADMIN_TOKEN=$(openssl rand -hex 32)
```

Then set the **R2 backup secrets** (see [Backups](#backups-litestream--r2) for why this
is not optional — the ledger is real money on a single volume):

```bash
fly secrets set \
  R2_BUCKET=aloud-cloud \
  R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  R2_ACCESS_KEY_ID=<r2-access-key-id> \
  R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
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

### Deploy hygiene (read before `fly deploy`)

A few non-obvious things that have bitten us. This is a money server (the credit
ledger) — treat a deploy as a production change, not a save button.

1. **`fly deploy` ships your whole working tree, not a commit.** The Docker build
   context is whatever's in `ts/` *right now* — uncommitted edits, and every
   commit on your current branch that isn't live yet. So deploying from a feature
   branch pushes that entire branch's divergence to prod, even the part you
   weren't thinking about. **Habit:** before deploying, run `git status` (clean?)
   and know what's on this branch vs what's running. Deploy from `main` or a
   branch you've deliberately readied — not "whatever I happen to have checked
   out." (This is how a half-finished schema change once rode along with an
   unrelated deploy and crashed the boot.)

2. **A release marked `complete` does NOT mean the server booted.** Because
   `min_machines_running = 0`, the machine only actually starts on the first
   request. `fly releases` showing "complete" just means the *config* rolled out.
   A broken image can sit there looking fine until someone hits it and it
   crash-loops. **So always actually wake + check after deploying:**

   ```bash
   curl https://aloud-cloud.fly.dev/health     # forces a cold start
   fly logs -a aloud-cloud                      # watch it boot; look for "aloud cloud up"
   ```

3. **Rolling back is one command** — your escape hatch when a deploy goes bad.
   Every release keeps its image; redeploy a previous one by digest:

   ```bash
   fly releases -a aloud-cloud --image          # find a known-good DOCKER IMAGE ref
   fly deploy --image <that-ref> --config server/fly.toml -a aloud-cloud
   ```

   The volume (and thus the ledger) is untouched by a rollback — you're only
   swapping the code image, not the data.

4. **Build it locally first when the Dockerfile changed.** `docker build -f
   server/Dockerfile -t aloud-cloud .` from `ts/` runs the exact same build Fly
   does, so a typo fails on your laptop in seconds instead of after a push.

### Durability & scale

The credit ledger is a SQLite file (`SqliteCreditsStore`, `node:sqlite`) on the
mounted volume at `/data/aloud.db`. This is the durable swap for the in-memory
dev store — **balances survive restarts/redeploys/suspends**. Because a Fly
volume binds to one machine, this app is **single-machine by design**
(`min_machines_running = 0`, `auto_stop = suspend` for cost). That's correct at
trial scale. To scale out later: implement `CreditsStore` over Postgres
(`ts/server/src/credits/store.ts` is the whole interface — the ledger logic on
top is storage-agnostic) and drop the `[mounts]` block.

### Backups (Litestream → R2)

A Fly volume is a **single copy on one physical host** — Fly's own docs warn that
hardware failure can destroy it, so the ledger needs an off-Fly backup. (Fly's
daily volume snapshots are a nice-to-have second line, not the strategy.) Stripe
is only a partial backstop: it can reconstruct *purchases* but knows nothing about
usage debits or free grants, so the ledger file is the real source of truth.

We replicate it with **[Litestream](https://litestream.io)** — purpose-built for a
single SQLite file on a single machine. It streams the WAL (we already run
`PRAGMA journal_mode = WAL`) to **Cloudflare R2** continuously (~1s lag) and gives
point-in-time restore. Because the ledger is append-only, a slightly-stale replica
just misses the most recent rows — no torn-write hazard.

Wiring (already in the image):

- `ts/server/litestream.yml` — replica config (db `${ALOUD_DB_PATH}` → R2 bucket),
  copied to `/etc/litestream.yml`.
- `ts/server/docker-entrypoint.sh` — the container entrypoint. On boot, if the
  volume has **no** ledger (fresh/replaced volume) it runs `litestream restore`
  from R2 first; then it runs the server under `litestream replicate -exec`. If
  the `R2_*` secrets are **absent** it just runs the server directly (so dev and
  self-host need zero backup setup).
- The Dockerfile copies the `litestream` binary from `litestream/litestream:0.3.13`.

One-time R2 setup (Cloudflare dashboard → R2): create a bucket (e.g.
`aloud-cloud`) and an **API token** scoped to it (Object Read & Write). That
gives you the Access Key ID / Secret Access Key and your account's S3 endpoint
(`https://<account-id>.r2.cloudflarestorage.com`). Set them as the `R2_*` secrets
above, then `fly deploy`.

> If you see an S3 `region` error on boot, change `region: auto` in
> `litestream.yml` to `us-east-1` — some SDK versions are picky with R2.

**Verify replication** (after a deploy, once the server has taken a write):

```bash
fly ssh console -a aloud-cloud -C "litestream snapshots /data/aloud.db"   # lists snapshots in R2
fly logs -a aloud-cloud | grep litestream                                  # "replicating to" lines
```

**Restore** (disaster recovery is automatic on a fresh volume; this is the manual
form, e.g. to a local file for inspection):

```bash
# On the box (or anywhere the R2_* env vars + litestream.yml are present):
litestream restore -o /tmp/aloud-restored.db /data/aloud.db
```

To force a full rebuild from R2 on the server: stop the machine, delete (or
recreate) the volume, and redeploy — the entrypoint restores automatically because
`/data/aloud.db` will be missing.

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

Run the **Deploy web app (UI → GitHub Pages)** GitHub Action
(`.github/workflows/deploy-web.yml`, manual). It builds the hosted UI into
`docs/app/` in the runner, then uploads the whole `docs/` tree (marketing site +
built app) straight to Pages as an artifact. **Nothing is committed back to the
branch**, so there's nothing to pull after a deploy.

One-time setup: set **Pages source to "GitHub Actions"** (Settings → Pages →
Build and deployment → Source). The custom domain (`aloud.rest`) is preserved via
`docs/CNAME`, which rides along in the artifact. The build output `docs/app/` is
gitignored — local `ui:build:hosted` runs won't dirty the tree.

Also set two repo **Variables** (Settings → Secrets
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
  npm run ui:build:hosted          # → repo-root docs/app/ (gitignored)
# Then publish docs/ to Pages yourself, e.g. via the gh-pages CLI or by
# re-running the workflow. docs/app/ is no longer committed.
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

**Account deletion + anti-farming (meditation-pal-8jc).** Settings → *Danger zone*
→ *Delete account* calls `DELETE /cloud/v1/me`, a **soft-delete**: the account is
anonymized and tombstoned (can't sign in), its identities are freed (so the same
Google/Apple/email can start fresh), and any remaining balance is forfeited — but
the append-only ledger rows stay for audit. Because the free grant costs real
money, it's gated on a hash of the **normalized email** (`auth/email-key.ts` —
case-, dot-, and `+tag`-invariant), recorded in an append-only `grant_keys` log
that **survives deletion**. So a deleted user can return and buy credits but can't
re-claim the freebie. No config; works on any store.

### Sign in with Apple — one-time Apple Developer setup

You have an Apple Developer membership; this is what to create (all in
[developer.apple.com](https://developer.apple.com) → Certificates, IDs & Profiles):

> **You do NOT need a Key.** Skip the **Keys** section entirely. This is a
> verify-only flow: the browser's Apple JS popup returns an `id_token` (JWT) that
> the server verifies against Apple's *public* JWKS (`auth/apple.ts`). The private
> `.p8` key is only for server-to-server token-endpoint calls (code exchange /
> refresh / revoke), which we don't make. If registering a Sign in with Apple
> **key** shows *"There are no identifiers available to associate"* — that's not a
> key problem, it's the prerequisite below: no App ID has the capability enabled
> yet (the same reason the Services ID's "Primary App ID" dropdown would be empty).

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
- [ ] R2 backup wired: `R2_*` secrets set; `fly logs | grep litestream` shows
      replication and `litestream snapshots /data/aloud.db` lists a snapshot
      (see [Backups](#backups-litestream--r2)).
- [ ] Google OAuth web client id created; `GOOGLE_CLIENT_IDS` set on the server.
      The UI then serves the sign-in button to any install via `/cloud/v1/config`
      (baking `VITE_GOOGLE_CLIENT_ID` is optional — it only avoids a one-probe
      delay). Without `GOOGLE_CLIENT_IDS` the client falls back to dev sign-in,
      which 404s in prod.
- [ ] (Optional) Apple Services ID created + `APPLE_CLIENT_IDS` set (see
      "Sign in with Apple" above). Email/password needs no setup.
- [ ] UI built with `VITE_ALOUD_CLOUD_URL` = the server origin.
- [ ] Server `ALOUD_CORS_ORIGINS` includes the UI origin **and the desktop
      webview origins**: `https://aloud.rest`, `tauri://localhost` (macOS /
      Linux), `http://tauri.localhost` (Windows). The desktop app calls this
      same server cross-origin from inside the Tauri webview; if its origins
      are missing, sign-in and credits fail **only on desktop**, which browser
      testing won't catch.
- [ ] Stripe live keys + webhook endpoint (`POST /cloud/v1/billing/webhook`)
      registered in the Stripe dashboard, if selling credits at launch.
- [ ] `ALOUD_ADMIN_TOKEN` set; spot-check `GET /cloud/v1/admin/metrics` for
      spend monitoring.

## Still open before charging real money

See [ts-server.md → Gaps](ts-server.md#gaps-before-a-real-deploy). The durable
store (this doc) is done; the remaining launch-blockers are real Google OAuth
in the UI (`meditation-pal-rfb`) and Stripe live keys (`meditation-pal-8sj`).
