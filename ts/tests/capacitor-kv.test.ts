/**
 * CapacitorKv — the durable native KV backed by @capacitor/preferences.
 *
 * The plugin is mocked with an in-memory Map matching its API shape. We assert
 * the "aloud:" prefix is applied on write and stripped on read, and that
 * keys()/clear() only touch our own prefixed entries — the same contract
 * LocalStorageKv holds, so the two are interchangeable across platforms.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            store.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            store.delete(key);
        },
        keys: async () => ({ keys: Array.from(store.keys()) }),
        clear: async () => {
            store.clear();
        },
    },
}));

import { CapacitorKv } from '../ui/src/adapters/capacitor-kv.js';

beforeEach(() => store.clear());

describe('CapacitorKv', () => {
    it('prefixes on write and strips on read', async () => {
        const kv = new CapacitorKv();
        await kv.set('theme', 'dark');
        expect(store.get('aloud:theme')).toBe('dark');
        expect(await kv.get('theme')).toBe('dark');
    });

    it('returns null for a missing key', async () => {
        expect(await new CapacitorKv().get('nope')).toBeNull();
    });

    it('delete removes only the prefixed key', async () => {
        const kv = new CapacitorKv();
        await kv.set('a', '1');
        await kv.delete('a');
        expect(await kv.get('a')).toBeNull();
    });

    it('keys() lists only our prefixed entries, prefix stripped', async () => {
        const kv = new CapacitorKv();
        await kv.set('a', '1');
        await kv.set('b', '2');
        store.set('other-plugin:x', 'y'); // foreign entry — must be ignored
        expect((await kv.keys()).sort()).toEqual(['a', 'b']);
    });

    it('clear() removes our entries but leaves foreign ones', async () => {
        const kv = new CapacitorKv();
        await kv.set('a', '1');
        store.set('other-plugin:x', 'y');
        await kv.clear();
        expect(await kv.keys()).toEqual([]);
        expect(store.get('other-plugin:x')).toBe('y');
    });

    it('honours a custom prefix', async () => {
        const kv = new CapacitorKv({ prefix: 'mp:' });
        await kv.set('k', 'v');
        expect(store.get('mp:k')).toBe('v');
    });
});
