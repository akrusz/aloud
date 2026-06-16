# x402 credit-purchase channel — implementation plan (meditation-pal-du9)

Status: **Phase 1 (server MVP) BUILT, hand-rolled (no SDK)** — channel +
commission + config + `billing/x402.ts` + buy route + idempotency fix + tests
all landed and green. HTTP paywall smoke-verified:
enabled+authed+unpaid → 402 advertising the right USDC amount / network / USDC
asset / payTo / EIP-712 domain; mainnet path refuses loudly (no half-settle).
Flag-gated OFF. The viem/x402-hono middleware was tried then reverted — see the
decision note below. **Phase 2 (client "Pay with USDC" UI) is also BUILT**
(injected-wallet, no viem in the bundle) — see the Phase 2 section.
**Not yet done:** a live Base Sepolia end-to-end with a funded test wallet
(plan step 8), Phase 3 (mainnet CDP auth + ops/off-ramp/refunds/tax).
The sections below are kept as the as-built record + the remaining roadmap.

## Decisions locked (do not re-litigate)

- **Verification: hand-rolled over `fetch`, NO SDK** (matches `billing/stripe.ts`).
  Originally built on `x402-hono` + `@coinbase/x402`, then reverted: reading the
  code showed the server owns NO cryptographic verification in either design —
  the payer's wallet signs (client side) and the facilitator verifies + settles
  on-chain. `viem` was used only for address checksumming / payment decode /
  price math (utilities). So the middleware added ~108MB + ~500 transitive
  packages of supply-chain surface (`node_modules` 717M→104M after revert) for a
  thin HTTP broker, with no crypto-risk delta. The hand-roll is ~200 lines +
  static constants (USDC addresses, EIP-712 domain, facilitator URLs), zero new
  deps (`fetch` + `jose`, already present). See commit abdc65f.
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

## Phase 2 — client UI ✅ BUILT (commit 71538e0)

A "Pay with USDC" path in the buy-credits modal, the LEAN way — **no viem/web3
in the bundle** (+~14KB plain JS vs hundreds of KB for `x402-fetch`). We talk to
the injected EIP-1193 wallet directly; it signs.
- `ui/src/x402-sign.ts` — pure x402 `exact` signing (TransferWithAuthorization /
  EIP-3009): buildAuthorization, buildTypedData, encodeXPayment. Verified to
  match the x402 reference field-for-field.
- `ui/src/x402-pay.ts` — the flow: POST buy (402) → connect wallet + switch to
  Base → eth_signTypedData_v4 → re-POST with X-PAYMENT → settled result. Adds
  the Base chain if the wallet lacks it; friendly WalletError on reject/no-wallet.
- `ui/src/buy-credits-modal.ts` — Card | USDC toggle (shown only when the
  channel is live, per `/me/packs`). USDC is self-only for now (no gift flow);
  settles in-place (no redirect), updates the live balance, shows a success line.
- `server/routes/me.ts` — `/me/packs` advertises `{ x402: { enabled, network } }`.

**To see it locally:** set `X402_ENABLED=1`, `X402_PAY_TO_ADDRESS=0x…`,
`X402_NETWORK=base-sepolia` on the server → the modal shows the USDC toggle.
**NOT yet verified end-to-end** — the wallet→sign→settle→credit round-trip needs
a real browser + a Base Sepolia wallet holding test USDC. That's the remaining
manual test (and the wallet-connect plumbing now exists to reuse for the tip-jar
"Send" follow-up, meditation-pal-0gn).

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
