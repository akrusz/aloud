/**
 * localStorage adapter for the KvStorage interface.
 *
 * Synchronous under the hood — wrapped in async to match the cross-platform
 * contract (Capacitor Preferences and IndexedDB are both async). Uses a
 * prefix so `clear()` doesn't wipe unrelated localStorage entries from
 * other code running on the same origin.
 */

import type { KvStorage } from '../../../src/platform/storage.js';

export interface LocalStorageKvOptions {
    /** Key prefix to namespace this store. Defaults to "aloud:". */
    prefix?: string;
}

export class LocalStorageKv implements KvStorage {
    private readonly prefix: string;

    constructor(options: LocalStorageKvOptions = {}) {
        if (typeof localStorage === 'undefined') {
            throw new Error('localStorage is not available in this environment.');
        }
        this.prefix = options.prefix ?? 'aloud:';
    }

    async get(key: string): Promise<string | null> {
        return localStorage.getItem(this.prefix + key);
    }

    async set(key: string, value: string): Promise<void> {
        localStorage.setItem(this.prefix + key, value);
    }

    async delete(key: string): Promise<void> {
        localStorage.removeItem(this.prefix + key);
    }

    async keys(): Promise<string[]> {
        const result: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k !== null && k.startsWith(this.prefix)) {
                result.push(k.slice(this.prefix.length));
            }
        }
        return result;
    }

    async clear(): Promise<void> {
        // Only remove our own keys.
        const keys = await this.keys();
        for (const key of keys) {
            await this.delete(key);
        }
    }
}
