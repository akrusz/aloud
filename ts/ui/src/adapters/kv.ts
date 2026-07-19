/**
 * Pick the KvStorage backend for the current runtime:
 *
 *   - Native mobile (Capacitor)  → CapacitorKv (durable UserDefaults /
 *                                  SharedPreferences; a WKWebView can evict
 *                                  localStorage).
 *   - Everything else            → LocalStorageKv (web, Tauri webview, browsers).
 *
 * Both honour the same "aloud:" prefix and async contract, so callers never
 * branch on platform. A bare Node context (no localStorage, not native) throws
 * by design - there's no persistence there.
 */

import type { KvStorage } from '../../../src/platform/storage.js';
import { isCapacitor } from '../is-desktop.js';
import { CapacitorKv } from './capacitor-kv.js';
import { LocalStorageKv } from './localstorage-kv.js';

export function createKv(): KvStorage {
    return isCapacitor() ? new CapacitorKv() : new LocalStorageKv();
}
