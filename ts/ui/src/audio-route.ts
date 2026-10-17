/**
 * Whether the iOS app's sound goes to headphones, where the mic can't hear the
 * facilitator, so the meditator can talk over it (session.ts,
 * meditation-pal-hi6f). The native half is ios/App/App/AudioRoutePlugin.swift.
 * False everywhere else, iPhone Safari included: a page can't see the output
 * route.
 */

import { capacitorPlatform } from './is-desktop.js';

interface AudioRoutePlugin {
    headphones(): Promise<{ connected: boolean }>;
    addListener(
        event: 'change',
        listener: (e: { connected: boolean }) => void
    ): Promise<{ remove(): Promise<void> }>;
}

// Never `await` or resolve a promise with this: a Capacitor plugin proxy
// answers every property read, `then` included (screen-dim.ts).
let plugin: AudioRoutePlugin | null = null;

async function ensurePlugin(): Promise<boolean> {
    if (capacitorPlatform() !== 'ios') return false;
    plugin ??= (await import('@capacitor/core')).registerPlugin<AudioRoutePlugin>('AudioRoute');
    return true;
}

export async function iosHeadphones(): Promise<boolean> {
    try {
        if (!(await ensurePlugin())) return false;
        return (await plugin!.headphones()).connected;
    } catch {
        return false;
    }
}

/** Calls back with the new answer on every route change; resolves to the
 *  unsubscribe. */
export async function watchIosHeadphones(onChange: (connected: boolean) => void): Promise<() => void> {
    try {
        if (!(await ensurePlugin())) return () => {};
        const handle = await plugin!.addListener('change', (e) => onChange(e.connected));
        return () => void handle.remove();
    } catch {
        return () => {};
    }
}
