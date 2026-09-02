/**
 * Voice the fixed billing apology to a user who's out of credits (or paused).
 *
 * Metered hosted TTS 402s at a zero balance, precisely when we need to speak, so
 * we hit the free unmetered canned endpoint (server-owned strings, synthesized
 * once per voice and cached). Falls back to browser speechSynthesis on any
 * failure. Never throws: the voicing is garnish on top of the on-screen bubble.
 */

import { ensureCloudToken, clearCloudToken } from './cloud-auth.js';
import { cloudUrl } from './cloud-base.js';
import type { CannedReason } from './billing-messages.js';
import { playbackAudio } from './audio-unlock.js';

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

/** Self-heals a stale token once on 401, like the LLM/TTS proxies. Throws on
 *  non-OK so the caller falls back to the browser voice. */
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
        // The shared, gesture-primed element (audio-unlock.ts) - a fresh one is
        // blocked on Safari, and an apology nobody hears is no apology.
        const audio = playbackAudio();
        audio.src = url;
        const done = () => {
            audio.onended = null;
            audio.onerror = null;
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
        /* no speech synthesis: the on-screen bubble stands alone */
    }
}
