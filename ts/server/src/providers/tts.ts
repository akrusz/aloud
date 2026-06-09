/**
 * Server-side TTS: synthesize speech to MP3 bytes via a hosted provider
 * (Google Cloud TTS or OpenAI). Returns MP3 bytes. Stateless — the text
 * transits only for the synthesis call and is never persisted (privacy
 * invariant; see logger.ts). The route picks the provider from the resolved
 * voice (voice-catalog.resolveVoice) and calls the matching function here.
 *
 * Google voice names encode their language (e.g. en-US-Chirp3-HD-Achernar →
 * languageCode en-US). Chirp3-HD is Google's high-naturalness tier; the voice
 * is configurable per request so the client's voice picker can drive it.
 */

const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

/** OpenAI's high-quality, instruction-steerable TTS model (meditation-pal-b7i).
 *  Billed by audio output, ~$0.015/min; ~$22/1M chars at a slow pace (priced in
 *  pricing/providers.OPENAI_TTS_USD_PER_CHAR). */
const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';

/** languageCode is the first two hyphen segments of the voice name. */
function languageOf(voice: string): string {
    const parts = voice.split('-');
    return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US';
}

/** Synthesize `text` to MP3 bytes. Throws on an upstream error. */
export async function synthesizeWithGoogle(
    text: string,
    voice: string,
    rate: number,
    apiKey: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<Uint8Array> {
    // `rate` is a multiplier (1.0 = normal); the client converts WPM→multiplier.
    // Clamp to Google's accepted sync-synthesis range [0.25, 4.0] so a stray
    // value can't 400 the request.
    const speakingRate = Math.min(4, Math.max(0.25, rate));
    const res = await fetchImpl(`${GOOGLE_TTS_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            input: { text },
            voice: { languageCode: languageOf(voice), name: voice },
            audioConfig: { audioEncoding: 'MP3', speakingRate },
        }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Google TTS ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { audioContent?: string };
    if (!data.audioContent) throw new Error('Google TTS returned no audioContent');
    return Uint8Array.from(Buffer.from(data.audioContent, 'base64'));
}

/** A calm facilitation register for the instruction-steered OpenAI model. The
 *  `rate` multiplier (1.0 = normal) folds in as a pace word because
 *  gpt-4o-mini-tts can ignore the numeric `speed` param — the instruction is
 *  the reliable lever — while `speed` is still sent (harmless if honored). */
function meditationInstruction(rate: number): string {
    const pace =
        rate < 0.95 ? ' Speak slowly, leaving generous space between phrases.'
        : rate > 1.1 ? ' Keep a gentle but slightly brisker pace.'
        : '';
    return (
        'Speak in a warm, calm, unhurried voice, soft and grounded, as a meditation ' +
        'facilitator gently guiding a listener.' + pace
    );
}

/**
 * Synthesize `text` to MP3 bytes via OpenAI's audio/speech (gpt-4o-mini-tts).
 * Unlike Google's base64-in-JSON shape, OpenAI streams the audio as the raw
 * response body, so we read it straight off arrayBuffer(). `voice` is an OpenAI
 * voice name (coral, ash, sage, …). Throws on an upstream error.
 */
export async function synthesizeWithOpenAI(
    text: string,
    voice: string,
    rate: number,
    apiKey: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<Uint8Array> {
    // Same accepted band as Google [0.25, 4.0]; gpt-4o-mini-tts may ignore it,
    // which is why pacing also rides in the instruction.
    const speed = Math.min(4, Math.max(0.25, rate));
    const res = await fetchImpl(OPENAI_TTS_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: OPENAI_TTS_MODEL,
            input: text,
            voice,
            response_format: 'mp3',
            speed,
            instructions: meditationInstruction(rate),
        }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`OpenAI TTS ${res.status}: ${detail}`);
    }
    return new Uint8Array(await res.arrayBuffer());
}
