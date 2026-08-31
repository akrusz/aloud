/**
 * Audition-only TTS sources: the roster + synth call + cost model for every
 * engine we might curate a voice from, including ones the server cannot yet
 * bill. Nothing here is wired into a route on purpose - promoting a source is a
 * deliberate follow-up (src/providers/tts.ts + a TtsProvider union member + a
 * rate in pricing/providers.ts), and until that happens an audition-only
 * adapter must not be reachable from a metered path.
 *
 * THE POINT OF THE COST MODEL (meditation-pal-b7i). TTS providers bill one of
 * two ways, and for aloud they are not interchangeable:
 *
 *   'per-char'   - price scales with TEXT. Delivery pace is free.
 *   'per-second' - price scales with AUDIO DURATION. Speaking slowly costs more.
 *
 * aloud speaks slowly by design, so a duration-priced engine bills us well above
 * its headline "per 1M chars" figure, which is always quoted at conversational
 * pace. Measured against our own meditation sample at our own instruction:
 * Gemini 2.5 Flash TTS advertises as cheaper than Chirp3-HD and lands at
 * ~$43/1M chars; Gemini 3.1 Flash TTS lands at ~$78/1M. So the audition
 * runner measures the real audio duration of every clip (ffprobe) and reports a
 * PACE-ADJUSTED $/1M chars, which is the only number comparable across sources.
 * Where a provider reports its own usage (Gemini), we bill from that instead of
 * modelling it.
 */

import { synthesizeWithGoogle, synthesizeWithOpenAI } from '../../src/providers/tts.js';
import { googleTtsRateFor } from '../../src/pricing/providers.js';

const M = 1_000_000;

/** How a source charges. Drives whether pace inflates the effective rate. */
export type Billing = 'per-char' | 'per-second';

export interface AuditionVoice {
    /** Provider-native voice id, passed straight to synth. */
    id: string;
    /** Row label; defaults to the id. */
    label?: string;
    /** Perceived character - gender, accent, anything orienting. Not authoritative. */
    note?: string;
}

/**
 * A prosody treatment: the same text, delivered differently. Sources control
 * prosody by completely different mechanisms - SSML markup (Google), a
 * natural-language style instruction (OpenAI, Gemini, Inworld), a numeric knob
 * (Cartesia), or nothing at all (Deepgram Aura-2) - so a treatment is declared
 * per source and interpreted inside its own synth().
 *
 * The FIRST treatment in a source's list is what that source ships today, so a
 * default run reproduces current behaviour and `--prosody` adds the variants
 * beside it.
 */
export interface Treatment {
    id: string;
    label: string;
    /** What it actually does, shown on the audition row. */
    note: string;
}

export interface SynthResult {
    bytes: Uint8Array;
    /** File extension for the written clip (drives the <audio> type). */
    ext: 'mp3' | 'wav';
    /**
     * Provider-reported USD for this call, when the response carries usage.
     * Preferred over the modelled rate - it is what we would actually be billed.
     */
    usdActual?: number;
    /**
     * Characters actually BILLED, when a treatment sends more than the plain
     * text. Google bills SSML by the full tagged length, so a heavily marked-up
     * line costs more than the words it speaks - the SSML tax is real and the
     * audition has to show it rather than quietly pricing the plain sample.
     */
    billedChars?: number;
}

export interface AuditionSource {
    id: string;
    label: string;
    /** Env vars checked in order; the first non-empty one is the key. */
    envKeys: readonly string[];
    /** Where to get a key, shown when the source is skipped. */
    signupUrl: string;
    billing: Billing;
    /** USD per character, or per audio second, for a voice id. */
    usdPerUnit(voiceId: string): number;
    /** Where the rate came from, so a stale number is traceable. */
    rateNote: string;
    /** Whether this source is already in CURATED_VOICES (voice-catalog.ts). */
    shipping: boolean;
    /** The roster to audition. May hit the provider's list endpoint. */
    roster(key: string, opts: RosterOpts): Promise<AuditionVoice[]>;
    /** Prosody treatments this source can express. First = what ships today. */
    treatments: readonly Treatment[];
    synth(text: string, voiceId: string, rate: number, key: string, t: Treatment): Promise<SynthResult>;
}

