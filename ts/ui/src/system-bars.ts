/**
 * Native status/navigation bar icons → the app's theme.
 *
 * The mobile app draws under the system bars, and left alone their icons take
 * their color from the device's light/dark mode. The theme on screen can
 * differ (a manual pick, the Settings choice, the kasina's forced dark), which
 * put dark icons on the dark nav. Follow `data-theme` itself rather than any
 * one writer of it.
 *
 * Dynamic import so web/desktop bundles don't pull the plugin (mirrors
 * wakelock.ts).
 */

import { isCapacitor } from './is-desktop.js';

export function initSystemBarsTheme(): void {
    if (!isCapacitor()) return;
    const root = document.documentElement;
    const sync = (): void => {
        void (async () => {
            const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
            // Read after the import lands, so a flip during it isn't lost.
            // The plugin names the style for the background: Dark = light icons.
            const dark = root.getAttribute('data-theme') === 'dark';
            await SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
        })().catch(() => {});
    };
    sync();
    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}
