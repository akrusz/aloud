/**
 * Shared services — a single SessionStore + KvStorage that all views
 * reach for, so we don't get one-per-view instances and they all see
 * the same persisted data.
 *
 * On desktop (Tauri) sessions persist to disk via the embedded shell
 * (BackendSessionStore → <app-data>/sessions/*.json), so they're durable,
 * openable files. Native mobile (Capacitor) keeps them in durable Preferences
 * via the shared KV; the web build keeps the localStorage-backed store. The
 * shared KV picks its backend per platform (createKv) — settings, small UI
 * state, and (off-desktop) the session history all ride on it.
 */

import { SessionStore, type SessionStoreApi } from '../../src/platform/index.js';
import { createKv } from './adapters/kv.js';
import { BackendSessionStore } from './adapters/backend-session-store.js';
import { isTauri } from './is-desktop.js';

export const sharedKv = createKv();
export const sessionStore: SessionStoreApi = isTauri()
    ? new BackendSessionStore()
    : new SessionStore(sharedKv);
