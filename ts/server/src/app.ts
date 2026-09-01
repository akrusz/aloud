/**
 * Hono app factory: CORS, health check, and routes over an injected Deps. Free
 * of process/network side effects so tests drive it with `app.request(...)`
 * against an in-memory store (see tests/).
 *
 * `/cloud/v1/*` is the signed-in, billed cloud service (auth, account, billing,
 * metered LLM/STT/TTS forwarding). `/app/v1/*` is the app's own backend
 * (provider/voice catalogs, system info, on-device inference): the Rust shell
 * on desktop, mirrored here for the web build (bkg).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Deps } from './deps.js';
import { configuredProviders } from './config.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { llmRoutes } from './routes/llm.js';
import { sttRoutes } from './routes/stt.js';
import { ttsRoutes } from './routes/tts.js';
import { CURATED_VOICES } from './providers/voice-catalog.js';
import { voiceCreditsPerHourTypical } from './pricing/estimate.js';
import type { CloudVoice } from './contract.js';
import { billingRoutes } from './routes/billing.js';
import { giftRoutes } from './routes/gifts.js';
import { adminRoutes } from './routes/admin.js';
import { appBackendRoutes } from './routes/app.js';

export function createApp(deps: Deps): Hono {
    const app = new Hono();

    // Allowlist match is trailing-slash tolerant on both sides: browsers send
    // Origin without one, but a configured `https://aloud.rest/` is an easy
    // mistake. Normalizing both avoids silently dropping the CORS header, which
    // surfaces only as an opaque "Access-Control-Allow-Origin missing". With no
    // origins configured we fall open to '*' for zero-config local dev.
    const allowedOrigins = deps.config.corsOrigins.map(stripTrailingSlash);
    app.use(
        '*',
        cors({
            origin:
                allowedOrigins.length === 0
                    ? '*'
                    : (origin) => (allowedOrigins.includes(stripTrailingSlash(origin)) ? origin : null),
            // PATCH/DELETE are the /cloud/v1/me verbs (email-updates opt-in,
            // account deletion). Both preflight, and a missing verb here fails
            // the preflight, not the request - the client only ever sees an
            // opaque "Load failed" (meditation-pal-bozr).
            allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
            allowHeaders: ['authorization', 'content-type'],
            // So the browser can read per-request cost off the /cloud/v1/tts response.
            exposeHeaders: ['X-Credits-Charged', 'X-Credits-Remaining', 'X-Session-Refresh'],
        })
    );

    // Liveness + a peek at what's wired, without leaking secrets.
    app.get('/health', (c) =>
        c.json({
            ok: true,
            providers: configuredProviders(deps.config),
            billing: Boolean(deps.config.stripeSecretKey),
            // Which media capabilities the client can route here (vs native).
            stt: Boolean(deps.config.sttConfig),
            tts: Boolean(deps.config.googleTtsApiKey || deps.config.openaiTtsApiKey || deps.config.azureSpeechKey),
        })
    );

    // Public: what a client needs *before* sign-in, chiefly the Google OAuth web
    // client id. It's public by design (it already ships in the hosted bundle),
    // so any install pointed at this server can render the sign-in button without
    // baking the id in at build time. Empty when GOOGLE_CLIENT_IDS is unset; the
    // client then keeps its dev-sign-in fallback. (meditation-pal-rfb)
    app.get('/cloud/v1/config', (c) =>
        c.json({
            googleClientId: deps.config.googleClientIds[0] ?? '',
            appleClientId: deps.config.appleClientIds[0] ?? '',
            // Desktop (Tauri) uses a separate "Desktop app" OAuth client for the
            // loopback PKCE flow. The id is public (it appears in the auth URL the
            // user sees); the secret stays server-side. Empty disables it.
            googleDesktopClientId: deps.config.googleDesktopClientId ?? '',
        })
    );

    // Public: the curated hosted voices, or [] when TTS isn't configured. The
    // client merges these into its voice picker.
    app.get('/cloud/v1/voices', (c) => {
        // A provider's voices appear only when its key is configured, so the
        // picker never offers a voice the server can't synthesize.
        const hasKey = {
            google: Boolean(deps.config.googleTtsApiKey),
            openai: Boolean(deps.config.openaiTtsApiKey),
            azure: Boolean(deps.config.azureSpeechKey),
        };
        const voices: CloudVoice[] = CURATED_VOICES.filter((v) => hasKey[v.provider]).map((v) => ({
            name: v.name,
            gender: v.gender,
            tier: v.tier,
            creditsPerHourTypical: voiceCreditsPerHourTypical(v.provider, v.providerVoiceId, v),
            ...(v.multilingual ? { multilingual: true } : {}),
            ...(v.style ? { fixedPace: true } : {}),
        }));
        return c.json(voices);
    });

    app.route('/cloud/v1/auth', authRoutes(deps));
    app.route('/cloud/v1/me', meRoutes(deps));
    app.route('/cloud/v1/llm', llmRoutes(deps));
    app.route('/cloud/v1/stt', sttRoutes(deps));
    app.route('/cloud/v1/tts', ttsRoutes(deps));
    app.route('/cloud/v1/billing', billingRoutes(deps));
    app.route('/cloud/v1/gifts', giftRoutes(deps));
    app.route('/cloud/v1/admin', adminRoutes(deps));

    // The app's own backend for the web build (desktop serves these natively).
    // Non-inference only; see routes/app.ts.
    app.route('/app/v1', appBackendRoutes(deps));

    return app;
}

/** Drop trailing slashes so origin comparison is robust to `https://x/` vs the
 *  `https://x` a browser sends. Empty string stays empty. */
function stripTrailingSlash(origin: string): string {
    return origin.replace(/\/+$/, '');
}
