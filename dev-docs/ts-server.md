# Running aloud cloud (`@aloud/server`)

aloud cloud - a Hono proxy with Google/Apple/email auth, a credit ledger, and
metered LLM/STT/TTS billing. Lives at `ts/server/`, a workspace package of `ts/`
(`@aloud/core`). Design rationale is in `ts/server/README.md`; this file is the
operational quick-reference. Deploying it: [deploy.md](deploy.md).

## Run it

```bash
cd ts            # the workspace root
npm install      # installs server deps too (hoisted; server is a workspace)

cd ts/server
npm run dev      # tsx watch - boots on :8787 with an in-memory store, no secrets
npm test         # vitest
npm run typecheck
```

Smoke-test a running instance:

```bash
curl localhost:8787/health                # {"ok":true,"providers":[...],"billing":bool}
curl localhost:8787/cloud/v1/me/models    # public: models, per-token cost, usdPerCredit, packMarkup,
                                          #   plus the sttCreditsPerHour / utilityCreditsPerHour legs
                                          #   the setup footer composes with a model's rate
curl localhost:8787/cloud/v1/me/estimates # public: credit-use bands per model/STT/voice
curl localhost:8787/cloud/v1/me/packs     # public: credit packs for sale
```

`npm run dev` (watch) vs `npm start` (one-shot) - both run via `tsx`, which
resolves the `@aloud/core` path alias at runtime so the proxy reuses core's
provider classes (`AnthropicProvider`, etc.) for request-building and
token-usage parsing. Billing rides on that shared usage split - that's the
whole reason the server lives in this monorepo.

## Dev mode vs production mode

The boundary is the `ALOUD_ENV` env var (`loadConfig` in `config.ts`):

