/* Keep the screen on during a session; otherwise the phone sleeps mid-session
   and the audio connection breaks. Acquired on session start, released on end,
   re-acquired on visibility change so a tab-switch doesn't drop it.

   Two backends:
     - Native mobile (Capacitor) → @capacitor-community/keep-awake, since
       WKWebView / Android System WebView often lack navigator.wakeLock.
     - Everything else (browser, desktop) → the web Wake Lock API. */

import { isCapacitor } from './is-desktop.js';

// The Wake Lock API isn't in TypeScript's default DOM lib yet.
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

// Lazy-loaded so web/desktop bundles don't pull the Capacitor plugin. Tracked
// separately from `wakeLock`: it's a global on/off toggle, not a sentinel.
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
        // Usually tab not visible or no secure context. Not fatal: we retry on
        // visibilitychange.
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

// Module-load side effect: the handler installs on first import.
installVisibilityHandler();
