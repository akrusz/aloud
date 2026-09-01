/**
 * Server-side TTS - fetches a WAV from the app backend's /app/v1/voices/preview
 * and plays it via an HTMLAudioElement, whose browser-managed lifecycle avoids
 * the suspension races Firefox causes with Web Audio decode.
 *
 * Desktop (Tauri) is the exception: a macOS WKWebView registers a playing
 * HTMLAudioElement with the system Now Playing center, which pops an
 * unexpected "access Apple Music and your media library" consent dialog on
 * first playback. Web Audio doesn't touch that machinery, so isTauri() plays
 * through it instead - and the Firefox reason never applies there (a Tauri
 * webview is WebKit/WebView2/WebKitGTK).
 *
 * The server's `rate` query param renders the WAV at the requested wpm, so
 * playbackRate stays untouched.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../../src/platform/tts.js';
import { appUrl } from '../app-base.js';
import { getCloudSessionId } from '../cloud-session.js';
import { isTauri } from '../is-desktop.js';
import { withTimeout } from '../net-timeout.js';

// Dead-server ceiling, not a latency budget: a synthesis request that hangs
// would leave speak() awaiting forever, freezing the turn in "Speaking…". A
// sentence's WAV renders in a second or two.
const TTS_REQUEST_TIMEOUT_MS = 45_000;

/** Preview-URL version - see buildRequest's GET branch. Bump when a curated
 *  voice's server-side sound changes (style/pace treatment, not new voices). */
const PREVIEW_CACHE_REV = '2';

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
     * GET with query params - targets the cloud's authed /v1/tts (vs the app
     * backend's open GET), and keeps meditation text out of URLs that
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
    // Desktop Web Audio playback (see header): the active source + the shared
    // context. Only one of currentAudio / currentSource is ever live at a time.
    private currentSource: AudioBufferSourceNode | null = null;
    private audioCtx: AudioContext | null = null;

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
        // Cache-buster for the public preview GET. A voice's server-side
        // treatment (style, pace) can change under an unchanged URL, and the
        // old long max-age left stale clips in webview/browser HTTP caches for
        // a day (the softvoice fix was inaudible until this bump). Bump when a
        // voice's sound changes server-side; the server's max-age is short now,
        // so this mostly exists to evict entries cached before the shortening.
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
            let { url, init } = await this.buildRequest(text, options);
            let response = await withTimeout(
                this.fetchImpl(url, init),
                TTS_REQUEST_TIMEOUT_MS,
                'aloud cloud TTS timed out.'
            );
            // Self-heal a stale token: clear and re-sign-in once on a 401,
            // matching the LLM proxy.
            if (response.status === 401 && this.usePost && this.authProvider && this.onAuthError) {
                await this.onAuthError();
                ({ url, init } = await this.buildRequest(text, options));
                response = await withTimeout(
                    this.fetchImpl(url, init),
                    TTS_REQUEST_TIMEOUT_MS,
                    'aloud cloud TTS timed out.'
                );
            }
            if (!response.ok) {
                // Phrase as "endpoint <status>", mirroring the Whisper adapter,
                // so the session views' describeCloudError recognizes hosted
                // billing/auth failures and shows the apology / buy prompt.
                const detail = await response.text().catch(() => '');
                throw new Error(
                    `TTS endpoint ${response.status}${detail ? `: ${detail}` : ''}`
                );
            }
            const blob = await withTimeout(
                response.blob(),
                TTS_REQUEST_TIMEOUT_MS,
                'aloud cloud TTS timed out.'
            );
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
     * calls this the moment a sentence lands from the LLM, so its round-trip
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

        // Desktop: play through Web Audio so the OS never sees a media element
        // (avoids the macOS "Apple Music / media library" consent prompt).
        if (isTauri()) return this.playViaWebAudio(blob, abort, options?.onStart);

        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        // preload=auto so Firefox buffers before play(), trimming the lead-in gap.
        audio.preload = 'auto';
        // Report when audible playback begins (not when the blob arrived), so
        // callers can reveal text in step with the voice.
        const onStart = options?.onStart;
        if (onStart) {
            audio.onplaying = () => {
                audio.onplaying = null;
                onStart();
            };
        }

        return new Promise<void>((resolve, reject) => {
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
                URL.revokeObjectURL(url);
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                    this.currentUrl = null;
                    this.currentAbort = null;
                }
                this.currentResolve = null;
                reject(err instanceof Error ? err : new Error(String(err)));
            });
        });
    }

    /** Lazily create (and reuse) the playback AudioContext. */
    private ensureAudioContext(): AudioContext {
        if (!this.audioCtx) {
            const Ctor =
                (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
                (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
                    .webkitAudioContext;
            if (!Ctor) throw new Error('Web Audio is unavailable');
            this.audioCtx = new Ctor();
        }
        return this.audioCtx;
    }

    /**
     * Desktop playback: decode the WAV through a Web Audio BufferSource. Same
     * contract as the HTMLAudioElement path - onStart at audible start, resolves
     * on natural end OR cancel, shares currentResolve/currentAbort with
     * cancelSync so a barge-in stops it cleanly. No object URL to revoke.
     */
    private playViaWebAudio(
        blob: Blob,
        abort: AbortController,
        onStart: (() => void) | undefined
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            void (async () => {
                try {
                    const ctx = this.ensureAudioContext();
                    if (ctx.state === 'suspended') await ctx.resume();
                    const data = await blob.arrayBuffer();
                    if (abort.signal.aborted) return resolve();
                    const buffer = await ctx.decodeAudioData(data);
                    if (abort.signal.aborted) return resolve();

                    const source = ctx.createBufferSource();
                    source.buffer = buffer;
                    source.connect(ctx.destination);
                    source.onended = () => {
                        // Fires on natural end and on stop(). cancelSync detaches
                        // this handler so a barge-in resolves through its own
                        // currentResolve tail instead.
                        if (this.currentSource === source) {
                            this.currentSource = null;
                            this.currentAbort = null;
                        }
                        const r = this.currentResolve;
                        this.currentResolve = null;
                        if (r) r();
                        else resolve();
                    };
                    this.currentSource = source;
                    this.currentResolve = resolve;
                    source.start();
                    // BufferSource has no "playing" event, and start latency is
                    // sub-frame, so report audible start right after start().
                    onStart?.();
                } catch (err) {
                    if (this.currentSource === null) this.currentAbort = null;
                    this.currentResolve = null;
                    if (abort.signal.aborted) resolve();
                    else reject(err instanceof Error ? err : new Error(String(err)));
                }
            })();
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
        if (this.currentSource) {
            // Detach onended first so it can't double-finalize - the
            // currentResolve tail below resolves the pending speak() once.
            this.currentSource.onended = null;
            try {
                this.currentSource.stop();
            } catch {
                // ignore (already stopped / never started)
            }
            this.currentSource = null;
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
