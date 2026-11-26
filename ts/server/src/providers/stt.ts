/**
 * Server-side STT via an OpenAI-compatible Whisper endpoint. Backend is
 * config-selected (base URL + model + key), not hardcoded: OpenAI
 * (gpt-transcribe) by default, Groq speaks the same multipart
 * `audio/transcriptions` API. See config.ts `resolveSttConfig`.
 * The route hands over mono Float32 samples; we wrap them in a WAV container
 * (these endpoints want a file upload) and forward. Stateless: audio is never
 * persisted (privacy invariant; logger.ts, meditation-pal-dn2).
 */

/** A config-selected OpenAI-compatible Whisper backend. */
export interface SttBackend {
    /** Short label for logs / debit tags, e.g. 'openai'. */
    provider: string;
    apiKey: string;
    /** Full transcription endpoint URL. */
    baseUrl: string;
    model: string;
}

/** Widen Int16 PCM to the Float32 [-1, 1] the rest of the pipeline speaks.
 *  (encodeWav narrows it right back; the round trip is within 1 LSB.) */
export function int16ToFloat32(samples: Int16Array): Float32Array {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / 0x8000;
    return out;
}

/** Encode mono Float32 PCM in [-1, 1] as a 16-bit little-endian WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
    const dataBytes = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);
    const writeStr = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]!));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
    }
    return new Uint8Array(buf);
}

/** An upstream answer with an error status: metered as unbilled, since
 *  OpenRouter's zero-completion insurance covers it and OpenAI made no
 *  transcription. Any other failure might have been billed (stt-hybrid.ts
 *  legIsBilled). */
export class SttUpstreamError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export interface SttResult {
    text: string;
    /** The audio seconds the provider says it billed, where it says (OpenAI's
     *  duration-billed models: `usage.seconds`). Only a cross-check on our own
     *  meter - the charge is fixed before the call (routes/stt.ts). */
    reportedSeconds?: number;
}

export interface SttHints {
    /** ISO-639-1 code of the expected speech (the session language,
     *  meditation-pal-c3a0.2). These endpoints auto-detect without it, but a
     *  hint removes the misfire where a soft zh utterance comes back
     *  transliterated or translated. */
    language?: string | undefined;
    /** Sent as the multipart `prompt`: the setup vocabulary, built on the
     *  server, or the turn's transcript up to this clip, which the caller sends
     *  bounded and cleaned by routes/stt.ts sttPrior. It biases spelling and
     *  word choice and lets a clip continue the turn; it is not an
     *  instruction. Meditation content either way: never log it. */
    prompt?: string | undefined;
}

/** Models that refuse a `prompt` (OpenAI's API reference), so a backend pinned
 *  to one through STT_MODEL still transcribes, just unprompted. Every model
 *  the stock backends allowlist takes it (gpt-transcribe, gpt-4o-transcribe,
 *  Groq's Whisper). */
const PROMPTLESS_MODELS = new Set(['gpt-4o-transcribe-diarize']);

/**
 * The hosted STT models served through OpenRouter's transcription API, keyed
 * by the id a client sends as `?model=`. Each is pinned to the one host the
 * privacy policy names for it (docs/privacy/index.html), with fallbacks off:
 * a host that drops out fails the call instead of moving the audio somewhere
 * the policy doesn't say. A Parakeet request's short clip, failure or stall
 * does go to OpenAI's gpt-transcribe (stt-hybrid.ts), so the policy has to
 * name OpenAI for a Parakeet pick too. `zdr` adds OpenRouter's
 * zero-data-retention filter, which the policy's "keeps none of it" rests on,
 * so that call fails closed if the host ever stops qualifying. Neither model takes keyterms through
 * OpenRouter (400, probed 2026-11-15), so setup listening goes unprompted here.
 */
export const OPENROUTER_STT_MODELS: Readonly<Record<string, { host: string; zdr: boolean }>> = {
    // Moondream's post-trained Parakeet TDT 0.6B v3. European languages only:
    // the client never offers it in a zh session.
    'moondream/parakeet-ultra': { host: 'primeintellect', zdr: true },
    // xAI's own endpoint. Passes data_collection: deny, but has no ZDR
    // offering (zdr:true finds no endpoint).
    'x-ai/grok-stt-2.0': { host: 'xai', zdr: false },
};

const OPENROUTER_STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

/** Transcribe mono Float32 PCM with one of OPENROUTER_STT_MODELS. Throws on an
 *  unknown model or an upstream error. */
export async function transcribeOpenRouter(
    samples: Float32Array,
    sampleRate: number,
    apiKey: string,
    model: string,
    hints: Pick<SttHints, 'language'> = {},
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<SttResult> {
    const route = OPENROUTER_STT_MODELS[model];
    if (!route) throw new Error(`STT openrouter: unknown model ${model}`);
    const wav = encodeWav(samples, sampleRate);
    const res = await fetchImpl(OPENROUTER_STT_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            model,
            input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' },
            ...(hints.language ? { language: hints.language } : {}),
            provider: {
                only: [route.host],
                allow_fallbacks: false,
                data_collection: 'deny',
                ...(route.zdr ? { zdr: true } : {}),
            },
        }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new SttUpstreamError(`STT openrouter ${res.status}: ${detail}`, res.status);
    }
    const data = (await res.json()) as { text?: string; usage?: { seconds?: unknown } };
    const reported = data.usage?.seconds;
    return {
        text: (data.text ?? '').trim(),
        ...(typeof reported === 'number' && Number.isFinite(reported) ? { reportedSeconds: reported } : {}),
    };
}

/** Transcribe mono Float32 PCM via the configured backend. Throws on upstream
 *  error. */
export async function transcribeWhisper(
    samples: Float32Array,
    sampleRate: number,
    backend: SttBackend,
    hints: SttHints = {},
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<SttResult> {
    const wav = encodeWav(samples, sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', backend.model);
    form.append('response_format', 'json');
    if (hints.language) form.append('language', hints.language);
    if (hints.prompt && !PROMPTLESS_MODELS.has(backend.model)) form.append('prompt', hints.prompt);

    const res = await fetchImpl(backend.baseUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${backend.apiKey}` },
        body: form,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new SttUpstreamError(`STT ${backend.provider} ${res.status}: ${detail}`, res.status);
    }
    const data = (await res.json()) as { text?: string; usage?: { type?: string; seconds?: unknown } };
    const reported = data.usage?.type === 'duration' ? data.usage.seconds : undefined;
    return {
        text: (data.text ?? '').trim(),
        ...(typeof reported === 'number' && Number.isFinite(reported) ? { reportedSeconds: reported } : {}),
    };
}
