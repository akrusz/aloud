/**
 * Runtime "is this a desktop environment" detection.
 *
 * "Desktop" = the app backend reports it's a local/desktop backend. We probe
 * /app/v1/system-info at boot: the native Rust shell is desktop (it exposes
 * claude_proxy, the Ollama proxy, config-folder shell escapes); the hosted web
 * backend answers `desktop:false` so those features stay off there. The signal
 * is the `desktop` field — NOT mere reachability, since the web Hono also
 * answers /app/v1/system-info (with desktop:false). A response that omits the
 * field counts as desktop, to keep the existing browser-against-local-backend
 * dev behavior. Views read isDesktop() for gating desktop-only features
 * (claude_proxy provider, env-var hints, the Open config folder button).
 *
 * Result is monotonic: once we've decided "desktop", we stick with it
 * for the session. If the backend flaps down between probes we'd rather not
 * yank the controls.
 */

import { appUrl } from './app-base.js';

/**
 * Synchronous "are we running inside the Tauri desktop shell" check.
 * Tauri v2 always injects `window.__TAURI_INTERNALS__` into the webview
 * (independent of the `withGlobalTauri` config), so this is reliable at
 * boot without a probe. Used to gate shell-specific behavior: the macOS
 * WKWebView's Web Speech API is unreliable, so STT must prefer
 * server-Whisper (see stt-picker.ts); chrome (drag region, no-select)
 * keys off it too.
 */
export function isTauri(): boolean {
    return (
        typeof window !== 'undefined' &&
        (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
            undefined
    );
}

/**
 * Synchronous "are we on Android" check (userAgent sniff).
 *
 * Used to gate behavior that depends on Android's single-owner microphone:
 * unlike desktop Chrome, Android hands the mic to exactly one consumer, so a
 * second `getUserMedia` capture (e.g. the cosmetic mic-level meter) starves the
 * Web Speech system recognizer and recognition silently returns no results.
 * See startMeter() in views/session.ts.
 */
export function isAndroid(): boolean {
    return (
        typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')
    );
}

let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

export async function detectIsDesktop(): Promise<boolean> {
    if (cached !== null) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const resp = await fetch(appUrl('/system-info'), { method: 'GET' });
            if (!resp.ok) {
                cached = false;
                return cached;
            }
            // Desktop unless the backend explicitly says otherwise (web Hono
            // answers desktop:false). A missing field → desktop.
            const info = (await resp.json().catch(() => ({}))) as { desktop?: boolean };
            cached = info.desktop !== false;
            return cached;
        } catch {
            cached = false;
            return cached;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/** Synchronous read — returns the cached value, or `false` until the
 *  first probe completes. Useful for render paths that can't await. */
export function isDesktopSync(): boolean {
    return cached ?? false;
}
