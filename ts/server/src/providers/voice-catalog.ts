/**
 * Curated hosted voice catalog. The server owns the short display name →
 * provider voice id mapping, so the client carries neither the full id nor any
 * knowledge of which provider speaks it: it sends the short name as the
 * /cloud/v1/tts `voice`, resolveVoice() returns (provider, voiceId), and the
 * route dispatches. Hand-picked voices that lead the picker when aloud cloud is
 * reachable. Audition more with scripts/preview-voices.ts.
 */

export type VoiceGender = 'female' | 'male' | 'androgynous';

/** The TTS backend that speaks a voice. Each has its own synth call, key, and
 *  per-char rate (providers/tts.ts, pricing/providers.ttsRateFor). */
export type TtsProvider = 'google' | 'openai' | 'azure';

/** Voice quality/placement bucket (also the picker's cost-badge hint).
 *  'premium' = "Best", leads the picker, flagged recommended: Google Chirp3-HD
 *  (~$30/1M) AND the OpenAI gpt-4o-mini-tts voices (premium QUALITY at a
 *  below-Chirp3-HD ~$19/1M cost). 'value' = "Very Good", the cheaper Google
 *  Neural2 (~$16/1M). The real per-char rate comes from (provider, voiceId) via
 *  the meter (pricing/providers.ttsRateFor), and the picker's concrete
 *  credits/hr keeps the burn honest regardless of bucket, so a premium-bucket
 *  voice can read as a lower cost/hr. */
export type VoiceTier = 'premium' | 'value';

export interface CuratedVoice {
    /** Short display name shown + stored by the client (e.g. "Pulcherrima"). */
    name: string;
    provider: TtsProvider;
    /** Google Cloud TTS voice id (en-US-Chirp3-HD-Leda), OpenAI voice name
     *  (coral), or Azure ShortName (en-US-AvaMultilingualNeural). */
    providerVoiceId: string;
    /** Perceived gender, for the picker's label. */
    gender: VoiceGender;
    tier: VoiceTier;
    /** The default when the client doesn't specify a voice. */
    default?: boolean;
}

export const CURATED_VOICES: readonly CuratedVoice[] = [
    // Premium tier: Google Chirp3-HD (~$30/1M), most natural/expressive.
    // Pulcherrima reads androgynous despite Google's "female" label.
    { name: 'Pulcherrima', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Pulcherrima', gender: 'androgynous', tier: 'premium' },
    { name: 'Sadachbia', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Sadachbia', gender: 'male', tier: 'premium' },
    { name: 'Leda', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Leda', gender: 'female', tier: 'premium', default: true },
    // Value tier: Google Neural2 (~$16/1M, about half), still natural and calm.
    // Unauditioned picks, refine after listening (meditation-pal-b7i).
    { name: 'Vega', provider: 'google', providerVoiceId: 'en-US-Neural2-F', gender: 'female', tier: 'value' },
    { name: 'Rigel', provider: 'google', providerVoiceId: 'en-US-Neural2-J', gender: 'male', tier: 'value' },
    // OpenAI gpt-4o-mini-tts: auditioned picks (scripts/preview-voices.ts openai),
    // in the 'premium' (Best) bucket. Tier is QUALITY/placement only: these cost
    // ~$19/1M, below Chirp3-HD's ~$30/1M, and the picker's credits/hr badge shows
    // that lower real burn. Steerable via natural-language instructions
    // (providers/tts.ts sets a calm meditation register). OpenAI's full set:
    // alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse.
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
 * can only ever synthesize this one line per curated voice, never arbitrary
 * caller input. Mirrors the client's PREVIEW_PHRASE (ui/src/voice-picker.ts);
 * keep in sync.
 */
export const PREVIEW_PHRASE = "Welcome to aloud. I'll be your facilitator.";

/** The route uses `provider` to pick the key + synth call; `voiceId` is the
 *  provider-native id. */
export interface ResolvedVoice {
    provider: TtsProvider;
    voiceId: string;
}

/**
 * Resolve a client-supplied voice to (provider, voiceId). Accepts a curated
 * short name ("Leda", "Lyra"), a raw Google voice id (power-user passthrough),
 * or empty → the default. The meter bills per char at the RESOLVED provider's
 * rate, so an unrecognized value can't be a billing problem.
 */
export function resolveVoice(voice: string | undefined): ResolvedVoice {
    if (!voice) {
        const d = defaultVoice();
        return { provider: d.provider, voiceId: d.providerVoiceId };
    }
    const curated = CURATED_VOICES.find((v) => v.name === voice);
    if (curated) return { provider: curated.provider, voiceId: curated.providerVoiceId };
    // Raw passthrough accepts Google and Azure ids, which encode their own tier
    // (OpenAI voices must come through the curated short names). Azure
    // ShortNames end in "Neural" (en-US-SaraNeural, zh-CN-XiaochenNeural,
    // en-US-Andrew_DragonHDLatestNeural) or name an MAI-Voice model; Google's
    // tiers never do (Neural2 ids continue "Neural2-F").
    if (/Neural$/.test(voice) || voice.includes('MAI-Voice')) return { provider: 'azure', voiceId: voice };
    return { provider: 'google', voiceId: voice };
}
