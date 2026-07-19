/**
 * Runtime "is this a desktop environment" detection.
 *
 * "Desktop" = the app backend reports itself local. Probe /app/v1/system-info
 * at boot and read the `desktop` field, NOT mere reachability: the web Hono
 * also answers /app/v1/system-info, with desktop:false. A response omitting the
 * field counts as desktop, preserving browser-against-local-backend dev. Views
 * gate desktop-only features on isDesktop() (claude_proxy provider, env-var
 * hints, Open config folder).
 *
 * Monotonic: once decided "desktop" it sticks for the session, so a backend
 * flap can't yank the controls.
 */

import { appUrl } from './app-base.js';

/**
 * Sync "inside the Tauri desktop shell?" check. Tauri v2 always injects
 * `window.__TAURI_INTERNALS__` regardless of `withGlobalTauri`, so this is
 * reliable at boot without a probe. Gates shell-specific behavior: macOS
 * WKWebView's Web Speech API is unreliable so STT prefers server-Whisper
 * (stt-picker.ts); chrome (drag region, no-select) keys off it too.
 */
export function isTauri(): boolean {
    return (
        typeof window !== 'undefined' &&
        (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
            undefined
    );
}

/**
 * The slice of the Capacitor bridge we read. Capacitor injects
 * `window.Capacitor` in the native iOS/Android webview, and a web shim in a
 * plain browser where `isNativePlatform()` returns false.
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
 * Mobile analog of {@link isTauri}: true only in the packaged iOS/Android app.
 * Swaps in mobile-specific adapters at boot without an async probe: durable
 * Preferences storage (state.ts), the native keep-awake plugin (wakelock.ts),
 * in-app-browser links (external-links.ts), and hiding the web OAuth buttons
 * whose GIS/Apple JS can't run from the `capacitor://` origin (sign-in-modal.ts).
 */
export function isCapacitor(): boolean {
    return capacitorGlobal()?.isNativePlatform?.() === true;
}

/** 'ios' | 'android' when native, else 'web' (browser, Tauri, Node tests).
 *  Never throws when the bridge is absent. */
export function capacitorPlatform(): 'ios' | 'android' | 'web' {
    const p = capacitorGlobal()?.getPlatform?.();
    return p === 'ios' || p === 'android' ? p : 'web';
}

/**
 * UA/platform sniff for Android + iOS/iPadOS, where the mic goes to exactly one
 * consumer (desktop browsers let captures share it). A second `getUserMedia`
 * capture, e.g. the cosmetic mic-level meter, starves the Web Speech recognizer
 * and it silently returns nothing: the mic ring pulses, nothing transcribes.
 * startMeter() (views/session.ts) skips the meter on the Web Speech path.
 *
 * iPadOS 13+ Safari masquerades as desktop Mac, so it's caught via touch points
 * rather than the UA string (Macs aren't touchscreens).
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
            // Desktop unless the backend says otherwise; missing field → desktop.
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

/** Cached value, `false` until the first probe completes. For render paths
 *  that can't await. */
export function isDesktopSync(): boolean {
    return cached ?? false;
}
