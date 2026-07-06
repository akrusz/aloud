/**
 * Capacitor Preferences adapter for the KvStorage interface — the durable
 * key-value store on native mobile (iOS UserDefaults / Android
 * SharedPreferences via @capacitor/preferences).
 *
 * Why not localStorage on mobile: a WKWebView's localStorage lives in the
 * WebKit data store, which iOS may evict under storage pressure (and which a
 * "Clear website data" style sweep can wipe). Preferences is real native
 * persistence — settings, the STT/voice picks, and the session history that
 * SessionStore keeps here survive that. Mobile is always a fresh install when
 * this store first runs, so there's no localStorage→Preferences migration to
 * do (unlike an upgrade of an existing web build).
 *
 * Keeps the same "aloud:" key prefix as LocalStorageKv so keys()/clear() only
 * touch our own entries and the two stores stay behaviourally interchangeable.
 * The whole KvStorage contract is async, which the native plugin already is.
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
        // Only remove our own prefixed keys, mirroring LocalStorageKv — never
        // Preferences.clear(), which would nuke any other plugin's data too.
        const keys = await this.keys();
        for (const key of keys) {
            await this.delete(key);
        }
    }
}
