/**
 * BYOK API key storage.
 *
 * Keys live in their own KvStorage slot, apart from session setup, so the
 * backend can be swapped per-platform (localStorage today; secure storage on
 * mobile later) without touching setup persistence.
 *
 * Call getApiKey(provider) lazily, just before constructing an LLM provider, and
 * never put keys in any object that gets serialized into setup/state.
 */

import type { Provider } from './settings.js';
import { LocalStorageKv } from './adapters/localstorage-kv.js';
import type { KvStorage } from '../../src/platform/storage.js';

const KEY_PREFIX = 'apikey:';

// Singleton so a test can swap the backend before any caller pulls a key out.
// Mirrors the sharedKv approach in state.ts.
let backend: KvStorage = new LocalStorageKv();

export function setApiKeyBackend(kv: KvStorage): void {
    backend = kv;
}

export async function getApiKey(provider: Provider): Promise<string | null> {
    return backend.get(KEY_PREFIX + provider);
}

export async function setApiKey(provider: Provider, key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed) {
        await backend.set(KEY_PREFIX + provider, trimmed);
    } else {
        await backend.delete(KEY_PREFIX + provider);
    }
}

export async function hasApiKey(provider: Provider): Promise<boolean> {
    return (await getApiKey(provider)) !== null;
}
