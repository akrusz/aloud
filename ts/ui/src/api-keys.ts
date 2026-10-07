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
import { isTauri } from './is-desktop.js';
import { LocalStorageKv } from './adapters/localstorage-kv.js';
import type { KvStorage } from '../../src/platform/storage.js';

/** TypeSafe is no LLM provider: its key runs the Jev judge on a desktop sit
 *  (ownJudgeKey). */
export type KeyOwner = Provider | 'typesafe';

const KEY_PREFIX = 'apikey:';

// Singleton so a test can swap the backend before any caller pulls a key out.
// Mirrors the sharedKv approach in state.ts.
let backend: KvStorage = new LocalStorageKv();

export function setApiKeyBackend(kv: KvStorage): void {
    backend = kv;
}

export async function getApiKey(provider: KeyOwner): Promise<string | null> {
    return backend.get(KEY_PREFIX + provider);
}

export async function setApiKey(provider: KeyOwner, key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed) {
        await backend.set(KEY_PREFIX + provider, trimmed);
    } else {
        await backend.delete(KEY_PREFIX + provider);
    }
}

export async function hasApiKey(provider: KeyOwner): Promise<boolean> {
    return (await getApiKey(provider)) !== null;
}

/** The user's own TypeSafe key, where it can be used: only the desktop shell
 *  can reach TypeSafe (adapters/own-key-judge.ts). */
export async function ownJudgeKey(): Promise<string | null> {
    return isTauri() ? getApiKey('typesafe') : null;
}
