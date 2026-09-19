/**
 * Is the local Whisper model ready to transcribe?
 *
 * The desktop shell downloads and loads the model in the background (first
 * launch, or after a size/language change), and until that lands every
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
    /** On disk, being read into memory. Seconds, not minutes. */
    | { state: 'loading' }
    /** Download or load failed; the shell keeps retrying with backoff. */
    | { state: 'failed' };

const POLL_MS = 1500;

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
        const res = await fetch(
            appUrl(
                `/stt/whisper/warm?model_size=${encodeURIComponent(size)}&lang=${encodeURIComponent(lang)}`
            )
        );
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
    const tick = async (): Promise<void> => {
        const status = await probeWhisper(size, lang);
        if (stopped) return;
        onStatus(status);
        if (status.state !== 'ready') timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
    };
}

/** The setup-page notice, or null when there's nothing to wait for. */
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
