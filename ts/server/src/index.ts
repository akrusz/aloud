/**
 * Server entrypoint: load config from the environment, assert pricing solvency
 * (refuses to start at a loss, meditation-pal-8sj), build deps, serve the Hono
 * app over Node's HTTP server.
 *
 * Runs via tsx (package.json "start"), which resolves the @aloud/core path alias
 * so the proxy can reuse core's provider/usage code at runtime.
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { loadConfig, configuredProviders } from './config.js';
import { buildDeps } from './deps.js';
import { createApp } from './app.js';
import { reconcileExpiredGifts } from './credits/gifts.js';
import { ageOutSignupIps } from './auth/identity.js';
import { assertSolvent, PACK_MARKUP } from './pricing/meter.js';
import { loadRuntimeOverrides } from './admin/runtime-config.js';
import { CREDIT_PACKS } from './billing/stripe.js';
import { setStrictContentCheck, log } from './logger.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read `index.html` from the UI dir once for the SPA fallback; null if absent
 *  (unmatched paths then 404 rather than crashing the boot). */
function readIndexHtml(root: string): string | null {
    try {
        return readFileSync(join(root, 'index.html'), 'utf8');
    } catch (e) {
        log.warn('ALOUD_UI_DIR set but index.html unreadable; no SPA fallback', {
            uiDir: root,
            error: String(e),
        });
        return null;
    }
}

async function main(): Promise<void> {
    // Load .env for local dev; Fly/Render inject real env and have no file,
    // hence the guard. Tests build config explicitly and never import this
    // entrypoint, so they stay hermetic.
    try {
        process.loadEnvFile();
    } catch {
        /* no .env present - rely on the ambient environment */
    }

    const config = loadConfig();

    // In production the content-check drops the field instead of throwing, so a
    // stray log field can't crash a paying request. Content is still never logged.
    setStrictContentCheck(!config.strict);

    // Refuse to start if any pack's margin can't clear the worst channel. Pack
    // credits already include the volume discount, so this is the real margin.
    const solvency = assertSolvent(CREDIT_PACKS);

    const deps = buildDeps(config);
    // Fold persisted operator overrides (admin panel) over the env defaults
    // before serving, so a knob set last week survives this restart.
    await loadRuntimeOverrides(deps);
    const app = createApp(deps);

    // Optional: serve the built UI from this process (the self-host story;
    // unset in the canonical deploy, where the UI is on a static host).
    // Registered after the API routes so /cloud and /app win; unmatched paths
    // fall through to static files, then to index.html for client routes. API
    // namespaces keep their JSON 404 so clients aren't handed HTML. Lives in the
    // entrypoint, not createApp(), so the app factory stays filesystem-free for
    // tests.
    if (config.uiDir) {
        const root = config.uiDir;
        const indexHtml = readIndexHtml(root);
        app.use('/*', serveStatic({ root }));
        app.notFound((c) => {
            const path = new URL(c.req.url).pathname;
            const isApi = ['/cloud', '/app', '/health'].some((p) => path.startsWith(p));
            if (isApi || indexHtml === null) return c.json({ error: 'not found' }, 404);
            return c.html(indexHtml);
        });
        log.info('serving static UI', { uiDir: root, spaFallback: indexHtml !== null });
    }

    // Hourly housekeeping, once at boot then on an interval. Both jobs are
    // idempotent, so overlapping/extra runs are harmless:
    //   - gift expiry: return clouds from gifts left unaccepted past their
    //     expiry to the buyer (meditation-pal-bd5);
    //   - signup-IP ageing: scrub IPs past the retention window
    //     (meditation-pal-9rkg);
    //   - model liveness: zero-token metadata probes so /me/models drops any
    //     allowlisted model its provider has retired (pricing/liveness.ts,
    //     fail-open on probe errors).
    const sweep = (): void => {
        void reconcileExpiredGifts(deps, Date.now() / 1000)
            .then((n) => {
                if (n > 0) log.info('gift expiry sweep', { returnedToBuyers: n });
            })
            .catch((err: unknown) => log.error('gift expiry sweep failed', { err: String(err) }));
        void ageOutSignupIps(deps, Date.now() / 1000).catch((err: unknown) =>
            log.error('signup IP ageing failed', { err: String(err) })
        );
        void deps.liveness
            .sweep()
            .then((r) => {
                // Gone models are the actionable signal; log them every sweep
                // so a retirement can't scroll away unnoticed.
                if (r.gone.length > 0) log.error('model liveness: retired models dropped from /me/models', { gone: r.gone });
                if (r.unknown.length > 0) log.info('model liveness: unverified (kept, fail-open)', { unknown: r.unknown });
            })
            .catch((err: unknown) => log.error('model liveness sweep failed', { err: String(err) }));
    };
    sweep();
    setInterval(sweep, 3_600_000).unref();

    const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
        log.info('aloud cloud up', {
            port: info.port,
            providers: configuredProviders(config),
            billing: Boolean(config.stripeSecretKey),
            packMarkup: PACK_MARKUP,
            packsClear: solvency.every((r) => r.clears),
            freeSignupCredits: config.freeSignupCredits,
            // Echoed so a CORS mismatch is debuggable from the boot log alone
            // ('*' = open, else the exact allowlist the browser must match).
            corsOrigins: config.corsOrigins.length > 0 ? config.corsOrigins : '*',
        });
    });

    // Graceful shutdown. Fly stops/redeploys by signalling the process
    // (litestream catches it and forwards to us); exiting slowly gets the VM
    // force-halted ("exited abruptly"), which can cut litestream's final R2
    // sync. So: close the HTTP server, then the SQLite handle (closing
    // checkpoints the WAL into the main file), then exit, all inside Fly's kill
    // window. Hard-capped so a hung connection can't outlive that window;
    // committed rows are already durable on the volume (PRAGMA synchronous =
    // FULL), so a forced exit is still safe.
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info('shutting down', { signal });
        const cap = setTimeout(() => process.exit(0), 4000);
        cap.unref();
        server.close(() => {
            try {
                deps.store.close?.();
            } catch (err) {
                log.warn('store close failed during shutdown', { error: String(err) });
            }
            process.exit(0);
        });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
    log.error('fatal: server failed to start', { error: String(err) });
    process.exit(1);
});
