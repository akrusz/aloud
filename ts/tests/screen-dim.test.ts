/**
 * screen-dim.ts: a session on a touch device running on battery goes black
 * after DIM_AFTER_MS without a touch and comes back at the next one. Never on a
 * charger, never where the battery can't be read, never outside a session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const H = vi.hoisted(() => ({ setDimmed: vi.fn(async (_opts: { dimmed: boolean }) => {}) }));
vi.mock('@capacitor/core', () => ({
    registerPlugin: () => ({ setDimmed: H.setDimmed }),
}));

type Listener = () => void;

interface World {
    covers: () => number;
    tapCover: () => void;
    touch: () => void;
    setCharging: (charging: boolean) => void;
    setVisible: (visible: boolean) => void;
    setKasina: (on: boolean) => void;
}

function plant(opts: { coarse?: boolean; battery?: 'charging' | 'discharging' | 'none'; native?: boolean }): World {
    const coarse = opts.coarse ?? true;
    const batteryKind = opts.battery ?? 'discharging';
    const windowListeners: Record<string, Listener[]> = {};
    const documentListeners: Record<string, Listener[]> = {};
    const batteryListeners: Listener[] = [];
    const covers: Array<{ click: Listener | null }> = [];
    let kasina = false;
    const battery = {
        charging: batteryKind === 'charging',
        addEventListener: (_type: string, l: Listener) => batteryListeners.push(l),
    };
    const doc = {
        visibilityState: 'visible',
        querySelector: (selector: string) => (selector === '.kasina-active' && kasina ? {} : null),
        addEventListener: (type: string, l: Listener) => (documentListeners[type] ??= []).push(l),
        createElement: () => {
            const el = {
                click: null as Listener | null,
                className: '',
                textContent: '',
                offsetWidth: 0,
                classList: { add: () => {} },
                setAttribute: () => {},
                appendChild: () => {},
                addEventListener: (type: string, l: Listener) => {
                    if (type === 'click') el.click = l;
                },
                remove: () => {
                    const i = covers.indexOf(el);
                    if (i >= 0) covers.splice(i, 1);
                },
            };
            return el;
        },
        body: {
            appendChild: (el: { click: Listener | null }) => covers.push(el),
        },
    };
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = {
        Capacitor: { isNativePlatform: () => opts.native ?? false, getPlatform: () => 'android' },
        addEventListener: (type: string, l: Listener) => (windowListeners[type] ??= []).push(l),
    };
    g.document = doc;
    g.matchMedia = () => ({ matches: coarse });
    vi.stubGlobal('navigator', batteryKind === 'none' ? {} : { getBattery: async () => battery });
    return {
        covers: () => covers.length,
        tapCover: () => covers[0]?.click?.(),
        touch: () => windowListeners['pointerdown']?.forEach((l) => l()),
        setCharging: (charging) => {
            battery.charging = charging;
            batteryListeners.forEach((l) => l());
        },
        setVisible: (visible) => {
            doc.visibilityState = visible ? 'visible' : 'hidden';
            documentListeners['visibilitychange']?.forEach((l) => l());
        },
        setKasina: (on) => {
            kasina = on;
        },
    };
}

async function load(): Promise<typeof import('../ui/src/screen-dim.js')> {
    return import('../ui/src/screen-dim.js');
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    H.setDimmed.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.matchMedia;
});

describe('screen dim', () => {
    it('goes black after the idle time on battery, and a tap brings it back', async () => {
        const world = plant({});
        const { startScreenDim, DIM_AFTER_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS - 1);
        expect(world.covers()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(world.covers()).toBe(1);
        world.tapCover();
        expect(world.covers()).toBe(0);
        // And it counts again from the tap.
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS);
        expect(world.covers()).toBe(1);
    });

    it('a touch restarts the count', async () => {
        const world = plant({});
        const { startScreenDim, DIM_AFTER_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS - 1000);
        world.touch();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS - 1000);
        expect(world.covers()).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(world.covers()).toBe(1);
    });

    it('stays lit on a charger, and lights up when one is plugged in', async () => {
        const world = plant({ battery: 'charging' });
        const { startScreenDim, DIM_AFTER_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS * 2);
        expect(world.covers()).toBe(0);
        world.setCharging(false);
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS);
        expect(world.covers()).toBe(1);
        world.setCharging(true);
        expect(world.covers()).toBe(0);
    });

    it('stays lit where the battery cannot be read', async () => {
        const world = plant({ battery: 'none' });
        const { startScreenDim, DIM_AFTER_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS * 2);
        expect(world.covers()).toBe(0);
    });

    it('stays lit on a pointer device', async () => {
        const world = plant({ coarse: false });
        const { startScreenDim, DIM_AFTER_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS * 2);
        expect(world.covers()).toBe(0);
    });

    it('the session ending lights the screen and stops the count', async () => {
        const world = plant({});
        const { startScreenDim, stopScreenDim, DIM_AFTER_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS);
        expect(world.covers()).toBe(1);
        stopScreenDim();
        expect(world.covers()).toBe(0);
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS * 2);
        expect(world.covers()).toBe(0);
    });

    it('coming back from a lock lights the screen', async () => {
        const world = plant({});
        const { startScreenDim, DIM_AFTER_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS);
        world.setVisible(false);
        world.setVisible(true);
        expect(world.covers()).toBe(0);
    });

    it('stays lit through kasina gazing, and counts again once it is over', async () => {
        const world = plant({});
        const { startScreenDim, DIM_AFTER_MS } = await load();
        startScreenDim();
        world.setKasina(true);
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS * 3);
        expect(world.covers()).toBe(0);
        world.setKasina(false);
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS);
        expect(world.covers()).toBe(1);
    });

    it('native: brightness drops once the hint has been up a moment, and returns on the tap', async () => {
        const world = plant({ native: true });
        const { startScreenDim, DIM_AFTER_MS, HINT_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS);
        expect(H.setDimmed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(HINT_MS);
        expect(H.setDimmed).toHaveBeenLastCalledWith({ dimmed: true });
        world.tapCover();
        await vi.advanceTimersByTimeAsync(0);
        expect(H.setDimmed).toHaveBeenLastCalledWith({ dimmed: false });
    });

    it('web: no native call', async () => {
        const world = plant({ native: false });
        const { startScreenDim, DIM_AFTER_MS, HINT_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS + HINT_MS);
        world.tapCover();
        await vi.advanceTimersByTimeAsync(0);
        expect(H.setDimmed).not.toHaveBeenCalled();
    });
});
