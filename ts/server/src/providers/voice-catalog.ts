/**
 * Curated hosted voice catalog. The server owns the mapping from a short,
 * friendly display name (what the client stores + shows) to the underlying
 * provider voice id, so the client never has to carry the full id — and never
 * has to know which provider speaks it. The client just sends the short name
 * back as the /cloud/v1/tts `voice`; resolveVoice() turns it into a
 * (provider, voiceId) pair and the route dispatches to that provider.
 *
 * These are the hand-picked "very high quality" voices that float to the top
 * of the picker when the aloud cloud is reachable. Audition more with
 * scripts/preview-voices.ts and add the winners here.
 */

export type VoiceGender = 'female' | 'male' | 'androgynous';

/** The TTS backend that speaks a voice. Each has its own synth call, key, and
 *  per-character rate (providers/tts.ts, pricing/providers.ttsRateFor). */
export type TtsProvider = 'google' | 'openai';

/** Voice quality/placement bucket (also the picker's cost-badge hint).
 *  'premium' = the "Best" tier — leads the picker, flagged recommended: Google
 *  Chirp3-HD (~$30/1M) AND the OpenAI gpt-4o-mini-tts voices (premium QUALITY at
 *  a below-Chirp3-HD ~$22/1M cost). 'value' = the "Very Good" tier — the cheaper
 *  Google Neural2 (~$16/1M). The actual per-char rate is derived from the
 *  (provider, voiceId) by the meter (pricing/providers.ttsRateFor), and the
 *  concrete credits/hr the picker shows keeps the real burn honest regardless of
 *  bucket — so a premium-bucket voice can still read as a lower cost/hr. */
export type VoiceTier = 'premium' | 'value';

export interface CuratedVoice {
    /** Short display name shown + stored by the client (e.g. "Pulcherrima"). */
    name: string;
    /** Which backend speaks this voice. */
    provider: TtsProvider;
    /** Underlying provider voice id: a Google Cloud TTS voice id
     *  (en-US-Chirp3-HD-Leda) or an OpenAI voice name (coral). */
    providerVoiceId: string;
    /** Perceived gender, for the picker's label. */
    gender: VoiceGender;
    /** Cost tier for the picker's cost indicator. */
    tier: VoiceTier;
    /** The default when the client doesn't specify a voice. */
    default?: boolean;
}

export const CURATED_VOICES: readonly CuratedVoice[] = [
    // Premium tier — Google Chirp3-HD (~$30/1M), the most natural/expressive.
    // Pulcherrima reads androgynous despite Google's "female" label — a neutral
    // default for a meditation facilitator.
    { name: 'Pulcherrima', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Pulcherrima', gender: 'androgynous', tier: 'premium' },
    { name: 'Sadachbia', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Sadachbia', gender: 'male', tier: 'premium' },
    { name: 'Leda', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Leda', gender: 'female', tier: 'premium', default: true },
    // Value tier — Google Neural2 (~$16/1M, about half the cost) — still natural
    // and calm, a gentler credit burn. Display names continue the star theme;
    // unauditioned picks, refine after listening (meditation-pal-b7i).
    { name: 'Vega', provider: 'google', providerVoiceId: 'en-US-Neural2-F', gender: 'female', tier: 'value' },
    { name: 'Rigel', provider: 'google', providerVoiceId: 'en-US-Neural2-J', gender: 'male', tier: 'value' },
    // OpenAI gpt-4o-mini-tts — auditioned picks (scripts/preview-voices.ts openai),
    // promoted to the 'premium' (Best) bucket: top quality, recommended in the
    // picker. Tier here is the QUALITY/placement bucket — these cost ~$22/1M
    // (below the Chirp3-HD premium ~$30/1M), and the picker's concrete credits/hr
    // badge shows that lower real burn. Warm and steerable via natural-language
    // instructions (providers/tts.ts sets a calm meditation register). OpenAI's
    // full set: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage,
    // shimmer, verse.
    { name: 'Lyra', provider: 'openai', providerVoiceId: 'shimmer', gender: 'female', tier: 'premium' },
    { name: 'Altair', provider: 'openai', providerVoiceId: 'fable', gender: 'male', tier: 'premium' },
    { name: 'Mira', provider: 'openai', providerVoiceId: 'echo', gender: 'male', tier: 'premium' },
    { name: 'Polaris', provider: 'openai', providerVoiceId: 'nova', gender: 'female', tier: 'premium' },
];

export function defaultVoice(): CuratedVoice {
    return CURATED_VOICES.find((v) => v.default) ?? CURATED_VOICES[0]!;
}

/**
 * The fixed phrase spoken by the public voice-preview endpoint. Server-owned
 * (like the canned-apology texts) so the free, unauthenticated preview route
 * can only ever synthesize this one line per curated voice — never arbitrary
 * caller input. Mirrors the client's PREVIEW_PHRASE (ui/src/voice-picker.ts);
 * keep the two in sync.
 */
export const PREVIEW_PHRASE = "Welcome to aloud. I'll be your facilitator.";

/** A voice resolved to the backend that speaks it. The route uses `provider` to
 *  pick the key + synth call, `voiceId` is the provider-native id. */
export interface ResolvedVoice {
    provider: TtsProvider;
    voiceId: string;
}

/**
 * Resolve a client-supplied voice to its (provider, voiceId). Accepts a curated
 * short name ("Leda", "Lyra"), a raw Google voice id (passes through as a
 * Google voice, for power users), or empty/unknown → the default. The meter
 * bills per character at the resolved provider's rate regardless of which
 * voice, so an unrecognized value can't be a billing problem.
 */
export function resolveVoice(voice: string | undefined): ResolvedVoice {
    if (!voice) {
        const d = defaultVoice();
        return { provider: d.provider, voiceId: d.providerVoiceId };
    }
    const curated = CURATED_VOICES.find((v) => v.name === voice);
    if (curated) return { provider: curated.provider, voiceId: curated.providerVoiceId };
    // Raw passthrough — only Google ids are accepted in raw form (they encode
    // their own tier; OpenAI voices must come through the curated short names).
    return { provider: 'google', voiceId: voice };
}
