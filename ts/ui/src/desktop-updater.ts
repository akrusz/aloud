/**
 * Desktop self-update via the Tauri updater plugin.
 *
 * Tauri-shell only; a browser just reloads to pick up a new deploy. The plugin
 * fetches the signed latest.json manifest (tauri.conf.json →
 * plugins.updater.endpoints), compares versions, then on the user's click
 * downloads the bundle over Rust (not the webview, so no CSP entry is needed),
 * verifies its minisign signature, installs, and relaunches.
 *
 * Plugin modules are imported dynamically (as in external-links.ts) so the
 * shared web build never pulls in updater/process code.
 */

import { isTauri } from './is-desktop.js';

export interface DesktopUpdate {
    /** The available version, e.g. "1.0.6". */
    version: string;
    /** Release notes from the manifest, if the release carried a body. */
    notes?: string | undefined;
    /**
     * Download + install, reporting 0..1 progress (null while total size is
     * unknown), then relaunch. On success the app restarts, so this never
     * resolves; it rejects if download or install fails.
     */
    installAndRelaunch: (onProgress?: (fraction: number | null) => void) => Promise<void>;
}

/**
 * Null when not on desktop, already up to date, or the check failed: callers
 * treat all three as "nothing to offer". Never throws.
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
