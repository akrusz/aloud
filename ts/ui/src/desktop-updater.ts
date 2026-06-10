/**
 * Desktop self-update via the Tauri updater plugin.
 *
 * Only meaningful inside the Tauri shell (isTauri()); in a browser there's
 * nothing to install — the page just reloads to pick up a new deploy. The
 * plugin fetches the signed latest.json manifest (tauri.conf.json →
 * plugins.updater.endpoints), compares its version to the running app, and — on
 * the user's click — downloads that platform's bundle over Rust (not the
 * webview, so no CSP entry is needed), verifies its minisign signature against
 * the configured pubkey, installs it, and we relaunch into the new version.
 *
 * The plugin modules are imported dynamically, matching external-links.ts, so
 * they only load inside the desktop bundle — the shared web build never pulls
 * in updater/process code.
 */

import { isTauri } from './is-desktop.js';

export interface DesktopUpdate {
    /** The available version, e.g. "1.0.6". */
    version: string;
    /** Release notes from the manifest, if the release carried a body. */
    notes?: string | undefined;
    /**
     * Download + install the update, reporting 0..1 progress (null while the
     * total size is unknown), then relaunch into the new version. On success
     * the app restarts, so this never resolves; it rejects if the download or
     * install fails.
     */
    installAndRelaunch: (onProgress?: (fraction: number | null) => void) => Promise<void>;
}

/**
 * Check for a newer desktop release. Returns null when not on desktop, when
 * already up to date, or when the check fails — callers treat all three the
 * same (nothing to offer). Never throws: failures resolve to null.
 */
export async function checkDesktopUpdate(): Promise<DesktopUpdate | null> {
    if (!isTauri()) return null;
    try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (!update) return null;
        return {
            version: update.version,
            notes: update.body || undefined,
            installAndRelaunch: async (onProgress) => {
                let total = 0;
                let received = 0;
                await update.downloadAndInstall((event) => {
                    switch (event.event) {
                        case 'Started':
                            total = event.data.contentLength ?? 0;
                            onProgress?.(total ? 0 : null);
                            break;
                        case 'Progress':
                            received += event.data.chunkLength;
                            onProgress?.(total ? Math.min(received / total, 1) : null);
                            break;
                        case 'Finished':
                            onProgress?.(1);
                            break;
                    }
                });
                const { relaunch } = await import('@tauri-apps/plugin-process');
                await relaunch();
            },
        };
    } catch {
        return null;
    }
}
