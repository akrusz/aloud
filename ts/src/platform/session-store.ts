/**
 * Typed persistence for session state on top of any KvStorage.
 *
 * Stores each session under a prefixed key plus an index key listing all
 * session IDs. The index is updated atomically with each save/delete so
 * `list()` doesn't require enumerating all keys (which is fast for the
 * in-memory backend but can be slow for Capacitor Preferences).
 */

import type { SessionState } from '../facilitation/session.js';
import { type KvStorage, getJson, setJson } from './storage.js';

const DEFAULT_PREFIX = 'session:';
const INDEX_KEY = 'session:index';

export interface SessionStoreOptions {
    prefix?: string;
}

/**
 * The persistence surface the UI depends on. Implemented by SessionStore (over
 * any KvStorage — localStorage on web) and by the UI's BackendSessionStore
 * (HTTP to the desktop shell, which writes one JSON file per session to disk).
 */
export interface SessionStoreApi {
    save(state: SessionState): Promise<void>;
    load(sessionId: string): Promise<SessionState | null>;
    delete(sessionId: string): Promise<void>;
    list(): Promise<string[]>;
}

export class SessionStore implements SessionStoreApi {
    private readonly prefix: string;

    constructor(private readonly storage: KvStorage, options: SessionStoreOptions = {}) {
        this.prefix = options.prefix ?? DEFAULT_PREFIX;
    }

    private keyFor(id: string): string {
        return `${this.prefix}${id}`;
    }

    async save(state: SessionState): Promise<void> {
        await setJson(this.storage, this.keyFor(state.sessionId), state);
        const index = (await getJson<string[]>(this.storage, INDEX_KEY, [])) ?? [];
        if (!index.includes(state.sessionId)) {
            index.push(state.sessionId);
            await setJson(this.storage, INDEX_KEY, index);
        }
    }

    async load(sessionId: string): Promise<SessionState | null> {
        return getJson<SessionState>(this.storage, this.keyFor(sessionId));
    }

    async delete(sessionId: string): Promise<void> {
        await this.storage.delete(this.keyFor(sessionId));
        const index = (await getJson<string[]>(this.storage, INDEX_KEY, [])) ?? [];
        const next = index.filter((id) => id !== sessionId);
        if (next.length !== index.length) {
            await setJson(this.storage, INDEX_KEY, next);
        }
    }

    async list(): Promise<string[]> {
        const index = await getJson<string[]>(this.storage, INDEX_KEY, []);
        return index ?? [];
    }
}
