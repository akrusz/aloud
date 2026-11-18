/**
 * Server-side TTS - fetches audio from the app backend's /app/v1/voices/preview
 * (or aloud cloud's /cloud/v1/tts) and plays it through the shared <audio>
 * element (audio-unlock.ts), on every platform.
 *
 * Never through an AudioContext. In a macOS WKWebView all same-rate contexts of
 * a page share one output pipe, and a stall of the page's audio thread leaves it
 * late for good, or past ~2.7 s silent for good, while the page still reports it
 * running (meditation-pal-wk4u, dev-docs/audio-output.md).
 *
 * The server's `rate` query param renders the WAV at the requested wpm, so
 * playbackRate stays untouched.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../../src/platform/tts.js';
import { appUrl } from '../app-base.js';
import { getCloudSessionId } from '../cloud-session.js';
import { playbackAudio } from '../audio-unlock.js';
import { withTimeout } from '../net-timeout.js';
import { sendWithNetworkRetry } from '../net-retry.js';

// Dead-server ceiling, not a latency budget: a synthesis request that hangs
// would leave speak() awaiting forever, freezing the turn in "Speaking…". A
// sentence's WAV renders in a second or two.
const TTS_REQUEST_TIMEOUT_MS = 45_000;

/** How long a hosted session's synthesis re-sends through a dropped connection
 *  (net-retry.ts; tts-picker createCloudAloudTts). Sentences prefetch in
 *  parallel but play in order, so one that is still retrying holds up the rest
 *  of the reply: long enough to ride out a cell handover, short enough that a
 *  dead patch costs a sentence, not the turn. */
export const CLOUD_TTS_RETRY_BUDGET_MS = 10_000;

/** Preview-URL version - see buildRequest's GET branch. Bump when a curated
 *  voice's server-side sound changes (style/pace treatment, not new voices). */
const PREVIEW_CACHE_REV = '3';

/**
 * The UI carries TTS rate as WPM (≈160 neutral; see SessionSetup.ttsRate); the
 * aloud cloud contract (and Google Cloud TTS) wants a multiplier (1.0 neutral).
 * Mirrors BrowserTtsEngine so all engines agree on "normal": >5 is WPM (÷160),
 * otherwise already relative. Only the hosted POST body needs this - the app
 * backend's GET path takes WPM directly.
 */
function wpmToMultiplier(rate: number): number {
    return rate > 5 ? rate / 160 : rate;
}

/**
 * Request signature → rendered audio blob. Auditioning voices replays the same
 * preview phrase repeatedly; without this every click re-synthesizes server-side
 * and re-debits credits. Bounded FIFO; a Blob is immutable, so one cached blob
 * serves many object-URL playbacks.
 */
const SYNTH_CACHE = new Map<string, Blob>();
const SYNTH_CACHE_MAX = 48;

/**
 * In-flight requests, keyed like SYNTH_CACHE, so prefetch() and the eventual
 * speak() of the same sentence share one network call (and one credit charge).
 */
const SYNTH_INFLIGHT = new Map<string, Promise<Blob>>();

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
     * Characters synthesized server-side, for session usage tracking. Fires once
     * per successful synthesis. Browser TTS has no equivalent (no server
     * compute, not counted).
     */
    onSynthesize?: (chars: number) => void;
    /**
     * POST a JSON body ({text, voice, rate}) with a bearer token instead of a
     * GET with query params - targets the cloud's authed /cloud/v1/tts (vs the
     * app backend's open GET), and keeps meditation text out of URLs that
     * intermediaries log.
     */
    usePost?: boolean;
    /** Supplies the bearer token when usePost is set. */
    authProvider?: () => Promise<string | null>;
    /**
     * Called once on a 401 to invalidate a stale token before a single retry.
     * Without it a token the server no longer accepts (expired, or minted under
     * a previous session secret) fails every hosted synthesis, even though the
     * LLM path self-heals. Wire to clearCloudToken for the hosted engine.
     */
    onAuthError?: () => Promise<void>;
    /** GET only: the language the public hosted preview should speak its
     *  fixed line in (the server owns the text, so this is all that can be
     *  asked for). */
    previewLang?: string;
    /** How long a synthesis re-sends through a dropped connection
     *  (net-retry.ts). Default 0 (no retry): the app backend is on loopback
     *  (desktop) or a preview nobody is waiting on mid-sit. */
    networkRetryMs?: number;
}

