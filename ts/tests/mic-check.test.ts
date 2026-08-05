/**
 * Mic availability gate (meditation-pal-j8k1).
 *
 * The load-bearing property is asymmetry: probeMic() must never report a
 * problem it isn't sure about (a false "no mic" blocks Begin for a user who
 * has one), while acquireMicOnce() must report every failure it sees.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../ui/src/mic-permission.js', () => ({
    ensureMicPermission: vi.fn(async () => {}),
}));

import { probeMic, acquireMicOnce, describeMicProblem } from '../ui/src/mic-check.js';

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

afterEach(() => vi.unstubAllGlobals());

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

    it('drives both probes from the URL', async () => {
        stubUrl('?nomic=denied');
        stubNavigator(healthyNav());
        expect(await probeMic()).toBe('denied');
        expect(await acquireMicOnce()).toBe('denied');
    });

    it("keeps 'error' invisible to the silent probe, as in real life", async () => {
        // A mic that's present and permitted but won't open can only be
        // discovered by opening it, so setup stays clean and Begin catches it.
        stubUrl('?nomic=error');
        stubNavigator(healthyNav());
        expect(await probeMic()).toBe('ok');
        expect(await acquireMicOnce()).toBe('error');
    });

    it('ignores a value that is not a known status', async () => {
        stubUrl('?nomic=banana');
        stubNavigator(healthyNav());
        expect(await acquireMicOnce()).toBe('ok');
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
            const msg = describeMicProblem(status);
            expect(msg).toBeTruthy();
            // House style: no em-dashes in user-facing copy.
            expect(msg).not.toContain('—');
        }
    });
});
