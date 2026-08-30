/**
 * Server-side TTS to MP3 bytes via Google Cloud TTS or OpenAI. The route picks
 * the provider from the resolved voice (voice-catalog.resolveVoice) and calls
 * the matching function here. Stateless: the text transits only for the synth
 * call, never persisted (privacy invariant; logger.ts).
 *
 * Google voice names encode their language (en-US-Chirp3-HD-Achernar →
 * languageCode en-US). Voice is per-request so the client's picker can drive it.
 */

const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

/** Instruction-steerable OpenAI TTS model (meditation-pal-b7i). Billed by audio
 *  output, ~$0.015/min; ~$19/1M chars at real delivery pace (reconciled - see
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
    // `rate` is a multiplier (1.0 = normal); client converts WPM→multiplier.
    // Clamp to Google's sync-synthesis range [0.25, 4.0] so a stray value
    // can't 400 the request.
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

/** Calm facilitation register for the instruction-steered OpenAI model.
 *
 *  NOTE the comment here previously said `speed` can be ignored and the
 *  instruction is the reliable lever. Measured 2026-08-30, that is BACKWARDS:
 *  `speed` is precise and linear (0.7 -> +42% duration against a nominal +43%,
 *  0.5 -> +100% against +100%), while the instruction is erratic (+26% with a
 *  35% render-to-render spread, and an explicitly MORE spacious instruction
 *  produced a SHORTER clip than the plain one).
 *
 *  Which makes the pace word below a likely cause of meditation-pal-5yi1 rather
 *  than a fix for it: we send BOTH levers, and they compound - speed 0.7 alone
 *  gives +42%, speed 0.7 plus the instruction gives +66%. Left as-is here
 *  because changing delivery pace is a tuning decision with an audible effect
 *  on every hosted OpenAI session, not a comment fix. See 5yi1. */
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
 * Synthesize `text` to MP3 bytes via OpenAI audio/speech. Unlike Google's
 * base64-in-JSON shape, OpenAI returns raw audio as the response body, so we
 * read it straight off arrayBuffer(). `voice` is an OpenAI voice name (coral,
 * ash, sage, …). Throws on an upstream error.
 */
export async function synthesizeWithOpenAI(
    text: string,
    voice: string,
    rate: number,
    apiKey: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<Uint8Array> {
    // Same band as Google [0.25, 4.0]; gpt-4o-mini-tts may ignore it, which is
    // why pacing also rides in the instruction.
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
