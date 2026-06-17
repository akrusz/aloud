/**
 * SessionStoreApi backed by the desktop shell's on-disk session logs.
 *
 * In a Tauri build, the embedded Rust server persists one JSON file per session
 * under <app-data>/sessions/ (see src-tauri/src/server.rs). This adapter maps
 * the store API onto those /app/v1/sessions endpoints, so saved sessions are
 * durable, openable files instead of webview localStorage. Wired in state.ts
 * only when isTauri(); the web build keeps the localStorage-backed SessionStore.
 */

import type { SessionState } from '../../../src/facilitation/index.js';
import type { SessionStoreApi } from '../../../src/platform/index.js';
import { appUrl } from '../app-base.js';

export class BackendSessionStore implements SessionStoreApi {
    private url(id: string): string {
        return appUrl(`/sessions/${encodeURIComponent(id)}`);
    }

    async save(state: SessionState): Promise<void> {
        const res = await fetch(this.url(state.sessionId), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(state),
        });
        if (!res.ok) throw new Error(`session save failed: HTTP ${res.status}`);
    }

    async load(sessionId: string): Promise<SessionState | null> {
        const res = await fetch(this.url(sessionId));
        if (!res.ok) return null; // 404 (gone) or error — caller treats as missing
        return (await res.json()) as SessionState;
    }

    async delete(sessionId: string): Promise<void> {
        await fetch(this.url(sessionId), { method: 'DELETE' });
    }

    async list(): Promise<string[]> {
        const res = await fetch(appUrl('/sessions'));
        if (!res.ok) return [];
        const body = (await res.json()) as { ids?: string[] };
        return body.ids ?? [];
    }
}
