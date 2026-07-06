/**
 * Pick the right KvStorage backend for the current runtime.
 *
 *   - Native mobile (Capacitor)  → CapacitorKv (durable UserDefaults /
 *                                   SharedPreferences; localStorage can be
 *                                   evicted in a WKWebView).
 *   - Everything else            → LocalStorageKv (web preview, desktop Tauri
 *                                   webview, and any browser).
 *
 * Both honour the same "aloud:" prefix and the same async contract, so callers
 * never branch on platform. Node/test environments with no localStorage fall
 * through to CapacitorKv only when actually inside the native app, so this
 * throws in a bare Node context by design (no persistence there) — production
 * callers run in a webview where one backend or the other exists.
 */

import type { KvStorage } from '../../../src/platform/storage.js';
import { isCapacitor } from '../is-desktop.js';
import { CapacitorKv } from './capacitor-kv.js';
import { LocalStorageKv } from './localstorage-kv.js';

export function createKv(): KvStorage {
    return isCapacitor() ? new CapacitorKv() : new LocalStorageKv();
}
