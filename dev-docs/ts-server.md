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
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` | LLM forwarding | ≥1 required in prod; server-held, never sent to client. `OPENROUTER_API_KEY` also runs the Parakeet and Grok STT models (`providers/stt.ts` `OPENROUTER_STT_MODELS`): the app's "Grok" choice, and Parakeet, the English default in 2.21.0 and now only the longer passes of the developer-mode "Hybrid" choice, which the server backs with gpt-transcribe (Parakeet requests below); unset, those calls answer "not configured" |
| `GEMINI_API_KEY` | value-tier LLM (Gemini direct) | Google AI Studio key; powers `gemini-3.5-flash-lite` without OpenRouter's fee |
| `OPENAI_API_KEY` | server STT (default) + premium LLM | one key drives `/cloud/v1/stt` (Whisper; server default `gpt-transcribe`, ≈ $0.27/hr with each clip billed in whole seconds rounded up, which is also what the app's "GPT" STT choice asks for) and the GPT LLM. `OPENAI_STT_API_KEY` splits STT onto its own key |
| `STT_API_KEY` (+ `STT_PROVIDER` / `STT_BASE_URL` / `STT_MODEL`) | server STT (override) | point STT at any OpenAI-compatible `/audio/transcriptions` host (OpenAI/Groq/self-hosted). See `config.ts` `resolveSttConfig` |
| `GOOGLE_TTS_API_KEY` | server TTS | Google Cloud TTS key (Cloud TTS API enabled); distinct from `GEMINI_API_KEY`. Unset → `/cloud/v1/tts` reports not-configured, client falls back to browser TTS |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | server TTS | Azure AI Speech key + region (region defaults to `eastus`). Unset → the Azure voices drop out of `GET /cloud/v1/voices`, including the flagged default Harper, and `defaultVoice()` falls down `DEFAULT_VOICE_CHAIN` to Leda, then Luna. Azure bills SSML markup and counts each CJK char twice; `providers/tts.ts azureBilledChars` is what the meter charges on |
| `INWORLD_API_KEY` | server TTS | Inworld key; a read-only one synthesizes. Unset → the Inworld voices (Luna, Wren, Silas, Clive) drop out of `GET /cloud/v1/voices`. Wren and Silas are custom voices in the key's own workspace, so a key from another account 404s them. Billed per character of spoken text: TTS-2 $25/1M, TTS-2 Flash $15/1M (`pricing/providers.inworldTtsRateFor`, the model is the part of the catalog id after the colon) |
| `TYPESAFE_API_KEY` | server judge | TypeSafe (Jev) key for `/cloud/v1/judge`, the typed-judgment path for the silence classifiers and the spoken commands. Unset → the route reports not-configured, clients keep the Haiku classifier, and there are no spoken commands (they have no LLM twin). Also read by `npm run jev:ab` (classifiers) and `npm run jev:commands` (every command ask, through the gate) |
| `ALOUD_FREE_SIGNUP_CREDITS` | free tier | default 20 (≈ $1 provider cost). Granted on CONNECTING a trusted, verified identity (Google/Apple), not on signup - once per account, once per identity (meditation-pal-116, `quota/freetier.ts` `decideConnectGrant`) |
| `ALOUD_FREE_GRANT_BUDGET_PER_HOUR` | abuse brake | default 2000 (≈ 100 signups/hr) |
| `ALOUD_JUDGE_CALLS_PER_DAY` | abuse brake | default 500000 (≈ $50/day at worst). Judge calls across ALL accounts per UTC day; past it, accounts with no credits are refused until the day turns (`deps.judgeGlobalCap`). The per-account cap can't do this alone, since an email signup is free to repeat |
| `ALOUD_CLIENT_IP_HEADER` | per-IP limits off Fly | the header your proxy sets with the real client IP (`loadConfig` → `clientIpHeader`, read by `auth/middleware.ts` `forwardedIp`). Automatic on Fly (`Fly-Client-IP`). Unset elsewhere, the first `X-Forwarded-For` hop is used, which the client chooses behind a proxy that appends |
| `ALOUD_BETA_BONUS_CLIENT_IDS` / `ALOUD_BETA_BONUS_CREDITS` | beta bonus | temporary (meditation-pal-bb4k, ends with `b73h`). A Google/Apple sign-in whose verified token names one of these native clients gets a one-time bonus (default 10) in the ordinary balance: the Android OAuth client id (the token's `azp`), the iOS Google client id, the iOS bundle id (Apple's `aud`). Never the web client id or the Services ID. Empty list = off. Once per account, identity and mailbox, through the same hourly breaker (`quota/beta-bonus.ts` `grantBetaBonus`) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | buying credits | optional; without them, free-grant only |
| `ALOUD_ADMIN_TOKEN` | `/cloud/v1/admin/*` + panel | static operator bearer token; admin is disabled (404, not open) unless this or `ALOUD_ADMIN_EMAILS` is set |
| `ALOUD_ADMIN_EMAILS` | `/cloud/v1/admin/*` + panel | comma-separated emails whose signed-in sessions get admin access - the panel's Google sign-in path, so a phone never holds the static token |
| `ALOUD_ADMIN_READ_TOKEN` | read-only admin reports | a second bearer token that reaches only the routes marked `admin, read` below and gets 403 on every other admin route. Not an account: nothing outside `/cloud/v1/admin` honours it. Turns nothing on alone; ignored, with a boot-log warning, when under 32 characters, equal to `ALOUD_ADMIN_TOKEN`, or set while admin is off. See [Reading production as the assistant](#reading-production-as-the-assistant) |

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
| `GET /cloud/v1/config` | public | build-agnostic client bits before sign-in: the Google/Apple client ids (first of `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS`). Lets any install render OAuth sign-in without baking ids in at build. Also `minClientVersion`, the oldest app version served per platform (see Minimum client version below) |
| `POST /cloud/v1/auth/google` | public (optional bearer) | verify Google ID token; sign in, or on a first connect create/link an account and grant free credits per the connect rules. With a bearer token it LINKS Google to that account (the "connect to claim credits" flow). The response's `granted: {connect, beta}` (present only when non-zero) is what the client's thank-you dialog reads (`ui/src/sign-in-thanks.ts`) |
| `POST /cloud/v1/auth/google/desktop` | public (optional bearer) | the desktop loopback-PKCE variant (exchanges an auth code server-side) |
| `POST /cloud/v1/auth/apple` | public (optional bearer) | same as google for Sign in with Apple (verifies vs Apple JWKS; needs `APPLE_CLIENT_IDS`) |
| `POST /cloud/v1/auth/email/signup` | public (optional bearer) | create an email/password account (scrypt hash). UNTRUSTED → no free credits until it connects Google/Apple (meditation-pal-116). Optional `emailUpdates` body flag carries the signup opt-in |
| `POST /cloud/v1/auth/email/login` | public | email/password sign-in; one generic 401 for wrong-password / unknown-email |
| `POST /cloud/v1/auth/email/set-password` | session | add/change a password on an OAuth-created account. CHANGING one ends every session issued before now (`Account.sessionsValidAfter`) and the response carries this device's replacement token; adding a first password revokes nothing |
| `POST /cloud/v1/auth/signout-all` | session | "Sign out everywhere": ends every session on the account, the caller's included. The tokens are stateless and renew themselves, so this (and a password change) is the only thing that ends one held elsewhere; the app's plain Sign out only forgets the token on that device. Every token check goes through `auth/middleware.ts` `sessionForToken` |
| `POST /cloud/v1/auth/dev` | public (dev only) | local dev sign-in; mints a session for `dev@localhost`. 404s unless `ALOUD_ENABLE_DEV_AUTH` is set |
| `GET /cloud/v1/me` | session | account + live balance. The app's first call of a load adds `?v=<version>&platform=<desktop\|android\|ios\|web>`, stored on the account as the build last seen (Minimum client version below) |
| `PATCH /cloud/v1/me` | session | flip the email-updates opt-in (`{emailUpdates: boolean}`); returns the updated account view |
| `DELETE /cloud/v1/me` | session | soft-delete the account (see deploy.md → Sign-in methods). Also clears the email-updates opt-in with the scrubbed address |
| `GET /cloud/v1/me/models` `/estimates` `/packs` | public | published pricing (`/packs` also advertises the x402 channel) |
| `POST /cloud/v1/llm/complete` | session | metered proxy: hold → forward → settle to actual cost (SSE or JSON). `messages` must be role + string content. A turn is refused (402) when its worst-case estimate runs more than `MAX_UNCOVERED_CREDITS` past its hold, counted across the account's turns in flight (`deps.overdraft`): a near-empty account still finishes its last turn, but can't run an oversized prompt, or a burst of turns, on credits it doesn't have. When Anthropic's refusal fallback answers a declined turn (`anthropic.ts` `takesRefusalFallback`), each model's attempt settles at its own rates with a usage row apiece, the declined one tagged `utility`. A Kimi reply that opens with the model's thinking is held back until its closing tag and only what follows is sent, or a blank turn when there is no tag (`providers/withheld-thinking.ts` `withholdThinking`); the tokens bill as reported and the final chunk's `reasoningChars` counts what was held |
| `POST /cloud/v1/llm/keepalive` | session | prompt-cache keep-alive (see Prompt-cache keep-alive below): `{provider,model,messages,system?,sessionId?}`, the session's last facilitation request without its reply, forwarded at `max_tokens: 0` → `{kept,creditsCharged,creditsRemaining?}`. Same auth, rate guard and request checks as `/llm/complete` (`routes/llm.ts` `checkCall`). A non-Anthropic model, a paused account, or a balance that couldn't cover the prompt written again in full answers `kept: false` and sends nothing upstream; otherwise billed at provider cost through the STT/TTS money path (`upfront-charge.ts`), retreat passes honoured, usage row `purpose: 'keepalive'`. An upstream failure is a 502 and one `llm_error` incident (`keepalive: ...`) |
| `POST /cloud/v1/stt` | session | metered STT: raw mono PCM body (`?format=i16`, or Float32 from older clients) → Whisper (OpenAI by default; `?model=` picks gpt-transcribe, which current clients send for "GPT"), or OpenRouter for `moondream/parakeet-ultra` ("Parakeet", the English default in 2.21.0; later clients no longer offer it alone and send it only for the passes over `HYBRID_GPT_MAX_SEC` of "Hybrid", a developer-mode choice not offered in zh, re-sending a pass it refuses with `provider_error` to gpt-transcribe: `stt-picker.ts` `HOSTED_STT`; the server runs every Parakeet request with gpt-transcribe behind it, see Parakeet requests below) and `x-ai/grok-stt-2.0` ("Grok", zh only), each pinned to its host (`providers/stt.ts` `OPENROUTER_STT_MODELS`, needs `OPENROUTER_API_KEY`) → `{text, model, route?, creditsCharged, creditsRemaining}`, `model` being the one that wrote the text; debits by the seconds the provider bills (`sttBilledSeconds`: gpt-transcribe rounds each request up to a whole second; OpenRouter bills the exact second, plus its credit fee via `viaOpenRouter`). An `x-stt-prior` header (the turn's transcript so far, percent-encoded; incremental passes send it) becomes the Whisper backend's prompt (`routes/stt.ts` `sttPrior`): never logged, not sent to the OpenRouter models or to a model that bills prompt text (`sttPromptIsBilled`). `?setup=1` is the setup screen's listening: prompted with core `setupVocabulary`, free while the clip is under `SETUP_MAX_CLIP_SECONDS` and the account has `SETUP_STT_SECONDS_PER_DAY` left (`deps.ts`, with an all-accounts ceiling), else metered as usual; usage rows carry `purpose: 'setup'` ([voice-commands.md](voice-commands.md#the-mic)) |
| `POST /cloud/v1/tts` | session | metered TTS: `{text,voice?,rate?,marks?}` → the voice's provider (Azure / Google / Inworld) → audio/mpeg; cost in headers, and with `marks` (a whole reply, see Whole replies below) where each marked sentence begins, in `X-Mark-Times`. A synthesis failure is `provider_error` (502), or `provider_unavailable` (503) when the provider refused aloud's own account (`isProviderAccountFailure`), which the app words as "this voice isn't available" rather than "try again" |
| `POST /cloud/v1/tts/canned` | session | the fixed out-of-credits / paused apology (`{reason,voice?}`; the store apps ask for `insufficient_credits_plain`, the wording with no purchase in it) → audio/mpeg; unmetered, no balance gate, cached per voice |
| `GET /cloud/v1/tts/preview` | public | a curated voice's fixed preview phrase (`?voice=&rate=`) → audio/mpeg; unmetered, cached per voice and speed step |
| `POST /cloud/v1/judge` | session | silence classifier or spoken-command detection (`classifier`: a core `JudgeId`) as probabilities: `{classifier,text,earlier?,before?}` → TypeSafe Jev → `{answers,model,latencyMs}`, one P(yes) per ask; the client applies thresholds (core `judgeVerdict`). `earlier` (the hold so far) is used for `resume` only, `before` (`{facilitator?,meditator?}`, what was said just before) for `command` only. The question comes from core `JUDGE_SPECS`, never the client. Free to any signed-in account, BYOK and local sessions included (their opt-in), and not charged (~$0.00007/call; usage recorded as `typesafe`), so it has its own rate budget (`deps.judgeGuard`, 90/min/account, separate from the 60/min every other metered route shares) plus a 5,000-a-day cap per account and an all-accounts daily ceiling (`ALOUD_JUDGE_CALLS_PER_DAY`), both of which only bind accounts with no credits. A command is two calls: the one-ask `command-gate`, then `command` if that says maybe; a maybe that names no command costs up to two more, `command` again with one side of `before` each (the second look, [voice-commands.md](voice-commands.md#how-an-utterance-is-checked)). The setup screen's ids (`setup-gate`, `setup-command`, core `setup-command-specs.ts`) take no session and are recorded as `purpose: 'setup'` against the same caps ([voice-commands.md](voice-commands.md#the-judge-tier)). Failures are invisible to users (clients fall back), so they are recorded in the incidents table as `judge_error`, one row a minute with a count, never with content |
| `POST /cloud/v1/billing/checkout` | session | start Stripe Checkout for a pack |
| `POST /cloud/v1/billing/webhook` | Stripe sig | credit the ledger after signature verify |
| `POST /cloud/v1/billing/x402/buy/:packId` | session + payment | USDC-on-Base pack purchase (402 → sign → settle). Config-gated; see [x402.md](x402.md) |
| `/cloud/v1/gifts/*` | mixed | gift-credit purchase + redemption (`routes/gifts.ts`). A gift is addressed to an email, so only an account whose email is verified lists, accepts or declines it; an email/password signup gets `awaitingVerification: n` instead, until it connects Google/Apple for the same address (`auth/identity.ts` `adoptVerifiedEmail`) |
| `GET /cloud/v1/voices` | public | curated hosted voices (empty when TTS unconfigured) |
| `POST /cloud/v1/incidents` | session | the app reports a cloud failure it handled quietly (kind from `CLIENT_INCIDENT_KINDS`, optional one-line detail, provider/model/session ids); feeds the admin Incidents section |
| `GET /cloud/v1/admin` | none* | operator control panel HTML (`*` served only when admin access is configured) |
| `GET /cloud/v1/admin/metrics` | admin, read | ledger aggregates for spend monitoring; the read token gets the top signup IPs as `redacted` (counts kept) |
| `GET /cloud/v1/admin/usage` | admin, read | cost-attribution report from usage telemetry (`?sinceHours=&excludeAdmin=1`, plus the real-sit bar: `all=1` for every session, or `sitMinutes=`/`sitTurns=` to override `DEFAULT_REAL_SIT` - 5 turns AND 5 min - which filters distributions and per-hour rates together). Response also carries `perHour.raw` (unweighted total/total beside the account-weighted headline rates), `perHour.tokensPerTurn`, and `sessionRows`: itemized sessions for `ALOUD_ADMIN_EMAILS` accounts only - real users stay aggregate |
| `GET /cloud/v1/admin/usage/history` | admin, read | daily trend buckets (usage + gross revenue per UTC day), computed live (`?days=&excludeAdmin=1`) |
| `GET /cloud/v1/admin/usage/provider-daily` | admin, read | per-provider per-UTC-day spend for invoice reconciliation (never filtered) |
| `GET /cloud/v1/admin/incidents` | admin, read | incident log (`?sinceHours=&excludeAdmin=1`): what the app handled quietly on the cloud path - blank completions with finish reason + tokens, replies cut off at max_tokens (`llm_max_tokens`), safety-classifier refusals (`refusal=<category>` on the row) and turns Anthropic's server-side fallback answered instead (`llm_fallback`), upstream LLM/STT/TTS failures (voice previews and canned clips included, throttled to a row a minute), a Parakeet request retried on gpt-transcribe after a failure (`stt_fallback`) or sent there too past its deadline (`stt_hedge`), Stripe checkout failures (`billing_error`), retired models the liveness sweep dropped (`model_retired`), refused 402s, and `client_*` rows the app reports itself (`POST /cloud/v1/incidents`). Grouped by kind plus the newest rows; content-free by construction (`credits/incidents.ts`). For the read token a real user's rows carry no account id or label (`account: "user"`); the `ALOUD_ADMIN_EMAILS` accounts keep theirs |
| `GET /cloud/v1/admin/calls` | none* | per-call page HTML: one session's every metered call (`admin/calls-page.ts`); reuses the panel's stored credential |
| `GET /cloud/v1/admin/sessions` | admin, read | sessions by client session id (`?sinceHours=`, default 7d) with cost per leg and cold-cache call count; `ALOUD_ADMIN_EMAILS` accounts only |
| `GET /cloud/v1/admin/sessions/:id` | admin, read | one session's calls in order (gap since the previous facilitation call or keep-alive, cache read/write, cost; keep-alives listed as their own kind, never turns or cold calls), facilitation spend by token type, and its incidents; 404 for a non-admin session |
| `GET /cloud/v1/admin/accounts` | admin | every account + derived balance / granted / spent / paid flag / last metered call / the app build last seen (`lastClient`) |
| `GET /cloud/v1/admin/accounts/:id` | admin | one account + its full ledger (audit trail) |
| `POST /cloud/v1/admin/grant` | admin | `{email, credits}` → grant credits (ledger `signup_grant`, reason `admin_grant`) |
| `POST /cloud/v1/admin/accounts/:id/delete` | admin | soft-delete an account (the panel's typed-email confirm flow) |
| `GET /cloud/v1/admin/retreats` | admin | retreat passes with rosters + real provider spend so far |
| `POST /cloud/v1/admin/retreats` | admin | create a pass (date window, optional spend cap) |
| `POST /cloud/v1/admin/retreats/:id/members` | admin | add an attendee by email; no account yet → pending invite that binds on that address's first verified (Google/Apple) sign-in. An email/password signup does not bind it: add the attendee again once the account exists (the response then carries `unverified: true`) |
| `POST /cloud/v1/admin/retreats/:id/revoke` | admin | revoke a pass; coverage stops for every member |
| `GET /cloud/v1/admin/config` | admin, read | live effective knobs (free credits, pause, testers) + pricing context, and the minimum app versions read-only; the read token gets `testerEmailCount` in place of `testerEmails` |
| `PUT /cloud/v1/admin/config` | admin | `{freeSignupCredits?, freeGrantBudgetPerHour?, betaBonusCredits?, meteredPaused?, testerEmails?}` → retune live + persist |

"admin" auth = the `ALOUD_ADMIN_TOKEN` bearer, or a normal session token whose
verified account email is in `ALOUD_ADMIN_EMAILS` (see the panel section).
"admin, read" also takes `ALOUD_ADMIN_READ_TOKEN`, which gets 403 (`forbidden`)
on every plain "admin" row, the accounts and retreats reads included since they
carry real users' emails and balances. A route is readable only when
registered with `readable` in `routes/admin.ts`; `tests/admin-read-token.test.ts`
holds a decision for every admin route and fails on a new one until it gets one.

### Minimum client version

`MIN_CLIENT_VERSION` in `src/min-client-version.ts` is the oldest app version
aloud cloud still serves, per platform (`desktop`, `android`, `ios`; `0.0.0` is
no cutoff). No admin override and no env var: it ships with a server deploy,
and a release raises it (`scripts/release.sh`, criteria in
[pre-release-checklist.md](pre-release-checklist.md) Part D). The hosted web
app has no entry, being always the last release.

The app reads it from `GET /cloud/v1/config` at load (`ui/src/capabilities.ts`
into `client-version.ts`) and, below its platform's minimum, mounts a blocking
update screen in place of the first view (`ui/src/update-gate.ts`,
`views/update-block.ts`). Begin checks the same stored value again, with no
request, since an app can stay open for days. Never blocking: no config
(offline, a fully local build) or no minimum. Desktop blocks only once the
Tauri updater offers a version at or above the minimum, so the minutes
between a server deploy and the release's desktop bundles strand nobody; its
button installs and relaunches. A phone's opens its store listing
(`STORE_LISTING` in `views/update-block.ts`). An install older than this
mechanism never checks: it can only be reached by what the server does.

The same load names its build once, on the first signed-in `GET /me`
(`?v=&platform=`, validated by `parseClientReport`), kept on the account as
`lastClient` (version, platform, when; cleared on deletion) and shown in the
admin accounts list's App column, which the search also matches. The panel
prints the minimums above that list.

### Parakeet requests

Every `POST /cloud/v1/stt` asking for `moondream/parakeet-ultra` runs with
gpt-transcribe behind it (`providers/stt-hybrid.ts`), so installed 2.21.0
clients, whose English default is Parakeet alone, get it as well as the
current client's "Hybrid". Only where the configured backend offers
gpt-transcribe (`config.ts` `sttModelChoices`); elsewhere Parakeet runs alone.

- **reroute**: a clip of `HYBRID_SHORT_MAX_SEC` (3.0 s) or less goes to
  gpt-transcribe instead. Short wordless clips are where Parakeet writes a word
  from a breath, and gpt-transcribe returns nothing.
- **fallback**: a longer clip Parakeet fails (an upstream 429 or 5xx, a dropped
  connection) is sent once to gpt-transcribe.
- **hedge**: with no answer from Parakeet by `hybridDeadlineMs` (3 s plus 0.1 s
  per audio second, from the send), the same audio goes to gpt-transcribe too;
  the first answer wins and the other request is aborted (`transcribeHedged`).

gpt-transcribe gets no prompt on any of these, neither `x-stt-prior` nor the
setup vocabulary. The response adds `model` (which model wrote the text) and,
when the request did not simply go where it asked, `route` (`contract.ts`
`TranscribeResponse`). Old clients ignore both; the current one reads them into
its `[stt-time]` diag line and the clip recorder's `model`/`fallback`.

**Metering.** Every request a provider bills is metered at its own model's
rate: one ledger debit for the sum, one usage row per model
(`upfront-charge.ts` `chargeUpfrontLegs`). `stt-hybrid.ts` `legIsBilled`
decides: the answer, yes; a leg a hedge cut off, yes (OpenRouter bills an
aborted non-streaming request in full, which a Parakeet request aborted in
flight confirmed, and OpenAI documents nothing for an aborted transcription); a leg that failed with no error status, yes, since it
may have run; a leg refused with an error status, no (OpenRouter's
zero-completion insurance). So a reroute bills gpt-transcribe in whole seconds,
a fallback after a refusal gpt-transcribe alone, and a hedge both. A request
that ends in a 502 charges nothing. The credit hold for a longer clip covers
both models, and a short clip's is at gpt-transcribe's rate (about 4.3x
Parakeet's a second, more with the rounding), so no outcome outruns it.

**Rates on production.** Each fallback is an `stt_fallback` incident and each
hedge an `stt_hedge`, under model `moondream/parakeet-ultra`, with `served=`,
timings and an upstream error's first line, never audio or text. A reroute is
routine and leaves no incident. The long Parakeet requests to divide by are the
Parakeet usage rows plus the `stt_fallback` rows whose Parakeet leg was
refused, since a refused leg leaves no usage row.

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
  days, but the gate (`routes/admin.ts` `adminAccess`) honours a token only
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
`src/admin/runtime-config.ts`. The same section carries `betaBonusCredits`
(`beta_bonus_credits`); 0 ends the beta bonus without touching the free tier.

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

### Reading production as the assistant

The coding assistant reads production's reports (usage, cost attribution,
cache reads per session, incidents) over the JSON API with
`ALOUD_ADMIN_READ_TOKEN`, so no admin session is left signed in anywhere. It
reaches the `admin, read` rows of the route table and nothing else: no grant,
deletion, config change or retreat, and no accounts or retreats listing.

What it sees of real users: aggregates only (counts, totals, distributions,
per-model and per-day sums, incidents with what happened but no account), the
same line the privacy policy draws for the panel's reports. It does see the
operator's own `ALOUD_ADMIN_EMAILS` accounts itemized, with their email's local
part as a label, and incident details, which are an error's first line and in
principle could quote whatever an upstream error message did. A window holding
one real user's activity is, in aggregate, that user's.

The dev machine's copy lives in `ts/server/.env` (gitignored by
`ts/server/.gitignore`) as `PROD_ADMIN_READ_TOKEN`, not under the server's own
variable name, so a local server started from that file doesn't adopt it:

```bash
TOKEN=$(sed -n 's/^PROD_ADMIN_READ_TOKEN=//p' ts/server/.env)
curl -s -H "authorization: Bearer $TOKEN" 'https://aloud-cloud.fly.dev/cloud/v1/admin/usage?sinceHours=168'
curl -s -H "authorization: Bearer $TOKEN" 'https://aloud-cloud.fly.dev/cloud/v1/admin/sessions?sinceHours=48'
```

Turning it on, once: generate a token (`openssl rand -hex 32`), set it on Fly
(the line in [deploy.md](deploy.md), staged so it lands with the next deploy),
deploy the server, and add `PROD_ADMIN_READ_TOKEN=<token>` to `ts/server/.env`.
The boot log warns if the server ignored it. To revoke, set a new value or
`fly secrets unset ALOUD_ADMIN_READ_TOKEN`; nothing else depends on it.

## Prompt-cache keep-alive

A sit's Anthropic prompt cache is one entry, written at the tail of each
facilitation request (`anthropic.ts` `buildRequest`, one 5-minute breakpoint),
and it lives five minutes from the start of the request that last wrote or
read it. A quiet stretch longer than that (a hold, a long silence between
check-ins) used to make the next turn write the whole prefix again: on Opus 5.5
about 0.4 to 0.8 credits, against 0.08 for a warm turn.

So while a sit is quiet the app re-sends its last facilitation request at
`max_tokens: 0`: same system prompt, same rendered conversation, same tail
breakpoint, same thinking and effort settings (both render into the cached
prompt), not streamed. That is a cache read and nothing else, about 0.02
credits on Opus 5.5, and it restarts the entry's five minutes.

- **When.** `CacheKeepAlive` (`ts/src/llm/keep-alive.ts`) pings 270 s after the
  start of the last facilitation request or ping, at most 13 in a row (about an
  hour), and never while a facilitation request is in flight. A timer that runs
  more than 295 s after the last start (a phone throttling a background tab) is
  skipped, and nothing more goes until the next real request: the entry is
  already gone. Any failure, a 404 from an older server, or a ping that read
  nothing stops it for the rest of the session, silently.
- **What it re-sends.** The session view (`ui/src/views/session.ts`
  `facilitationRequest`, plus the smart check-in and the timer notice) tells it
  about each facilitation request, and passes the request's messages only when
  they stay a prefix of the log: a check-in that passed never logged its event,
  so its request is not the one to keep. Side calls (classifiers, recaps) never
  report to it, even where they share the facilitation provider.
- **Where.** Only where a read keeps the cache alive: BYOK Anthropic
  (`AnthropicProvider.keepAlive`, which sends one request with none of `send()`'s
  retries, so a ping refused for any reason can't change what the real turns
  send) and aloud cloud on an Anthropic model (`CloudLlmProvider.keepAlive` →
  `POST /cloud/v1/llm/keepalive` → `Forwarder.keepAlive`, the same provider
  construction as the turn). Not the Claude subscription, Ollama, OpenAI or
  OpenRouter.
- **Why no 1-hour write.** The code used to set a second, 1-hour breakpoint
  some messages behind the tail. It was never written while the cache was
  warm: it landed on a message that already had a 5-minute entry, and reading a
  5-minute entry only restarts its five minutes, even from a request that marks
  the block 1-hour. A replay of all production sessions found any 1-hour write
  strategy costs more than none, since most sessions are short, while a read
  every 4.5 quiet minutes cuts input-side cost 10 to 22%. `ephemeral_1h_input_tokens`
  is still parsed and the `cacheCreation1h` rates kept, for old usage rows.

In the cost report (`credits/usage.ts`) a keep-alive is the facilitator's cost
but never a turn or a utility call, and its read counts toward neither the hit
ratio nor the savings: without the cache there would be no ping.

## Hosted voices & auditioning new ones

The curated hosted voices live in `src/providers/voice-catalog.ts` - a short-name
→ (provider, voice id) map across Google Cloud TTS, Azure AI Speech and Inworld
(the flagged default, Harper, is an Azure MAI-Voice-2.1 voice). `GET
/cloud/v1/voices` publishes them; the client merges them into its picker (a
`premium` voice under "Best", a `value` one under "Very Good") and sends the
short name back, which `/cloud/v1/tts` resolves. To add more: audition, then append the winners to `CURATED_VOICES`.

**Levels.** Every voice carries a `gainDb` (`CuratedVoice`, how to pick one
is on the field) that `routes/tts.ts` `synthFor` applies to all of its audio by
moving the MP3's own gain field (`providers/mp3-gain.ts` `withGain`). The
target is -22.4 LUFS, the catalog average, measured 2026-11-16 on the
as-shipped audition line (LUFS before → gainDb):

| Voice | LUFS | gainDb | Voice | LUFS | gainDb |
|---|---|---|---|---|---|
| Phoenix | -22.8 | 0 | Harper | -17.8 | -4.5 |
| Orion | -23.2 | 0 | Isla | -17.5 | -4.5 |
| Leda | -23.0 | 0 | Serena | -26.7 | +3 |
| Vega | -19.2 | -3 | Dahai | -28.1 | +3 |
| Rigel | -19.1 | -3 | Luna | -22.1 | 0 |
| Ada | -17.7 | -4.5 | Wren | -25.0 | +3 |
| Davis | -21.6 | -1.5 | Silas | -25.8 | +3 |
| Ethan | -24.9 | +3 | Clive | -24.3 | +1.5 |

Serena and Dahai (Azure's Yunfan) stop short of the target: their peaks
allow one step more than the first pass gave them (gainDb 3 since 2026-11-17,
the loudest of a dozen takes then peaking at -2.5 and -0.8 dBTP) and no
further, and they move up to 8 dB from one take to the next. With that gain a
session sits at about -24.3 LUFS (Serena) and -27.7 (Dahai), recorded as
`sessionLufs`. The dev's rule is that a voice is as loud in the tour as in the
session it leads into, even where that is quieter than the other voices. So
`scripts/render-voice-clips.ts` levels every setup clip by its own gain behind
a limiter (`levelGain`, `encodeClip`) to the voice's `sessionLufs`, or to
-22.4 without one, and marks it `levelled` in the manifest; a later change of
`gainDb` renames such a clip and moves nothing, so `sessionLufs` moves with it
by hand.

That is why Serena is no longer a house voice. The zh female one is Xiaoyue
(小月), Azure's zh-CN-XiaoqiuNeural, picked on 2026-11-17 by measure alone from
ten zh-native female Azure voices (DragonHD, HD Flash, HD Omni, multilingual
and plain neural, MAI-Voice-2.1-Flash) reading setup lines at session pace.
Xiaoqiu was the slowest of them (282 ms a character; Serena 289, Dahai 248),
paused only at punctuation, and sat at -20.6 LUFS with -3.9 dBTP peaks, the
same on every take of a line, as a plain neural voice renders it; so gainDb
-1.5 reaches the target with headroom, where Serena and Dahai spread 2.6 and
4.8 dB over five takes of the same lines. The runners-up were Xiaoyu (HD
Flash) and Mei (MAI-Voice-2.1-Flash). All three cost what Serena and Dahai do
or less ($16, $22 and $15 a million characters), and none lost an opening or
doubled 很好 in ten takes. The dev heard Xiaoyue and Dahai on 2026-11-18:
both are good, Dahai a little quiet. Xiaoyue took `zhNative` from Serena that
day, so a zh session with no voice picked starts on her.

**Harper's lead word.** Harper's softvoice swallows a consonant-initial
opening word on most takes ("Back to Exploration" lost "Back" 6 of 7, "That
can't change" lost "That" 7 of 8), never a vowel-initial one, and never the
sentence behind a short lead. So her entry carries `lead: 'Okay.'`:
`routes/tts.ts` `synthFor` sends a consonant-initial input as `Okay. <text>`
inside the style (`leadFor`), and `providers/mp3-lead-trim.ts` `trimLead`
cuts everything before the sentence off again without decoding: Azure's MP3 is
constant bitrate, so a frame's `global_gain` tracks its level, and the cut lands
on a frame boundary in the silence, 0.15s ahead of the sentence's first sound,
with the first kept frame emptied so it needs nothing from the bit reservoir
cut away. A trimmed clip skips the lead-silence pad. A take that could be
hiding the lead said twice is rolled again once (`leadExpect`, `LeadExpect`):
a short input must come back in one burst; otherwise only the first burst
behind the lead can be a second "Okay", and only while it is lead-sized
(`LEAD_TRIM.longestLeadS`), so then it must be long enough for the text's
opening phrase (`minLetterS` a letter) and no more lead-length bursts may come
ahead of a longer one than the text has short opening phrases. If the
second take fails the same check, or neither has a gap, the text is synthesized
without the lead: it may lose its opening word, but a lead that can be heard
is the worse fault, and wherever the two risks meet the code takes the lost
word. Azure bills every call, so `billedCharsFor` counts the lead (6
characters) and the metered route adds any further call (`extraBilled`).
Measured 2026-11-16 through this path: 0 of 40 openings lost (16 of 23
before), 0 of 40 short inputs voiced twice. It adds a median 23ms (p90 101ms)
to the Azure call and about 0.1ms of CPU, and a roll costs one more call
(about 6% of long sentences, 20% of short ones); about 1% end up without the
lead. Only the first sentence of a reply waits on any of it, since the rest
synthesize while earlier ones play. Other leads tried ("Hm.", "Mm.", "So.",
"Oh.", "Ah.", "I.", "And.", "Alright.") did no better; "Ah." and "Oh." often
ran into the sentence, and "Mm.", "So." and "Alright." slowed it by about 15%.

**Whole replies.** Azure bills everything inside `<speak>`, so a styled voice
pays its 55 characters of `<mstts:express-as style="softvoice">` on every
request, and the client used to send a request per sentence: on short
facilitator sentences the tags were about 40% of the bill (confirmed against
Azure's own Synthesized Characters metric, meditation-pal-6ixc). A voice with
`wholeReply` (`CuratedVoice`, published as `CloudVoice.wholeReply`; Harper
and Ethan) gets a whole reply in one request instead (`ui/src/streaming-tts.ts`
`WHOLE_REPLY_WAIT_MS`). Priced on the dev's 420 desktop replies (the probe's
`bill` step, 2026-11-19), that bills 19.4% fewer characters for Harper and
18.5% for Ethan, before lead re-rolls: about 3.1 and 3.0 credits a session
hour at 0.9 replies a minute, against 3.9 and 3.7. Through the metered route
itself (the probe's `route` step) the bill matched `billedCharsFor` request
for request. Inside one request no sentence lost its opening word (0 of 254
behind the first) and pace and level held, so the lead is needed only at the
start; what changes is the pause between sentences: Harper a median 1.0s
(0.56s between clips), Ethan 1.5s (0.75s) with a tail to about 5s. Nothing
in the request shortens it (a `<break>`, `mstts:silence`, `<s>` and a voice
temperature were all tried), and the dev heard the long ones and kept them.

The lead goes once per request, and a roll repeats the whole request, so on
a whole reply it costs a whole reply. It is not rolled more often there: on
raw led takes of 23 replies (2026-11-20, the probe's `lead` step, takes in
`.probe-data/harper-lead-whole`) the check of the day refused 6 of 138 whole
replies and 3 of 63 of their first chunks sent alone. (The 5 of 65 against 0
of 40 the day before set whole replies against mostly later sentences, which
open differently; their 10 first chunks rolled 0 times.) Whisper heard every
refused take clean when cut. What it refuses is a pause in the opening that
leaves a lead-sized burst behind the lead ("Feel the weight | of your body
resting.", 3 of 9 takes), which is just what the lead said twice looks like;
and twelve of the replies sent as "Okay. Okay. <reply>" got 8 of 24 takes
through, when the opening phrase came back long or ran on. Since 2026-11-20
a first burst no lead could fill passes, the text having begun, and a lead-sized one too short for
the opening phrase is refused: clean whole replies refused went from 6 to 4
of 137 (10 to 9 of 240 with the first chunks and 40 older chunk-sized takes),
so rolls are about 1.5% of Harper's bill by the reckoning that made 5 of 65
about 4%, and the lead said twice got through 5 times in 24 instead of 8. A
pause inside a long opening phrase is still refused (5 of the 9): the frame
levels the check reads can't tell it from a second "Okay", and the doubled
takes still let through are the same shape, a short opening phrase behind
the second lead. One whole reply came back as "Okay. Hm. Gently now, ...",
a filler of lead size ahead of a short opening phrase, which neither check
catches (1 in 138). The `lead` step re-scores the saved takes after a change
to the check, with no new synthesis.

A voice to switch on needs the same measuring first (the repeat probe's
`whole` and `chunks` sends). An unstyled voice pays no tags, though an Azure
one pays a 31-character `<prosody>` wrapper per request at any speed but
1.0 (the default 140 wpm included). Chinese text is one chunk per reply
already: the client's sentence split needs an ASCII `.!?` and a space.

The client (`streamCompletionWithChunkedTts`) gathers the reply's sentence
chunks and sends them when the stream ends, unless it is still running
`WHOLE_REPLY_WAIT_MS` (500ms) after the first chunk is complete: then what
has arrived goes, and the rest follows as one more request at the end. A
stream slower than its audio doesn't hold the rest to its end: what arrived
goes as soon as the first has played, and a chunk that arrives with nothing
playing goes at once. On the
default Opus 5.5 a reply's text arrives in one burst after its thinking, so
the wait almost never runs out; on Haiku 5.5, 98% of multi-chunk replies end
inside it, on Sonnet 5.5 about three in four (estimated from reply latency
against length in the session logs and soak runs). Requests stay under
`MAX_WHOLE_REPLY_CHARS`. The bubble shows the whole request's text when it
starts to play. A synthesis that fails is said again a chunk at a time, in
order, inside what is left of the first one's network retry budget
(`TtsOptions.retryFrom`), and so is the rest of that reply; only a failure
there is reported. A clip that synthesized but would not play (an autoplay
block, `TtsOptions.onSynthesized` tells them apart) is reported as a single
chunk's is, not tried again chunk by chunk, which would bill every chunk for
nothing. Only an engine that can say how far a stopped clip got
(`TtsEngine.reportsMarks`) is given whole replies; a clip stopped without a
hush keeps the chunks it reached, and the rest are said one at a time. An
older server sends no `wholeReply`, so a newer client keeps every voice a
sentence per request.

Such a request carries `marks`, the character offsets of the client's
sentence chunks after the first, and the response says in `X-Mark-Times`
where each begins in the audio (`providers/mp3-marks.ts`
`sentenceMarkTimes`, run on the clip as returned, under the voice's
`gainDb`), so a reply cut off mid-clip keeps only the sentences heard. The
finder reads level off the frames' `global_gain` like the lead trim, and
fits every sentence end of the text to the pauses at once. Against the
sentence ends local Whisper confirmed in 226 whole-reply takes, its times
were within 0.25s of the sentence's first sound for 95% of Harper's chunk
starts and 98% of Ethan's (the rest a whole pause out), so a cut at a random
moment keeps or drops the wrong chunk about 2% and 1% of the time; shares of
the characters, all a client could do alone, are wrong 8% and 13% of the
time. The probe's `marks` step re-runs that score.

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
  comparison worth making. Measured at our own instruction: OpenAI comes to
  $16-20/1M (bracketing the reconciled $19 it billed at while it shipped), and Gemini
  TTS at $25-43/1M - i.e. **at or above** the $30/1M Chirp3-HD it is widely
  claimed to undercut.
- **Prosody differs enormously by engine.** Google honors SSML `<prosody>` +
  `<break>` on *both* tiers, Chirp3-HD included, despite the docs historically
  listing SSML as WaveNet/Neural2-only (verified: a 15.0s line goes to 22.8s
  under rate 80% + 1400ms breaks). That is the strongest pacing lever available
  and it is on the engine we already ship. But Google bills the tags, so marked-up
  speech costs roughly double per spoken word - which is why Neural2 + SSML comes out
  at the same $30/1M as flat Chirp3-HD, and why that A/B is the interesting
  listen. OpenAI/Gemini/Inworld take a natural-language style instruction only
  (weakly honored - see meditation-pal-5yi1); Deepgram Aura-2 exposes no prosody
  control at all.

A curated run costs a few cents (one short clip per voice per treatment).

## Known limits

- **Request bodies are capped** (`app.ts` `JSON_BODY_LIMIT_BYTES`, 2 MB;
  `STT_BODY_LIMIT_BYTES`, 32 MB of PCM on `/cloud/v1/stt`), answered with 413.
  Raise the STT one if the client's `maxUtteranceMs` ever grows past two
  minutes.
- **The in-flight money guards are per process** (`quota/in-flight.ts`), like
  the rate limits: a restart admits the first calls as if nothing were open.

- **Single-machine by design.** The ledger is one SQLite file on one Fly volume.
  Scaling out means implementing `CreditsStore` (`credits/store.ts`) over
  Postgres. See [deploy.md](deploy.md) → Durability & scale.
- **x402 is flag-gated off** pending mainnet ops (tax, off-ramp, refunds). See
  [x402.md](x402.md).
- **In-flight clients don't see a live spend-pause** until their next turn.
