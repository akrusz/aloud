/**
 * BYOK API key storage.
 *
 * Keys live in their own slots of the platform KV (createKv: localStorage on
 * web and desktop, native Preferences on mobile), apart from session setup, so
 * the backend can change (secure storage on mobile, say) without touching
 * setup persistence.
 *
 * Call getApiKey(provider) lazily, just before constructing an LLM provider, and
 * never put keys in any object that gets serialized into setup/state.
 */

import type { Provider } from './settings.js';
import { isCapacitor, isTauri } from './is-desktop.js';
import { createKv } from './adapters/kv.js';
import { LocalStorageKv } from './adapters/localstorage-kv.js';
import type { KvStorage } from '../../src/platform/storage.js';

/** TypeSafe is no LLM provider: its key runs the Jev judge on a desktop sit
 *  (ownJudgeKey). */
export type KeyOwner = Provider | 'typesafe';

const KEY_PREFIX = 'apikey:';

// Lazy for the same reason as cloud-auth.ts; a test swaps the backend before
// any caller pulls a key out.
let backendOverride: KvStorage | null = null;
let lazyBackend: KvStorage | null = null;
function kv(): KvStorage {
    if (backendOverride) return backendOverride;
    if (!lazyBackend) lazyBackend = createKv();
    return lazyBackend;
}

export function setApiKeyBackend(kvStorage: KvStorage): void {
    backendOverride = kvStorage;
}

/** One-time lift of the keys an older mobile build left in the webview's
 *  localStorage (which iOS can evict) into the platform KV, like the setup's
 *  (settings.ts loadRawSetup). Native only. Every legacy slot is emptied, moved
 *  or not, so a key cleared later can't come back from it. */
let legacyLift: Promise<void> | null = null;
function liftLegacyKeys(): Promise<void> {
    if (backendOverride || !isCapacitor()) return Promise.resolve();
    return (legacyLift ??= (async () => {
        try {
            const legacy = new LocalStorageKv();
            for (const slot of await legacy.keys()) {
                if (!slot.startsWith(KEY_PREFIX)) continue;
                const old = await legacy.get(slot);
                if (old && (await kv().get(slot)) === null) await kv().set(slot, old);
                await legacy.delete(slot);
            }
        } catch {
            /* nothing to lift */
        }
    })());
}

export async function getApiKey(provider: KeyOwner): Promise<string | null> {
    await liftLegacyKeys();
    return kv().get(KEY_PREFIX + provider);
}

export async function setApiKey(provider: KeyOwner, key: string): Promise<void> {
    await liftLegacyKeys();
    const trimmed = key.trim();
    if (trimmed) {
        await kv().set(KEY_PREFIX + provider, trimmed);
    } else {
        await kv().delete(KEY_PREFIX + provider);
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
