/**
 * Curated hosted voice catalog. The server owns the mapping from a short,
 * friendly display name (what the client stores + shows) to the underlying
 * Google Cloud TTS voice id, so the client never has to carry the full id.
 *
 * These are the hand-picked "very high quality" voices that float to the top
 * of the picker when the aloud cloud is reachable. Audition more with
 * scripts/preview-voices.ts and add the winners here.
 */

export type VoiceGender = 'female' | 'male' | 'androgynous';

/** Cost tier shown in the picker so a pricier voice reads as pricier.
 *  'premium' = the priciest tier we offer (Google Chirp3-HD, ~$30/1M);
 *  'value'   = a cheaper Google tier (Neural2, ~$16/1M — about half) that still
 *  sounds natural and calm. The actual per-char rate is derived from the
 *  googleId by the meter (pricing/providers.googleTtsRateFor); this label is the
 *  product-facing bucket the UI badges. */
export type VoiceTier = 'premium' | 'value';

export interface CuratedVoice {
    /** Short display name shown + stored by the client (e.g. "Pulcherrima"). */
    name: string;
    /** Underlying Google Cloud TTS voice id. */
    googleId: string;
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
    { name: 'Pulcherrima', googleId: 'en-US-Chirp3-HD-Pulcherrima', gender: 'androgynous', tier: 'premium' },
    { name: 'Sadachbia', googleId: 'en-US-Chirp3-HD-Sadachbia', gender: 'male', tier: 'premium' },
    { name: 'Leda', googleId: 'en-US-Chirp3-HD-Leda', gender: 'female', tier: 'premium', default: true },
    // Value tier — Google Neural2 (~$16/1M, about half the cost) — still natural
    // and calm, a gentler credit burn. Display names continue the star theme;
    // unauditioned picks, refine after listening (meditation-pal-b7i).
    { name: 'Vega', googleId: 'en-US-Neural2-F', gender: 'female', tier: 'value' },
    { name: 'Rigel', googleId: 'en-US-Neural2-J', gender: 'male', tier: 'value' },
];

export function defaultVoice(): CuratedVoice {
    return CURATED_VOICES.find((v) => v.default) ?? CURATED_VOICES[0]!;
}

/**
 * Resolve a client-supplied voice to a Google voice id. Accepts a curated
 * short name ("Leda"), a raw Google id (passes through, for power users), or
 * empty/unknown → the default. The meter bills per character regardless of
 * which voice, so an unrecognized value can't be a billing problem.
 */
export function resolveVoiceId(voice: string | undefined): string {
    if (!voice) return defaultVoice().googleId;
    const curated = CURATED_VOICES.find((v) => v.name === voice);
    return curated ? curated.googleId : voice;
}
