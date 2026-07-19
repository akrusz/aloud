/**
 * Shared services - one SessionStore + KvStorage for all views, so they see the
 * same persisted data. Desktop (Tauri) persists sessions to disk via the
 * embedded shell (BackendSessionStore -> <app-data>/sessions/*.json); elsewhere
 * they ride on the shared KV, which picks its backend per platform (createKv:
 * Capacitor Preferences on native mobile, localStorage on web).
 */

import { SessionStore, type SessionStoreApi } from '../../src/platform/index.js';
import { createKv } from './adapters/kv.js';
import { BackendSessionStore } from './adapters/backend-session-store.js';
import { isTauri } from './is-desktop.js';

export const sharedKv = createKv();
export const sessionStore: SessionStoreApi = isTauri()
    ? new BackendSessionStore()
    : new SessionStore(sharedKv);
