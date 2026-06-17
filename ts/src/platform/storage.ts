/**
 * Async key-value storage.
 *
 * Concrete impls: Capacitor Preferences plugin on mobile, localStorage
 * (wrapped) or IndexedDB on web, fs on Node. The interface is async
 * across the board so callers don't need to branch on platform — even
 * for synchronous backends, returning a Promise is cheap.
 *
 * Named `KvStorage` (not `Storage`) to avoid colliding with the DOM
 * `Storage` global type in browser builds.
 */

export interface KvStorage {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
    clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation — tests, ephemeral CLI runs, fallback
// ---------------------------------------------------------------------------

export class InMemoryKvStorage implements KvStorage {
    private readonly data = new Map<string, string>();

    async get(key: string): Promise<string | null> {
        return this.data.get(key) ?? null;
    }

    async set(key: string, value: string): Promise<void> {
        this.data.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.data.delete(key);
    }

    async keys(): Promise<string[]> {
        return Array.from(this.data.keys());
    }

    async clear(): Promise<void> {
        this.data.clear();
    }
}

// ---------------------------------------------------------------------------
// Typed helper for storing JSON-serializable values
// ---------------------------------------------------------------------------

/**
 * Read a JSON value, returning `defaultValue` (or null) when the key is
 * missing or unparseable. Avoids sprinkling JSON.parse / try-catch all
 * over callers.
 */
export async function getJson<T>(
    storage: KvStorage,
    key: string,
    defaultValue: T | null = null
): Promise<T | null> {
    const raw = await storage.get(key);
    if (raw === null) return defaultValue;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return defaultValue;
    }
}

export async function setJson<T>(storage: KvStorage, key: string, value: T): Promise<void> {
    await storage.set(key, JSON.stringify(value));
}
