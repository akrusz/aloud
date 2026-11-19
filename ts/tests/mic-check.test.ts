/**
 * Mic availability gate (meditation-pal-j8k1).
 *
 * The load-bearing property is asymmetry: probeMic() must never report a
 * problem it isn't sure about (a false "no mic" blocks Begin for a user who
 * has one), while acquireMicOnce() must report every failure it sees.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const micPermission = vi.hoisted(() => ({ granted: null as boolean | null }));
vi.mock('../ui/src/mic-permission.js', () => ({
    ensureMicPermission: vi.fn(async () => micPermission.granted),
}));

import {
    probeMic,
    acquireMicOnce,
    adoptSimMicParam,
    describeMicProblem,
} from '../ui/src/mic-check.js';

type NavStub = {
    mediaDevices?: {
        getUserMedia?: (c: unknown) => Promise<unknown>;
        enumerateDevices?: () => Promise<Array<{ kind: string }>>;
    };
    permissions?: { query: (d: unknown) => Promise<{ state: string }> };
};

function stubNavigator(nav: NavStub): void {
    vi.stubGlobal('navigator', nav);
}

/** A navigator that answers "yes, and nothing is wrong". */
function healthyNav(overrides: NavStub = {}): NavStub {
    return {
        mediaDevices: {
            getUserMedia: async () => ({ getTracks: () => [] }),
            enumerateDevices: async () => [{ kind: 'audioinput' }],
        },
        ...overrides,
    };
}

function failingGetUserMedia(name: string) {
    return async () => {
        const err = new Error('nope');
        err.name = name;
        throw err;
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    micPermission.granted = null;
});

describe('probeMic - silent, and only certain of what it can prove', () => {
    it('reports no-api when the browser has no getUserMedia', async () => {
        stubNavigator({});
        expect(await probeMic()).toBe('no-api');
    });

    it('reports denied when the Permissions API says so', async () => {
        stubNavigator(
            healthyNav({ permissions: { query: async () => ({ state: 'denied' }) } })
        );
        expect(await probeMic()).toBe('denied');
    });

    it("treats 'prompt' as fine - it isn't a refusal", async () => {
        stubNavigator(
            healthyNav({ permissions: { query: async () => ({ state: 'prompt' }) } })
        );
        expect(await probeMic()).toBe('ok');
    });

    it('stays optimistic when the Permissions API throws (Safari)', async () => {
        stubNavigator(
            healthyNav({
                permissions: {
                    query: async () => {
                        throw new TypeError('unsupported descriptor');
                    },
                },
            })
        );
        expect(await probeMic()).toBe('ok');
    });

    it('reports no-device only when devices exist and none capture audio', async () => {
        stubNavigator({
            mediaDevices: {
                getUserMedia: async () => ({ getTracks: () => [] }),
                enumerateDevices: async () => [{ kind: 'videoinput' }],
            },
        });
        expect(await probeMic()).toBe('no-device');
    });

    it('an empty device list means "hidden until granted", not "no mic"', async () => {
        // Safari/Firefox withhold devices pre-permission; calling that no-device
        // would block Begin for everyone on those browsers.
        stubNavigator({
            mediaDevices: {
                getUserMedia: async () => ({ getTracks: () => [] }),
                enumerateDevices: async () => [],
            },
        });
        expect(await probeMic()).toBe('ok');
    });

    it('never opens a stream, so it can never prompt', async () => {
        const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
        stubNavigator({
            mediaDevices: { getUserMedia, enumerateDevices: async () => [{ kind: 'audioinput' }] },
        });
        await probeMic();
        expect(getUserMedia).not.toHaveBeenCalled();
    });
});

