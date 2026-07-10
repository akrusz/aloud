/**
 * watchCloudReachable — the shared cloud-wake watcher (capabilities.ts) that
 * lets desktop/mobile/web self-heal from a cold aloud cloud (it scales to zero
 * when idle). Contract: fire synchronously if already reachable; otherwise
 * re-probe with backoff and fire once when it comes up; never fire after
 * unsubscribe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let mod: typeof import('../ui/src/capabilities.js');

// URL-substring → Response factory; unmatched throws (an unreachable host).
type Routes = Record<string, () => Response>;
let routes: Routes = {};
const realFetch = globalThis.fetch;
function setRoutes(next: Routes): void {
    routes = next;
}

beforeEach(async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        for (const key of Object.keys(routes)) {
            if (u.includes(key)) return routes[key]!();
        }
        throw new TypeError(`fetch failed: ${u}`);
    }) as typeof fetch;
    // Fresh module state per test (module-level capability cache + watch timer).
    vi.resetModules();
    mod = await import('../ui/src/capabilities.js');
    vi.useFakeTimers();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
});

const ok = (): Response => new Response(JSON.stringify({ googleClientId: 'x' }), { status: 200 });
const down = (): Response => new Response('', { status: 503 });

/** Prime the capability cache with cloud=false by running a full boot probe
 *  (the cloud axis fails; its short retry backoff is advanced through). */
async function primeCloudDown(): Promise<void> {
    setRoutes({}); // everything throws → cloud unreachable, is-desktop false
    const p = mod.detectCapabilities();
    await vi.advanceTimersByTimeAsync(1500); // ride out probeCloudWithRetry backoff
    await p;
    expect(mod.capabilitiesSync().cloud).toBe(false);
}

describe('watchCloudReachable', () => {
    it('fires synchronously when cloud is already reachable', async () => {
        setRoutes({ '/cloud/v1/config': ok });
        await mod.detectCapabilities();
        expect(mod.capabilitiesSync().cloud).toBe(true);

        const cb = vi.fn();
        mod.watchCloudReachable(cb);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('fires once when a cold cloud comes up on a later probe', async () => {
        await primeCloudDown();

        const cb = vi.fn();
        mod.watchCloudReachable(cb);
        expect(cb).not.toHaveBeenCalled(); // still down, poll not yet due

        // Machine boots; the next backoff probe reaches it.
        setRoutes({ '/cloud/v1/config': ok });
        await vi.advanceTimersByTimeAsync(2000);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(mod.capabilitiesSync().cloud).toBe(true);
    });

    it('does not fire after unsubscribe, even once cloud comes up', async () => {
        await primeCloudDown();

        const cb = vi.fn();
        const unsub = mod.watchCloudReachable(cb);
        unsub();

        setRoutes({ '/cloud/v1/config': ok });
        await vi.advanceTimersByTimeAsync(5000);
        expect(cb).not.toHaveBeenCalled();
    });

    it('keeps re-probing across misses until cloud answers', async () => {
        await primeCloudDown();
        const cb = vi.fn();
        mod.watchCloudReachable(cb);

        setRoutes({ '/cloud/v1/config': down }); // still booting (503)
        await vi.advanceTimersByTimeAsync(3000);
        expect(cb).not.toHaveBeenCalled();

        setRoutes({ '/cloud/v1/config': ok }); // finally up
        await vi.advanceTimersByTimeAsync(6000);
        expect(cb).toHaveBeenCalledTimes(1);
    });
});
