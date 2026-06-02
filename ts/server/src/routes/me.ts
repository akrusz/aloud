/**
 * GET /v1/me — the signed-in account and its live credit balance. Also exposes
 * the things a client needs to render its model picker and store transparently:
 * GET /v1/me/models (allowed models + per-token cost) and GET /v1/me/packs.
 */

import { Hono } from 'hono';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { buildAccountView, deleteAccount } from '../auth/identity.js';
import { allowedModels } from '../pricing/providers.js';
import { USD_PER_CREDIT, PACK_MARKUP } from '../pricing/meter.js';
import { CREDIT_PACKS } from '../billing/stripe.js';
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
        return c.json(await buildAccountView(deps, c.get('account')));
    });

    // Delete the signed-in account (meditation-pal-8jc). Soft-delete: anonymize +
    // tombstone, free the identities, forfeit any remaining balance. Irreversible;
    // the client confirms first. The token is dead afterward (requireAuth rejects
    // a tombstoned account), so the client clears it and signs out.
    app.delete('/', requireAuth(deps), async (c) => {
        await deleteAccount(deps, c.get('account'));
        return c.json({ deleted: true });
    });

    // Public pricing transparency — no auth needed; the margin is published.
    // Each model carries its typical-session creditsPerHour so the client's
    // model dropdown can show the cloud-rate badge ("N☁️") next to it.
    app.get('/models', (c) => {
        const ratePerHour = new Map(
            estimateModels().map((e) => [`${e.provider}:${e.model}`, e.creditsPerHour])
        );
        return c.json({
            // Credits debit at provider COST; margin is added at purchase.
            usdPerCredit: USD_PER_CREDIT,
            packMarkup: PACK_MARKUP,
            models: allowedModels().map((m) => ({
                ...m,
                creditsPerHour: ratePerHour.get(`${m.provider}:${m.model}`) ?? null,
            })),
        });
    });

    // Packs for sale, plus whether the x402 (USDC-on-Base) channel is available
    // so the buy-credits UI knows to offer "Pay with USDC" and which network to
    // sign for. Off → the UI shows card-only. (meditation-pal-du9 Phase 2.)
    app.get('/packs', (c) => {
        const x402 = x402Configured(deps);
        return c.json({
            packs: CREDIT_PACKS,
            x402: x402 ? { enabled: true, network: x402.network } : { enabled: false },
        });
    });

    // Public credit-use estimates for the UI ("Opus ~N credits/hr", per-voice
    // cost lines). Seeded from one measured session; refine with telemetry.
    // The client composes a session estimate as: model + stt + chosen voice.
    app.get('/estimates', (c) =>
        c.json({
            usdPerCredit: USD_PER_CREDIT,
            packMarkup: PACK_MARKUP,
            basis: {
                source: 'one measured ~50-min session, history-caching on',
                sessionMinutes: TYPICAL_SESSION_MINUTES,
                confidence: 'order-of-magnitude (±~35%); validate before launch',
                voiceBand: 'TTS cost is a band (spacious/typical/engaged) — it tracks facilitator verbosity, user share length, and model chattiness; local voices are free',
            },
            models: estimateModels(),
            stt: estimateStt(),
            voices: estimateVoices(),
        })
    );

    return app;
}
