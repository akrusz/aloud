/**
 * Shared services — a single SessionStore + KvStorage that all views
 * reach for, so we don't get one-per-view instances and they all see
 * the same persisted data.
 *
 * On desktop (Tauri) sessions persist to disk via the embedded shell
 * (BackendSessionStore → <app-data>/sessions/*.json), so they're durable,
 * openable files. The web build keeps the localStorage-backed store. The
 * shared KV stays localStorage either way (settings, small UI state).
 */

import { SessionStore, type SessionStoreApi } from '../../src/platform/index.js';
import { LocalStorageKv } from './adapters/localstorage-kv.js';
import { BackendSessionStore } from './adapters/backend-session-store.js';
import { isTauri } from './is-desktop.js';

export const sharedKv = new LocalStorageKv();
export const sessionStore: SessionStoreApi = isTauri()
    ? new BackendSessionStore()
    : new SessionStore(sharedKv);
