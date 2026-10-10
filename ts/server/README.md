# @aloud/server

**aloud cloud** - the hosted **aloud** backend: a stateless proxy with accounts,
a credit ledger, and metered billing. It's what lets a stranger hit a URL, sign
in with Google, get a few free credits, and spend them on premium LLMs/voices,
without an API key or anything running locally. (The app-store and desktop builds
keep the on-device and bring-your-own-key paths; aloud cloud is just the "easy"
option.)

This is part of the public, **AGPL-3.0** aloud repo, on purpose. See
[Why it's open source](#why-its-open-source).

## What it does

The hosted service lives under `/cloud/v1/*`: sign-in (Google / Apple / email),
the account and its credit balance, published pricing, the metered LLM / STT /
TTS proxies (hold → forward → settle to actual cost), Stripe checkout + webhook,
and an operator admin surface. The full route table, config and how to run it
are in [dev-docs/ts-server.md](../../dev-docs/ts-server.md); deploying it is
[dev-docs/deploy.md](../../dev-docs/deploy.md).

This process also answers the **web build's app-backend** surface under
`/app/v1/*` - the non-inference endpoints the desktop shell serves natively
(`src-tauri/src/server.rs`):

| Route | Purpose |
|-------|---------|
| `GET /app/v1/system-info` | Platform marker; `desktop:false` so the UI keeps desktop-only features off on the web. |
| `GET /app/v1/providers` | Provider availability for the picker (Ollama is local-only → unavailable; BYOK providers report available, client-key-gated). |
| `GET /app/v1/models/:provider` | Live model list; BYOK key forwarded as `x-provider-key` (never persisted). OpenRouter needs none; `claude_proxy` is a static alias list. |
| `GET /app/v1/voices` | Local server voices - none on the web (hosted voices are at `/cloud/v1/voices`). |

With `ALOUD_UI_DIR` set, this process also serves the built UI (`ui/dist`)
statically - the single-box "full install" self-host story. In the canonical
deploy it's unset: the UI is on a static host (e.g. GitHub Pages) and this box
is API-only.

## Architecture

Deliberately small and stateless. **Sessions live entirely on the client** - the
server never stores conversation history. Meditation content touches the server
only while a metered route forwards it to a provider (an LLM turn, STT audio,
TTS text, a judge utterance), and those paths persist nothing.

```
src/
  contract.ts         the ENTIRE client↔server wire surface (keep it small)
  config.ts           env config; secrets never in the repo
  logger.ts           structured logs with a hard "never log content" invariant
  deps.ts             dependency container (inject a store, build the rest)
  app.ts / index.ts   Hono app + entrypoint
  routes/             one file per route group
  auth/               Google/Apple ID-token verify (jose+JWKS), email/password, our session JWT, middleware
  credits/            CreditsStore interface (in-memory + SQLite), append-only Ledger, usage + incident logs
  pricing/            cost tables, commission-by-(channel,jurisdiction), the meter, estimates
  providers/          forwarder (reuses @aloud/core provider classes at runtime), STT, TTS, voice catalog
  billing/            Stripe checkout + webhook verify (fetch + node:crypto, no SDK); x402
  quota/              free-tier grant gating, rate guard, global free-grant breaker
  admin/              ledger aggregation for spend monitoring, the operator panel
```

### Reuse of `@aloud/core`

The forwarder (`providers/forward.ts`) constructs the **same** provider classes
the client uses (`AnthropicProvider`, `OpenAIProvider`, `GoogleProvider`, ...)
rather than re-implementing request building and token-usage parsing. Billing
rides on that usage split, so a single shared implementation is the whole reason
this lives in the monorepo. It's wired via a tsconfig path alias resolved by
`tsx` at runtime (and a matching Vitest `resolve.alias`).

### Metered billing, in the open (Model B - margin at purchase)

Margin lives at **purchase**, not in the debit:

- **Credits debit at cost.** Each turn is priced by its actual provider cost
  (token split × rates, cache reads/creation separate) and debited as
  `cost / USD_PER_CREDIT` via a pre-auth hold that settles to the real cost.
  No markup in the debit - so the credit counts a user watches tick down map
  1:1 to real compute, which is easy to verify.
- **Packs carry the markup.** A pack of N credits funds `N × USD_PER_CREDIT` of
  cost and sells on a volume curve (`billing/stripe.ts`): `PACK_MARKUP` (2.5x)
  at the entry tier, easing to ~2.1x on larger buys. Sales tax/VAT rides on top
  via Stripe Tax, not from margin.
- **Solvency is enforced at boot.** `assertSolvent(CREDIT_PACKS)` **refuses to
  start** if any pack's effective markup can't clear the worst channel's
  commission - including the 15% IAP floor. Commission is a
  `(channel, jurisdiction)` lookup, not a constant (web-Stripe / EU / IAP take
  very different cuts). See `pricing/commission.ts`, ticket `meditation-pal-8sj`.

Connecting a Google or Apple identity grants a fixed number of free credits
(`ALOUD_FREE_SIGNUP_CREDITS`, default 20 ≈ $1 of cost; an email-only account
gets none), bounded globally by an hourly grant breaker
(`ALOUD_FREE_GRANT_BUDGET_PER_HOUR`) so a signup flood can't drain the budget.

## Why it's open source

Putting the billing/credits server in the public AGPL repo isn't an oversight,
it's the point. For a privacy-and-ownership-minded meditation product:

- **AGPL works *for* us here.** Its network-use clause means anyone running this
  server owes their users the source. We want that.
- **The one arguably-sensitive number, the pack markup, is published**
  (`/cloud/v1/me/models` exposes `usdPerCredit` + `packMarkup`). It's trivially
  derivable from public provider pricing anyway, and anyone who cares had two
  cheaper escape hatches: local Ollama or their own API key. Transparency is a
  trust feature, not a leak.
- **Privacy comes from the architecture, not from hiding code:** stateless
  proxy, client-side sessions, and a logger that refuses to print message bodies
  (`meditation-pal-dn2`).

## Running it

```bash
cp .env.example .env   # fill in secrets, or set them as host secrets
npm run dev            # tsx watch
npm start              # tsx (prod; resolves the @aloud/core alias)
npm test               # vitest
npm run typecheck
```

Dev vs production mode, every config key and the dev sign-in shortcut:
[dev-docs/ts-server.md](../../dev-docs/ts-server.md).
