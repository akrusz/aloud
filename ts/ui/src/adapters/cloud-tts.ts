/**
 * Server-side TTS adapter — fetches a WAV from Flask's /api/voices/preview
 * and plays it via an HTMLAudioElement.
 *
 * Previous iterations used Web Audio (AudioContext + BufferSource), which
 * Firefox keeps re-suspending during the decode step. HTMLAudioElement is
 * a regular media element with browser-managed lifecycle — no manual
 * resume() dance, no suspension races. We swap to it here for stability.
 *
 * The server's `rate` query param already renders the WAV at the
 * requested wpm, so we don't need to mess with playbackRate.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../../src/platform/tts.js';
import { appUrl } from '../app-base.js';
import { getCloudSessionId } from '../cloud-session.js';

/**
 * The UI carries TTS rate as words-per-minute (≈160 neutral; see
 * SessionSetup.ttsRate). The aloud cloud contract (and Google Cloud TTS)
 * wants a multiplier (1.0 = neutral). Mirror BrowserTtsEngine's normalization
 * so all engines agree on "normal": treat a value >5 as WPM (÷160), else as an
 * already-relative multiplier. (Flask's GET path takes WPM directly, so this
 * only applies to the hosted POST body.)
 */
function wpmToMultiplier(rate: number): number {
    return rate > 5 ? rate / 160 : rate;
}

/**
 * Module-level synthesis cache: a request signature → its rendered audio blob.
 * Auditioning hosted voices replays the same short preview phrase over and over;
 * without this, every click re-hits the server, which re-synthesizes and (for
 * hosted voices) re-debits the signed-in user's credits. Caching the blob means
 * a repeat plays locally with no network call and no charge. Bounded FIFO so it
 * can't grow without limit; a Blob is immutable so one cached blob serves many
 * object-URL playbacks.
 */
const SYNTH_CACHE = new Map<string, Blob>();
const SYNTH_CACHE_MAX = 48;

function synthCacheKey(
    endpoint: string,
    voice: string,
    engine: string | undefined,
    text: string,
    rate: number | undefined
): string {
    return JSON.stringify({ endpoint, voice, engine: engine ?? '', text, rate: rate ?? null });
}

function synthCachePut(key: string, blob: Blob): void {
    // Evict the oldest entry once full (Map preserves insertion order).
    if (SYNTH_CACHE.size >= SYNTH_CACHE_MAX) {
        const oldest = SYNTH_CACHE.keys().next().value;
        if (oldest !== undefined) SYNTH_CACHE.delete(oldest);
    }
    SYNTH_CACHE.set(key, blob);
}

export interface CloudTtsEngineOptions {
    voice: string;
    engine?: string;
    endpointUrl?: string;
    fetchImpl?: typeof fetch;
    /**
     * Reports characters synthesized server-side, for session usage
     * tracking. Fires once per successful synthesis with the text length.
     * Browser-side TTS has no equivalent (no server compute, not counted).
     */
    onSynthesize?: (chars: number) => void;
    /**
     * POST a JSON body ({text, voice, rate}) instead of a GET with query
     * params, and attach a bearer token. Used to target the aloud cloud's
     * authed /v1/tts (vs Flask's open GET /api/voices/preview), and to keep
     * the meditation text out of URL query strings that intermediaries log.
     */
    usePost?: boolean;
    /** Supplies the bearer token when usePost is set. */
    authProvider?: () => Promise<string | null>;
    /**
     * Called once on a 401 to invalidate a stale token before a single retry
     * (the next authProvider() then re-signs-in). Without this, a cached token
     * that the server no longer accepts — expired, or minted under a previous
     * session secret — fails every hosted synthesis even though the LLM path
     * self-heals. Wire to clearCloudToken for the hosted engine.
     */
    onAuthError?: () => Promise<void>;
}

export class CloudTtsEngine implements TtsEngine {
    private readonly voiceId: string;
    private readonly engine: string | undefined;
    private readonly endpointUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly onSynthesize: ((chars: number) => void) | undefined;
    private readonly usePost: boolean;
    private readonly authProvider: (() => Promise<string | null>) | undefined;
    private readonly onAuthError: (() => Promise<void>) | undefined;

    private currentAudio: HTMLAudioElement | null = null;
    private currentUrl: string | null = null;
    private currentResolve: (() => void) | null = null;
    private currentAbort: AbortController | null = null;

    constructor(options: CloudTtsEngineOptions) {
        this.voiceId = options.voice;
        this.engine = options.engine;
        this.endpointUrl = options.endpointUrl ?? appUrl('/voices/preview');
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.onSynthesize = options.onSynthesize;
        this.usePost = options.usePost ?? false;
        this.authProvider = options.authProvider;
        this.onAuthError = options.onAuthError;
    }

