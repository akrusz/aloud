/**
 * The minimum client version (client-version.ts): the version compare, the
 * config field adopted at load, the block decision behind the update screen,
 * its dev simulation, and the build named once on GET /cloud/v1/me.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    compareVersions,
    decideUpdateBlock,
    isBelowMinimum,
    minimumFor,
    setMinClientVersions,
    type UpdateGateInput,
} from '../ui/src/client-version.js';
import { simulatedGateInput, OUTDATED_SIMS, outdatedSimParam } from '../ui/src/dev-sim.js';
import type { DesktopUpdate } from '../ui/src/desktop-updater.js';
import { fetchMe, setCloudAuthBackend, setCloudAuthFetch } from '../ui/src/cloud-auth.js';
import type { KvStorage } from '../src/platform/storage.js';

function update(version: string): DesktopUpdate {
    return { version, installAndRelaunch: async () => {} };
}

function input(over: Partial<UpdateGateInput> = {}): UpdateGateInput {
    return {
        platform: 'android',
        running: '2.20.1',
        minimum: '2.21.0',
        checkDesktopUpdate: async () => null,
        ...over,
    };
}

describe('compareVersions', () => {
    it('orders by major, minor, then patch, numerically', () => {
        expect(compareVersions('2.20.1', '2.21.0')).toBeLessThan(0);
        expect(compareVersions('2.21.0', '2.20.9')).toBeGreaterThan(0);
        expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
        expect(compareVersions('3.0.0', '2.99.99')).toBeGreaterThan(0);
        expect(compareVersions('2.20.1', '2.20.1')).toBe(0);
    });

    it('puts a pre-release below its release', () => {
        expect(compareVersions('2.21.0-rc.1', '2.21.0')).toBeLessThan(0);
        expect(compareVersions('2.21.0', '2.21.0-rc.1')).toBeGreaterThan(0);
        expect(compareVersions('2.21.0-rc.1', '2.20.9')).toBeGreaterThan(0);
    });

    it('is null for anything that is not a version', () => {
        expect(compareVersions('', '2.20.1')).toBeNull();
        expect(compareVersions('2.20', '2.20.1')).toBeNull();
        expect(compareVersions('2.20.1', 'v2.20.1')).toBeNull();
    });
});

describe('isBelowMinimum', () => {
    it('is true only for a build strictly older than the minimum', () => {
        expect(isBelowMinimum('2.20.1', '2.21.0')).toBe(true);
        expect(isBelowMinimum('2.21.0', '2.21.0')).toBe(false);
        expect(isBelowMinimum('2.21.1', '2.21.0')).toBe(false);
    });

    it('never blocks on a guess: no minimum, 0.0.0, or an unreadable version', () => {
        expect(isBelowMinimum('2.20.1', null)).toBe(false);
        expect(isBelowMinimum('2.20.1', undefined)).toBe(false);
        expect(isBelowMinimum('2.20.1', '0.0.0')).toBe(false);
        expect(isBelowMinimum('', '2.21.0')).toBe(false);
        expect(isBelowMinimum('2.20.1', 'soon')).toBe(false);
    });
});

describe('setMinClientVersions (the config field)', () => {
    afterEach(() => setMinClientVersions(undefined));

    it('adopts each platform minimum, and the web never has one', () => {
        setMinClientVersions({ desktop: '2.21.0', android: '2.17.0', ios: '0.0.0', web: '9.9.9' });
        expect(minimumFor('desktop')).toBe('2.21.0');
        expect(minimumFor('android')).toBe('2.17.0');
        expect(minimumFor('ios')).toBe('0.0.0');
        expect(minimumFor('web')).toBeNull();
    });

    it('reads a missing field (an older server, no config) or a malformed one as none', () => {
        setMinClientVersions(undefined);
        expect(minimumFor('desktop')).toBeNull();
        setMinClientVersions('2.21.0');
        expect(minimumFor('desktop')).toBeNull();
        setMinClientVersions({ desktop: 2, android: 'latest', ios: null });
        expect(minimumFor('desktop')).toBeNull();
        expect(minimumFor('android')).toBeNull();
        expect(minimumFor('ios')).toBeNull();
    });
});

describe('decideUpdateBlock', () => {
    it('blocks a phone below its minimum, with no updater asked', async () => {
        const check = vi.fn(async () => update('9.9.9'));
        expect(await decideUpdateBlock(input({ checkDesktopUpdate: check }))).toEqual({
            platform: 'android',
            minimum: '2.21.0',
        });
        expect(await decideUpdateBlock(input({ platform: 'ios' }))).toEqual({ platform: 'ios', minimum: '2.21.0' });
        expect(check).not.toHaveBeenCalled();
    });

    it('lets a build at or above the minimum through', async () => {
        expect(await decideUpdateBlock(input({ running: '2.21.0' }))).toBeNull();
        expect(await decideUpdateBlock(input({ running: '2.22.0' }))).toBeNull();
    });

    it('never blocks without a minimum (no config, none for the platform, 0.0.0)', async () => {
        expect(await decideUpdateBlock(input({ minimum: null }))).toBeNull();
        expect(await decideUpdateBlock(input({ minimum: '0.0.0' }))).toBeNull();
    });

    it('never blocks the web', async () => {
        expect(await decideUpdateBlock(input({ platform: 'web' }))).toBeNull();
    });

    it('blocks desktop only once the updater offers a version that meets the minimum', async () => {
        const offered = update('2.21.0');
        const blocked = await decideUpdateBlock(
            input({ platform: 'desktop', checkDesktopUpdate: async () => offered })
        );
        expect(blocked).toEqual({ platform: 'desktop', minimum: '2.21.0', update: offered });

        // The server deployed, the release's bundles aren't out yet.
        expect(
            await decideUpdateBlock(input({ platform: 'desktop', checkDesktopUpdate: async () => null }))
        ).toBeNull();
        // Only an older release to install: it would come back to this screen.
        expect(
            await decideUpdateBlock(input({ platform: 'desktop', checkDesktopUpdate: async () => update('2.20.2') }))
        ).toBeNull();
    });

    it('asks the desktop updater only when the build is below the minimum', async () => {
        const check = vi.fn(async () => update('2.22.0'));
        await decideUpdateBlock(input({ platform: 'desktop', running: '2.21.0', checkDesktopUpdate: check }));
        await decideUpdateBlock(input({ platform: 'desktop', minimum: null, checkDesktopUpdate: check }));
        expect(check).not.toHaveBeenCalled();
    });
});

describe('the outdated-app simulation', () => {
    it('shows each variant through the real decision, desktop with no real update', async () => {
        for (const [sim, platform] of [
            ['desktop', 'desktop'],
            ['android', 'android'],
            ['ios', 'ios'],
        ] as const) {
            const block = await decideUpdateBlock(simulatedGateInput(sim, 'web', '2.20.1'));
            expect(block?.platform).toBe(platform);
            expect(block?.minimum).toBe('2.20.2');
        }
        const desktop = await decideUpdateBlock(simulatedGateInput('desktop', 'desktop', '2.20.1'));
        expect(desktop?.platform === 'desktop' && desktop.update.version).toBe('2.20.2');
    });

    it("picks this platform's variant, desktop in a browser", async () => {
        expect((await decideUpdateBlock(simulatedGateInput('this platform', 'web', '2.20.1')))?.platform).toBe('desktop');
        expect((await decideUpdateBlock(simulatedGateInput('this platform', 'ios', '2.20.1')))?.platform).toBe('ios');
        expect((await decideUpdateBlock(simulatedGateInput('this platform', 'desktop', '2.20.1')))?.platform).toBe(
            'desktop'
        );
    });

    it('still shows when the build has no readable version', async () => {
        expect(await decideUpdateBlock(simulatedGateInput('android', 'web', ''))).not.toBeNull();
    });

    it('names its params as the cheatsheet does', () => {
        expect(OUTDATED_SIMS.map(outdatedSimParam)).toEqual([
            'outdated',
            'outdated-desktop',
            'outdated-android',
            'outdated-ios',
        ]);
    });
});

describe('fetchMe names the build once per load', () => {
    class MemoryKv implements KvStorage {
        private m = new Map<string, string>();
        async get(k: string) {
            return this.m.get(k) ?? null;
        }
        async set(k: string, v: string) {
            this.m.set(k, v);
        }
        async delete(k: string) {
            this.m.delete(k);
        }
        async keys() {
            return [...this.m.keys()];
        }
        async clear() {
            this.m.clear();
        }
    }

    beforeEach(() => vi.stubGlobal('__APP_VERSION__', '2.20.1'));
    afterEach(() => vi.unstubAllGlobals());

    it('adds v and platform to the first call that goes through, and to none after', async () => {
        const kv = new MemoryKv();
        await kv.set('server:token', 'tok');
        setCloudAuthBackend(kv);
        const urls: string[] = [];
        let fail = true;
        setCloudAuthFetch(async (url) => {
            urls.push(String(url));
            if (fail) return new Response('down', { status: 503 });
            return new Response(
                JSON.stringify({ id: 'a1', email: 'u@e.com', emailVerified: true, creditsRemaining: 5, providers: [] }),
                { status: 200 }
            );
        });

        await fetchMe();
        fail = false;
        await fetchMe();
        await fetchMe();
        // The failed call carried it, so did the one that went through; the
        // third goes without.
        expect(urls[0]).toMatch(/\/cloud\/v1\/me\?v=2\.20\.1&platform=web$/);
        expect(urls[1]).toMatch(/\/cloud\/v1\/me\?v=2\.20\.1&platform=web$/);
        expect(urls[2]).toMatch(/\/cloud\/v1\/me$/);
    });
});
