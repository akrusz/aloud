/**
 * A session keeps the screen on (wakelock.ts) while nobody looks at it. On a
 * phone or tablet running on battery, go black after a few minutes without a
 * touch, and come back at the next one.
 *
 * Black is a cover over the page, which on an OLED panel is the pixels off. The
 * Android app also drops the window's brightness (ScreenDimPlugin.java), for
 * the LCD panels where black is still a lit backlight.
 *
 * Only where the Battery Status API says the device is discharging. No API
 * (iOS, Firefox) means we cannot tell, and a screen that blacks out on a
 * charger is a surprise that saves nothing.
 */

import { isCapacitor } from './is-desktop.js';
import { t } from './i18n.js';

export const DIM_AFTER_MS = 3 * 60_000;
/** How long "Tap to wake" stays readable before the brightness drops under it.
 *  Matches the hint's fade in app-base.css (.screen-dim-hint). */
export const HINT_MS = 5000;

interface BatteryLike {
    charging: boolean;
    addEventListener(type: 'chargingchange', listener: () => void): void;
}

interface ScreenDimPlugin {
    setDimmed(options: { dimmed: boolean }): Promise<void>;
}

let active = false;
let onBattery = false;
let installed = false;
let cover: HTMLElement | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

// Wrapped in an object: a Capacitor plugin proxy answers every property read,
// `then` included, so a promise resolved WITH one calls a native method named
// "then" and never settles.
let pluginLoad: Promise<{ plugin: ScreenDimPlugin }> | null = null;
let nativeWanted = false;

async function setNativeDim(dimmed: boolean): Promise<void> {
    if (!isCapacitor()) return;
    nativeWanted = dimmed;
    try {
        pluginLoad ??= import('@capacitor/core').then((core) => ({
            plugin: core.registerPlugin<ScreenDimPlugin>('ScreenDim'),
        }));
        const { plugin } = await pluginLoad;
        // The latest ask, not this call's: a wake can arrive during the import.
        await plugin.setDimmed({ dimmed: nativeWanted });
    } catch {
        // No such plugin (iOS): the cover is the whole feature there.
    }
}

function arm(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (!active || !onBattery || cover) return;
    idleTimer = setTimeout(dim, DIM_AFTER_MS);
}

function dim(): void {
    idleTimer = null;
    if (!active || !onBattery || cover || document.visibilityState !== 'visible') return;
    // Kasina gazing (kasina.ts) is the one part of a session that is looked at.
    if (document.querySelector('.kasina-active')) {
        arm();
        return;
    }
    const el = document.createElement('div');
    el.className = 'screen-dim';
    el.setAttribute('role', 'button');
    const hint = document.createElement('span');
    hint.className = 'screen-dim-hint';
    hint.textContent = t('Tap to wake');
    el.appendChild(hint);
    // click, not pointerdown: the cover has to outlive the whole tap, or its
    // second half hits whatever button was underneath.
    el.addEventListener('click', wake);
    document.body.appendChild(el);
    cover = el;
    // Lay it out transparent first, or there is nothing to fade from.
    void el.offsetWidth;
    el.classList.add('visible');
    hintTimer = setTimeout(() => {
        hintTimer = null;
        void setNativeDim(true);
    }, HINT_MS);
}

function wake(): void {
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = null;
    if (cover) {
        cover.remove();
        cover = null;
        void setNativeDim(false);
    }
    arm();
}

function install(): void {
    if (installed) return;
    installed = true;
    window.addEventListener('pointerdown', () => arm(), { capture: true, passive: true });
    window.addEventListener('keydown', () => (cover ? wake() : arm()), { capture: true });
    // Back from a lock or another app: someone is looking at it.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') wake();
    });
    const nav = navigator as unknown as { getBattery?: () => Promise<BatteryLike> };
    if (!nav.getBattery) return;
    void nav
        .getBattery()
        .then((battery) => {
            const sync = (): void => {
                onBattery = !battery.charging;
                wake();
            };
            battery.addEventListener('chargingchange', sync);
            sync();
        })
        .catch(() => {});
}

/** Session start (wakelock.ts). A no-op off touch devices: a laptop on battery
 *  has its own display sleep, and its screen is what the user is working at. */
export function startScreenDim(): void {
    if (active) return;
    if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) return;
    active = true;
    install();
    arm();
}

/** Session end: light the screen and stop counting. */
export function stopScreenDim(): void {
    if (!active) return;
    active = false;
    wake();
}
