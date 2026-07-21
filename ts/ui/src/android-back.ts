/**
 * Android hardware/gesture back → in-app navigation.
 *
 * Without a listener, Capacitor's default back handling exits the activity,
 * losing in-app history. Route the button through `history.back()` instead so
 * it flows into the app's popstate handler (app.ts) - including the
 * end-session confirm overlay - and only backgrounds the app from the root
 * view. iOS has no back button; the listener simply never fires there.
 *
 * Dynamic import so web/desktop bundles don't pull the plugin (mirrors
 * wakelock.ts).
 */

import { isCapacitor } from './is-desktop.js';

export function initAndroidBack(): void {
    if (!isCapacitor()) return;
    void (async () => {
        const { App } = await import('@capacitor/app');
        await App.addListener('backButton', ({ canGoBack }) => {
            if (canGoBack) window.history.back();
            else void App.minimizeApp();
        });
    })();
}