| | Dev (default) | Production (`ALOUD_ENV=production`) |
|---|---|---|
| Missing secrets | boots with stubs (`dev-insecure-secret`, in-memory store) | **refuses to start** unless session secret + ≥1 Google client id + ≥1 provider key are set |
| Content-check in logger | throws on a stray content field (catches mistakes loudly) | downgrades to drop-the-field (a logging slip can't crash a paying request) |
| Stripe unset | billing routes report "not configured"; runs on free-grant only | same, but you'll want it configured |

Solvency is enforced in **both** modes: `assertSolvent(CREDIT_PACKS)` in
`index.ts` refuses to boot if any credit pack's markup can't clear the worst
channel's commission (incl. the 15% IAP floor). See `pricing/commission.ts`.

## Configuration

Copy `ts/server/.env.example` → `.env` (gitignored) and fill in, or set these
as host secrets (Fly/Render). Full annotated list is in `.env.example`; the
load logic is `loadConfig` in `config.ts`.

| Var | Needed for | Notes |
|---|---|---|
| `ALOUD_ENV` | toggle prod checks | `production` or unset |
| `PORT` | - | default 8787 |
| `ALOUD_CORS_ORIGINS` | browser client | comma-sep; the `ui/dist` host origin(s) |
| `ALOUD_DB_PATH` | durable credit ledger | SQLite file path (e.g. `/data/aloud.db` on a Fly volume); **required in prod**. Unset in dev → in-memory store, lost on restart |
| `ALOUD_SESSION_SECRET` | signing session JWTs | `openssl rand -hex 32`; required in prod |
| `GOOGLE_CLIENT_IDS` | sign-in | comma-sep web/iOS/android client ids; required in prod |
| `APPLE_CLIENT_IDS` | Apple sign-in | comma-sep Services ID (web) / bundle id (native); empty disables Apple. Email/password needs no config (meditation-pal-s75) |
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | LLM forwarding | ≥1 required in prod; server-held, never sent to client |
| `GEMINI_API_KEY` | value-tier LLM (Gemini direct) | Google AI Studio key; powers `gemini-2.5-flash-lite` without OpenRouter's fee |
| `OPENAI_API_KEY` | server STT (default) + premium LLM + OpenAI TTS | one key drives `/cloud/v1/stt` (Whisper; server default `gpt-transcribe`, ≈ $0.27/hr, which is also what the app's "aloud cloud" STT choice asks for), the GPT LLM, and OpenAI voices. `OPENAI_STT_API_KEY` splits STT onto its own key |
| `STT_API_KEY` (+ `STT_PROVIDER` / `STT_BASE_URL` / `STT_MODEL`) | server STT (override) | point STT at any OpenAI-compatible `/audio/transcriptions` host (OpenAI/Groq/self-hosted). See `config.ts` `resolveSttConfig` |
| `GOOGLE_TTS_API_KEY` | server TTS | Google Cloud TTS key (Cloud TTS API enabled); distinct from `GEMINI_API_KEY`. Unset → `/cloud/v1/tts` reports not-configured, client falls back to browser TTS |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | server TTS | Azure AI Speech key + region (region defaults to `eastus`). Unset → the Azure voices drop out of `GET /cloud/v1/voices`, including the flagged default Harper, and `defaultVoice()` falls down `DEFAULT_VOICE_CHAIN` to Leda/Polaris. Azure bills SSML markup and counts each CJK char twice; `providers/tts.ts azureBilledChars` is what the meter charges on |
| `ALOUD_FREE_SIGNUP_CREDITS` | free tier | default 20 (≈ $1 provider cost). Granted on CONNECTING a trusted, verified identity (Google/Apple), not on signup - once per account, once per identity (meditation-pal-116, `quota/freetier.ts` `decideConnectGrant`) |
| `ALOUD_FREE_GRANT_BUDGET_PER_HOUR` | abuse brake | default 2000 (≈ 100 signups/hr) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | buying credits | optional; without them, free-grant only |
| `ALOUD_ADMIN_TOKEN` | `/cloud/v1/admin/*` + panel | static operator bearer token; admin is disabled (404, not open) unless this or `ALOUD_ADMIN_EMAILS` is set |
| `ALOUD_ADMIN_EMAILS` | `/cloud/v1/admin/*` + panel | comma-separated emails whose signed-in sessions get admin access - the panel's Google sign-in path, so a phone never holds the static token |

### Keys for the full hosted pipeline

The whole meditation loop can run through the server:

| Hop | Provider | Key |
|---|---|---|
| LLM (premium) | Anthropic | `ANTHROPIC_API_KEY` |
| LLM (value tier) | Google Gemini (direct) | `GEMINI_API_KEY` |
| STT | OpenAI Whisper (default) | `OPENAI_API_KEY` |
| TTS | Google Cloud TTS | `GOOGLE_TTS_API_KEY` |

### Minimal "actually forward an LLM turn" setup

```bash
cd ts/server
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY=sk-ant-...   (or GROQ / OPENROUTER)
npm run dev
# /health now shows that provider under "providers"
```

`/cloud/v1/llm/complete` still requires a valid session (a Bearer token from
`POST /cloud/v1/auth/google`), so end-to-end forwarding needs a real Google ID
token. The route-level logic is unit-tested against the in-memory store in
`tests/app.test.ts` without network.

## Running the full loop locally (UI ↔ server)

The browser UI can drive the metered proxy end-to-end. The `aloud cloud`
provider in Setup/Settings routes LLM turns through this server instead of
BYOK or a local provider.

```bash
# Terminal 1 - the server (needs a real provider key to actually complete)
cd ts/server
cp .env.example .env        # set ANTHROPIC_API_KEY (or GROQ / OPENROUTER)
npm run dev                 # :8787

# Terminal 2 - the UI (Vite proxies /app/v1 + /cloud/v1 → :8787; override via ALOUD_CLOUD_URL)
cd ts
npm run ui:dev              # :4649
```

In the UI: pick provider **aloud cloud**, choose a model (the picker is
populated live from `GET /cloud/v1/me/models`), start a session. On first LLM
turn the UI auto-signs-in via the dev route and caches the token.

**On the hosted provider, STT and TTS also route through the server** - `/cloud/v1/stt` (OpenAI Whisper by default) and `/cloud/v1/tts` (Google), so the whole
pipeline runs server-side. STT needs `OPENAI_API_KEY` (or any backend via the
`STT_*` overrides - see `config.ts` `resolveSttConfig`); TTS needs
`GOOGLE_TTS_API_KEY` (without it the client falls back to browser
`speechSynthesis`). Wiring: `stt-picker.createServerAloudStt`
and `tts-picker.createCloudAloudTts`, selected in `views/session.ts` when
`setup.provider === 'aloud'`.

**Auth - dev shortcut.** `/cloud/v1/llm/complete` is behind bearer auth. On a
dev build with no Google client id configured, `ensureCloudToken()`
(`ui/src/cloud-auth.ts`) falls back to `POST /cloud/v1/auth/dev` - a
**local-only** route that mints a session for a fixed `dev@localhost` account
(seeded with `ALOUD_FREE_SIGNUP_CREDITS`, auto-refilled when it runs dry). It
**404s in production** (strict mode), so it's a dev convenience, not a backdoor.
Client wiring: `ui/src/cloud-auth.ts` (token) + `ui/src/adapters/cloud-llm.ts`
(`complete` + SSE `completeStream`).

Quick handshake without the UI:

```bash
TOK=$(curl -s -X POST localhost:8787/cloud/v1/auth/dev | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:8787/cloud/v1/me -H "authorization: Bearer $TOK"    # account + balance
curl -s -X POST localhost:8787/cloud/v1/llm/complete -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"provider":"anthropic","model":"claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
```

## Routes

Wired in `app.ts`; the entire client↔server wire surface is `contract.ts`.

Everything except `/health` is mounted under **`/cloud/v1`** (the app's own
backend is the separate `/app/v1` group, also served here in browser dev).

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | public | liveness + what's configured |
| `GET /cloud/v1/config` | public | build-agnostic client bits before sign-in: the Google/Apple client ids (first of `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS`). Lets any install render OAuth sign-in without baking ids in at build |
| `POST /cloud/v1/auth/google` | public (optional bearer) | verify Google ID token; sign in, or on a first connect create/link an account and grant free credits per the connect rules. With a bearer token it LINKS Google to that account (the "connect to claim credits" flow) |
| `POST /cloud/v1/auth/google/desktop` | public (optional bearer) | the desktop loopback-PKCE variant (exchanges an auth code server-side) |
| `POST /cloud/v1/auth/apple` | public (optional bearer) | same as google for Sign in with Apple (verifies vs Apple JWKS; needs `APPLE_CLIENT_IDS`) |
| `POST /cloud/v1/auth/email/signup` | public (optional bearer) | create an email/password account (scrypt hash). UNTRUSTED → no free credits until it connects Google/Apple (meditation-pal-116). Optional `emailUpdates` body flag carries the signup opt-in |
| `POST /cloud/v1/auth/email/login` | public | email/password sign-in; one generic 401 for wrong-password / unknown-email |
| `POST /cloud/v1/auth/email/set-password` | session | add/change a password on an OAuth-created account |
| `POST /cloud/v1/auth/dev` | public (dev only) | local dev sign-in; mints a session for `dev@localhost`. 404s in production |
| `GET /cloud/v1/me` | session | account + live balance |
| `PATCH /cloud/v1/me` | session | flip the email-updates opt-in (`{emailUpdates: boolean}`); returns the updated account view |
| `DELETE /cloud/v1/me` | session | soft-delete the account (see deploy.md → Sign-in methods). Also clears the email-updates opt-in with the scrubbed address |
| `GET /cloud/v1/me/models` `/estimates` `/packs` | public | published pricing (`/packs` also advertises the x402 channel) |
| `POST /cloud/v1/llm/complete` | session | metered proxy: hold → forward → settle to actual cost (SSE or JSON) |
| `POST /cloud/v1/stt` | session | metered STT: raw mono PCM body (`?format=i16`, or Float32 from older clients) → Whisper (OpenAI by default; `?model=` picks gpt-transcribe, which current clients send) → transcript; debits by duration |
| `POST /cloud/v1/tts` | session | metered TTS: `{text,voice?,rate?}` → Google Cloud TTS → audio/mpeg; cost in headers |
| `POST /cloud/v1/billing/checkout` | session | start Stripe Checkout for a pack |
| `POST /cloud/v1/billing/webhook` | Stripe sig | credit the ledger after signature verify |
| `POST /cloud/v1/billing/x402/buy/:packId` | session + payment | USDC-on-Base pack purchase (402 → sign → settle). Config-gated; see [x402.md](x402.md) |
| `/cloud/v1/gifts/*` | mixed | gift-credit purchase + redemption (`routes/gifts.ts`) |
| `GET /cloud/v1/voices` | public | curated hosted voices (empty when TTS unconfigured) |
| `POST /cloud/v1/incidents` | session | the app reports a cloud failure it handled quietly (kind from `CLIENT_INCIDENT_KINDS`, optional one-line detail, provider/model/session ids); feeds the admin Incidents section |
| `GET /cloud/v1/admin` | none* | operator control panel HTML (`*` served only when admin access is configured) |
| `GET /cloud/v1/admin/metrics` | admin | ledger aggregates for spend monitoring |
| `GET /cloud/v1/admin/usage` | admin | cost-attribution report from usage telemetry (`?sinceHours=&excludeAdmin=1`, plus the real-sit bar: `all=1` for every session, or `sitMinutes=`/`sitTurns=` to override `DEFAULT_REAL_SIT` - 5 turns AND 5 min - which filters distributions and per-hour rates together). Response also carries `perHour.pooled` (unweighted total/total beside the account-weighted rates), `perHour.tokensPerTurn`, and `sessionRows`: itemized sessions for `ALOUD_ADMIN_EMAILS` accounts only - real users stay aggregate |
| `GET /cloud/v1/admin/usage/history` | admin | daily trend buckets (usage + gross revenue per UTC day), computed live (`?days=&excludeAdmin=1`) |
| `GET /cloud/v1/admin/usage/provider-daily` | admin | per-provider per-UTC-day spend for invoice reconciliation (never filtered) |
| `GET /cloud/v1/admin/incidents` | admin | incident log (`?sinceHours=&excludeAdmin=1`): what the app handled quietly on the cloud path - blank completions with finish reason + tokens, upstream LLM/STT/TTS failures, refused 402s, and `client_*` rows the app reports itself (`POST /cloud/v1/incidents`). Grouped by kind plus the newest rows; content-free by construction (`credits/incidents.ts`) |
| `GET /cloud/v1/admin/accounts` | admin | every account + derived balance / granted / spent / paid flag / last metered call |
| `GET /cloud/v1/admin/accounts/:id` | admin | one account + its full ledger (audit trail) |
| `POST /cloud/v1/admin/grant` | admin | `{email, credits}` → grant credits (ledger `signup_grant`, reason `admin_grant`) |
| `POST /cloud/v1/admin/accounts/:id/delete` | admin | soft-delete an account (the panel's typed-email confirm flow) |
| `GET /cloud/v1/admin/retreats` | admin | retreat passes with rosters + real provider spend so far |
| `POST /cloud/v1/admin/retreats` | admin | create a pass (date window, optional spend cap) |
| `POST /cloud/v1/admin/retreats/:id/members` | admin | add an attendee by email; no account yet → pending invite that binds on first sign-in |
| `POST /cloud/v1/admin/retreats/:id/revoke` | admin | revoke a pass; coverage stops for every member |
| `GET /cloud/v1/admin/config` | admin | live effective knobs (free credits, pause, testers) + pricing context |
| `PUT /cloud/v1/admin/config` | admin | `{freeSignupCredits?, freeGrantBudgetPerHour?, meteredPaused?, testerEmails?}` → retune live + persist |

"admin" auth = the `ALOUD_ADMIN_TOKEN` bearer, or a normal session token whose
verified account email is in `ALOUD_ADMIN_EMAILS` (see the panel section).

### Admin control panel

Browse to `/cloud/v1/admin` on the server (e.g.
`https://aloud-cloud.fly.dev/cloud/v1/admin`) - a single self-contained page
(`src/admin/panel.ts`) for spend monitoring, account lookup, credit grants,
account deletion (typed-email confirm), and retreat passes.
Two ways in, both kept in this origin's localStorage and sent as a Bearer
header (never baked into the page):

- **Paste `ALOUD_ADMIN_TOKEN`** - the original path; still what scripts/curl use.
- **Sign in with Google** (`ALOUD_ADMIN_EMAILS`) - for the road: the device
  holds a 7-day session JWT instead of the root token. The gate
  (`routes/admin.ts` `authFailure`) requires the session account's email to be
  on the list AND verified, so an email-signup squatting on an admin address
  can't pass. Remove the email from the env to revoke. The sign-in button uses
  the FIRST id in `GOOGLE_CLIENT_IDS` (the web client), and that OAuth client
  must list the server's origin (e.g. `https://aloud-cloud.fly.dev`) under
  "Authorized JavaScript origins" in the Google Cloud console.

With neither configured the panel and every `/admin/*` endpoint 404 - disabled, not open.

**Tunable free-credit knobs.** The panel's *Free credits* section sets
`freeSignupCredits` and the global hourly `freeGrantBudgetPerHour` live (no
redeploy) via `PUT /cloud/v1/admin/config`. Set either to **0** to stop handing out
free credits while testing. Overrides persist in the store's `settings` KV
(`free_signup_credits`, `free_grant_budget_per_hour`) and are folded over the
env defaults at boot (`loadRuntimeOverrides`), so they survive a restart - a
persisted panel override wins over `ALOUD_FREE_SIGNUP_CREDITS` /
`ALOUD_FREE_GRANT_BUDGET_PER_HOUR` on subsequent boots. See
`src/admin/runtime-config.ts`.

**Soft-launch spend pause.** The panel's *Soft launch* section sets
`meteredPaused` + a `testerEmails` allowlist (also persisted; env seeds
`ALOUD_METERED_PAUSED=1` / `ALOUD_TESTER_EMAILS`). While paused, a conversation
call (`POST /cloud/v1/llm/complete`) from a non-tester returns a graceful 200
turn - `FREE_LIMIT_MESSAGE`, **cost 0, no hold** - instead of a real billed
response (`isMeteredBlocked` short-circuits before the hold). So users keep their
granted credits, the facilitator says "come back later," TTS speaks it, and the
session saves normally. STT/TTS stay open so that message can be heard; tester
emails bypass the pause entirely. In-flight clients only see it on their next
turn (live-reload is a follow-up - meditation-pal).

## Hosted voices & auditioning new ones

The curated hosted voices live in `src/providers/voice-catalog.ts` - a short-name
→ (provider, voice id) map across Google Cloud TTS, OpenAI and Azure AI Speech
(the flagged default, Harper, is an Azure MAI-Voice-2 voice). `GET
/cloud/v1/voices` publishes them; the client merges them into its picker (top
"Recommended" tier) and sends the short name back, which `/cloud/v1/tts`
resolves. To add more: audition, then append the winners to `CURATED_VOICES`.

`scripts/preview-voices.ts` synthesizes one meditation sample per voice, measures
the resulting audio, and writes `voice-previews/index.html` (gitignored) - a
sortable, filterable page with a player per voice, a shortlist that emits
paste-ready `CURATED_VOICES` lines, and `space`/`j`/`k`/`s` shortcuts.

Run it from **anywhere in the repo** through the npm delegate. Note the `--`,
which passes the rest of the arguments through; and note that there is also a
`scripts/` directory at the repo root, so calling the file by a bare relative
path from the wrong one fails with a confusing `MODULE_NOT_FOUND`.

```bash
npm run voices -- curated         # only what we already ship (the default)
npm run voices -- google          # ~130 Google voices, all English locales
npm run voices -- openai gemini   # several sources at once
npm run voices -- all             # every source with a key
npm run voices -- google --locales=en-US,en-GB,en-AU
npm run voices -- google --filter=Chirp3-HD --limit=12
npm run voices -- curated --prosody       # every prosody treatment, side by side
npm run voices -- all --rate=0.85         # at session pace
```

Runs **merge**: auditioning one source adds to the page rather than replacing
it, so building up google, then openai, then a new candidate as its key arrives
works, and a quick spot-check does not destroy a roster that took minutes to
render. `--fresh` starts over. State lives in `voice-previews/rows.json`.

Keys on the page: `e` play/pause, `w`/`s` prev/next, `f` shortlist (space is
left alone so it still scrolls).

`curated` is the default and shows **only the voices already in
`CURATED_VOICES`** - it is the set-the-defaults pass, not the discovery one.
To find new voices, name a source. Google alone has ~130 English voices across
en-US/en-GB/en-AU (30 Chirp3-HD per locale, plus Neural2 and Standard), which
is roughly $0.70 and a few minutes to audition in full.

Sources are declared in `scripts/audition/sources.ts` - roster, synth call,
prosody treatments, and cost model per engine. Beyond the three we ship it carries
key-gated adapters for Gemini TTS, Cartesia, Deepgram Aura-2 and Inworld;
anything without a key is skipped and listed on the page with a signup link, so a
partial run still produces a usable page. The keys are documented in
`.env.example` under "Voice-audition keys":

| Env var | Engine | Billing | Get a key |
|---|---|---|---|
| `GOOGLE_TTS_API_KEY` | Google Cloud TTS *(ships)* | per char | [console](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com) |
| `OPENAI_API_KEY` (or `OPENAI_TTS_API_KEY`) | OpenAI gpt-4o-mini-tts *(ships)* | per second | [platform](https://platform.openai.com/api-keys) |
| `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` | Azure AI Speech *(ships)* | per char (SSML tags billed; CJK ×2) | [portal](https://portal.azure.com) |
| `GEMINI_API_KEY` | Gemini TTS - already set for the LLM | per second | [AI Studio](https://aistudio.google.com/apikey) |
| `CARTESIA_API_KEY` | Cartesia Sonic 3 | per char | [play.cartesia.ai](https://play.cartesia.ai/keys) |
| `INWORLD_API_KEY` | Inworld TTS | per char | [platform.inworld.ai](https://platform.inworld.ai) |
| `DEEPGRAM_API_KEY` | Deepgram Aura-2 | per char | [console](https://console.deepgram.com/signup) | These adapters are audition-only on
purpose - promoting one means adding it to `src/providers/tts.ts`, the
`TtsProvider` union, and `pricing/providers.ttsRateFor` before it can bill.

Two things the page exists to make visible:

- **Cost is measured, not quoted.** Half these engines bill by audio *duration*,
  and every "$/1M chars" figure they publish assumes conversational pace. aloud
  speaks slowly, so a duration-priced engine costs materially more than its
  sticker. The page prices every clip from its real measured length (`ffprobe`,
  `afinfo` fallback) per *spoken* character, which is the only cross-source
  comparison worth making. Measured at our own instruction: OpenAI lands at
  $16-20/1M (bracketing the reconciled $19 in `pricing/providers.ts`), and Gemini
  TTS at $25-43/1M - i.e. **at or above** the $30/1M Chirp3-HD it is widely
  claimed to undercut.
- **Prosody differs enormously by engine.** Google honors SSML `<prosody>` +
  `<break>` on *both* tiers, Chirp3-HD included, despite the docs historically
  listing SSML as WaveNet/Neural2-only (verified: a 15.0s line goes to 22.8s
  under rate 80% + 1400ms breaks). That is the strongest pacing lever available
  and it is on the engine we already ship. But Google bills the tags, so marked-up
  speech costs roughly double per spoken word - which is why Neural2 + SSML lands
  at the same $30/1M as flat Chirp3-HD, and why that A/B is the interesting
  listen. OpenAI/Gemini/Inworld take a natural-language style instruction only
  (weakly honored - see meditation-pal-5yi1); Deepgram Aura-2 exposes no prosody
  control at all.

Needs `GOOGLE_TTS_API_KEY`, `OPENAI_API_KEY` and/or `AZURE_SPEECH_KEY` in `.env`
for the shipping sources. Costs a few cents (one short clip per voice per treatment).

## Known limits

The launch gaps (durable store, real OAuth in the UI, prompt caching, deploy
infra) are all closed - the server is live on Fly with a SQLite ledger, Google /
Apple / email sign-in, Anthropic 5m+1h prompt caching (`ts/src/llm/anthropic.ts`),
and Stripe. What's left:

- **Single-machine by design.** The ledger is one SQLite file on one Fly volume.
  Scaling out means implementing `CreditsStore` (`credits/store.ts`) over
  Postgres. See [deploy.md](deploy.md) → Durability & scale.
- **x402 is flag-gated off** pending mainnet ops (tax, off-ramp, refunds). See
  [x402.md](x402.md).
- **In-flight clients don't see a live spend-pause** until their next turn.

## Test/lint matrix (what "green" means here)

```bash
cd ts        && npm run typecheck && npm test   # core + ui
cd ts/server && npm run typecheck && npm test   # server
cd ts        && npm run ui:build                # vite build of ui/dist
```