export interface RosterOpts {
    /** BCP-47 locales to include, for sources that publish per-locale voices. */
    locales: readonly string[];
    /** Substring filter applied to voice ids (case-insensitive). */
    filter?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Calm facilitation register, mirroring providers/tts.ts meditationInstruction.
 *  Sources that accept a style prompt get this verbatim so the audition hears
 *  the register we would actually ship, not a neutral read. */
export function meditationInstruction(rate: number): string {
    const pace =
        rate < 0.95 ? ' Speak slowly, leaving generous space between phrases.'
        : rate > 1.1 ? ' Keep a gentle but slightly brisker pace.'
        : '';
    return (
        'Speak in a warm, calm, unhurried voice, soft and grounded, as a meditation ' +
        'facilitator gently guiding a listener.' + pace
    );
}

/** Sentence-ish split that keeps the terminator, so breaks land where a
 *  facilitator would actually breathe. The sample's "..." is one boundary, not
 *  three. */
function sentences(text: string): string[] {
    return text
        .replace(/\.\.\./g, '\u2026')
        .split(/(?<=[.!?\u2026])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function xmlEscape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/**
 * Wrap plain text in SSML with a slower rate, a slightly lowered pitch, and a
 * held pause between sentences. Verified honored on BOTH Google tiers, Chirp3-HD
 * included (a rate=slow + 1500ms break took a 3.4s line to 5.5s), despite the
 * docs historically listing SSML as WaveNet/Neural2-only.
 *
 * NOTE the billing consequence: Google counts the tags, so this input bills at
 * its FULL tagged length. synth() reports that as billedChars.
 */
export function ssmlProsody(text: string, opts: { rate: string; pitch: string; breakMs: number }): string {
    const body = sentences(text)
        .map(xmlEscape)
        .join(`<break time="${opts.breakMs}ms"/>`);
    return `<speak><prosody rate="${opts.rate}" pitch="${opts.pitch}">${body}</prosody></speak>`;
}

/** Style-instruction treatments, for the sources whose only prosody lever is
 *  natural language. `spacious` is the same register pushed harder on pauses;
 *  worth auditioning because instruction-steered engines drift fast under a
 *  short instruction (meditation-pal-5yi1). */
export const INSTRUCTION_TREATMENTS: readonly Treatment[] = [
    { id: 'instruction', label: 'meditation instruction', note: 'a natural-language style instruction: warm, calm, unhurried' },
    { id: 'plain', label: 'no instruction', note: 'the voice\u2019s own default, unsteered' },
    {
        id: 'instruction-spacious',
        label: 'instruction + pauses',
        note: 'the same instruction, pushed harder for long silences between sentences',
    },
];

/** The style text for an instruction treatment. */
export function instructionFor(t: Treatment, rate: number): string | undefined {
    if (t.id === 'plain') return undefined;
    if (t.id === 'instruction-spacious') {
        return (
            meditationInstruction(rate) +
            ' Leave a long, unhurried silence after each sentence, as if giving the listener ' +
            'room to feel what you just said. Never rush from one line to the next.'
        );
    }
    return meditationInstruction(rate);
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return res;
}

/** Wrap raw little-endian s16 mono PCM in a RIFF header so a browser can play
 *  it. Gemini returns bare PCM (audio/l16), which no <audio> element accepts. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number): Uint8Array {
    const out = new Uint8Array(44 + pcm.length);
    const dv = new DataView(out.buffer);
    const ascii = (off: number, s: string): void => {
        for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
    };
    ascii(0, 'RIFF');
    dv.setUint32(4, 36 + pcm.length, true);
    ascii(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); // PCM fmt chunk size
    dv.setUint16(20, 1, true); // format: PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true); // byte rate
    dv.setUint16(32, 2, true); // block align
    dv.setUint16(34, 16, true); // bits per sample
    ascii(36, 'data');
    dv.setUint32(40, pcm.length, true);
    out.set(pcm, 44);
    return out;
}

// ---------------------------------------------------------------------------
// Google Cloud TTS - the engine we ship on
// ---------------------------------------------------------------------------

interface GoogleVoice {
    name: string;
    languageCodes: string[];
    ssmlGender?: string;
}

const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** Tiers worth auditioning. Studio ($160/1M) is priced out and excluded.
 *  Standard ($4/1M) is in as the floor a value tier could fall back to.
 *  WaveNet and the older Chirp-HD are in because they bill at the SAME $16/1M
 *  as Neural2 while sounding different - excluding a same-price alternative
 *  just hides options. */
const GOOGLE_TIERS = ['Chirp3-HD', 'Chirp-HD', 'Neural2', 'Wavenet', 'Standard'];

const google: AuditionSource = {
    id: 'google',
    label: 'Google Cloud TTS',
    envKeys: ['GOOGLE_TTS_API_KEY'],
    signupUrl: 'https://console.cloud.google.com/apis/library/texttospeech.googleapis.com',
    billing: 'per-char',
    usdPerUnit: (voiceId) => googleTtsRateFor(voiceId),
    rateNote: 'cloud.google.com/text-to-speech/pricing - Standard $4 / Neural2 $16 / Chirp3-HD $30 per 1M chars',
    shipping: true,
    async roster(key, { locales, filter }) {
        const seen = new Set<string>();
        const out: AuditionVoice[] = [];
        for (const lang of locales) {
            const res = await fetch(
                `https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(key)}&languageCode=${lang}`
            );
            if (!res.ok) throw new Error(`voices.list ${res.status}`);
            const { voices = [] } = (await res.json()) as { voices?: GoogleVoice[] };
            for (const v of voices) {
                if (seen.has(v.name)) continue;
                if (!GOOGLE_TIERS.some((t) => v.name.includes(t))) continue;
                if (filter && !v.name.toLowerCase().includes(filter.toLowerCase())) continue;
                seen.add(v.name);
                out.push({
                    id: v.name,
                    // Locale is added below, not here: it is only worth the
                    // width when the run actually spans more than one.
                    label: v.name.replace(/^[a-z]{2}-[A-Z]{2}-/, ''),
                    note: `${(v.ssmlGender ?? '').toLowerCase()} · ${v.languageCodes[0] ?? lang}`,
                });
            }
        }
        // Google names repeat across locales - en-AU/en-GB/en-US all have a
        // "Standard-A" - so a locale-stripped label is ambiguous the moment a
        // run covers more than one. Qualify it rather than showing 48 rows that
        // read identically.
        if (locales.length > 1) {
            for (const v of out) {
                const loc = /^([a-z]{2}-[A-Z]{2})-/.exec(v.id)?.[1];
                if (loc) v.label = `${v.label} · ${loc}`;
            }
        }
        return out.sort((a, b) => a.id.localeCompare(b.id));
    },
    treatments: [
        { id: 'plain', label: 'plain text', note: 'no markup - pace comes from the speed setting alone' },
        {
            id: 'ssml-gentle',
            label: 'SSML gentle',
            note: 'rate 90%, pitch -1st, 700ms between sentences',
        },
        {
            id: 'ssml-spacious',
            label: 'SSML spacious',
            note: 'rate 80%, pitch -2st, 1400ms between sentences',
        },
    ],
    async synth(text, voiceId, rate, key, t) {
        if (t.id === 'plain') {
            return { bytes: await synthesizeWithGoogle(text, voiceId, rate, key), ext: 'mp3' };
        }
        const ssml =
            t.id === 'ssml-spacious'
                ? ssmlProsody(text, { rate: '80%', pitch: '-2st', breakMs: 1400 })
                : ssmlProsody(text, { rate: '90%', pitch: '-1st', breakMs: 700 });
        const res = await postJson(
            `${GOOGLE_TTS_URL}?key=${encodeURIComponent(key)}`,
            {
                input: { ssml },
                voice: { languageCode: voiceId.split('-').slice(0, 2).join('-'), name: voiceId },
                audioConfig: { audioEncoding: 'MP3', speakingRate: Math.min(4, Math.max(0.25, rate)) },
            },
            {}
        );
        const data = (await res.json()) as { audioContent?: string };
        if (!data.audioContent) throw new Error('Google TTS returned no audioContent');
        return {
            bytes: Uint8Array.from(Buffer.from(data.audioContent, 'base64')),
            ext: 'mp3',
            billedChars: ssml.length, // Google bills the tags too
        };
    },
};

// ---------------------------------------------------------------------------
// OpenAI - the other engine we ship on
// ---------------------------------------------------------------------------

/** gpt-4o-mini-tts has no list endpoint; these are the documented voices. */
const OPENAI_VOICES: readonly AuditionVoice[] = [
    { id: 'alloy', note: 'neutral, even' },
    { id: 'ash', note: 'male' },
    { id: 'ballad', note: 'male, lyrical' },
    { id: 'coral', note: 'female, warm' },
    { id: 'echo', note: 'male' },
    { id: 'fable', note: 'male, British' },
    { id: 'onyx', note: 'male, deep' },
    { id: 'nova', note: 'female' },
    { id: 'sage', note: 'androgynous, calm' },
    { id: 'shimmer', note: 'female, soft' },
    { id: 'verse', note: 'neutral, expressive' },
];

const openai: AuditionSource = {
    id: 'openai',
    label: 'OpenAI gpt-4o-mini-tts',
    envKeys: ['OPENAI_TTS_API_KEY', 'OPENAI_API_KEY'],
    signupUrl: 'https://platform.openai.com/api-keys',
    billing: 'per-second',
    // $0.015 per minute of audio (audio-output tokens at $12/1M, ~25 tok/s).
    usdPerUnit: () => 0.015 / 60,
    rateNote: 'audio-output billed, ~$0.015/min; our reconciliation put it at ~$19/1M chars at real pace (pricing/providers.OPENAI_TTS_USD_PER_CHAR)',
    shipping: true,
    roster: async () => [...OPENAI_VOICES],
    treatments: INSTRUCTION_TREATMENTS,
    async synth(text, voiceId, rate, key, t) {
        // The shipping path (providers/tts.ts) always sends the instruction, so
        // that treatment reuses it verbatim; the variants go direct.
        if (t.id === 'instruction') {
            return { bytes: await synthesizeWithOpenAI(text, voiceId, rate, key), ext: 'mp3' };
        }
        const instructions = instructionFor(t, rate);
        const res = await postJson(
            'https://api.openai.com/v1/audio/speech',
            {
                model: 'gpt-4o-mini-tts',
                input: text,
                voice: voiceId,
                response_format: 'mp3',
                speed: Math.min(4, Math.max(0.25, rate)),
                ...(instructions ? { instructions } : {}),
            },
            { authorization: `Bearer ${key}` }
        );
        return { bytes: new Uint8Array(await res.arrayBuffer()), ext: 'mp3' };
    },
};

// ---------------------------------------------------------------------------
// Gemini TTS - steerable, but DURATION-priced and expensive at meditation pace
// ---------------------------------------------------------------------------

/** Gemini's 30 prebuilt voices. Google reuses the star names across Chirp3-HD
 *  and Gemini TTS, so a Gemini "Leda" is NOT the Chirp3-HD "Leda" we ship - the
 *  audition rows carry the source so the two can't be confused. */
const GEMINI_VOICES: readonly string[] = [
    'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
    'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
    'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
    'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

/** Text-in / audio-out USD per token, per ai.google.dev/gemini-api/docs/pricing. */
const GEMINI_TTS_MODELS = {
    'gemini-2.5-flash-preview-tts': { input: 0.5 / M, output: 10 / M },
    'gemini-3.1-flash-tts-preview': { input: 1 / M, output: 20 / M },
} as const;

type GeminiTtsModel = keyof typeof GEMINI_TTS_MODELS;

/** Which Gemini TTS model the audition uses. The Pro variant prices identically
 *  to 3.1 Flash and reads no calmer, so it is not offered here. */
const GEMINI_MODEL: GeminiTtsModel = 'gemini-2.5-flash-preview-tts';

const gemini: AuditionSource = {
    id: 'gemini',
    label: `Gemini TTS (${GEMINI_MODEL})`,
    envKeys: ['GEMINI_API_KEY'],
    signupUrl: 'https://aistudio.google.com/apikey',
    billing: 'per-second',
    // ~25 audio tokens/sec on 2.5 Flash, measured. usdActual overrides this per
    // clip from the response's own usageMetadata, so the model is only a prior.
    usdPerUnit: () => 25 * GEMINI_TTS_MODELS[GEMINI_MODEL].output,
    rateNote: 'ai.google.dev/gemini-api/docs/pricing - audio output $10/1M tokens at ~25 tok/s; per-clip cost read from usageMetadata',
    shipping: false,
    roster: async () => GEMINI_VOICES.map((id) => ({ id })),
    treatments: INSTRUCTION_TREATMENTS,
    async synth(text, voiceId, rate, key, t) {
        const instruction = instructionFor(t, rate);
        const res = await postJson(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
            {
                contents: [{ parts: [{ text: instruction ? `${instruction}\n\n${text}` : text }] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } } },
                },
            },
            {}
        );
        const data = (await res.json()) as {
            candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        const inline = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (!inline?.data) throw new Error('Gemini TTS returned no audio');
        // mimeType looks like "audio/l16; rate=24000; channels=1" - bare PCM.
        const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1] ?? 24000);
        const rates = GEMINI_TTS_MODELS[GEMINI_MODEL];
        const u = data.usageMetadata;
        const usdActual =
            u ? (u.promptTokenCount ?? 0) * rates.input + (u.candidatesTokenCount ?? 0) * rates.output : undefined;
        return {
            bytes: wavFromPcm16(Uint8Array.from(Buffer.from(inline.data, 'base64')), sampleRate),
            ext: 'wav',
            ...(usdActual === undefined ? {} : { usdActual }),
        };
    },
};

// ---------------------------------------------------------------------------
// Off-roster candidates. All character-priced, which is the property that makes
// them worth the integration at all (see the header): a per-char engine bills
// us its headline rate no matter how slowly the facilitator speaks.
//
// Deliberately NOT here: Rime (~$0.03/audio min, duration-priced and so worse
// for us than the sticker suggests), Hume Octave ($50-100/1M), ElevenLabs
// ($180-300/1M). Priced out of a session whose TTS leg is already the dominant
// cost line.
// ---------------------------------------------------------------------------

const CARTESIA_VERSION = '2026-08-14';

const cartesia: AuditionSource = {
    id: 'cartesia',
    label: 'Cartesia Sonic 3',
    envKeys: ['CARTESIA_API_KEY'],
    signupUrl: 'https://play.cartesia.ai/keys',
    billing: 'per-char',
    usdPerUnit: () => 25 / M,
    rateNote: '1 credit/char; effective $5-37/1M chars by plan - $25/1M assumed at a mid plan, confirm before shipping',
    shipping: false,
    async roster(key, { filter }) {
        const res = await fetch('https://api.cartesia.ai/voices/?limit=100', {
            headers: { 'Cartesia-Version': CARTESIA_VERSION, authorization: `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`voices ${res.status}`);
        const body = (await res.json()) as {
            data?: { id: string; name?: string; description?: string; language?: string }[];
        };
        return (body.data ?? [])
            .filter((v) => (v.language ?? 'en').startsWith('en'))
            .filter((v) => !filter || (v.name ?? '').toLowerCase().includes(filter.toLowerCase()))
            .map((v) => ({
                id: v.id,
                label: v.name ?? v.id,
                note: (v.description ?? '').slice(0, 70),
            }));
    },
    treatments: [
        { id: 'plain', label: 'default speed', note: 'the voice as-is at the session speed' },
        { id: 'slow', label: 'slowest', note: 'speed 0.6, the floor of Cartesia\u2019s band' },
    ],
    async synth(text, voiceId, rate, key, t) {
        const speed = t.id === 'slow' ? 0.6 : Math.min(1.5, Math.max(0.6, rate));
        const res = await postJson(
            'https://api.cartesia.ai/tts/bytes',
            {
                model_id: 'sonic-3.6',
                transcript: text,
                voice: { id: voiceId },
                language: 'en',
                output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
                // Cartesia's speed band is [0.6, 1.5], narrower than Google's.
                generation_config: { speed },
            },
            { 'Cartesia-Version': CARTESIA_VERSION, authorization: `Bearer ${key}` }
        );
        return { bytes: new Uint8Array(await res.arrayBuffer()), ext: 'mp3' };
    },
};

/** Aura-2's English roster; there is no list endpoint, so this is the published
 *  set. Trimmed to the calm//low-key half - the audition is for a meditation
 *  facilitator, and auditioning 41 voices to reject 20 obvious newsreaders
 *  wastes the listen more than it wastes the pennies. */
const DEEPGRAM_VOICES: readonly AuditionVoice[] = [
    { id: 'aura-2-amalthea-en', note: 'female, engaging' },
    { id: 'aura-2-andromeda-en', note: 'female, casual' },
    { id: 'aura-2-aurora-en', note: 'female, cheerful' },
    { id: 'aura-2-callista-en', note: 'female, clear' },
    { id: 'aura-2-cora-en', note: 'female, smooth' },
    { id: 'aura-2-cordelia-en', note: 'female, approachable' },
    { id: 'aura-2-delia-en', note: 'female, warm' },
    { id: 'aura-2-harmonia-en', note: 'female, empathetic' },
    { id: 'aura-2-helena-en', note: 'female, caring' },
    { id: 'aura-2-iris-en', note: 'female, gentle' },
    { id: 'aura-2-luna-en', note: 'female, friendly' },
    { id: 'aura-2-ophelia-en', note: 'female, expressive' },
    { id: 'aura-2-pandora-en', note: 'female, British, smooth' },
    { id: 'aura-2-phoebe-en', note: 'female, energetic' },
    { id: 'aura-2-selene-en', note: 'female, expressive' },
    { id: 'aura-2-theia-en', note: 'female, American' },
    { id: 'aura-2-thalia-en', note: 'female, clear' },
    { id: 'aura-2-vesta-en', note: 'female, natural' },
    { id: 'aura-2-apollo-en', note: 'male, confident' },
    { id: 'aura-2-arcas-en', note: 'male, natural' },
    { id: 'aura-2-atlas-en', note: 'male, mature' },
    { id: 'aura-2-draco-en', note: 'male, British' },
    { id: 'aura-2-hermes-en', note: 'male, expressive' },
    { id: 'aura-2-hyperion-en', note: 'male, Australian' },
    { id: 'aura-2-jupiter-en', note: 'male, calm' },
    { id: 'aura-2-orion-en', note: 'male, approachable' },
    { id: 'aura-2-orpheus-en', note: 'male, centered' },
    { id: 'aura-2-saturn-en', note: 'male, knowledgeable' },
];

const deepgram: AuditionSource = {
    id: 'deepgram',
    label: 'Deepgram Aura-2',
    envKeys: ['DEEPGRAM_API_KEY'],
    signupUrl: 'https://console.deepgram.com/signup',
    billing: 'per-char',
    usdPerUnit: () => 30 / M,
    rateNote: 'deepgram.com/pricing - $0.030 per 1k chars PAYG ($30/1M), discounted on committed plans',
    shipping: false,
    async roster(_key, { filter }) {
        return DEEPGRAM_VOICES.filter((v) => !filter || v.id.includes(filter.toLowerCase())).map((v) => ({
            ...v,
            label: v.id.replace(/^aura-2-|-en$/g, ''),
        }));
    },
    treatments: [
        {
            id: 'plain',
            label: 'no prosody control',
            note: 'Aura-2 exposes no rate, pitch, SSML or style control of any kind',
        },
    ],
    async synth(text, voiceId, _rate, key) {
        // Aura has no speed control; pace is whatever the voice does. That alone
        // may disqualify it - our sessions drive pace off the speed setting.
        const res = await postJson(
            `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voiceId)}&encoding=mp3`,
            { text },
            { authorization: `Token ${key}` }
        );
        return { bytes: new Uint8Array(await res.arrayBuffer()), ext: 'mp3' };
    },
};

const inworld: AuditionSource = {
    id: 'inworld',
    label: 'Inworld TTS',
    envKeys: ['INWORLD_API_KEY'],
    signupUrl: 'https://platform.inworld.ai',
    billing: 'per-char',
    usdPerUnit: () => 25 / M,
    rateNote: 'Realtime TTS-2 $25/1M on-demand - the rate that applies to us. Cheaper tiers are SUBSCRIPTION commitments ($25/mo Creator $20, $300/mo Developer $15, $1500/mo Growth $12.50), not volume discounts',
    shipping: false,
    async roster(key, { filter }) {
        const res = await fetch('https://api.inworld.ai/tts/v1/voices', {
            headers: { authorization: `Basic ${key}` },
        });
        if (!res.ok) throw new Error(`voices ${res.status}`);
        const body = (await res.json()) as {
            voices?: { voiceId: string; displayName?: string; description?: string; languages?: string[] }[];
        };
        return (body.voices ?? [])
            .filter((v) => !v.languages?.length || v.languages.some((l) => l.startsWith('en')))
            .filter((v) => !filter || v.voiceId.toLowerCase().includes(filter.toLowerCase()))
            .map((v) => ({
                id: v.voiceId,
                label: v.displayName ?? v.voiceId,
                note: (v.description ?? '').slice(0, 70),
            }));
    },
    treatments: INSTRUCTION_TREATMENTS,
    async synth(text, voiceId, rate, key, t) {
        const instruction = instructionFor(t, rate);
        const res = await postJson(
            'https://api.inworld.ai/tts/v1/voice',
            {
                text,
                voiceId,
                modelId: 'inworld-tts-2',
                // Inworld takes a style instruction AND a numeric rate; its band
                // is [0.5, 1.5].
                ...(instruction ? { instruction } : {}),
                audioConfig: {
                    audioEncoding: 'MP3',
                    sampleRateHertz: 24000,
                    speakingRate: Math.min(1.5, Math.max(0.5, rate)),
                },
            },
            { authorization: `Basic ${key}` }
        );
        const body = (await res.json()) as { audioContent?: string };
        if (!body.audioContent) throw new Error('Inworld returned no audioContent');
        return { bytes: Uint8Array.from(Buffer.from(body.audioContent, 'base64')), ext: 'mp3' };
    },
};

export const SOURCES: readonly AuditionSource[] = [google, openai, gemini, cartesia, deepgram, inworld];

export function sourceById(id: string): AuditionSource | undefined {
    return SOURCES.find((s) => s.id === id);
}

/** The key for a source, or undefined when none of its env vars are set.
 *  `||` not `??`: a blank `FOO=` line is the empty string, which `??` keeps. */
export function keyFor(source: AuditionSource): string | undefined {
    for (const name of source.envKeys) {
        const v = process.env[name];
        if (v) return v;
    }
    return undefined;
}
