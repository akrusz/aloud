/**
 * Server-side STT via an OpenAI-compatible Whisper endpoint. Backend is
 * config-selected (base URL + model + key), not hardcoded: OpenAI
 * (gpt-4o-transcribe) by default, Groq speaks the same multipart
 * `audio/transcriptions` API. See config.ts `resolveSttConfig`.
 * The client POSTs raw mono Float32 samples; we wrap them in a WAV container
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
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
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

/**
 * Transcribe mono Float32 PCM via the configured backend. Throws on upstream
 * error. `language` is an optional ISO-639-1 hint (the session language,
 * meditation-pal-c3a0.2): these endpoints auto-detect without it, but a hint
 * removes the misfire where a soft zh utterance comes back transliterated or
 * translated.
 */
export async function transcribeWhisper(
    samples: Float32Array,
    sampleRate: number,
    backend: SttBackend,
    language?: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<string> {
    const wav = encodeWav(samples, sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', backend.model);
    form.append('response_format', 'json');
    if (language) form.append('language', language);

    const res = await fetchImpl(backend.baseUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${backend.apiKey}` },
        body: form,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`STT ${backend.provider} ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
}
