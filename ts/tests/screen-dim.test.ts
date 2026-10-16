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
    coverHas: (cls: string) => boolean;
    hintTransform: () => string | undefined;
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
    type FakeEl = {
        click: Listener | null;
        className: string;
        classes: Set<string>;
        style: { transform?: string };
    };
    const covers: FakeEl[] = [];
    const created: FakeEl[] = [];
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
            const classes = new Set<string>();
            const el = {
                click: null as Listener | null,
                className: '',
                textContent: '',
                offsetWidth: 300,
                offsetHeight: 20,
                clientWidth: 360,
                clientHeight: 780,
                classes,
                style: {} as { transform?: string },
                classList: {
                    add: (c: string) => classes.add(c),
                    toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
                },
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
            created.push(el);
            return el;
        },
        body: {
            appendChild: (el: FakeEl) => covers.push(el),
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
        coverHas: (cls) => covers[0]?.classes.has(cls) ?? false,
        hintTransform: () => created.filter((el) => el.className === 'screen-dim-hint').at(-1)?.style.transform,
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
        expect(world.coverHas('backlight-down')).toBe(false);
        await vi.advanceTimersByTimeAsync(HINT_MS);
        expect(H.setDimmed).toHaveBeenLastCalledWith({ dimmed: true });
        // Its grey goes lighter to read under the dropped brightness.
        expect(world.coverHas('backlight-down')).toBe(true);
        world.tapCover();
        await vi.advanceTimersByTimeAsync(0);
        expect(H.setDimmed).toHaveBeenLastCalledWith({ dimmed: false });
    });

    it('the hint drifts while it is dark, and stops on the tap', async () => {
        const world = plant({});
        const { startScreenDim, DIM_AFTER_MS, DRIFT_MS } = await load();
        startScreenDim();
        await vi.advanceTimersByTimeAsync(DIM_AFTER_MS);
        expect(world.hintTransform()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(DRIFT_MS);
        const first = world.hintTransform();
        expect(first).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\)$/);
        // Inside the 30px either side a 300px line has on a 360px screen.
        const x = Number(/translate\((-?[\d.]+)px/.exec(first!)![1]);
        expect(Math.abs(x)).toBeLessThanOrEqual(30);
        await vi.advanceTimersByTimeAsync(DRIFT_MS);
        expect(world.hintTransform()).not.toBe(first);
        world.tapCover();
        const last = world.hintTransform();
        await vi.advanceTimersByTimeAsync(DRIFT_MS * 2);
        expect(world.hintTransform()).toBe(last);
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