    /** Build the fetch URL + init for one synthesis request. */
    private async buildRequest(
        text: string,
        options: TtsOptions | undefined,
        signal: AbortSignal
    ): Promise<{ url: string; init: RequestInit }> {
        if (this.usePost) {
            const headers: Record<string, string> = { 'content-type': 'application/json' };
            if (this.authProvider) {
                const token = await this.authProvider();
                if (token) headers['authorization'] = `Bearer ${token}`;
            }
            const body: Record<string, unknown> = { text };
            if (this.voiceId) body['voice'] = this.voiceId;
            if (options?.rate !== undefined) body['rate'] = wpmToMultiplier(options.rate);
            // Group in-session synthesis with the rest of the session for the cost
            // report; null outside a session (e.g. a Settings voice preview).
            const sessionId = getCloudSessionId();
            if (sessionId) body['sessionId'] = sessionId;
            return { url: this.endpointUrl, init: { method: 'POST', headers, body: JSON.stringify(body), signal } };
        }
        const params = new URLSearchParams({ voice: this.voiceId, text });
        if (this.engine) params.set('engine', this.engine);
        if (options?.rate !== undefined) params.set('rate', String(options.rate));
        return { url: `${this.endpointUrl}?${params.toString()}`, init: { signal } };
    }

    async speak(text: string, options?: TtsOptions): Promise<void> {
        if (!text.trim()) return;
        this.cancelSync();

        const abort = new AbortController();
        this.currentAbort = abort;

        const cacheKey = synthCacheKey(this.endpointUrl, this.voiceId, this.engine, text, options?.rate);
        let blob: Blob;
        const cached = SYNTH_CACHE.get(cacheKey);
        if (cached) {
            // Cache hit: replay locally. No network call, no re-synthesis, and
            // (deliberately) no onSynthesize — nothing was rendered server-side,
            // so it isn't billable and mustn't be counted.
            blob = cached;
        } else {
            try {
                let { url, init } = await this.buildRequest(text, options, abort.signal);
                let response = await this.fetchImpl(url, init);
                // Self-heal a stale token: clear it and re-sign-in once on a 401,
                // matching the LLM proxy. Otherwise hosted preview/playback fails
                // whenever the cached token is expired or server-secret-rotated.
                if (response.status === 401 && this.usePost && this.authProvider && this.onAuthError) {
                    await this.onAuthError();
                    ({ url, init } = await this.buildRequest(text, options, abort.signal));
                    response = await this.fetchImpl(url, init);
                }
                if (!response.ok) {
                    throw new Error(`Server TTS responded ${response.status}`);
                }
                blob = await response.blob();
                // Successful server synthesis — count the characters rendered.
                this.onSynthesize?.(text.length);
                synthCachePut(cacheKey, blob);
            } catch (err) {
                this.currentAbort = null;
                if ((err as Error).name === 'AbortError') return;
                throw err;
            }
        }
        if (abort.signal.aborted) return;

        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        // preload=auto so Firefox starts buffering before play(); reduces
        // any small lead-in gap and keeps playback stable end-to-end.
        audio.preload = 'auto';

        return new Promise<void>((resolve) => {
            const cleanup = () => {
                URL.revokeObjectURL(url);
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                    this.currentUrl = null;
                    this.currentAbort = null;
                }
                const r = this.currentResolve;
                this.currentResolve = null;
                if (r) r();
                else resolve();
            };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.onpause = () => {
                // Pause without ending means we were cancelled — finalize.
                if (audio.ended) return;
                cleanup();
            };
            this.currentAudio = audio;
            this.currentUrl = url;
            this.currentResolve = resolve;
            audio.play().catch(() => cleanup());
        });
    }

    cancel(): Promise<void> {
        this.cancelSync();
        return Promise.resolve();
    }

    async listVoices(): Promise<TtsVoice[]> {
        return [];
    }

    private cancelSync(): void {
        if (this.currentAbort) {
            this.currentAbort.abort();
            this.currentAbort = null;
        }
        if (this.currentAudio) {
            try {
                this.currentAudio.pause();
            } catch {
                // ignore
            }
            this.currentAudio.src = '';
            this.currentAudio = null;
        }
        if (this.currentUrl) {
            URL.revokeObjectURL(this.currentUrl);
            this.currentUrl = null;
        }
        if (this.currentResolve) {
            const r = this.currentResolve;
            this.currentResolve = null;
            r();
        }
    }
}
