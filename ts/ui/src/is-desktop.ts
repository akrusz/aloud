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
 * The slice of the Capacitor runtime bridge we read. Capacitor injects a
 * `window.Capacitor` global inside the native iOS/Android webview (and a web
 * shim in a plain browser, where `isNativePlatform()` returns false). We only
 * touch `isNativePlatform()` / `getPlatform()`, so we type just those.
 */
interface CapacitorGlobal {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
}

function capacitorGlobal(): CapacitorGlobal | undefined {
    if (typeof window === 'undefined') return undefined;
    return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/**
 * Synchronous "are we running inside the Capacitor native mobile wrapper"
 * check — the mobile analog of {@link isTauri}. True only in the packaged
 * iOS/Android app, never in a browser (the web shim reports non-native) and
 * never under Tauri. Used to swap in mobile-specific adapters at boot without
 * an async probe: durable Preferences storage (state.ts), the native
 * keep-awake plugin (wakelock.ts), in-app-browser external links
 * (external-links.ts), and hiding the web OAuth buttons whose GIS/Apple JS
 * can't run from the `capacitor://` custom-scheme origin (sign-in-modal.ts).
 */
export function isCapacitor(): boolean {
    return capacitorGlobal()?.isNativePlatform?.() === true;
}

/**
 * The concrete Capacitor platform: 'ios' | 'android' when native, else 'web'
 * (a plain browser, desktop Tauri, or Node tests). Thin wrapper over
 * `Capacitor.getPlatform()` that never throws when the bridge is absent.
 */
export function capacitorPlatform(): 'ios' | 'android' | 'web' {
    const p = capacitorGlobal()?.getPlatform?.();
    return p === 'ios' || p === 'android' ? p : 'web';
}

/**
 * Synchronous "is this a mobile OS that hands the microphone to a single
 * owner" check (userAgent / platform sniff for Android + iOS/iPadOS).
 *
 * Unlike desktop browsers, which let multiple captures share the mic, mobile
 * Safari and Android Chrome give it to exactly one consumer. So a second
 * `getUserMedia` capture (e.g. the cosmetic mic-level meter) starves the Web
 * Speech system recognizer and recognition silently returns no results — the
 * mic ring pulses while nothing is ever transcribed. startMeter() (views/
 * session.ts) uses this to skip the meter on the Web Speech path there.
 *
 * iPadOS 13+ Safari masquerades as desktop Mac, so it's caught via touch
 * points rather than the UA string (Macs aren't touchscreens).
 */
export function isSingleOwnerMicPlatform(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    if (/Android/i.test(ua)) return true;
    if (/iPhone|iPad|iPod/i.test(ua) || /iPhone|iPad|iPod/i.test(platform)) return true;
    // iPadOS desktop-mode Safari reports as "MacIntel" but exposes touch.
    return /Mac/i.test(platform) && (navigator.maxTouchPoints ?? 0) > 1;
}

let cached: boolean | null = null;
let cachedRamGb: number | null = null;
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
            const info = (await resp.json().catch(() => ({}))) as {
                desktop?: boolean;
                ram_gb?: number | null;
            };
            cached = info.desktop !== false;
            cachedRamGb = typeof info.ram_gb === 'number' ? info.ram_gb : null;
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

/** Total system RAM in GB as reported by the desktop shell's system-info,
 *  or null when unknown (browser, hosted web, probe not finished). Used to
 *  size the Ollama context window (contextLengthForRam). */
export function systemRamGb(): number | null {
    return cachedRamGb;
}

/** Synchronous read — returns the cached value, or `false` until the
 *  first probe completes. Useful for render paths that can't await. */
export function isDesktopSync(): boolean {
    return cached ?? false;
}
