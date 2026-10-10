/**
 * Capacitor Preferences adapter for KvStorage - durable native key-value storage
 * on mobile (iOS UserDefaults / Android SharedPreferences).
 *
 * Not localStorage: a WKWebView's localStorage lives in the WebKit data store,
 * which iOS may evict under storage pressure and a "clear website data" sweep
 * wipes. Preferences is real native persistence, so settings, STT/voice picks,
 * and SessionStore history survive. Nothing is migrated from localStorage
 * here; the two slots older mobile builds kept there lift themselves
 * (cloud-auth.ts liftLegacyToken, settings.ts loadRawSetup).
 *
 * Same "aloud:" prefix as LocalStorageKv, so keys()/clear() touch only our own
 * entries and the two stores stay interchangeable.
 */

import { Preferences } from '@capacitor/preferences';

import type { KvStorage } from '../../../src/platform/storage.js';

const PREFIX = 'aloud:';

export class CapacitorKv implements KvStorage {
    async get(key: string): Promise<string | null> {
        const { value } = await Preferences.get({ key: PREFIX + key });
        return value;
    }

    async set(key: string, value: string): Promise<void> {
        await Preferences.set({ key: PREFIX + key, value });
    }

    async delete(key: string): Promise<void> {
        await Preferences.remove({ key: PREFIX + key });
    }

    async keys(): Promise<string[]> {
        const { keys } = await Preferences.keys();
        return keys
            .filter((k) => k.startsWith(PREFIX))
            .map((k) => k.slice(PREFIX.length));
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