/** Drop every listener this engine put on the shared playback element, so a
 *  finished (or cancelled) utterance's events can't reach the next one. */
function detachPlaybackHandlers(audio: HTMLAudioElement): void {
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.onpause = null;
}

/** The engine whose utterance is on the shared element. Several engines play
 *  through it (the session's, a voice preview, a setup line in a local voice),
 *  and giving it a new src fires no pause, so the engine it is taken from must
 *  be finalized by the taker or its speak() never resolves. */
let elementOwner: CloudTtsEngine | null = null;

export class CloudTtsEngine implements TtsEngine {
    private readonly voiceId: string;
    private readonly engine: string | undefined;
    private readonly endpointUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly onSynthesize: ((chars: number) => void) | undefined;
    private readonly usePost: boolean;
    private readonly authProvider: (() => Promise<string | null>) | undefined;
    private readonly onAuthError: (() => Promise<void>) | undefined;
    private readonly networkRetryMs: number;
    private readonly previewLang: string | undefined;

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
        this.networkRetryMs = options.networkRetryMs ?? 0;
        this.previewLang = options.previewLang;
    }

    private async buildRequest(
        text: string,
        options: TtsOptions | undefined
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
            // Group with the rest of the session for the cost report; null
            // outside one (e.g. a Settings voice preview).
            const sessionId = getCloudSessionId();
            if (sessionId) body['sessionId'] = sessionId;
            return { url: this.endpointUrl, init: { method: 'POST', headers, body: JSON.stringify(body) } };
        }
        const params = new URLSearchParams({ voice: this.voiceId, text });
        if (this.engine) params.set('engine', this.engine);
        if (options?.rate !== undefined) params.set('rate', String(options.rate));
        if (this.previewLang) params.set('lang', this.previewLang);
        // Cache-buster for the public preview GET: a voice's server-side
        // treatment (style, pace) can change under an unchanged URL, leaving
        // stale clips in webview/browser HTTP caches. The server's max-age is
        // short, so this mostly evicts entries cached under an older,
        // day-long one (see PREVIEW_CACHE_REV).
        params.set('r', PREVIEW_CACHE_REV);
        return { url: `${this.endpointUrl}?${params.toString()}`, init: {} };
    }

    /**
     * Resolve audio for `text`: cached blob, shared in-flight request, or a
     * fresh fetch. Deliberately NOT tied to a speak()'s abort - a short clip
     * completing into the cache beats a cancelled request, and a prefetched
     * sentence mustn't die on an unrelated cancel(). speak() checks its own
     * abort flag after awaiting instead.
     */
    private synthesize(text: string, options: TtsOptions | undefined, cacheKey: string): Promise<Blob> {
        const cached = SYNTH_CACHE.get(cacheKey);
        // Cache hit: replay locally, and deliberately no onSynthesize - nothing
        // was rendered server-side, so it isn't billable.
        if (cached) return Promise.resolve(cached);
        const inflight = SYNTH_INFLIGHT.get(cacheKey);
        if (inflight) return inflight;
        const request = (async (): Promise<Blob> => {
            const timed = <T>(p: Promise<T>): Promise<T> =>
                withTimeout(p, TTS_REQUEST_TIMEOUT_MS, 'aloud cloud TTS timed out.');
            const send = async (): Promise<Response> => {
                const { url, init } = await this.buildRequest(text, options);
                return timed(this.fetchImpl(url, init));
            };
            const response = await sendWithNetworkRetry(
                async () => {
                    let res = await send();
                    // Self-heal a stale token: one retry on a 401 (see onAuthError).
                    if (res.status === 401 && this.usePost && this.authProvider && this.onAuthError) {
                        await this.onAuthError();
                        res = await send();
                    }
                    return res;
                },
                {
                    budgetMs: this.networkRetryMs,
                    onRetry: (n, why) => console.warn(`[cloud-tts] retry ${n} after ${why}`),
                }
            );
            if (!response.ok) {
                // Phrase as "endpoint <status>", mirroring the Whisper adapter,
                // so the session views' describeCloudError recognizes hosted
                // billing/auth failures and shows the apology / buy prompt.
                const detail = await response.text().catch(() => '');
                throw new Error(
                    `TTS endpoint ${response.status}${detail ? `: ${detail}` : ''}`
                );
            }
            const blob = await timed(response.blob());
            // Count the characters rendered. Fires for prefetches too: the
            // server did render, so it bills.
            this.onSynthesize?.(text.length);
            synthCachePut(cacheKey, blob);
            return blob;
        })().finally(() => {
            SYNTH_INFLIGHT.delete(cacheKey);
        });
        SYNTH_INFLIGHT.set(cacheKey, request);
        return request;
    }

    /**
     * Start synthesizing `text` without playing it. The sentence-chunked bridge
     * calls this the moment a sentence arrives from the LLM, so its round-trip
     * overlaps earlier sentences' playback instead of starting at its turn.
     * Errors are swallowed: the eventual speak() joins the in-flight request
     * (or retries) and surfaces them.
     */
    prefetch(text: string, options?: TtsOptions): void {
        if (!text.trim()) return;
        const cacheKey = synthCacheKey(this.endpointUrl, this.voiceId, this.engine, text, options?.rate);
        this.synthesize(text, options, cacheKey).catch(() => {});
    }

    async speak(text: string, options?: TtsOptions): Promise<void> {
        if (!text.trim()) return;
        this.cancelSync();

        const abort = new AbortController();
        this.currentAbort = abort;

        const cacheKey = synthCacheKey(this.endpointUrl, this.voiceId, this.engine, text, options?.rate);
        let blob: Blob;
        try {
            blob = await this.synthesize(text, options, cacheKey);
        } catch (err) {
            if (this.currentAbort === abort) this.currentAbort = null;
            throw err;
        }
        if (abort.signal.aborted) return;

        const url = URL.createObjectURL(blob);
        // The ONE shared element, primed by the Begin click - a per-utterance
        // `new Audio()` is unprivileged under Safari's per-element autoplay gate
        // and plays nothing (see audio-unlock.ts).
        const audio = playbackAudio();
        if (elementOwner && elementOwner !== this) elementOwner.cancelSync();
        elementOwner = this;
        audio.src = url;
        // Report when audible playback begins (not when the blob arrived), so
        // callers can reveal text in step with the voice.
        const onStart = options?.onStart;
        audio.onplaying = onStart
            ? () => {
                  audio.onplaying = null;
                  onStart();
              }
            : null;

        return new Promise<void>((resolve, reject) => {
            // A cancel (cancelSync) settles this utterance itself. The play() it
            // cut short rejects later, often after the next utterance has put
            // its handlers on the shared element, and must leave them alone.
            const current = (): boolean => this.currentResolve === resolve;
            const release = (): void => {
                URL.revokeObjectURL(url);
                if (!current()) return;
                detachPlaybackHandlers(audio);
                this.currentAudio = null;
                this.currentUrl = null;
                this.currentAbort = null;
                this.currentResolve = null;
                if (elementOwner === this) elementOwner = null;
            };
            const cleanup = (): void => {
                release();
                resolve();
            };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.onpause = () => {
                // Pause without ending means we were cancelled - finalize.
                if (audio.ended) return;
                cleanup();
            };
            this.currentAudio = audio;
            this.currentUrl = url;
            this.currentResolve = resolve;
            audio.play().catch((err: unknown) => {
                // A cancel() mid-play rejects with AbortError - expected,
                // finalize quietly. Anything else (notably the iOS autoplay
                // gate's NotAllowedError) means no audio played: reject rather
                // than resolve as if it had, so the preview can say why.
                if ((err as { name?: string })?.name === 'AbortError') {
                    cleanup();
                    return;
                }
                release();
                reject(err instanceof Error ? err : new Error(String(err)));
            });
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
            // Detach FIRST: the element is shared, so a pause event still queued
            // when the next speak() installs its handlers would finalize that
            // utterance before it made a sound.
            detachPlaybackHandlers(this.currentAudio);
            try {
                this.currentAudio.pause();
            } catch {
                // ignore
            }
            this.currentAudio.removeAttribute('src');
            this.currentAudio = null;
            if (elementOwner === this) elementOwner = null;
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
