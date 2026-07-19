/**
 * Capacitor Preferences adapter for KvStorage - durable native key-value storage
 * on mobile (iOS UserDefaults / Android SharedPreferences).
 *
 * Not localStorage: a WKWebView's localStorage lives in the WebKit data store,
 * which iOS may evict under storage pressure and a "clear website data" sweep
 * wipes. Preferences is real native persistence, so settings, STT/voice picks,
 * and SessionStore history survive. Mobile is always a fresh install when this
 * first runs, so there's no localStorage→Preferences migration.
 *
 * Same "aloud:" prefix as LocalStorageKv, so keys()/clear() touch only our own
 * entries and the two stores stay interchangeable.
 */

import { Preferences } from '@capacitor/preferences';

import type { KvStorage } from '../../../src/platform/storage.js';

export interface CapacitorKvOptions {
    /** Key prefix to namespace this store. Defaults to "aloud:". */
    prefix?: string;
}

export class CapacitorKv implements KvStorage {
    private readonly prefix: string;

    constructor(options: CapacitorKvOptions = {}) {
        this.prefix = options.prefix ?? 'aloud:';
    }

    async get(key: string): Promise<string | null> {
        const { value } = await Preferences.get({ key: this.prefix + key });
        return value;
    }

    async set(key: string, value: string): Promise<void> {
        await Preferences.set({ key: this.prefix + key, value });
    }

    async delete(key: string): Promise<void> {
        await Preferences.remove({ key: this.prefix + key });
    }

    async keys(): Promise<string[]> {
        const { keys } = await Preferences.keys();
        return keys
            .filter((k) => k.startsWith(this.prefix))
            .map((k) => k.slice(this.prefix.length));
    }

    async clear(): Promise<void> {
        // Our own prefixed keys only, mirroring LocalStorageKv - never
        // Preferences.clear(), which would nuke other plugins' data too.
        const keys = await this.keys();
        for (const key of keys) {
            await this.delete(key);
        }
    }
}
