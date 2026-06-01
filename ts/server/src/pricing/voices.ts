/**
 * Per-voice TTS cost table. TTS is billed by characters spoken regardless of
 * which voice produced them, but DIFFERENT voices/engines cost different
 * amounts per char — so the rate is a lookup, mirroring the LLM model table.
 *
 * This is what lets the client put a per-voice "~N credits/hr" line in the
 * existing voice selector that can't drift from what actually bills: both read
 * this table (the line via /v1/me/estimates, the charge via the meter).
 *
 * Local engines (browser speechSynthesis, OS premium voices like Apple/MS Edge)
 * cost ZERO — when a capable local voice is detected the client should default
 * to it and show "free". Cloud voices (ElevenLabs, server-held key) carry a
 * per-char rate.
 *
 * ⚠️ Rates are APPROXIMATE early-2026 ElevenLabs list prices and vary by tier
 * (Flash is roughly half the standard models). Validate against a real bill
 * before launch — see the estimate-validation bead.
 */

export type TtsEngine = 'browser' | 'os' | 'openai' | 'neural' | 'hume' | 'elevenlabs';

export interface TtsVoiceRate {
    id: string;
    label: string;
    engine: TtsEngine;
    /** USD per character. Zero for local engines. */
    usdPerChar: number;
}

// Approximate early-2026 list rates, per char (= $/1M chars ÷ 1e6). ElevenLabs
// is the expressive premium end; for calm meditation guidance the cheaper
// neural voices are likely more than good enough at a fraction of the cost.
// NOTE: MS Edge "read aloud" voices (a common free local option) are Azure
// neural voices — i.e. the os-premium/free path often gives neural quality at
// $0. Validate all rates against a real bill before launch (see TTS bead).
//
// Cheaper options NOT in this table (evaluate later, meditation-pal-2gz):
//   - Unreal Speech ~$8/1M ("11x cheaper than ElevenLabs"; steep volume tiers)
//   - Speechify API ~$10/1M; Fish Audio s2-pro ~$15/1M
//   - Kokoro 82B (open-weight) ~$0.70/1M self-hosted — but self-hosting breaks
//     the cheap stateless-proxy model (same tradeoff as self-hosting Whisper).
const VOICES: Record<string, TtsVoiceRate> = {
    'browser-default': { id: 'browser-default', label: 'Device voice (free)', engine: 'browser', usdPerChar: 0 },
    'os-premium': { id: 'os-premium', label: 'System premium voice (free)', engine: 'os', usdPerChar: 0 },
    'hume-octave': {
        id: 'hume-octave',
        label: 'Cloud voice — Hume Octave (emotion-aware)',
        engine: 'hume',
        usdPerChar: 0.0000076, // ~$7.60/1M. Emotion-native TTS — strong fit for calm meditation delivery.
    },
    'openai-tts': {
        id: 'openai-tts',
        label: 'Cloud voice — OpenAI',
        engine: 'openai',
        usdPerChar: 0.000015, // ~$15/1M (tts-1)
    },
    'neural-budget': {
        id: 'neural-budget',
        label: 'Cloud voice — Neural (Google/Azure/Polly)',
        engine: 'neural',
        usdPerChar: 0.000016, // List price $16/1M across Azure Neural, Google Neural2/WaveNet, Polly Neural
    },
    'deepgram-aura': {
        id: 'deepgram-aura',
        label: 'Cloud voice — Deepgram Aura',
        engine: 'neural',
        usdPerChar: 0.000015, // Aura-1 $0.015/1k; Aura-2 (enterprise) ~$0.03/1k. Cheap + low-latency.
    },
    'elevenlabs-flash': {
        id: 'elevenlabs-flash',
        label: 'Cloud voice — ElevenLabs Flash',
        engine: 'elevenlabs',
        usdPerChar: 0.00005, // $0.05/1k chars PAYG (cut from $0.11 in 2026); ~half a credit/char
    },
    'elevenlabs-standard': {
        id: 'elevenlabs-standard',
        label: 'Cloud voice — ElevenLabs Premium',
        engine: 'elevenlabs',
        usdPerChar: 0.0001, // ~$0.10/1k (Multilingual v2, ~1 credit/char); lower plan tiers cost more
    },
};

/** Default cloud rate used when a specific voice id isn't recognized (so a new
 *  cloud voice never bills at zero by accident). Set at the ElevenLabs Flash
 *  rate — a safe upper-ish bound among the cloud options. */
export const DEFAULT_CLOUD_USD_PER_CHAR = 0.00005;

export function ttsRateFor(voiceId: string): number {
    return VOICES[voiceId]?.usdPerChar ?? DEFAULT_CLOUD_USD_PER_CHAR;
}

export function ttsVoices(): TtsVoiceRate[] {
    return Object.values(VOICES);
}
