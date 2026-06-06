/**
 * Hono app factory. Wires CORS, a health check, and the /cloud/v1 routes onto
 * an injected Deps. Kept free of process/network side effects so tests can
 * drive it with `app.request(...)` against an in-memory store (see tests/).
 *
 * Route naming: this server hosts the signed-in, billed cloud service under
 * `/cloud/v1/*` (auth, account, billing, metered LLM/STT/TTS forwarding). The
 * app's own backend — provider/voice catalogs, system info, on-device
 * inference — lives at `/app/v1/*` (the Rust shell on desktop; mirrored here
 * for the web build, see bkg).
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

    // Allowlist match is trailing-slash tolerant on both sides: a browser sends
    // Origin with no trailing slash, but a configured value like
    // `https://aloud.rest/` is an easy mistake — normalize both so it still
    // matches instead of silently dropping the CORS header (which surfaces as an
    // opaque "Access-Control-Allow-Origin missing" in the browser). With no
    // origins configured we fall back to '*' (open) for zero-config local dev.
    const allowedOrigins = deps.config.corsOrigins.map(stripTrailingSlash);
    app.use(
        '*',
        cors({
            origin:
                allowedOrigins.length === 0
                    ? '*'
                    : (origin) => (allowedOrigins.includes(stripTrailingSlash(origin)) ? origin : null),
            allowMethods: ['GET', 'POST', 'OPTIONS'],
            allowHeaders: ['authorization', 'content-type'],
            // So the browser can read per-request cost off the /cloud/v1/tts response.
            exposeHeaders: ['X-Credits-Charged', 'X-Credits-Remaining'],
        })
    );

    // Liveness + a peek at what's wired, without leaking secrets.
    app.get('/health', (c) =>
        c.json({
            ok: true,
            providers: configuredProviders(deps.config),
            billing: Boolean(deps.config.stripeSecretKey),
            // Which media capabilities the client can route here (vs Flask/native).
            stt: Boolean(deps.config.sttConfig),
            tts: Boolean(deps.config.googleTtsApiKey),
        })
    );

    // Public: the build-agnostic bits a client needs *before* sign-in. Today just
    // the Google OAuth web client id (public by design — it ships in the hosted
    // bundle already), so ANY install — local, desktop, or web — pointed at this
    // server can render the Google sign-in button without baking the id in at
    // build time. Empty when the server has no GOOGLE_CLIENT_IDS, in which case
    // the client keeps its dev-sign-in fallback. (meditation-pal-rfb)
    app.get('/cloud/v1/config', (c) =>
        c.json({
            googleClientId: deps.config.googleClientIds[0] ?? '',
            appleClientId: deps.config.appleClientIds[0] ?? '',
            // Desktop (Tauri) uses a separate "Desktop app" OAuth client for the
            // loopback PKCE flow; the id is public (it appears in the auth URL the
            // user sees), the secret stays server-side. Empty disables it.
            googleDesktopClientId: deps.config.googleDesktopClientId ?? '',
        })
    );

    // Public: the curated hosted voices, or [] when TTS isn't configured. The
    // client merges these into its voice picker (availability-driven menus).
    app.get('/cloud/v1/voices', (c) => {
        const voices: CloudVoice[] = deps.config.googleTtsApiKey
            ? CURATED_VOICES.map((v) => ({
                  name: v.name,
                  gender: v.gender,
                  tier: v.tier,
                  creditsPerHourTypical: voiceCreditsPerHourTypical(v.googleId),
              }))
            : [];
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

    // The app's own backend surface for the web build (the desktop shell serves
    // these natively). Non-inference only; see routes/app.ts.
    app.route('/app/v1', appBackendRoutes(deps));

    return app;
}

/** Drop trailing slashes so origin comparison is robust to `https://x/` vs the
 *  `https://x` a browser actually sends. Empty string stays empty. */
function stripTrailingSlash(origin: string): string {
    return origin.replace(/\/+$/, '');
}
