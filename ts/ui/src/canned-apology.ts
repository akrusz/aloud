/**
 * Voice the fixed billing apology to a user who's out of credits (or paused).
 *
 * The normal hosted TTS (/v1/tts) 402s at a zero balance — exactly when we most
 * need to speak. So we hit the server's free, unmetered /v1/tts/canned, which
 * synthesizes one of a few server-owned constants once per voice and serves the
 * cached audio. If that fails for any reason (offline, server hiccup, a
 * browser-side voice choice), we fall back to the browser's speechSynthesis so
 * the user still hears the message. Never throws — voicing the apology is
 * best-effort garnish on top of the on-screen bubble.
 */

import { ensureCloudToken, clearCloudToken } from './cloud-auth.js';
import { cloudUrl } from './cloud-base.js';
import type { CannedReason } from './billing-messages.js';

const CANNED_ENDPOINT = '/tts/canned';

export async function playCannedApology(
    reason: CannedReason,
    voice: string | null,
    fallbackText: string
): Promise<void> {
    try {
        const blob = await fetchCanned(reason, voice);
        await playBlob(blob);
    } catch {
        speakViaBrowser(fallbackText);
    }
}

/** POST to the free canned endpoint with bearer auth; self-heal a stale token
 *  once on 401, mirroring the LLM/TTS proxies. Throws on any non-OK response so
 *  the caller falls back to the browser voice. */
async function fetchCanned(reason: CannedReason, voice: string | null): Promise<Blob> {
    const send = async (token: string): Promise<Response> =>
        fetch(cloudUrl(CANNED_ENDPOINT), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ reason, ...(voice ? { voice } : {}) }),
        });

    let res = await send(await ensureCloudToken());
    if (res.status === 401) {
        await clearCloudToken();
        res = await send(await ensureCloudToken());
    }
    if (!res.ok) throw new Error(`canned tts ${res.status}`);
    return res.blob();
}

function playBlob(blob: Blob): Promise<void> {
    return new Promise<void>((resolve) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const done = () => {
            URL.revokeObjectURL(url);
            resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
    });
}

function speakViaBrowser(text: string): void {
    try {
        const synth = globalThis.speechSynthesis;
        if (!synth) return;
        synth.cancel();
        synth.speak(new SpeechSynthesisUtterance(text));
    } catch {
        /* no speech synthesis available — the on-screen bubble stands alone */
    }
}
