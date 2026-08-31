/**
 * Server-side TTS to MP3 bytes via Google Cloud TTS, OpenAI, or Azure AI
 * Speech. The route picks the provider from the resolved voice
 * (voice-catalog.resolveVoice) and calls the matching function here. Stateless:
 * the text transits only for the synth call, never persisted (privacy
 * invariant; logger.ts).
 *
 * Google and Azure voice names encode their language (en-US-Chirp3-HD-Achernar,
 * zh-CN-XiaochenNeural → languageCode en-US / zh-CN). Voice is per-request so
 * the client's picker can drive it.
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

function xmlEscape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/**
 * Azure's SSML body for a synthesis: the bare escaped text, wrapped in a
 * <prosody> rate when the session speed isn't 1.0 (Azure has no top-level
 * speakingRate knob; SSML is the only input shape it takes). This mirrors the
 * audition's 'plain' treatment (scripts/audition/sources.ts) — the richer
 * treatments (breaks, mstts styles) stay audition-only until one is chosen to
 * ship.
 *
 * Exported alongside billedChars because Azure's bill is NOT text.length
 * (learn.microsoft.com text-to-speech "Billable characters"):
 *   - everything inside <speak>…</speak> bills, including markup like the
 *     prosody tags and expanded XML escapes (&apos; is 6 chars), but NOT the
 *     <speak>/<voice> wrapper tags themselves;
 *   - each CJK character bills as TWO characters.
 * The route must gate and debit on THIS count, not the plain text length, or a
 * Chinese session under-bills by half.
 */
export function azureSsmlBody(text: string, rate: number, style?: string): { inner: string; billedChars: number } {
    const escaped = xmlEscape(text);
    // Azure reads a bare number as a multiplier of normal pace, but a
    // percentage as a RELATIVE CHANGE - rate="90%" means +90%, near-double
    // speed (verified 2026-08-31: 6.7s -> 3.6s). Google's SSML reads "90%" as
    // 90% OF normal, so porting its markup here shipped 2x-fast sessions.
    // Always the multiplier form; Azure's supported band is [0.5, 2].
    const paced =
        rate === 1 ? escaped : `<prosody rate="${Math.min(2, Math.max(0.5, rate)).toFixed(2)}">${escaped}</prosody>`;
    // A curated voice may carry an mstts speaking style (softvoice, empathetic);
    // express-as silently no-ops on a voice without it. The tags bill like any
    // other markup, hence wrapping BEFORE the count.
    const inner = style ? `<mstts:express-as style="${style}">${paced}</mstts:express-as>` : paced;
    // CJK ideographs, kana, and hangul bill double; count them once more on top
    // of the raw length. BMP ranges cover the zh/ja/ko text we'd actually send.
    const cjk = inner.match(/[\u3000-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF\uFF00-\uFFEF]/g)?.length ?? 0;
    return { inner, billedChars: inner.length + cjk };
}

/** Characters Azure will bill for `text` at `rate` — the number the meter and
 *  the up-front balance gate must use for an Azure voice. */
export function azureBilledChars(text: string, rate: number, style?: string): number {
    return azureSsmlBody(text, rate, style).billedChars;
}

/**
 * Synthesize `text` to MP3 bytes via Azure AI Speech. Azure takes SSML always
 * (content-type application/ssml+xml, raw audio back) and bakes the region into
 * the hostname. `voice` is an Azure ShortName (en-US-SaraNeural,
 * zh-CN-XiaochenNeural, en-US-Andrew_DragonHDLatestNeural). Throws on an
 * upstream error.
 */
export async function synthesizeWithAzure(
    text: string,
    voice: string,
    rate: number,
    apiKey: string,
    region: string,
    style?: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<Uint8Array> {
    const { inner } = azureSsmlBody(text, rate, style);
    const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
        `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${languageOf(voice)}">` +
        `<voice name="${voice}">${inner}</voice></speak>`;
    const res = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'content-type': 'application/ssml+xml',
            'x-microsoft-outputformat': 'audio-24khz-96kbitrate-mono-mp3',
            'user-agent': 'aloud-cloud-tts',
        },
        body: ssml,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Azure TTS ${res.status}: ${detail}`);
    }
    return new Uint8Array(await res.arrayBuffer());
}
