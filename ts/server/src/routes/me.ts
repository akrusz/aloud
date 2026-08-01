/**
 * GET /v1/me: the signed-in account and its live credit balance, plus what a
 * client needs to render its model picker and store transparently
 * (/v1/me/models, /v1/me/packs, /v1/me/estimates).
 */

import { Hono } from 'hono';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { UpdateMeRequest } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { buildAccountView, deleteAccount } from '../auth/identity.js';
import { USD_PER_CREDIT, PACK_MARKUP } from '../pricing/meter.js';
import {
    CREDIT_PACKS,
    MIN_CUSTOM_CREDITS,
    MAX_CUSTOM_CREDITS,
    BASE_CENTS_PER_CREDIT,
    CURVE_A,
    CURVE_B,
    CURVE_C,
    CAP_SPEND_CENTS,
    CAP_CREDITS_PER_DOLLAR,
} from '../billing/stripe.js';
import { x402Configured } from '../billing/x402.js';
import {
    TYPICAL_SESSION_MINUTES,
    estimateModels,
    estimateStt,
    estimateVoices,
} from '../pricing/estimate.js';

export function meRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.get('/', requireAuth(deps), async (c) => {
        const account = c.get('account');
        // Lazy orphan-hold cleanup: a turn that died between hold and settle
        // (client disconnect, crash) parks credits in a hold nobody will close.
        // Sweeping here means the balance the user sees has already recovered
        // them. placeHold does the same on the spend path.
        await deps.ledger.releaseStaleHolds(account.id);
        return c.json(await buildAccountView(deps, account));
    });

    // Update account preferences. Today that's just the email-updates opt-in
    // (occasional product news; strictly opt-in, the address is never shared or
    // sold). Returns the refreshed account view.
    app.patch('/', requireAuth(deps), async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as UpdateMeRequest;
        if (typeof body.emailUpdates !== 'boolean') {
            return c.json(apiError('bad_request', 'nothing to update'), ERROR_STATUS.bad_request);
        }
        const account = c.get('account');
        await deps.store.setAccountEmailUpdates(account.id, body.emailUpdates);
        return c.json(await buildAccountView(deps, { ...account, emailUpdates: body.emailUpdates }));
    });

    // Delete the signed-in account (meditation-pal-8jc). Soft-delete: anonymize +
    // tombstone, free the identities, forfeit any remaining balance. Irreversible;
    // the client confirms first. The token dies with it (requireAuth rejects a
    // tombstoned account), so the client clears it and signs out.
    app.delete('/', requireAuth(deps), async (c) => {
        await deleteAccount(deps, c.get('account'));
        return c.json({ deleted: true });
    });

    // Public pricing transparency, no auth: the margin is published. Each model
    // carries its typical-session creditsPerHour so the model dropdown can show
    // the cloud-rate badge ("N☁️"). Only models the liveness sweep hasn't
    // proven retired are offered (pricing/liveness.ts, fail-open) - the picker
    // never lists an id the provider would 404.
    app.get('/models', (c) => {
        const ratePerHour = new Map(
            estimateModels().map((e) => [`${e.provider}:${e.model}`, e.creditsPerHour])
        );
        return c.json({
            // Credits debit at provider COST; margin is added at purchase.
            usdPerCredit: USD_PER_CREDIT,
            packMarkup: PACK_MARKUP,
            models: deps.liveness.liveModels().map((m) => ({
                ...m,
                creditsPerHour: ratePerHour.get(`${m.provider}:${m.model}`) ?? null,
            })),
        });
    });

    // Packs for sale, plus whether the x402 (USDC-on-Base) channel is available
    // so the buy-credits UI knows to offer "Pay with USDC" and which network to
    // sign for. Off → card-only. (meditation-pal-du9 Phase 2.)
    app.get('/packs', (c) => {
        const x402 = x402Configured(deps);
        return c.json({
            packs: CREDIT_PACKS,
            x402: x402 ? { enabled: true, network: x402.network } : { enabled: false },
            // Backs the "type your own amount" field (card checkout only),
            // priced on the shared volume curve. The client previews the price
            // from these params; the server re-prices authoritatively at
            // checkout. `base` is the entry rate for the discount-vs-base hint;
            // `curve` is the quadratic (in dollars) plus the flat-rate cap
            // beyond $20.
            custom: {
                baseCentsPerCredit: BASE_CENTS_PER_CREDIT,
                curve: {
                    a: CURVE_A,
                    b: CURVE_B,
                    c: CURVE_C,
                    capSpendCents: CAP_SPEND_CENTS,
                    capCreditsPerDollar: CAP_CREDITS_PER_DOLLAR,
                },
                minCredits: MIN_CUSTOM_CREDITS,
                maxCredits: MAX_CUSTOM_CREDITS,
            },
        });
    });

    // Public credit-use estimates for the UI ("Opus ~N credits/hr", per-voice
    // cost lines), seeded from one measured session. The client composes a
    // session estimate as model + stt + chosen voice.
    app.get('/estimates', (c) =>
        c.json({
            usdPerCredit: USD_PER_CREDIT,
            packMarkup: PACK_MARKUP,
            basis: {
                source: 'one measured ~50-min session, history-caching on',
                sessionMinutes: TYPICAL_SESSION_MINUTES,
                confidence: 'order-of-magnitude (±~35%); validate before launch',
                voiceBand: 'TTS cost is a band (spacious/typical/engaged) - it tracks facilitator verbosity, user share length, and model chattiness; local voices are free',
            },
            models: estimateModels(),
            stt: estimateStt(),
            voices: estimateVoices(),
        })
    );

    return app;
}