describe('acquireMicOnce - definitive, and releases what it opens', () => {
    it('returns ok and stops every track it was given', async () => {
        const stop = vi.fn();
        stubNavigator({
            mediaDevices: {
                getUserMedia: async () => ({ getTracks: () => [{ stop }, { stop }] }),
            },
        });
        expect(await acquireMicOnce()).toBe('ok');
        // macOS re-arbitrates its single voice input between concurrent
        // captures, so a leaked probe stream could break the session's engine.
        expect(stop).toHaveBeenCalledTimes(2);
    });

    it('maps a refusal to denied', async () => {
        stubNavigator({ mediaDevices: { getUserMedia: failingGetUserMedia('NotAllowedError') } });
        expect(await acquireMicOnce()).toBe('denied');
    });

    it('maps missing hardware to no-device', async () => {
        stubNavigator({ mediaDevices: { getUserMedia: failingGetUserMedia('NotFoundError') } });
        expect(await acquireMicOnce()).toBe('no-device');
    });

    it('maps anything else to a generic error rather than swallowing it', async () => {
        stubNavigator({ mediaDevices: { getUserMedia: failingGetUserMedia('NotReadableError') } });
        expect(await acquireMicOnce()).toBe('error');
    });

    it('remembers a mic that opened, and nothing less, for the rest of the page', async () => {
        vi.resetModules();
        const fresh = await import('../ui/src/mic-check.js');
        stubNavigator({ mediaDevices: { getUserMedia: failingGetUserMedia('NotAllowedError') } });
        await fresh.acquireMicOnce();
        expect(fresh.micOpenedThisPage()).toBe(false);
        stubNavigator(healthyNav());
        await fresh.acquireMicOnce();
        expect(fresh.micOpenedThisPage()).toBe(true);
    });

    it('takes the RECORD_AUDIO grant as the answer in the Android app, opening no stream', async () => {
        const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
        stubNavigator({ mediaDevices: { getUserMedia } });
        vi.stubGlobal('window', {
            Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
        });
        micPermission.granted = true;
        expect(await acquireMicOnce()).toBe('ok');
        micPermission.granted = false;
        expect(await acquireMicOnce()).toBe('denied');
        expect(getUserMedia).not.toHaveBeenCalled();
    });
});

