/**
 * Server-side TTS adapter — fetches a WAV from the app backend's
 * /app/v1/voices/preview and plays it via an HTMLAudioElement.
 *
 * Previous iterations used Web Audio (AudioContext + BufferSource), which
 * Firefox keeps re-suspending during the decode step. HTMLAudioElement is
 * a regular media element with browser-managed lifecycle — no manual
 * resume() dance, no suspension races. We swap to it here for stability.
 *
 * Desktop (Tauri) is the exception: a macOS WKWebView registers a playing
 * HTMLAudioElement with the system Now Playing / MediaPlayer center, which
 * makes the OS pop an unexpected "access Apple Music and your media library"
 * consent dialog at first playback. A Web Audio AudioContext doesn't touch
 * that machinery, so on desktop we play through it instead (isTauri()). The
 * Firefox-suspension reason for HTMLAudioElement never applies there — a Tauri
 * webview is WebKit/WebView2/WebKitGTK, never Firefox.
 *
 * The server's `rate` query param already renders the WAV at the
 * requested wpm, so we don't need to mess with playbackRate.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../../src/platform/tts.js';
import { appUrl } from '../app-base.js';
import { getCloudSessionId } from '../cloud-session.js';
import { isTauri } from '../is-desktop.js';
import { withTimeout } from '../net-timeout.js';

// Stall guard: a synthesis request that never comes back (server accepted then
// hung) would leave speak()'s `await` pending forever, freezing the turn in the
// "Speaking…" state. One sentence's WAV renders in a second or two; this is the
// dead-server ceiling, not a normal-latency budget.
const TTS_REQUEST_TIMEOUT_MS = 45_000;

/**
 * The UI carries TTS rate as words-per-minute (≈160 neutral; see
 * SessionSetup.ttsRate). The aloud cloud contract (and Google Cloud TTS)
 * wants a multiplier (1.0 = neutral). Mirror BrowserTtsEngine's normalization
 * so all engines agree on "normal": treat a value >5 as WPM (÷160), else as an
 * already-relative multiplier. (The app backend's GET path takes WPM directly,
 * so this only applies to the hosted POST body.)
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

/**
 * In-flight synthesis requests, keyed like SYNTH_CACHE. prefetch() and the
 * eventual speak() of the same sentence share one network call (and one
 * credit charge) instead of racing two synthesis requests for it.
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
     * Reports characters synthesized server-side, for session usage
     * tracking. Fires once per successful synthesis with the text length.
     * Browser-side TTS has no equivalent (no server compute, not counted).
     */
    onSynthesize?: (chars: number) => void;
    /**
     * POST a JSON body ({text, voice, rate}) instead of a GET with query
     * params, and attach a bearer token. Used to target the aloud cloud's
     * authed /v1/tts (vs the app backend's open GET /app/v1/voices/preview),
     * and to keep the meditation text out of URL query strings that
     * intermediaries log.
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
            // Group in-session synthesis with the rest of the session for the cost
            // report; null outside a session (e.g. a Settings voice preview).
            const sessionId = getCloudSessionId();
            if (sessionId) body['sessionId'] = sessionId;
            return { url: this.endpointUrl, init: { method: 'POST', headers, body: JSON.stringify(body) } };
        }
        const params = new URLSearchParams({ voice: this.voiceId, text });
        if (this.engine) params.set('engine', this.engine);
        if (options?.rate !== undefined) params.set('rate', String(options.rate));
        return { url: `${this.endpointUrl}?${params.toString()}`, init: {} };
    }

    /**
     * Resolve audio for `text`: cached blob, shared in-flight request, or a
     * fresh fetch. The fetch is deliberately NOT tied to a speak()'s abort —
     * a short clip completing into the cache is more useful than a cancelled
     * request, and a prefetched sentence mustn't be killed by an unrelated
     * cancel(); speak() checks its own abort flag after awaiting instead.
     */
    private synthesize(text: string, options: TtsOptions | undefined, cacheKey: string): Promise<Blob> {
        const cached = SYNTH_CACHE.get(cacheKey);
        // Cache hit: replay locally. No network call, no re-synthesis, and
        // (deliberately) no onSynthesize — nothing was rendered server-side,
        // so it isn't billable and mustn't be counted.
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
            // Self-heal a stale token: clear it and re-sign-in once on a 401,
            // matching the LLM proxy. Otherwise hosted preview/playback fails
            // whenever the cached token is expired or server-secret-rotated.
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
                // Phrase as "endpoint <status>" (mirrors the Whisper
                // adapter's "Whisper endpoint 402: …") so the session
                // views' describeCloudError recognizes hosted billing/auth
                // failures and shows the apology / buy prompt instead of
                // swallowing them.
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
            // Successful server synthesis — count the characters rendered.
            // (Fires for prefetches too: the server did render, so it bills.)
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
     * Start synthesizing `text` without playing it. The sentence-chunked TTS
     * bridge calls this the moment a sentence lands from the LLM, so its
     * network round-trip + server synthesis runs concurrently with earlier
     * sentences' playback instead of starting only when its turn comes.
     * Errors are swallowed here: the eventual speak() of the same text joins
     * the in-flight request (or retries) and surfaces them.
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
        // preload=auto so Firefox starts buffering before play(); reduces
        // any small lead-in gap and keeps playback stable end-to-end.
        audio.preload = 'auto';
        // Report the moment audible playback begins (not when the blob
        // arrived), so callers can reveal text in step with the voice.
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
                // Pause without ending means we were cancelled — finalize.
                if (audio.ended) return;
                cleanup();
            };
            this.currentAudio = audio;
            this.currentUrl = url;
            this.currentResolve = resolve;
            audio.play().catch((err: unknown) => {
                // A cancel() mid-play rejects with AbortError — that's expected,
                // so finalize quietly. Any other rejection (notably the mobile
                // /iOS autoplay gate's NotAllowedError) means the audio never
                // actually played: reject instead of resolving as if it had, so
                // the voice preview can say why and in-session callers (which
                // already try/catch speak) aren't told a silent failure spoke.
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
     * Desktop playback path: decode the WAV and play it through a Web Audio
     * BufferSource. Mirrors the HTMLAudioElement path's contract — fires onStart
     * at audible start, resolves on natural end OR cancel (stop() → onended),
     * and shares currentResolve/currentAbort with cancelSync so a barge-in stops
     * it cleanly. No object URL is created, so there's nothing to revoke.
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
                        // Fires on natural end and on stop() (cancel). Finalize
                        // once; cancelSync detaches this handler so a barge-in
                        // resolves through its own currentResolve tail instead.
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
                    // BufferSource has no "playing" event; start latency is
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
            // Detach onended first so it doesn't double-finalize — the
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
