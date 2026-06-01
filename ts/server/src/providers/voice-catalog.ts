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

export interface CuratedVoice {
    /** Short display name shown + stored by the client (e.g. "Pulcherrima"). */
    name: string;
    /** Underlying Google Cloud TTS voice id. */
    googleId: string;
    /** Perceived gender, for the picker's label. */
    gender: VoiceGender;
    /** The default when the client doesn't specify a voice. */
    default?: boolean;
}

export const CURATED_VOICES: readonly CuratedVoice[] = [
    // Pulcherrima reads androgynous despite Google's "female" label — a neutral
    // default for a meditation facilitator.
    { name: 'Pulcherrima', googleId: 'en-US-Chirp3-HD-Pulcherrima', gender: 'androgynous' },
    { name: 'Sadachbia', googleId: 'en-US-Chirp3-HD-Sadachbia', gender: 'male' },
    { name: 'Leda', googleId: 'en-US-Chirp3-HD-Leda', gender: 'female', default: true},
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
