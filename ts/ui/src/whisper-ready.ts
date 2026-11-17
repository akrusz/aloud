/**
 * Is the local Whisper model ready to transcribe?
 *
 * The desktop shell downloads and loads the model in the background (first
 * launch, or after a size/language change), and until that finishes every
 * utterance 503s. Setup holds Begin on this rather than let a session start
 * deaf. The warm probe doubles as the kick: naming the model makes the shell
 * start loading it now.
 */

import { appUrl } from './app-base.js';
import { t } from './i18n.js';

export type WhisperStatus =
    /** Loaded - or nothing we can reach says otherwise. */
    | { state: 'ready' }
    | { state: 'downloading'; percent: number | null }
    /** On disk, being read into memory: about a third of a second for base
     *  (measured 2026-11-17), so it is `brief`, and not worth a notice, until
     *  it has gone on for LOADING_NOTICE_AFTER_MS. */
    | { state: 'loading'; brief?: true }
    /** Download or load failed; the shell keeps retrying with backoff. */
    | { state: 'failed' };

const POLL_MS = 1500;
/** While the model is only loading, so the wait ends about when the load does
 *  and not a poll later: nothing listens on the setup screen until it has. */
const LOADING_POLL_MS = 250;
const LOADING_NOTICE_AFTER_MS = 1000;

/** The shell's warm probe. Naming a model makes the shell start loading it;
 *  with no size it only proves the local Whisper route is wired. */
export function whisperWarmUrl(size: string | null | undefined, lang: string): string {
    const query = size
        ? `?model_size=${encodeURIComponent(size)}&lang=${encodeURIComponent(lang)}`
        : '';
    return appUrl(`/stt/whisper/warm${query}`);
}

interface WarmBody {
    ready?: boolean;
    error?: string | null;
    progress?: { done: number; total: number | null } | null;
}

export function parseWarmBody(body: WarmBody): WhisperStatus {
    if (body.ready !== false) return { state: 'ready' };
    if (body.progress) {
        const { done, total } = body.progress;
        return {
            state: 'downloading',
            percent: total ? Math.min(99, Math.floor((done * 100) / total)) : null,
        };
    }
    return body.error ? { state: 'failed' } : { state: 'loading' };
}

/**
 * Deliberately optimistic, like probeMic: an unreachable or unparseable probe
 * reads as ready, because a false "not ready" would block a user whose model
 * is fine. The session's own 503 handling is still behind it.
 */
async function probeWhisper(size: string, lang: string): Promise<WhisperStatus> {
    try {
        const res = await fetch(whisperWarmUrl(size, lang));
        if (!res.ok) return { state: 'ready' };
        return parseWarmBody((await res.json()) as WarmBody);
    } catch {
        return { state: 'ready' };
    }
}

/** Poll until ready, reporting each status. Returns the stop function. */
export function watchWhisperReady(
    size: string,
    lang: string,
    onStatus: (status: WhisperStatus) => void
): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let loadingSince: number | null = null;
    const tick = async (): Promise<void> => {
        const probed = await probeWhisper(size, lang);
        if (stopped) return;
        const status = settleLoading(probed, loadingSince, Date.now());
        loadingSince = status.state === 'loading' ? (loadingSince ?? Date.now()) : null;
        onStatus(status);
        if (status.state !== 'ready') {
            timer = setTimeout(() => void tick(), status.state === 'loading' ? LOADING_POLL_MS : POLL_MS);
        }
    };
    void tick();
    return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
    };
}

/** A load marked `brief` until it has lasted long enough to mention. */
export function settleLoading(status: WhisperStatus, loadingSince: number | null, now: number): WhisperStatus {
    if (status.state !== 'loading') return status;
    return now - (loadingSince ?? now) < LOADING_NOTICE_AFTER_MS ? { state: 'loading', brief: true } : { state: 'loading' };
}

/** What the setup page shows while it waits: nothing for a brief load, which
 *  still holds Begin and the listener (describeWhisperWait). */
export function whisperNotice(status: WhisperStatus): string | null {
    return status.state === 'loading' && status.brief ? null : describeWhisperWait(status);
}

/** Why the model can't be used yet, in words, or null when it can. */
export function describeWhisperWait(status: WhisperStatus): string | null {
    switch (status.state) {
        case 'ready':
            return null;
        case 'downloading':
            return status.percent === null
                ? t('Downloading the speech model…')
                : t('Downloading the speech model… {percent}%', { percent: status.percent });
        case 'loading':
            return t('Loading the speech model…');
        case 'failed':
            return t("Couldn't download the speech model. Retrying - or switch Speech Recognition to aloud cloud.");
    }
}
