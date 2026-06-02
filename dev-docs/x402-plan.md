# x402 credit-purchase channel — implementation plan (meditation-pal-du9)

Status: **planned, not started.** Written with context to spare so a fresh
session can execute Phase 1 end-to-end. Read this top-to-bottom, then build.

## Decisions locked (do not re-litigate)

- **Verification: `x402-hono` middleware** (Coinbase's maintained pkg) + the
  `@coinbase/x402` facilitator config. We accept the dep (pulls `viem`) in
  exchange for correct EIP-712/EIP-3009 signature handling — the part that is
  genuinely risky to hand-roll. This is a deliberate departure from the no-SDK
  Stripe integration (`billing/stripe.ts`), justified by crypto-correctness.
- **Treasury: dedicated self-custody Base wallet + CDP facilitator.** A NEW
  Base address we hold keys to (NOT `krusz.eth` / the tip-jar address — keep
  business revenue separate from personal tips for tax sanity). CDP facilitator
  is free on Base and runs KYT/OFAC screening, which covers du9's AML
  open-question. Receiving address is an env var; the real one can be filled in
  at deploy time — build against a placeholder.
- **Scheme/asset/chain:** `exact` scheme (EIP-3009 `transferWithAuthorization`),
  USDC, Base. Build/test on **Base Sepolia (testnet)** so Phase 1 needs no real
  funds — mirrors how Stripe shipped in test-mode.
- **Flag-gated, OFF by default.** No behavior change until explicitly enabled.

## Why the code side is small

The billing stack is already channel-agnostic. The terminal step for every
channel is `ledger.purchase(accountId, credits, reason)` (`credits/ledger.ts`).
x402 is a third `PurchaseChannel` that reaches that same call by a different
proof. The `Record<PurchaseChannel, …>` commission table is type-enforced, so
adding the union member forces the table entry — you can't forget it.

---

## Phase 1 — server MVP (this is the build task)

### 1. `contract.ts` — add the channel
Add `'x402'` to the `PurchaseChannel` union (currently
`'web_stripe' | 'iap_apple' | 'iap_google'`). This will immediately surface a
type error in `commission.ts` (good — it forces step 2).

### 2. `pricing/commission.ts` — commission entry
Add an `x402` entry to `TABLE`. Gas + CDP facilitator are ~0 on Base:
```ts
x402: {
  US: { rate: 0.001, note: 'Base gas + CDP facilitator (~0); USDC settled on-chain' },
  // EU CAVEAT: if x402 is ever exposed *inside the iOS app* in the EU, Apple's
  // Core Technology Commission may apply just like web_stripe EU. MVP offers
  // x402 on web/agent only, so no Apple cut — but if that changes, add an EU
  // row mirroring web_stripe.EU before enabling it there.
},
```
`WORST_CASE_COMMISSION` stays `0.18` (x402 is cheaper, doesn't move the max).
**Verify `meter.ts` `assertSolvent` still passes at boot** — it should, since
the worst case is unchanged.

### 3. Idempotency — fix once, covers both channels
**Latent bug found:** the direct (non-gift) Stripe purchase path is NOT
idempotent. `routes/billing.ts` calls `ledger.purchase(...)` →
`ledger.append` → `sqlite-store.appendEntry` (INSERT with a random UUID id, no
uniqueness on `reason`). A Stripe webhook *retry* would double-credit. The gift
path is safe only because `gifts.stripe_session_id` is `UNIQUE`.

Fix at the store layer so x402 inherits it:
- Add a **partial unique index** in `sqlite-store.ts` `SCHEMA`:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_purchase_ref
    ON ledger(reason) WHERE kind = 'purchase';
  ```
- In `appendEntry`, mirror `createGift`'s idempotent catch: on a UNIQUE/
  constraint violation **for a `purchase`-kind entry**, treat as a no-op
  (return) instead of throwing. For all other kinds, keep throwing.
- Reason formats become the dedup key:
  - Stripe: `purchase:${packId}:${stripeSessionId}` (already this shape).
  - x402:   `purchase:${packId}:x402:${txHash}`.
- Note: a fresh/test DB has no duplicate purchase reasons, so the index applies
  cleanly. (At current trial scale there's no legacy dupe risk; if it ever
  fails on legacy data, dedupe first.)
- Add a store-parity test: append two `purchase` entries with the same reason →
  one row, balance credited once.

### 4. `config.ts` — config + env
Add optional fields to `Config` (alongside `stripeSecretKey`):
```ts
x402Enabled?: boolean;        // X402_ENABLED
x402PayToAddress?: string;    // X402_PAY_TO_ADDRESS (Base address, 0x…)
x402Network?: 'base' | 'base-sepolia'; // X402_NETWORK (default base-sepolia)
cdpApiKeyId?: string;         // CDP_API_KEY_ID    (CDP facilitator, mainnet)
cdpApiKeySecret?: string;     // CDP_API_KEY_SECRET
```
Parse in the env block (mirror the `STRIPE_*` lines). The channel is "configured"
only when `x402Enabled && x402PayToAddress` are set; otherwise the route reports
"not configured" exactly like Stripe does without a key. Base Sepolia testing
may not need CDP keys (keyless testnet facilitator); mainnet settlement does —
note this in the config comment.

### 5. New module `billing/x402.ts` (mirrors `stripe.ts`'s role)
Thin glue over `x402-hono` + `@coinbase/x402`:
- Reuse the existing `CREDIT_PACKS` / `packById` from `stripe.ts` (don't
  duplicate pack definitions — import them, or lift packs into a neutral
  `billing/packs.ts` if importing from `stripe.ts` feels wrong).
- Build the `x402-hono` route map from `CREDIT_PACKS`: one entry per pack path
  (`/cloud/v1/billing/x402/buy/<packId>`) priced at `pack.priceUsdCents` in
  USDC. Static pricing per route avoids dynamic-price complexity.
- Configure `payTo = config.x402PayToAddress`, network from `config.x402Network`,
  facilitator from `@coinbase/x402` (CDP). Helper to extract the settlement
  **tx hash** from the x402 response context (`X-PAYMENT-RESPONSE`) for the
  idempotency reason.

### 6. `routes/billing.ts` — the buy route
Add an x402 sub-app/route group, gated on the channel being configured:
- `POST /cloud/v1/billing/x402/buy/:packId`
- Middleware order: **`requireAuth(deps)` → x402 `paymentMiddleware` → handler.**
  - `requireAuth` establishes WHICH account to credit (our Bearer JWT). The
    paying wallet is independent of the account — fine, and even enables "an
    agent tops up a user's balance."
  - x402 middleware enforces payment of the pack price; on unpaid requests it
    emits the `402` with payment requirements automatically.
- Handler (runs only after settlement): resolve `pack = packById(packId)`, read
  the settlement tx hash, call
  `ledger.purchase(account.id, pack.credits, 'purchase:${packId}:x402:${txHash}')`
  (idempotent per step 3), return `{ creditsRemaining }` (compute via
  `ledger.balance`). Use the existing `ApiError`/`ERROR_STATUS` shapes.
- Mounting: `billingRoutes` already mounts at `/cloud/v1/billing` (`app.ts:98`),
  so the new paths live under the same group — no new `app.route` needed.

### 7. Tests (mirror existing billing tests under `ts/server` test dir)
- `commissionFor('x402')` returns ~0; table has US entry; `assertSolvent` green.
- Idempotency: store-level (step 3) + a route-level test where a "paid" request
  (x402 middleware faked / facilitator stubbed) credits once and a replay with
  the same tx hash does not double-credit; an unpaid request returns 402.
- Contract: `PurchaseChannel` includes `'x402'` (type-level, compile check).

### 8. Manual end-to-end (testnet, no real money)
Funded Base Sepolia wallet + a tiny `x402-fetch` client script hitting
`/cloud/v1/billing/x402/buy/starter`. Confirm: 402 → pay → 200 → ledger credited
→ replay is a no-op. Document the script in the PR description.

---

## Phase 2 — client UI (overlaps meditation-pal-0gn)

Humans paying in the web app need a wallet to sign the EIP-3009 authorization:
`x402-fetch` + an injected/EIP-1193 provider in `ui/src/buy-credits-modal.ts`.
**This shares wallet-connect plumbing with the tip-jar "Send" follow-up
(meditation-pal-0gn)** — build the wallet-connect layer once and reuse. Until
Phase 2, the Phase 1 endpoint is fully usable by agents / any x402 client, which
is the agent-native use case du9 is really about.

## Phase 3 — ops, BEFORE enabling on mainnet (not blocking testnet MVP)
- Real treasury address + CDP mainnet API keys.
- **Off-ramp:** USDC → USD (providers bill us in USD). Manual at first.
- **Refunds:** on-chain is final → manual refund runbook.
- **Tax:** Stripe Tax does NOT cover x402. Sales-tax/VAT collection on x402
  purchases is unresolved — **treat as a go-live blocker for mainnet**, not for
  the testnet MVP.
- EU/Apple Core Technology Commission decision (see step 2 caveat).

## Key files (greppable anchors)
- `ts/server/src/contract.ts` — `PurchaseChannel`, `CheckoutRequest`
- `ts/server/src/pricing/commission.ts` — `TABLE`, `WORST_CASE_COMMISSION`, `commissionFor`
- `ts/server/src/pricing/meter.ts` — `assertSolvent` (boot solvency check)
- `ts/server/src/billing/stripe.ts` — `CREDIT_PACKS`, `packById` (pattern to mirror)
- `ts/server/src/routes/billing.ts` — `billingRoutes`, the `ledger.purchase` terminal
- `ts/server/src/credits/ledger.ts` — `purchase()` (append-only)
- `ts/server/src/credits/sqlite-store.ts` — `SCHEMA`, `appendEntry`, `createGift` (idempotent pattern)
- `ts/server/src/config.ts` — `Config`, `STRIPE_*` env parsing
- `ts/server/src/deps.ts` / `app.ts` — `Deps`/`buildDeps`, route mounting
- `ts/ui/src/buy-credits-modal.ts` — Phase 2 client entry point
