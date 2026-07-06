/* wakelock.ts — keep the screen on during an active meditation session.
   Without this, the phone sleeps mid-session and the audio/WebSocket
   connection breaks. Acquired on session start, released on session end,
   re-acquired on visibility change so a tab-switch doesn't drop it.

   Two backends:
     - Native mobile (Capacitor) → @capacitor-community/keep-awake, because a
       WKWebView / Android System WebView often doesn't implement the web Wake
       Lock API at all, so navigator.wakeLock is simply absent there.
     - Everything else (browser, desktop) → the web Wake Lock API. */

import { isCapacitor } from './is-desktop.js';

// The Wake Lock API isn't in TypeScript's default DOM lib yet. We type
// just what we need to call `request('screen')` and the release event.
interface WakeLockSentinelLike {
    release(): Promise<void>;
    addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockApi {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

let wakeLock: WakeLockSentinelLike | null = null;

function getWakeLockApi(): WakeLockApi | null {
    const nav = navigator as unknown as { wakeLock?: WakeLockApi };
    return nav.wakeLock ?? null;
}

// Native keep-awake, lazy-loaded so web/desktop bundles don't pull the
// Capacitor plugin. Tracked separately from `wakeLock` (the web sentinel)
// since it has no sentinel object — it's a global on/off toggle.
let nativeKeptAwake = false;
let keepAwakeMod: typeof import('@capacitor-community/keep-awake') | null = null;
async function ensureKeepAwake(): Promise<typeof import('@capacitor-community/keep-awake') | null> {
    if (keepAwakeMod) return keepAwakeMod;
    try {
        keepAwakeMod = await import('@capacitor-community/keep-awake');
    } catch {
        keepAwakeMod = null;
    }
    return keepAwakeMod;
}

export async function acquireWakeLock(): Promise<void> {
    if (isCapacitor()) {
        const mod = await ensureKeepAwake();
        if (!mod) return;
        try {
            await mod.KeepAwake.keepAwake();
            nativeKeptAwake = true;
        } catch (err) {
            console.warn('Keep-awake not acquired:', err && (err as Error).message);
        }
        return;
    }
    const api = getWakeLockApi();
    if (!api) return;
    try {
        wakeLock = await api.request('screen');
        wakeLock.addEventListener('release', function () {
            wakeLock = null;
        });
    } catch (err) {
        // Common reasons: tab not visible, page not in a secure context.
        // Not fatal — we'll try again on visibilitychange.
        console.warn('Wake Lock not acquired:', err && (err as Error).message);
    }
}

export function releaseWakeLock(): void {
    if (isCapacitor()) {
        if (!nativeKeptAwake) return;
        nativeKeptAwake = false;
        // Fire-and-forget to match the web path's synchronous signature.
        void ensureKeepAwake().then((mod) => mod?.KeepAwake.allowSleep().catch(function () {}));
        return;
    }
    if (wakeLock) {
        wakeLock.release().catch(function () {});
        wakeLock = null;
    }
}

let visibilityHandlerInstalled = false;
function installVisibilityHandler(): void {
    if (visibilityHandlerInstalled) return;
    visibilityHandlerInstalled = true;
    document.addEventListener('visibilitychange', function () {
        const held = isCapacitor() ? nativeKeptAwake : wakeLock !== null;
        if (
            document.visibilityState === 'visible' &&
            document.body.dataset['sessionActive'] === 'true' &&
            !held
        ) {
            void acquireWakeLock();
        }
    });
}

// Match the original module-load side effect — the visibility handler is
// always installed once this module is imported.
installVisibilityHandler();
