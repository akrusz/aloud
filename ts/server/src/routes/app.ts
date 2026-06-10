/**
 * The app's own backend surface for the **web** build, under `/app/v1/*`.
 *
 * The desktop shell answers these from native Rust (`src-tauri/server.rs`); the
 * web build has no local backend, so this hosted process answers the
 * non-inference ones (the parts that don't need on-device Whisper/Piper/Ollama
 * or shell access — those stay desktop-only and are simply absent here):
 *
 *   GET /app/v1/system-info      — platform marker; `desktop:false` so the UI's
 *                                  desktop-feature gate stays off on the web.
 *   GET /app/v1/providers        — provider availability for the picker's marks.
 *   GET /app/v1/models/:provider — live model lists (BYOK key via x-provider-key).
 *   GET /app/v1/voices           — local server voices: none on web (hosted
 *                                  voices are separate, at /cloud/v1/voices).
 *
 * Notes:
 * - No /tts-engines: Flask never implemented it and the UI has no fetch site.
 * - claude_proxy and the /open-* shell escapes are desktop-only (omitted).
 */

import { Hono } from 'hono';
import type { Deps } from '../deps.js';
import { ipRateLimit } from '../auth/middleware.js';
import { RateGuard } from '../quota/freetier.js';
import { fetchModels } from '../providers/models.js';

/** BYOK providers the picker may show. Availability is client-key-gated (the
 *  server never sees the key), so we report them available and let the client
 *  decide. Ollama and claude_proxy are local-only and never available on the
 *  web — reported unavailable so a forced-local browser-dev session (which
 *  shows every provider) marks them ✘ rather than as usable. */
const WEB_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'venice', 'groq'];

export function appBackendRoutes(_deps: Deps): Hono {
    const app = new Hono();

    app.get('/system-info', (c) =>
        c.json({
            platform: 'web',
            // The single most important field: the UI's is-desktop probe keys
            // off this so the web build never enables desktop-only features
            // (claude_proxy, Open config folder, env-var hints).
            desktop: false,
            has_homebrew: false,
            tools: {
                claude_cli: { installed: false, path: null },
                ollama: { installed: false, path: null },
            },
        })
    );

    app.get('/providers', (c) => {
        const providers: Record<string, { available: boolean; installed?: boolean; hint?: string }> =
            {
                ollama: {
                    available: false,
                    installed: false,
                    hint: 'Ollama runs on your own machine — use the desktop app for local models.',
                },
                claude_proxy: {
                    available: false,
                    installed: false,
                    hint: 'Anthropic (Subscription) uses the local Claude Code CLI — use the desktop app.',
                },
            };
        for (const p of WEB_PROVIDERS) providers[p] = { available: true };
        return c.json(providers);
    });

    // Unauthenticated forwarder of a client-supplied BYOK key to the provider's
    // model-list endpoint — cap it per IP so it can't be driven as a free
    // key-validation oracle / traffic relay. 30/min dwarfs any legitimate
    // picker refresh.
    const modelsGuard = new RateGuard(30, 60_000);
    app.get('/models/:provider', ipRateLimit(modelsGuard), async (c) => {
        const provider = c.req.param('provider');
        const key = c.req.header('x-provider-key') ?? null;
        return c.json(await fetchModels(provider, key));
    });

    // No on-device Piper/macOS voices on the web; the browser's speechSynthesis
    // voices come from the client and the hosted voices from /cloud/v1/voices.
    app.get('/voices', (c) => c.json([]));

    return app;
}
