/* wakelock.ts — keep the screen on during an active meditation session.
   Without this, the phone sleeps mid-session and the audio/WebSocket
   connection breaks. Acquired on session start, released on session end,
   re-acquired on visibility change so a tab-switch doesn't drop it. */

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

export async function acquireWakeLock(): Promise<void> {
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
        if (
            document.visibilityState === 'visible' &&
            document.body.dataset['sessionActive'] === 'true' &&
            wakeLock === null
        ) {
            void acquireWakeLock();
        }
    });
}

// Match the original module-load side effect — the visibility handler is
// always installed once this module is imported.
installVisibilityHandler();