describe("micForBegin - a capture of ours that just worked is Begin's answer", () => {
    // Each probe opens and closes an echo-cancelled stream, and on macOS each
    // of those rebuilds the audio output under the opening sound (uz8t).
    async function freshModule() {
        vi.resetModules();
        return import('../ui/src/mic-check.js');
    }
    const stream = (): MediaStream => ({}) as MediaStream;

    it('opens a probe stream when no capture of ours has run, and none while one is live', async () => {
        const mic = await freshModule();
        const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
        stubNavigator({ mediaDevices: { getUserMedia } });
        expect(await mic.micForBegin()).toBe('ok');
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        mic.noteCaptureOpened(stream(), () => true);
        expect(await mic.micForBegin()).toBe('ok');
        expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it('counts a capture as opening the mic on this page', async () => {
        const mic = await freshModule();
        expect(mic.micOpenedThisPage()).toBe(false);
        mic.noteCaptureOpened(stream(), () => true);
        expect(mic.micOpenedThisPage()).toBe(true);
    });

    it('takes one closed a moment ago, and asks the silent probe once that moment has passed', async () => {
        const mic = await freshModule();
        // Unplugged since: the device list, unhidden by the capture that
        // worked, says so with no stream opened.
        const getUserMedia = vi.fn(failingGetUserMedia('NotFoundError'));
        stubNavigator({ mediaDevices: { getUserMedia, enumerateDevices: async () => [{ kind: 'audiooutput' }] } });
        const clock = vi.spyOn(performance, 'now');
        try {
            const s = stream();
            mic.noteCaptureOpened(s, () => true);
            clock.mockReturnValue(10_000);
            mic.noteCaptureClosing(s);
            clock.mockReturnValue(10_000 + mic.RECENT_CAPTURE_MS);
            expect(await mic.micForBegin()).toBe('ok');
            clock.mockReturnValue(10_001 + mic.RECENT_CAPTURE_MS);
            expect(await mic.micForBegin()).toBe('no-device');
            expect(getUserMedia).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
        }
    });

    it('takes nothing from a stream that had died before it closed', async () => {
        const mic = await freshModule();
        const getUserMedia = vi.fn(failingGetUserMedia('NotAllowedError'));
        stubNavigator({
            mediaDevices: { getUserMedia, enumerateDevices: async () => [{ kind: 'audioinput' }] },
            permissions: { query: async () => ({ state: 'denied' }) },
        });
        const s = stream();
        mic.noteCaptureOpened(s, () => false);
        expect(await mic.micForBegin()).toBe('denied');
        mic.noteCaptureClosing(s);
        expect(await mic.micForBegin()).toBe('denied');
        expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('opens a probe stream only on the first Begin of a page', async () => {
        const mic = await freshModule();
        const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
        stubNavigator(healthyNav({ mediaDevices: { getUserMedia, enumerateDevices: async () => [{ kind: 'audioinput' }] } }));
        const clock = vi.spyOn(performance, 'now');
        try {
            clock.mockReturnValue(10_000);
            expect(await mic.micForBegin()).toBe('ok');
            clock.mockReturnValue(100_000);
            expect(await mic.micForBegin()).toBe('ok');
            expect(getUserMedia).toHaveBeenCalledTimes(1);
        } finally {
            clock.mockRestore();
        }
    });

    it('still gives a simulated failure to Begin under a live capture', async () => {
        const mic = await freshModule();
        const store = new Map([['aloud:simMic', 'error']]);
        vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null });
        stubNavigator(healthyNav());
        mic.noteCaptureOpened(stream(), () => true);
        expect(await mic.micForBegin()).toBe('error');
    });
});

describe("holdCaptureForSession - Begin keeps the setup screen's capture for the session's", () => {
    async function freshModule() {
        vi.resetModules();
        return import('../ui/src/mic-check.js');
    }
    function watch(promise: Promise<void>): { settled: boolean } {
        const state = { settled: false };
        void promise.then(() => (state.settled = true));
        return state;
    }
    afterEach(() => vi.useRealTimers());

    it('is held until a capture of ours hears, and one at a time', async () => {
        const mic = await freshModule();
        const first = mic.holdCaptureForSession();
        // A spoken "begin" holds it, then the Begin path asks again.
        expect(mic.holdCaptureForSession()).toBe(first);
        const state = watch(first);
        await Promise.resolve();
        expect(state.settled).toBe(false);
        mic.noteCaptureHearing();
        await Promise.resolve();
        expect(state.settled).toBe(true);
        expect(mic.holdCaptureForSession()).not.toBe(first);
    });

    it('is let go when asked, and by its cap at the latest', async () => {
        vi.useFakeTimers();
        const mic = await freshModule();
        const asked = watch(mic.holdCaptureForSession());
        mic.endCaptureHandover();
        await Promise.resolve();
        expect(asked.settled).toBe(true);

        const capped = watch(mic.holdCaptureForSession());
        await vi.advanceTimersByTimeAsync(mic.CAPTURE_HANDOVER_CAP_MS - 1);
        expect(capped.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(capped.settled).toBe(true);
    });
});

describe('?nomic simulation (dev builds only)', () => {
    function stubUrl(search: string): void {
        vi.stubGlobal('window', { location: { href: `http://localhost:4649/${search}` } });
        const store = new Map<string, string>();
        vi.stubGlobal('sessionStorage', {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        });
    }

    // Adopted at boot, not at probe time: by the first probe the router has
    // already stripped the query.
    it('drives both probes once adopted from the URL', async () => {
        stubUrl('?nomic=denied');
        adoptSimMicParam();
        stubNavigator(healthyNav());
        expect(await probeMic()).toBe('denied');
        expect(await acquireMicOnce()).toBe('denied');
    });

    it("keeps 'error' invisible to the silent probe, as in real life", async () => {
        // A mic that's present and permitted but won't open can only be
        // discovered by opening it, so setup stays clean and Begin catches it.
        stubUrl('?nomic=error');
        adoptSimMicParam();
        stubNavigator(healthyNav());
        expect(await probeMic()).toBe('ok');
        expect(await acquireMicOnce()).toBe('error');
    });

    it('ignores a value that is not a known status', async () => {
        stubUrl('?nomic=banana');
        adoptSimMicParam();
        stubNavigator(healthyNav());
        expect(await acquireMicOnce()).toBe('ok');
    });

    it('sticks once the query is gone, until ?nomic=off', async () => {
        stubUrl('?nomic=denied');
        adoptSimMicParam();
        stubNavigator(healthyNav());
        // The router's replaceState: same tab, no query.
        vi.stubGlobal('window', { location: { href: 'http://localhost:4649/' } });
        adoptSimMicParam();
        expect(await probeMic()).toBe('denied');
        vi.stubGlobal('window', { location: { href: 'http://localhost:4649/?nomic=off' } });
        adoptSimMicParam();
        expect(await probeMic()).toBe('ok');
    });
});

describe('describeMicProblem', () => {
    it('says nothing when the mic is fine', () => {
        expect(describeMicProblem('ok')).toBeNull();
    });

    // 'no-api' has three causes and only one is the browser's fault. Sending a
    // packaged-app user to "try another browser", or blaming the browser when
    // the origin is plain http, is advice that cannot work.
    it('blames the browser only in a browser, on a secure origin', () => {
        vi.stubGlobal('window', { isSecureContext: true });
        expect(describeMicProblem('no-api')).toMatch(/Try Chrome/);
    });

    it('points at https on a non-secure origin', () => {
        vi.stubGlobal('window', { isSecureContext: false });
        expect(describeMicProblem('no-api')).toMatch(/https/);
        expect(describeMicProblem('no-api')).not.toMatch(/Try Chrome/);
    });

    it('names the device, not a browser, inside the packaged apps', () => {
        vi.stubGlobal('window', { isSecureContext: true, __TAURI_INTERNALS__: {} });
        expect(describeMicProblem('no-api')).toMatch(/this device/);
        expect(describeMicProblem('no-api')).not.toMatch(/Try Chrome/);
    });

    it('gives every failure an actionable line', () => {
        for (const status of ['no-api', 'no-device', 'denied', 'error'] as const) {
            expect(describeMicProblem(status)).toBeTruthy();
        }
    });
});
