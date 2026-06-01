/**
 * GET /v1/me — the signed-in account and its live credit balance. Also exposes
 * the things a client needs to render its model picker and store transparently:
 * GET /v1/me/models (allowed models + per-token cost) and GET /v1/me/packs.
 */

import { Hono } from 'hono';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { buildAccountView } from '../auth/identity.js';
import { allowedModels } from '../pricing/providers.js';
import { USD_PER_CREDIT, PACK_MARKUP } from '../pricing/meter.js';
import { CREDIT_PACKS } from '../billing/stripe.js';
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

    // Public pricing transparency — no auth needed; the margin is published.
    app.get('/models', (c) =>
        c.json({
            // Credits debit at provider COST; margin is added at purchase.
            usdPerCredit: USD_PER_CREDIT,
            packMarkup: PACK_MARKUP,
            models: allowedModels(),
        })
    );

    app.get('/packs', (c) => c.json({ packs: CREDIT_PACKS }));

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
