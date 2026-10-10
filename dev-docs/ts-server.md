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

`npm run dev` (watch) and `npm start` (one-shot) both run via `tsx`, which
resolves the `@aloud/core` path alias at runtime so the proxy reuses core's
provider classes (why: `ts/server/README.md`).

## Dev mode vs production mode

The boundary is the `ALOUD_ENV` env var (`loadConfig` in `config.ts`):

| | Dev (default) | Production (`ALOUD_ENV=production`) |
|---|---|---|
| Missing secrets | boots with stubs (`dev-insecure-secret`, in-memory store) | **refuses to start** unless session secret, ≥1 Google client id, `ALOUD_DB_PATH`, `ALOUD_CORS_ORIGINS` and ≥1 provider key are set |
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
| `ALOUD_CORS_ORIGINS` | browser + desktop clients | comma-sep; the `ui/dist` host origin(s) plus the desktop and mobile webview origins (listed at the top of [deploy.md](deploy.md)); **required in prod** (unset, CORS falls open to `*`) |
| `ALOUD_DB_PATH` | durable credit ledger | SQLite file path (e.g. `/data/aloud.db` on a Fly volume); **required in prod**. Unset in dev → in-memory store, lost on restart |
| `ALOUD_SESSION_SECRET` | signing session JWTs | `openssl rand -hex 32`; required in prod |
| `GOOGLE_CLIENT_IDS` | sign-in | comma-sep web/iOS/android client ids; required in prod |
| `APPLE_CLIENT_IDS` | Apple sign-in | comma-sep Services ID (web) / bundle id (native); empty disables Apple. Email/password needs no config (meditation-pal-s75) |
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | LLM forwarding | ≥1 required in prod; server-held, never sent to client |
| `GEMINI_API_KEY` | value-tier LLM (Gemini direct) | Google AI Studio key; powers `gemini-3.5-flash-lite` without OpenRouter's fee |
| `OPENAI_API_KEY` | server STT (default) + premium LLM | one key drives `/cloud/v1/stt` (Whisper; server default `gpt-transcribe`, ≈ $0.27/hr with each clip billed in whole seconds rounded up, which is also what the app's "aloud cloud" STT choice asks for) and the GPT LLM. `OPENAI_STT_API_KEY` splits STT onto its own key |
| `STT_API_KEY` (+ `STT_PROVIDER` / `STT_BASE_URL` / `STT_MODEL`) | server STT (override) | point STT at any OpenAI-compatible `/audio/transcriptions` host (OpenAI/Groq/self-hosted). See `config.ts` `resolveSttConfig` |
| `GOOGLE_TTS_API_KEY` | server TTS | Google Cloud TTS key (Cloud TTS API enabled); distinct from `GEMINI_API_KEY`. Unset → `/cloud/v1/tts` reports not-configured, client falls back to browser TTS |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | server TTS | Azure AI Speech key + region (region defaults to `eastus`). Unset → the Azure voices drop out of `GET /cloud/v1/voices`, including the flagged default Harper, and `defaultVoice()` falls down `DEFAULT_VOICE_CHAIN` to Leda, then Luna. Azure bills SSML markup and counts each CJK char twice; `providers/tts.ts azureBilledChars` is what the meter charges on |
| `INWORLD_API_KEY` | server TTS | Inworld key; a read-only one synthesizes. Unset → the Inworld voices (Luna, Wren, Silas, Clive) drop out of `GET /cloud/v1/voices`. Wren and Silas are custom voices in the key's own workspace, so a key from another account 404s them. Billed per character of spoken text: TTS-2 $25/1M, TTS-2 Flash $15/1M (`pricing/providers.inworldTtsRateFor`, the model is the part of the catalog id after the colon) |
| `TYPESAFE_API_KEY` | server judge | TypeSafe (Jev) key for `/cloud/v1/judge`, the typed-judgment path for the silence classifiers and the spoken commands. Unset → the route reports not-configured, clients keep the Haiku classifier, and there are no spoken commands (they have no LLM twin). Also read by `npm run jev:ab` (classifiers) and `npm run jev:commands` (every command ask, through the gate) |
| `ALOUD_FREE_SIGNUP_CREDITS` | free tier | default 20 (≈ $1 provider cost). Granted on CONNECTING a trusted, verified identity (Google/Apple), not on signup - once per account, once per identity (meditation-pal-116, `quota/freetier.ts` `decideConnectGrant`) |
| `ALOUD_FREE_GRANT_BUDGET_PER_HOUR` | abuse brake | default 2000 (≈ 100 signups/hr) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | buying credits | optional; without them, free-grant only |
| `ALOUD_ADMIN_TOKEN` | `/cloud/v1/admin/*` + panel | static operator bearer token; admin is disabled (404, not open) unless this or `ALOUD_ADMIN_EMAILS` is set |
| `ALOUD_ADMIN_EMAILS` | `/cloud/v1/admin/*` + panel | comma-separated emails whose signed-in sessions get admin access - the panel's Google sign-in path, so a phone never holds the static token |

## Running the full loop locally (UI ↔ server)

Put one real provider key in `.env` (e.g. `ANTHROPIC_API_KEY`; `/health` then
lists it under `providers`), and run `npm run web:dev` from the repo root. In
the UI pick provider **aloud cloud**, choose a model (populated live from
`GET /cloud/v1/me/models`), and start a session; the first LLM turn signs in
via the dev route below and caches the token.

**On the hosted provider, STT and TTS also route through the server**
(`/cloud/v1/stt` and `/cloud/v1/tts`). STT needs `OPENAI_API_KEY` (or the
`STT_*` overrides); TTS needs at least one TTS key (with none, the client falls
back to browser `speechSynthesis`). Client wiring:
`stt-picker.createServerAloudStt` and `tts-picker.createCloudAloudTts`, selected
in `views/session.ts` when `setup.provider === 'aloud'`; the LLM leg is
`ui/src/adapters/cloud-llm.ts`.

**Auth - dev shortcut.** `POST /cloud/v1/auth/dev` mints a session for a fixed
`dev@localhost` account (seeded with `ALOUD_FREE_SIGNUP_CREDITS`, refilled when
it runs dry). The route exists only when the server sets
`ALOUD_ENABLE_DEV_AUTH` (opt-in, so a deploy that forgets `ALOUD_ENV` can't
ship it); otherwise it 404s. A dev build's `ensureCloudToken()`
(`ui/src/cloud-auth.ts`) uses it when no Google client id is configured, or
with `?dev` when one is (see the cheatsheet's dev URL params).

Quick handshake without the UI:

```bash
TOK=$(curl -s -X POST localhost:8787/cloud/v1/auth/dev | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:8787/cloud/v1/me -H "authorization: Bearer $TOK"    # account + balance
curl -s -X POST localhost:8787/cloud/v1/llm/complete -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' \
  -d '{"provider":"anthropic","model":"claude-sonnet-5-5","messages":[{"role":"user","content":"hi"}]}'
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
| `POST /cloud/v1/auth/dev` | public (dev only) | local dev sign-in; mints a session for `dev@localhost`. 404s unless `ALOUD_ENABLE_DEV_AUTH` is set |
| `GET /cloud/v1/me` | session | account + live balance |
| `PATCH /cloud/v1/me` | session | flip the email-updates opt-in (`{emailUpdates: boolean}`); returns the updated account view |
| `DELETE /cloud/v1/me` | session | soft-delete the account (see deploy.md → Sign-in methods). Also clears the email-updates opt-in with the scrubbed address |
| `GET /cloud/v1/me/models` `/estimates` `/packs` | public | published pricing (`/packs` also advertises the x402 channel) |
| `POST /cloud/v1/llm/complete` | session | metered proxy: hold → forward → settle to actual cost (SSE or JSON). When Anthropic's refusal fallback answers a declined turn (`anthropic.ts` `takesRefusalFallback`), each model's attempt settles at its own rates with a usage row apiece, the declined one tagged `utility` |
| `POST /cloud/v1/stt` | session | metered STT: raw mono PCM body (`?format=i16`, or Float32 from older clients) → Whisper (OpenAI by default; `?model=` picks gpt-transcribe, which current clients send) → transcript; debits by the seconds the provider bills (`sttBilledSeconds`: gpt-transcribe rounds each request up to a whole second) |
| `POST /cloud/v1/tts` | session | metered TTS: `{text,voice?,rate?}` → the voice's provider (Azure / Google / Inworld) → audio/mpeg; cost in headers. A synthesis failure is `provider_error` (502), or `provider_unavailable` (503) when the provider refused aloud's own account (`isProviderAccountFailure`), which the app words as "this voice isn't available" rather than "try again" |
| `POST /cloud/v1/tts/canned` | session | the fixed out-of-credits / paused apology (`{reason,voice?}`) → audio/mpeg; unmetered, no balance gate, cached per voice |
| `GET /cloud/v1/tts/preview` | public | a curated voice's fixed preview phrase (`?voice=&rate=`) → audio/mpeg; unmetered, cached per voice and speed step |
| `POST /cloud/v1/judge` | session | silence classifier or spoken-command detection (`classifier`: a core `JudgeId`) as probabilities: `{classifier,text,earlier?}` → TypeSafe Jev → `{answers,model,latencyMs}`, one P(yes) per ask; the client applies thresholds (core `judgeVerdict`). `earlier` (the hold so far) is used for `resume` only. The question comes from core `JUDGE_SPECS`, never the client. Free to any signed-in account, BYOK and local sessions included (their opt-in), and not charged (~$0.00007/call; usage recorded as `typesafe`), so it has its own rate budget (`deps.judgeGuard`, 90/min/account, separate from the 60/min every other metered route shares) plus a 5,000-a-day cap that only binds accounts with no credits. A command is two calls: the one-ask `command-gate`, then `command` if that says maybe. Failures are invisible to users (clients fall back), so they land in the incidents table as `judge_error`, one row a minute with a count, never with content |
| `POST /cloud/v1/billing/checkout` | session | start Stripe Checkout for a pack |
| `POST /cloud/v1/billing/webhook` | Stripe sig | credit the ledger after signature verify |
| `POST /cloud/v1/billing/x402/buy/:packId` | session + payment | USDC-on-Base pack purchase (402 → sign → settle). Config-gated; see [x402.md](x402.md) |
| `/cloud/v1/gifts/*` | mixed | gift-credit purchase + redemption (`routes/gifts.ts`) |
| `GET /cloud/v1/voices` | public | curated hosted voices (empty when TTS unconfigured) |
| `POST /cloud/v1/incidents` | session | the app reports a cloud failure it handled quietly (kind from `CLIENT_INCIDENT_KINDS`, optional one-line detail, provider/model/session ids); feeds the admin Incidents section |
| `GET /cloud/v1/admin` | none* | operator control panel HTML (`*` served only when admin access is configured) |
| `GET /cloud/v1/admin/metrics` | admin | ledger aggregates for spend monitoring |
| `GET /cloud/v1/admin/usage` | admin | cost-attribution report from usage telemetry (`?sinceHours=&excludeAdmin=1`, plus the real-sit bar: `all=1` for every session, or `sitMinutes=`/`sitTurns=` to override `DEFAULT_REAL_SIT` - 5 turns AND 5 min - which filters distributions and per-hour rates together). Response also carries `perHour.raw` (unweighted total/total beside the account-weighted headline rates), `perHour.tokensPerTurn`, and `sessionRows`: itemized sessions for `ALOUD_ADMIN_EMAILS` accounts only - real users stay aggregate |
| `GET /cloud/v1/admin/usage/history` | admin | daily trend buckets (usage + gross revenue per UTC day), computed live (`?days=&excludeAdmin=1`) |
| `GET /cloud/v1/admin/usage/provider-daily` | admin | per-provider per-UTC-day spend for invoice reconciliation (never filtered) |
| `GET /cloud/v1/admin/incidents` | admin | incident log (`?sinceHours=&excludeAdmin=1`): what the app handled quietly on the cloud path - blank completions with finish reason + tokens, replies cut off at max_tokens (`llm_max_tokens`), safety-classifier refusals (`refusal=<category>` on the row) and turns Anthropic's server-side fallback answered instead (`llm_fallback`), upstream LLM/STT/TTS failures (voice previews and canned clips included, throttled to a row a minute), Stripe checkout failures (`billing_error`), retired models the liveness sweep dropped (`model_retired`), refused 402s, and `client_*` rows the app reports itself (`POST /cloud/v1/incidents`). Grouped by kind plus the newest rows; content-free by construction (`credits/incidents.ts`) |
| `GET /cloud/v1/admin/calls` | none* | per-call page HTML: one session's every metered call (`admin/calls-page.ts`); reuses the panel's stored credential |
| `GET /cloud/v1/admin/sessions` | admin | sessions by client session id (`?sinceHours=`, default 7d) with cost per leg and cold-cache call count; `ALOUD_ADMIN_EMAILS` accounts only |
| `GET /cloud/v1/admin/sessions/:id` | admin | one session's calls in order (gap since the previous facilitation call, cache read/write, cost), facilitation spend by token type, and its incidents; 404 for a non-admin session |
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
  holds a session JWT instead of the root token. User sessions slide for 90
  days, but the gate (`routes/admin.ts` `authFailure`) honours a token only
  while it is under 7 days old (`ADMIN_MAX_TOKEN_AGE_SECONDS`), and requires the session account's email to be
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
turn.

## Hosted voices & auditioning new ones

The curated hosted voices live in `src/providers/voice-catalog.ts` - a short-name
→ (provider, voice id) map across Google Cloud TTS, Azure AI Speech and Inworld
(the flagged default, Harper, is an Azure MAI-Voice-2.1 voice). `GET
/cloud/v1/voices` publishes them; the client merges them into its picker (a
`premium` voice under "Best", a `value` one under "Very Good") and sends the
short name back, which `/cloud/v1/tts` resolves. To add more: audition, then append the winners to `CURATED_VOICES`.

`scripts/preview-voices.ts` synthesizes one meditation sample per voice, measures
the resulting audio, and writes `voice-previews/index.html` (gitignored) - a
sortable, filterable page with a player per voice, a shortlist that emits
paste-ready `CURATED_VOICES` lines, and keyboard shortcuts (`e` play/pause,
`w`/`s` prev/next, `f` shortlist; space is left alone so it still scrolls).

Run it through the npm delegate, from anywhere in the repo (there is a second
`scripts/` directory at the repo root, so a bare relative path from the wrong
place fails with a confusing `MODULE_NOT_FOUND`):

```bash
npm run voices                    # what we ship, as a session hears it (the default)
npm run voices -- google          # ~130 Google voices, all English locales
npm run voices -- openai gemini   # several sources at once
npm run voices -- all             # every source with a key
npm run voices -- google --locales=en-US,en-GB,en-AU
npm run voices -- google --filter=Chirp3-HD --limit=12
npm run voices -- curated --prosody       # every prosody treatment, side by side
npm run voices -- all --rate=0.85         # at session pace
npm run voices -- --rebuild               # rewrite the page after a catalog edit, no synthesis
```

A curated run renders each catalog voice through the route's own dispatch
(`routes/tts.ts` `synthFor`: its style, pace bias and lead silence) at the default
session speed. Those are the page's **as shipped** rows, and the filter's
"shipped, as shipped" (`index.html#shipped`) shows them alone, with each voice's
picker bucket: the list to listen down when deciding what stays in the catalog.
A source's own treatments are not that list. Harper ships in softvoice, so her
"plain text" row is a voice no session has heard. Which voices are shipping is
read from the catalog on every build, and an as-shipped clip whose voice has
left the catalog (or changed style or pace) is dropped.

Runs **merge**: auditioning one source adds to the page rather than replacing
it, so a quick spot-check does not destroy a roster that took minutes to
render. `--fresh` starts over. State lives in `voice-previews/rows.json`.

`curated` (the default) shows **only the voices already in `CURATED_VOICES`**;
to find new voices, name a source. Google alone has ~130 English voices across
en-US/en-GB/en-AU (30 Chirp3-HD per locale, plus Neural2 and Standard), roughly
$0.70 and a few minutes to audition in full.

Sources are declared in `scripts/audition/sources.ts` - roster, synth call,
prosody treatments, and cost model per engine. Beyond the three we ship (Google,
Azure, Inworld) it carries key-gated adapters for OpenAI, Gemini TTS, Cartesia
and Deepgram Aura-2; anything without a key is skipped and listed on the page
with a signup link. The keys (also in `.env.example` under "Voice-audition
keys"):

| Env var | Engine | Billing | Get a key |
|---|---|---|---|
| `GOOGLE_TTS_API_KEY` | Google Cloud TTS *(ships)* | per char | [console](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com) |
| `OPENAI_API_KEY` | OpenAI gpt-4o-mini-tts (shipped until 2026-10-07) | per second | [platform](https://platform.openai.com/api-keys) |
| `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` | Azure AI Speech *(ships)* | per char (SSML tags billed; CJK ×2) | [portal](https://portal.azure.com) |
| `GEMINI_API_KEY` | Gemini TTS - already set for the LLM | per second | [AI Studio](https://aistudio.google.com/apikey) |
| `CARTESIA_API_KEY` | Cartesia Sonic 3 | per char | [play.cartesia.ai](https://play.cartesia.ai/keys) |
| `INWORLD_API_KEY` | Inworld TTS-2 and TTS-2 Flash *(ships)* | per char (text only; the style instruction is free) | [platform.inworld.ai](https://platform.inworld.ai) |
| `DEEPGRAM_API_KEY` | Deepgram Aura-2 | per char | [console](https://console.deepgram.com/signup) |

These adapters are audition-only on purpose - promoting one means adding it to `src/providers/tts.ts`, the
`TtsProvider` union, and `pricing/providers.ttsRateFor` before it can bill.

Two things the page exists to make visible:

- **Cost is measured, not quoted.** Half these engines bill by audio *duration*,
  and every "$/1M chars" figure they publish assumes conversational pace. aloud
  speaks slowly, so a duration-priced engine costs materially more than its
  sticker. The page prices every clip from its real measured length (`ffprobe`,
  `afinfo` fallback) per *spoken* character, which is the only cross-source
  comparison worth making. Measured at our own instruction: OpenAI lands at
  $16-20/1M (bracketing the reconciled $19 it billed at while it shipped), and Gemini
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

A curated run costs a few cents (one short clip per voice per treatment).

## Known limits

- **Single-machine by design.** The ledger is one SQLite file on one Fly volume.
  Scaling out means implementing `CreditsStore` (`credits/store.ts`) over
  Postgres. See [deploy.md](deploy.md) → Durability & scale.
- **x402 is flag-gated off** pending mainnet ops (tax, off-ramp, refunds). See
  [x402.md](x402.md).
- **In-flight clients don't see a live spend-pause** until their next turn.
