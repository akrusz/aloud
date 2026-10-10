# Deploying aloud cloud and the web app

The runbook for the live deploy: a static UI talking to aloud cloud
(`@aloud/server`) over HTTPS, with accounts + credits.

Two halves, deployed together (see [Release deploys](#release-deploys-one-tag-ships-everything)):

| Half | What | Where | TLS |
|---|---|---|---|
| **Server** | `@aloud/server` (Hono): auth, credit ledger, metered LLM/STT/TTS proxy | a small always-on box - **Fly.io** here (Render/any VPS also fine) | Fly terminates TLS |
| **UI** | `ui/dist` (static Vite build) | GitHub Pages at `aloud.rest/app` (see [UI hosting](#ui-hosting-aloudrestapp)) | host-provided |

They're stitched together by two settings: the UI is **built** with
`VITE_ALOUD_CLOUD_URL` = the server's public origin, and the server is
**configured** with `ALOUD_CORS_ORIGINS` = every origin a client calls from.
That's the web UI origin **plus the app webview origins**: the desktop and
mobile apps call the same hosted server cross-origin, from `tauri://localhost`
(macOS / Linux), `http://tauri.localhost` (Windows), `capacitor://localhost`
(iOS) and `https://localhost` (Android). Leaving one out breaks sign-in/credits
on that platform only (a failure mode that's invisible in browser testing). Mic
capture needs a secure context, so the web halves must be real HTTPS (a
self-signed LAN cert won't do here).

---

## Release deploys: one tag ships everything

**Publishing a GitHub release is the deploy.** `.github/workflows/deploy-release.yml`
runs the Fly server deploy and then, only if it succeeded, publishes the hosted
web app built from the same tag. The desktop build rides the same release
(`tauri-release.yml`). So the browser app and the API it calls always ship
together, and `main` is somewhere you can merge without shipping.

The order is deliberate: **server first, web second.** New UI against an old
server is the skew that breaks (it calls fields that don't exist yet); an old
client against a new server is the permanent state of the world anyway, since
desktop and mobile update on their own schedule - which is also why the server
contract has to stay backward-compatible regardless.

What does *not* wait for a release:

- **Marketing pages** (`docs/index.html`, `/privacy`, `/terms`, …) publish on
  every push to `main` that touches `docs/`. Pages replaces the whole site on
  each deployment, so that run also rebuilds `docs/app` - from the **latest
  published release**, never from `main`. Vite's asset hashes are
  content-derived, so an unchanged app rebuilds to the same bytes.
- **Mobile** (Play / App Store) is out of band; a store build is its own trip.
- **`npm audit fix` commits** from `audit-autofix.yml` land on `main` and ship
  with the next release. If an advisory is urgent, cut one.

Re-running after a failure: the **Release deploy (server → web)** button takes a
tag, or use the individual **Deploy server (Fly)** / **Deploy web app** buttons -
both still accept a manual run.

---

## Server (Fly.io)

Files: `ts/server/Dockerfile`, `ts/server/fly.toml`, and
`.github/workflows/deploy-server.yml` (run by a release, or by hand). Everything runs from the **`ts/`
workspace root** because the server resolves `@aloud/core` (`../src`) at
runtime via tsx - the build context must include core's source.

### One-time setup

```bash
cd ts
# Create the app explicitly. Do NOT use `fly launch` here: it looks for fly.toml
# in the cwd (ts/), not server/, so --copy-config finds nothing and scaffolds a
# "blank app" with no build config.
fly apps create aloud-cloud                               # globally-unique name
fly volumes create aloud_data --size 1 --region sjc --app aloud-cloud   # durable ledger disk
```

> **Single volume on purpose.** Fly warns you to create two - say no. The ledger
> is one SQLite file pinned to one machine (see below); a second volume would
> mean a second, divergent ledger.

Then set the secrets (everything sensitive - never in `fly.toml`):

```bash
fly secrets set \
  ALOUD_SESSION_SECRET=$(openssl rand -hex 32) \
  GOOGLE_CLIENT_IDS=<your-web-oauth-client-id> \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-... \
  GEMINI_API_KEY=... \
  GOOGLE_TTS_API_KEY=... \
  AZURE_SPEECH_KEY=... \
  INWORLD_API_KEY=... \
  TYPESAFE_API_KEY=... \
  ALOUD_CORS_ORIGINS='https://<your-ui-host>,tauri://localhost,http://tauri.localhost,capacitor://localhost,https://localhost' \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  ALOUD_ADMIN_TOKEN=$(openssl rand -hex 32)
```

Then set the **R2 backup secrets** (see [Backups](#backups-litestream--r2) for why this
is not optional - the ledger is real money on a single volume):

```bash
fly secrets set \
  R2_BUCKET=aloud-cloud \
  R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  R2_ACCESS_KEY_ID=<r2-access-key-id> \
  R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
```

Required vs optional in production is enforced at boot (`loadConfig`, strict
mode): the server **refuses to start** without `ALOUD_SESSION_SECRET`,
`GOOGLE_CLIENT_IDS`, **`ALOUD_DB_PATH`** (set in `fly.toml` → the volume),
`ALOUD_CORS_ORIGINS`, and
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

Things that have bitten us. This is the money server (the credit ledger).

1. **`fly deploy` ships your whole working tree, not a commit.** The Docker build
   context is whatever's in `ts/` *right now*: uncommitted edits, and every
   commit on the current branch that isn't live yet. Run `git status` first and
   deploy from `main` or a branch you've deliberately readied. (A half-finished
   schema change once rode along with an unrelated deploy and crashed the boot.)

2. **A release marked `complete` does NOT mean the server booted.** It means
   the *config* rolled out; a broken image can still crash-loop. Hit it and
   watch the boot after deploying:

   ```bash
   curl https://aloud-cloud.fly.dev/health
   fly logs -a aloud-cloud                      # watch it boot; look for "aloud cloud up"
   ```

3. **Rolling back is one command.** Every release keeps its image; redeploy a
   previous one by digest:

   ```bash
   fly releases -a aloud-cloud --image          # find a known-good DOCKER IMAGE ref
   fly deploy --image <that-ref> --config server/fly.toml -a aloud-cloud
   ```

   A rollback swaps the code image only; the volume (the ledger) is untouched.

4. **Build it locally first when the Dockerfile changed**: `docker build -f
   server/Dockerfile -t aloud-cloud .` from `ts/` is the same build Fly runs.

### Durability & scale

The credit ledger is a SQLite file (`SqliteCreditsStore`, `node:sqlite`) on the
mounted volume at `/data/aloud.db`, so balances survive restarts and redeploys.
Because a Fly volume binds to one machine, this app is **single-machine by
design** (`min_machines_running = 1`, kept warm so the first turn after an idle
stretch has no cold start; `auto_stop_machines = "stop"`, never `"suspend"`,
see below). To scale out later: implement `CreditsStore` over Postgres
(`ts/server/src/credits/store.ts` is the whole interface - the ledger logic on
top is storage-agnostic) and drop the `[mounts]` block.

### Backups (Litestream → R2)

A Fly volume is a **single copy on one physical host** - Fly's own docs warn that
hardware failure can destroy it, so the ledger needs an off-Fly backup. (Fly's
daily volume snapshots are a nice-to-have second line, not the strategy.) Stripe
is only a partial backstop: it can reconstruct *purchases* but knows nothing about
usage debits or free grants, so the ledger file is the real source of truth.

We replicate it with **[Litestream](https://litestream.io)** - purpose-built for a
single SQLite file on a single machine. It streams the WAL (we already run
`PRAGMA journal_mode = WAL`) to **Cloudflare R2** continuously (~1s lag) and gives
point-in-time restore. Because the ledger is append-only, a slightly-stale replica
just misses the most recent rows - no torn-write hazard.

Wiring (already in the image):

- `ts/server/litestream.yml` - replica config (db `${ALOUD_DB_PATH}` → R2 bucket),
  copied to `/etc/litestream.yml`.
- `ts/server/docker-entrypoint.sh` - the container entrypoint. On boot, if the
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
> `litestream.yml` to `us-east-1` - some SDK versions are picky with R2.

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
recreate) the volume, and redeploy - the entrypoint restores automatically because
`/data/aloud.db` will be missing.

### Durability validation

A real credit purchase was once acknowledged by the webhook and then **lost**
across an idle suspend + redeploy (meditation-pal-5iv4). The fixes are
`auto_stop_machines = "stop"` (a clean SIGTERM, so SQLite closes and Litestream
does a final sync, instead of a frozen VM) and `PRAGMA synchronous = FULL`
(fsync the WAL every commit). **Re-validate after any change to `fly.toml`'s
machine lifecycle, `litestream.yml`, or the entrypoint** - those are exactly the
knobs that can silently undo the fix.

The harness is `ts/server/scripts/durability-probe.sh` (`write` / `check` /
`cleanup`): it writes an isolated marker (a retreat pass, same SQLite file + WAL
as the ledger, without polluting it) and asserts it survived. It needs
`ALOUD_ADMIN_TOKEN` (or a signed-in admin session JWT from the panel console,
`localStorage.getItem('aloud-admin-token')`); `ALOUD_BASE_URL` points it at a
non-prod app.

**Precheck - is the fix running?** `fly config show` collapses `"stop"` to the
legacy boolean `true` (only `"suspend"` renders as a string); the machine-level
value is unambiguous:

```bash
fly machine list -j -a aloud-cloud | python3 -c "import sys,json; print([s.get('autostop') for m in json.load(sys.stdin) for s in (m.get('config') or {}).get('services',[])])"
```

**Test 1 - a write survives a power-down + redeploy.** Run
`./durability-probe.sh write`, let the machine stop, redeploy onto the same
volume, then `./durability-probe.sh check` (and `cleanup`). An explicit `fly
machine stop` is a clean SIGTERM and proves less than an automatic power-down,
and with `min_machines_running = 1` prod's warm machine is never auto-stopped,
so use a staging app at 0. For teeth, run it once on `"suspend"` and confirm it
**fails**. A failure on `"stop"` means escalate to Postgres (meditation-pal-sk9s).

**Test 2 - restore after total volume loss** (the Litestream DR claim).
**Destructive: staging app only**, with its replica on a separate R2 prefix:

```bash
export ALOUD_BASE_URL=https://<staging-app>.fly.dev
./durability-probe.sh write
fly ssh console -a <staging-app> -C "litestream snapshots /data/aloud.db"   # wait for a fresh snapshot
fly machine stop -a <staging-app> <machine-id>
fly volume destroy -a <staging-app> <volume-id>                            # simulate hardware loss
fly volume create aloud_data --size 1 --region sjc -a <staging-app>
fly deploy --config server/fly.toml -a <staging-app>                       # entrypoint runs `litestream restore`
./durability-probe.sh check
```

A failure here is the more dangerous bug (you'd find it only in a real
disaster): fix `litestream.yml` / the entrypoint until it passes.

### Render / VPS alternative

The Dockerfile is host-agnostic. On Render: a Docker web service, root
directory `ts`, Dockerfile path `server/Dockerfile`, a persistent disk mounted
at `/data`, and the same env vars. Any box with Node 22 can also run it
directly: `cd ts && npm ci && ALOUD_ENV=production ALOUD_DB_PATH=/var/lib/aloud/aloud.db npm run start -w @aloud/server` behind a TLS-terminating reverse proxy.

---

## UI hosting (aloud.rest/app)

The browser app is a **subpath under the GitHub Pages site**: built with Vite
`base: '/app/'` into `docs/app/`, so it serves at `https://aloud.rest/app/`
alongside the marketing site at `/`. The SPA router is base-path aware
(`ui/src/route-base.ts`) and `docs/404.html` carries the deep-link redirect.

### Deploy: the workflow

`.github/workflows/deploy-web.yml` builds the hosted UI into `docs/app/` in the
runner, then uploads the whole `docs/` tree (marketing site + built app) to Pages
as an artifact. **Nothing is committed back to the branch**, so there's nothing
to pull after a deploy.

It runs three ways, and **which app it builds depends on how it was triggered**:

| Trigger | Marketing pages | `docs/app` |
|---|---|---|
| Push to `main` touching `docs/` | that commit | latest published release |
| Release (via `deploy-release.yml`) | `main` | the release tag |
| Manual button | the branch you run it from | `app_ref` input, else latest release |

The app is never built from `main` (except on a repo with no releases at all,
which warns) - that's what keeps the hosted client in step with the server.

Repo settings it depends on (set once):

- **Pages source = "GitHub Actions"** (Settings → Pages → Build and deployment).
- A **`v*` tag rule** on the `github-pages` environment (Settings →
  Environments → github-pages → Deployment branches and tags). Pages ships with
  a default-branch-only policy and a release deploy runs under the tag, so
  without the rule it fails with *"Tag v2.3.0 is not allowed to deploy to
  github-pages"* (hit on v2.3.0). Recovery if it resurfaces: run **Deploy web
  app** from `main` with `app_ref` set to the tag.
- Repo **Variables** (Settings → Secrets and variables → Actions):
  `ALOUD_CLOUD_URL`, the hosted `/cloud` origin (e.g.
  `https://aloud-cloud.fly.dev`), and optionally `GOOGLE_CLIENT_ID`, the web
  OAuth client id. The UI discovers the client id at runtime from
  `GET /cloud/v1/config` (`setRuntimeGoogleClientId`), so baking it only lets
  the button paint before that probe resolves.

The custom domain (`aloud.rest`) rides along in the artifact as `docs/CNAME`.

### Building it by hand

```bash
cd ts
VITE_ALOUD_CLOUD_URL=https://aloud-cloud.fly.dev \
  VITE_GOOGLE_CLIENT_ID=<web-oauth-client-id> \
  npm run ui:build:hosted          # → repo-root docs/app/ (gitignored)
```

Only `ui:build:hosted` (base `/app/`) writes `docs/app`; the dev/desktop build
(`npm run ui:build`, base `/` → `ui/dist`) doesn't touch it.

---

## Sign-in methods (meditation-pal-s75)

Three methods, all behind the one account model (accounts ↔ identities). The UI
discovers which OAuth methods to show at runtime from `/cloud/v1/config`, so
nothing needs baking into the build.

- **Email/password** - always on, zero config. New email accounts get **no free
  credits** until they connect Google or Apple (the anti-farming lever,
  meditation-pal-116).
- **Google** - set `GOOGLE_CLIENT_IDS` (see below). Trusted → connecting unlocks
  the free grant.
- **Apple** - set `APPLE_CLIENT_IDS`. Trusted, same as Google.

**Account deletion + anti-farming (meditation-pal-8jc).** Account → *Danger zone*
→ *Delete account* calls `DELETE /cloud/v1/me`, a **soft-delete**: the account is
anonymized and tombstoned (can't sign in), its identities are freed (so the same
Google/Apple/email can start fresh), and any remaining balance is forfeited - but
the append-only ledger rows stay for audit. Because the free grant costs real
money, it's gated on a hash of the **normalized email** (`auth/email-key.ts` - case-, dot-, and `+tag`-invariant), recorded in an append-only `grant_keys` log
that **survives deletion**. So a deleted user can return and buy credits but can't
re-claim the freebie. No config; works on any store.

### Sign in with Apple (web) - Apple Developer setup

All in [developer.apple.com](https://developer.apple.com) → Certificates, IDs &
Profiles. Two things that cost time the first time:

- **No Key is needed.** This is a verify-only flow: the browser's Apple JS popup
  returns an `id_token` that the server verifies against Apple's *public* JWKS
  (`auth/apple.ts`). The `.p8` key is only for token-endpoint calls (code
  exchange / refresh / revoke), which we don't make. If registering a key shows
  *"There are no identifiers available to associate"*, no App ID has the
  capability enabled yet (the same reason the Services ID's "Primary App ID"
  dropdown would be empty).
- **The token's `aud` differs by platform.** A native iOS token carries the
  **App ID / bundle id** (`app.aloud.meditation`); a web token carries a
  separate **Services ID**, which can't reuse the bundle id string
  (`app.aloud.meditation.web`). `APPLE_CLIENT_IDS` takes both, comma-separated,
  and the server accepts a token whose `aud` matches any of them.

1. **App ID** `app.aloud.meditation`: enable **Sign in with Apple** (Edit →
   Capabilities).
2. **Services ID** `app.aloud.meditation.web` (Identifiers → +, type Services
   IDs): enable **Sign in with Apple**, click **Configure**. Primary App ID
   `app.aloud.meditation`; Domain `aloud.rest`; Return URL
   `https://aloud.rest/app/`, the exact origin + base path the UI posts back to
   (`redirectURI` in `ui/src/apple-signin.ts`). Add `https://localhost:4649/`
   to test Apple locally.
3. `fly secrets set APPLE_CLIENT_IDS=app.aloud.meditation.web` (append
   `,app.aloud.meditation` when the native app ships) and redeploy. List the
   **web Services ID first**: the client reads the first id from
   `/cloud/v1/config`.

Apple's web popup requires HTTPS and an exact Return URL match; a mismatch is
the usual "it silently won't open" cause. The id token's `email` may be a
private-relay address, and Apple omits it on repeat sign-ins (the identity is
already linked by then).

---

## Wiring checklist (standing up a new instance)

- [ ] Server deployed; `GET /health` returns `ok:true` with your providers.
- [ ] Volume mounted; `ALOUD_DB_PATH=/data/aloud.db` (balances persist across a
      `fly deploy`).
- [ ] `R2_*` secrets set and replication verified
      (see [Backups](#backups-litestream--r2)).
- [ ] Google OAuth web client id created; `GOOGLE_CLIENT_IDS` set on the server.
      Without it the client falls back to dev sign-in, which 404s in prod.
- [ ] (Optional) Apple Services ID created + `APPLE_CLIENT_IDS` set.
      Email/password needs no setup.
- [ ] UI built with `VITE_ALOUD_CLOUD_URL` = the server origin.
- [ ] Server `ALOUD_CORS_ORIGINS` = the UI origin **and every app webview
      origin** (top of this doc): a missing one fails sign-in and credits on
      that platform only, which browser testing won't catch.
- [ ] Stripe live keys + webhook endpoint (`POST /cloud/v1/billing/webhook`)
      registered in the Stripe dashboard.
- [ ] `ALOUD_ADMIN_TOKEN` set; spot-check `GET /cloud/v1/admin/metrics`.

Standing limits: [ts-server.md → Known limits](ts-server.md#known-limits).
