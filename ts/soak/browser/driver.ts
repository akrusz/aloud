/**
 * Playwright driver for tier 2: boots the real web UI in real Chrome with the
 * loopback device selected as its microphone, starts a session, and exposes the
 * page's soak tap (ui/src/soak-tap.ts) to the orchestrator.
 *
 * Real Chrome, not bundled Chromium: the Web Speech API only works in a build
 * with Google's speech keys, so `channel: 'chrome'` is load-bearing rather than
 * a preference. Headed by default for the same reason - headless Chrome's media
 * stack is a different animal, and a run that silently transcribes nothing looks
 * exactly like a facilitator that never answers.
 *
 * Everything the app needs to know is seeded into localStorage before boot
 * (settings.ts `preview:setup`, app-settings.ts `app:settings`, api-keys.ts
 * `apikey:<provider>`, all under the LocalStorageKv `aloud:` prefix), so the
 * driver never has to click through the setup panel - one less thing that breaks
 * when the panel is restyled. The only click is Begin, which has to be a real
 * user gesture for the microphone permission (mic-check.ts).
 */

import { chromium, type BrowserContext, type Page } from 'playwright-core';

import type { SoakTapState } from '../../ui/src/soak-tap.js';

const KV_PREFIX = 'aloud:';

export interface DriverOptions {
    /** Where the Vite dev server is serving the UI. */
    baseUrl: string;
    /** Chrome profile directory; persistent so a granted permission sticks. */
    userDataDir: string;
    /** Merged into the stored SessionSetup (settings.ts defaultSetup fills the rest). */
    setup: Record<string, unknown>;
    /** Merged into stored AppSettings. */
    appSettings: Record<string, unknown>;
    /** BYOK keys by provider name, written to `apikey:<provider>`. */
    apiKeys?: Record<string, string>;
    /** Substring matched against input-device labels. */
    micLabel: string;
    headless?: boolean;
    log?: (line: string) => void;
}

export interface SessionDriver {
    page: Page;
    /** Read the whole tap. Cheap: a few hundred small records per session. */
    readTap(): Promise<SoakTapState>;
    /** True once the view has torn down (timer close, auto-quit, End). */
    isEnded(): Promise<boolean>;
    /** End the sit from the app's side and tear the browser down. */
    close(): Promise<void>;
}

/** Fail fast with an actionable message rather than a Playwright timeout. */
async function assertReachable(baseUrl: string): Promise<void> {
    try {
        const res = await fetch(baseUrl, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        throw new Error(
            `The UI is not reachable at ${baseUrl} (${err instanceof Error ? err.message : String(err)}).\n` +
                'Start the dev servers first: npm run web:dev'
        );
    }
}

export async function launchSession(opts: DriverOptions): Promise<SessionDriver> {
    const log = opts.log ?? (() => {});
    await assertReachable(opts.baseUrl);

    const context: BrowserContext = await chromium.launchPersistentContext(opts.userDataDir, {
        channel: 'chrome',
        headless: opts.headless ?? false,
        // The app's own audio must play without a gesture, and the mic prompt
        // must never appear: grantPermissions covers the origin, the fake-UI
        // flag covers anything that asks again mid-session.
        args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
        permissions: ['microphone'],
        viewport: { width: 1100, height: 900 },
    });
    const origin = new URL(opts.baseUrl).origin;
    await context.grantPermissions(['microphone'], { origin });

    // Source text, not a function: tsx compiles this file with esbuild, which
    // wraps named functions in a `__name` helper that doesn't exist in the page.
    // A serialized function would arrive referencing it and throw on every load.
    const seed = async (extraSettings: Record<string, unknown>): Promise<void> => {
        const payload = JSON.stringify({
            prefix: KV_PREFIX,
            setup: opts.setup,
            settings: { ...opts.appSettings, ...extraSettings },
            keys: opts.apiKeys ?? {},
        });
        await context.addInitScript({
            content: `(() => {
                const { prefix, setup, settings, keys } = ${payload};
                const merge = (key, patch) => {
                    let base = {};
                    try { base = JSON.parse(localStorage.getItem(prefix + key) || '{}'); } catch (e) { base = {}; }
                    localStorage.setItem(prefix + key, JSON.stringify(Object.assign(base, patch)));
                };
                merge('preview:setup', setup);
                merge('app:settings', settings);
                for (const provider of Object.keys(keys)) {
                    localStorage.setItem(prefix + 'apikey:' + provider, keys[provider]);
                }
            })();`,
        });
    };

    try {
        return await bringUpSession(context, opts, seed, log);
    } catch (err) {
        await context.close();
        throw err;
    }
}

async function bringUpSession(
    context: BrowserContext,
    opts: DriverOptions,
    seed: (extraSettings: Record<string, unknown>) => Promise<void>,
    log: (line: string) => void
): Promise<SessionDriver> {
    await seed({});
    const page = await context.newPage();
    page.on('pageerror', (err) => log(`page error: ${err.message}`));
    await page.goto(opts.baseUrl, { waitUntil: 'domcontentloaded' });

    // The capture device is a per-origin, per-profile id, so it can only be
    // resolved in the page - and only after the permission grant, since labels
    // are empty until then. Seed it and reload so the session view is built with
    // the right mic from the start.
    const micDeviceId = await page.evaluate(async (label: string) => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const match = devices.find(
            (d) => d.kind === 'audioinput' && d.label.toLowerCase().includes(label.toLowerCase())
        );
        return match ? { id: match.deviceId, label: match.label } : null;
    }, opts.micLabel);
    if (!micDeviceId) {
        throw new Error(
            `Chrome sees no input device matching "${opts.micLabel}". ` +
                'Install BlackHole and restart the Mac, then restart Chrome.'
        );
    }
    log(`mic: ${micDeviceId.label}`);
    await seed({ micDeviceId: micDeviceId.id });

    await page.goto(`${opts.baseUrl}${opts.baseUrl.includes('?') ? '&' : '?'}soak=1`, {
        waitUntil: 'domcontentloaded',
    });

    // Begin must be a real click: the permission prompt rides on that gesture.
    const begin = page.locator('#begin-btn');
    await begin.waitFor({ state: 'visible', timeout: 30_000 });
    try {
        await page.waitForFunction(
            () => !document.querySelector<HTMLButtonElement>('#begin-btn')?.disabled,
            undefined,
            { timeout: 30_000 }
        );
    } catch {
        // Begin is gated on a usable mic AND a reachable LLM (setup.ts
        // updateBeginButton). A bare timeout says neither; the page does.
        const why = await page.evaluate(() =>
            ['#setup-no-mic-text', '#provider-hint']
                .map((sel) => document.querySelector<HTMLElement>(sel))
                .filter((el): el is HTMLElement => el !== null && !el.closest('.hidden'))
                .map((el) => el.innerText.trim())
                .filter(Boolean)
                .join(' | ')
        );
        throw new Error(
            `Begin never became clickable. The setup page says: ${why || '(nothing)'}.\n` +
                'Usually a missing BYOK key for the facilitator provider, or Chrome without microphone access.'
        );
    }
    await begin.click();

    // The tap arms at session mount; its presence is the signal the view is up.
    await page.waitForFunction(() => window.__aloudSoak !== undefined, undefined, {
        timeout: 30_000,
    });
    log('session started');

    return {
        page,
        async readTap(): Promise<SoakTapState> {
            return page.evaluate(() => window.__aloudSoak as SoakTapState);
        },
        async isEnded(): Promise<boolean> {
            return page.evaluate(() => window.__aloudSoak?.flags.ended ?? true);
        },
        async close(): Promise<void> {
            await context.close();
        },
    };
}
