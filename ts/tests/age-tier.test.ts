/**
 * age-tier.ts: the app store's age signal as a tier, and the boot decision
 * built on it. The store is the only source; not knowing falls back to the
 * tier stored on an earlier launch, else adult; a flip between blocked and not
 * is stored and reloads; web and desktop never ask.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const H = vi.hoisted(() => ({
    check: vi.fn(async (_opts: { askWhereOptional: boolean }): Promise<unknown> => ({ status: 'notRequired' })),
    kvGet: vi.fn(async (_key: string): Promise<string | null> => null),
    kvSet: vi.fn(async (_key: string, _value: string): Promise<void> => {}),
}));
vi.mock('@capacitor/core', () => ({
    registerPlugin: () => ({ check: H.check }),
}));
vi.mock('../ui/src/state.js', () => ({
    sharedKv: { get: H.kvGet, set: H.kvSet },
}));

import {
    ASK_WHERE_OPTIONAL,
    FIRST_CHECK_WAIT_MS,
    createAgeGate,
    isBlockingTier,
    readAgeSignals,
    tierFromReading,
    type AgeGateDeps,
    type AgeReading,
    type AgeTier,
} from '../ui/src/age-tier.js';

const shared = (ageLower: number | null, ageUpper: number | null, consent?: AgeReading['consent']): AgeReading => ({
    status: 'shared',
    ageLower,
    ageUpper,
    ...(consent !== undefined ? { consent } : {}),
});

describe('tierFromReading', () => {
    it('says nothing without an answer: no reading, an error, Play asking for verification', () => {
        expect(tierFromReading(null)).toBeNull();
        expect(tierFromReading(undefined)).toBeNull();
        expect(tierFromReading({ status: 'unavailable', detail: 'APP_NOT_OWNED (-9)' })).toBeNull();
        expect(tierFromReading({ status: 'unavailable', ageLower: 0, ageUpper: 12 })).toBeNull();
        expect(tierFromReading({ status: 'verificationRequired' })).toBeNull();
    });

    it('says nothing where nothing is shared, whatever else rides along', () => {
        expect(tierFromReading({ status: 'notShared' })).toBeNull();
        expect(tierFromReading({ status: 'notRequired' })).toBeNull();
        expect(tierFromReading({ status: 'notShared', ageLower: 0, ageUpper: 12, consent: 'declined' })).toBeNull();
        expect(tierFromReading({ status: 'notRequired', ageLower: 18, ageUpper: null })).toBeNull();
    });

    it("reads Play's ranges", () => {
        expect(tierFromReading(shared(0, 12))).toBe('child');
        expect(tierFromReading(shared(13, 15))).toBe('teen');
        expect(tierFromReading(shared(16, 17))).toBe('teen');
        expect(tierFromReading(shared(18, null))).toBe('adult');
    });

    it("reads Apple's ranges with gates 13, 16 and 18", () => {
        expect(tierFromReading(shared(null, 12))).toBe('child');
        expect(tierFromReading(shared(13, 15))).toBe('teen');
        expect(tierFromReading(shared(16, 17))).toBe('teen');
        expect(tierFromReading(shared(18, null))).toBe('adult');
    });

    it('takes bounds as inclusive, with gates a regulation moved', () => {
        expect(tierFromReading(shared(12, 12))).toBe('child');
        expect(tierFromReading(shared(null, 13))).toBe('teen');
        expect(tierFromReading(shared(10, 14))).toBe('teen');
        expect(tierFromReading(shared(null, 17))).toBe('teen');
        expect(tierFromReading(shared(13, null))).toBe('teen');
        expect(tierFromReading(shared(17, 19))).toBe('teen');
        expect(tierFromReading(shared(18, 20))).toBe('adult');
        expect(tierFromReading(shared(21, null))).toBe('adult');
    });

    it('says nothing when shared with no bounds at all', () => {
        expect(tierFromReading(shared(null, null))).toBeNull();
        expect(tierFromReading({ status: 'shared' })).toBeNull();
        expect(tierFromReading({ status: 'shared', consent: 'declined' })).toBeNull();
    });

    it('reads anything but a finite number as no bound', () => {
        expect(tierFromReading({ status: 'shared', ageLower: NaN, ageUpper: 12 })).toBe('child');
        expect(tierFromReading({ status: 'shared', ageLower: 13, ageUpper: Infinity })).toBe('teen');
        expect(tierFromReading({ status: 'shared', ageUpper: '12' as unknown as number })).toBeNull();
    });

    it("reads a teen's parental consent, and nobody else's", () => {
        expect(tierFromReading(shared(13, 15, 'pending'))).toBe('pendingConsent');
        expect(tierFromReading(shared(16, 17, 'declined'))).toBe('deniedConsent');
        expect(tierFromReading(shared(16, 17, 'approved'))).toBe('teen');
        expect(tierFromReading(shared(13, 15, null))).toBe('teen');
        expect(tierFromReading(shared(0, 12, 'pending'))).toBe('child');
        expect(tierFromReading(shared(0, 12, 'declined'))).toBe('child');
        expect(tierFromReading(shared(0, 12, 'approved'))).toBe('child');
        expect(tierFromReading(shared(18, null, 'declined'))).toBe('adult');
        expect(tierFromReading(shared(18, null, 'pending'))).toBe('adult');
    });

    it('blocks under 13 and on a pending or declined approval, nothing else', () => {
        const blocking = (['adult', 'teen', 'child', 'pendingConsent', 'deniedConsent'] as AgeTier[]).filter(isBlockingTier);
        expect(blocking).toEqual(['child', 'pendingConsent', 'deniedConsent']);
    });
});

function plantPlatform(platform: 'ios' | 'android' | 'web'): void {
    vi.stubGlobal('window', {
        Capacitor: { isNativePlatform: () => platform !== 'web', getPlatform: () => platform },
    });
}

describe('readAgeSignals', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        H.check.mockReset();
    });

    it('never calls anything off the phone apps', async () => {
        plantPlatform('web');
        expect(await readAgeSignals()).toBeNull();
        expect(H.check).not.toHaveBeenCalled();
    });

    it('hands the native check the one switch, and passes its answer on', async () => {
        plantPlatform('android');
        H.check.mockResolvedValueOnce({ status: 'shared', ageLower: 13, ageUpper: 15, consent: null });
        expect(await readAgeSignals()).toEqual({ status: 'shared', ageLower: 13, ageUpper: 15, consent: null });
        expect(H.check).toHaveBeenCalledWith({ askWhereOptional: ASK_WHERE_OPTIONAL });
        expect(ASK_WHERE_OPTIONAL).toBe(false);
    });

    it('is null when the plugin fails or answers nonsense', async () => {
        plantPlatform('ios');
        H.check.mockRejectedValueOnce(new Error('not implemented'));
        expect(await readAgeSignals()).toBeNull();
        H.check.mockResolvedValueOnce({ status: 'maybe' });
        expect(await readAgeSignals()).toBeNull();
        H.check.mockResolvedValueOnce({});
        expect(await readAgeSignals()).toBeNull();
    });
});

interface World {
    deps: AgeGateDeps;
    kv: Map<string, string>;
    reload: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    foreground: () => void;
    hooked: () => boolean;
}

function world(opts: {
    stored?: AgeTier | string;
    readings?: Array<AgeReading | null | Error | Promise<AgeReading | null>>;
    platform?: 'ios' | 'android' | 'web';
    setFails?: boolean;
} = {}): World {
    const kv = new Map<string, string>();
    if (opts.stored) kv.set('ageTier', opts.stored);
    const readings = [...(opts.readings ?? [])];
    const read = vi.fn(async (): Promise<AgeReading | null> => {
        const next = readings.shift() ?? null;
        if (next instanceof Error) throw next;
        return next;
    });
    const reload = vi.fn();
    const notify = vi.fn();
    let recheck: (() => void) | null = null;
    const deps: AgeGateDeps = {
        platform: () => opts.platform ?? 'android',
        read,
        kv: {
            get: async (key) => kv.get(key) ?? null,
            set: async (key, value) => {
                if (opts.setFails) throw new Error('storage full');
                kv.set(key, value);
            },
        },
        reload,
        onForeground: (run) => {
            recheck = run;
        },
        notify,
    };
    return {
        deps,
        kv,
        reload,
        notify,
        read,
        foreground: () => recheck?.(),
        hooked: () => recheck !== null,
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the boot decision', () => {
    it('never asks on web or desktop, and is adult', async () => {
        const w = world({ platform: 'web', stored: 'child' });
        const gate = createAgeGate(w.deps);
        expect(await gate.boot()).toBe('adult');
        expect(w.read).not.toHaveBeenCalled();
        expect(w.hooked()).toBe(false);
    });

    it('boots at once on a stored tier, without waiting for the store', async () => {
        const answer = deferred<AgeReading | null>();
        const w = world({ stored: 'teen', readings: [answer.promise] });
        const gate = createAgeGate(w.deps);
        expect(await gate.boot()).toBe('teen');
        answer.resolve(shared(18, null));
        await settle();
        expect(w.kv.get('ageTier')).toBe('adult');
        expect(gate.tier()).toBe('adult');
        expect(w.reload).not.toHaveBeenCalled();
    });

    it('stores a flip from blocked to not, and reloads', async () => {
        const w = world({ stored: 'child', readings: [shared(18, null)] });
        expect(await createAgeGate(w.deps).boot()).toBe('child');
        await settle();
        expect(w.kv.get('ageTier')).toBe('adult');
        expect(w.reload).toHaveBeenCalledTimes(1);
    });

    it('stores a flip from not blocked to blocked, and reloads', async () => {
        const w = world({ stored: 'adult', readings: [shared(0, 12)] });
        expect(await createAgeGate(w.deps).boot()).toBe('adult');
        await settle();
        expect(w.kv.get('ageTier')).toBe('child');
        expect(w.reload).toHaveBeenCalledTimes(1);
    });

    it('keeps a stored tier when the store says nothing: offline, a decline, sharing switched off', async () => {
        for (const reading of [
            { status: 'unavailable', detail: 'NETWORK_ERROR (-3)' } as AgeReading,
            { status: 'notShared' } as AgeReading,
            { status: 'notRequired' } as AgeReading,
            null,
            new Error('boom'),
        ]) {
            const w = world({ stored: 'child', readings: [reading] });
            const gate = createAgeGate(w.deps);
            expect(await gate.boot()).toBe('child');
            await settle();
            expect(gate.tier()).toBe('child');
            expect(w.kv.get('ageTier')).toBe('child');
            expect(w.reload).not.toHaveBeenCalled();
        }
    });

    it('ignores a stored value that is not a tier', async () => {
        const w = world({ stored: 'grownup', readings: [null] });
        expect(await createAgeGate(w.deps).boot()).toBe('adult');
    });

    it('does not reload when the tier could not be stored', async () => {
        const w = world({ stored: 'adult', readings: [shared(0, 12)], setFails: true });
        expect(await createAgeGate(w.deps).boot()).toBe('adult');
        await settle();
        expect(w.reload).not.toHaveBeenCalled();
    });

    describe('first launch, nothing stored', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        const answerAt = (ms: number, reading: AgeReading | null): Promise<AgeReading | null> =>
            new Promise((r) => setTimeout(() => r(reading), ms));

        it('waits for the store, and boots on its answer', async () => {
            const w = world({ readings: [answerAt(1000, shared(0, 12))] });
            const booted = createAgeGate(w.deps).boot();
            await vi.advanceTimersByTimeAsync(1000);
            expect(await booted).toBe('child');
            expect(w.kv.get('ageTier')).toBe('child');
            expect(w.reload).not.toHaveBeenCalled();
        });

        it('goes on as adult after the wait, and reloads when a blocking answer comes later', async () => {
            const w = world({ readings: [answerAt(4000, shared(13, 15, 'declined'))] });
            let booted: AgeTier | null = null;
            void createAgeGate(w.deps).boot().then((tier) => (booted = tier));
            await vi.advanceTimersByTimeAsync(FIRST_CHECK_WAIT_MS - 1);
            expect(booted).toBeNull();
            await vi.advanceTimersByTimeAsync(1);
            expect(booted).toBe('adult');
            expect(w.reload).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(4000 - FIRST_CHECK_WAIT_MS);
            expect(w.kv.get('ageTier')).toBe('deniedConsent');
            expect(w.reload).toHaveBeenCalledTimes(1);
        });

        it('stores a late answer that blocks nothing, without a reload', async () => {
            const w = world({ readings: [answerAt(4000, shared(16, 17))] });
            const gate = createAgeGate(w.deps);
            const booted = gate.boot();
            await vi.advanceTimersByTimeAsync(4000);
            expect(await booted).toBe('adult');
            expect(w.kv.get('ageTier')).toBe('teen');
            expect(gate.tier()).toBe('teen');
            expect(w.reload).not.toHaveBeenCalled();
        });

        it('boots adult when the store says nothing, and stores that so the next launch does not wait', async () => {
            for (const reading of [{ status: 'unavailable', detail: 'APP_NOT_OWNED (-9)' }, { status: 'notRequired' }] as AgeReading[]) {
                const w = world({ readings: [reading] });
                const booted = createAgeGate(w.deps).boot();
                await vi.advanceTimersByTimeAsync(0);
                expect(await booted).toBe('adult');
                expect(w.kv.get('ageTier')).toBe('adult');
                expect(w.reload).not.toHaveBeenCalled();
            }
        });

        it('stores nothing while the store has not answered at all', async () => {
            const w = world({ readings: [new Promise<AgeReading | null>(() => {})] });
            const booted = createAgeGate(w.deps).boot();
            await vi.advanceTimersByTimeAsync(FIRST_CHECK_WAIT_MS);
            expect(await booted).toBe('adult');
            expect(w.kv.has('ageTier')).toBe(false);
        });
    });

    describe('while blocked', () => {
        it('checks again on returning to the foreground, and reloads on an approval', async () => {
            const w = world({
                stored: 'pendingConsent',
                readings: [shared(13, 15, 'pending'), shared(13, 15, 'approved')],
            });
            expect(await createAgeGate(w.deps).boot()).toBe('pendingConsent');
            await settle();
            expect(w.reload).not.toHaveBeenCalled();
            w.foreground();
            await settle();
            expect(w.kv.get('ageTier')).toBe('teen');
            expect(w.reload).toHaveBeenCalledTimes(1);
        });

        it('swaps one blocking screen for another without a reload', async () => {
            const onBlockedChange = vi.fn();
            const w = world({ stored: 'pendingConsent', readings: [shared(13, 15, 'declined')] });
            const gate = createAgeGate(w.deps);
            await gate.boot(onBlockedChange);
            await settle();
            expect(onBlockedChange).toHaveBeenCalledWith('deniedConsent');
            expect(gate.tier()).toBe('deniedConsent');
            expect(w.reload).not.toHaveBeenCalled();
        });

        it('runs one check at a time', async () => {
            const answer = deferred<AgeReading | null>();
            const w = world({ stored: 'child', readings: [answer.promise] });
            await createAgeGate(w.deps).boot();
            w.foreground();
            w.foreground();
            expect(w.read).toHaveBeenCalledTimes(1);
            answer.resolve(shared(0, 12));
            await settle();
            w.foreground();
            expect(w.read).toHaveBeenCalledTimes(2);
        });

        it('is the only time the foreground is watched', async () => {
            const w = world({ stored: 'teen', readings: [shared(13, 15)] });
            await createAgeGate(w.deps).boot();
            expect(w.hooked()).toBe(false);
        });
    });

    it("says once per install that Play wants to confirm the age, and treats it as not knowing", async () => {
        const w = world({ readings: [{ status: 'verificationRequired' }, { status: 'verificationRequired' }] });
        expect(await createAgeGate(w.deps).boot()).toBe('adult');
        await settle();
        expect(w.notify).toHaveBeenCalledTimes(1);
        expect(w.notify).toHaveBeenCalledWith(
            'Google Play needs to confirm your age. You can do that in the Play Store app.'
        );
        expect(w.kv.get('ageTier')).toBe('adult');
        expect(w.kv.get('storeVerifyNoticeShown')).toBe('1');

        await createAgeGate(w.deps).boot();
        await settle();
        expect(w.notify).toHaveBeenCalledTimes(1);
    });

    it('logs nothing age-related: an unavailable check is the only line', async () => {
        const lines: string[] = [];
        const capture = (...args: unknown[]): void => void lines.push(args.map(String).join(' '));
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
            vi.spyOn(console, m).mockImplementation(capture)
        );
        try {
            const w = world({ stored: 'adult', readings: [shared(0, 12, 'pending')] });
            await createAgeGate(w.deps).boot();
            await settle();
            expect(lines).toEqual([]);

            const u = world({ stored: 'child', readings: [{ status: 'unavailable', detail: 'NETWORK_ERROR (-3)' }] });
            await createAgeGate(u.deps).boot();
            await settle();
            expect(lines).toEqual(['[age-check] unavailable NETWORK_ERROR (-3)']);
        } finally {
            spies.forEach((s) => s.mockRestore());
        }
    });
});

describe('the dev override and the real boot', () => {
    beforeEach(() => {
        vi.resetModules();
        H.kvGet.mockClear();
        H.kvSet.mockClear();
        H.check.mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    function plantUrl(href: string, platform: 'ios' | 'android' | 'web' = 'web') {
        const replaceState = vi.fn();
        vi.stubGlobal('window', {
            location: { href },
            history: { state: null, replaceState },
            Capacitor: { isNativePlatform: () => platform !== 'web', getPlatform: () => platform },
        });
        return replaceState;
    }

    it('?age= boots on that tier, comes off the URL, and never touches the store or the cache', async () => {
        const replaceState = plantUrl('http://localhost:4649/?age=child&mode=web', 'android');
        const mod = await import('../ui/src/age-tier.js');
        mod.adoptAgeParam();
        expect(replaceState).toHaveBeenCalledWith(null, '', '/?mode=web');
        expect(await mod.bootAgeTier()).toBe('child');
        expect(mod.getAgeTier()).toBe('child');
        expect(H.kvGet).not.toHaveBeenCalled();
        expect(H.kvSet).not.toHaveBeenCalled();
        expect(H.check).not.toHaveBeenCalled();
    });

    it('ignores a value that is not a tier', async () => {
        plantUrl('http://localhost:4649/?age=five');
        const mod = await import('../ui/src/age-tier.js');
        mod.adoptAgeParam();
        expect(await mod.bootAgeTier()).toBe('adult');
    });

    it('is adult on web without asking anything', async () => {
        plantUrl('http://localhost:4649/');
        const mod = await import('../ui/src/age-tier.js');
        mod.adoptAgeParam();
        expect(await mod.bootAgeTier()).toBe('adult');
        expect(mod.getAgeTier()).toBe('adult');
        expect(H.kvGet).not.toHaveBeenCalled();
        expect(H.check).not.toHaveBeenCalled();
    });
});
