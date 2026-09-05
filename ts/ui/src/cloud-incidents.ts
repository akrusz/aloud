/**
 * Report a cloud failure the app handled quietly, so it still shows up in the
 * admin panel's Incidents section (meditation-pal-xtgh, server
 * credits/incidents.ts). aloud cloud is the convenience path: the session
 * papers over a blank turn or a failed voice, and this is what keeps that
 * from hiding a real problem.
 *
 * Fire-and-forget and silent: never prompts for sign-in (a missing token
 * just drops the report), never throws, never sends what was said - a kind,
 * a one-line detail, the provider/model, and the session id.
 */

import { getCloudToken } from './cloud-auth.js';
import { cloudUrl } from './cloud-base.js';
import { getCloudSessionId } from './cloud-session.js';

/** Mirrors CLIENT_INCIDENT_KINDS on the server; anything else is a 400. */
export type CloudIncidentKind =
    | 'client_llm_empty_retry'
    | 'client_llm_empty_fallback'
    | 'client_llm_error'
    | 'client_tts_error'
    | 'client_stt_error'
    | 'client_playback_blocked';

export interface CloudIncidentExtra {
    detail?: string;
    provider?: string;
    model?: string;
}

const ENDPOINT = '/incidents';

export function reportCloudIncident(kind: CloudIncidentKind, extra: CloudIncidentExtra = {}): void {
    void (async () => {
        try {
            const token = await getCloudToken();
            if (!token) return;
            const sessionId = getCloudSessionId();
            await fetch(cloudUrl(ENDPOINT), {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    kind,
                    ...(extra.detail ? { detail: firstLine(extra.detail) } : {}),
                    ...(extra.provider ? { provider: extra.provider } : {}),
                    ...(extra.model ? { model: extra.model } : {}),
                    ...(sessionId ? { sessionId } : {}),
                }),
                keepalive: true,
            });
        } catch {
            /* telemetry only */
        }
    })();
}

function firstLine(s: string): string {
    return s.split('\n')[0]!.slice(0, 240);
}

/** An error message that names the hosted voice path, so a cloud TTS failure
 *  can be told from a device-voice one at the shared TTS error handler. */
export function isCloudTtsError(msg: string): boolean {
    return /TTS endpoint|aloud cloud TTS/i.test(msg);
}
