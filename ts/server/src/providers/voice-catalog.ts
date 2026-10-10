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
export type TtsProvider = 'google' | 'azure' | 'inworld';

/** Voice quality/placement bucket (also the picker's cost-badge hint).
 *  'premium' = "Best", leads the picker, flagged recommended: Google Chirp3-HD
 *  (~$30/1M) AND most Azure and Inworld voices (premium QUALITY at a
 *  below-Chirp3-HD cost). 'value' = "Very Good", one rung down: the cheaper
 *  Google Neural2 (~$16/1M), plus any Azure/Inworld voice the dev places
 *  there (a taste call, not a price one). The real per-char rate comes from
 *  (provider, voiceId) via the meter (pricing/providers.ttsRateFor), and the
 *  picker's concrete credits/hr keeps the burn honest regardless of bucket, so
 *  a premium-bucket voice can read as a lower cost/hr. */
export type VoiceTier = 'premium' | 'value';

export interface CuratedVoice {
    /** Short display name shown + stored by the client (e.g. "Pulcherrima"). */
    name: string;
    provider: TtsProvider;
    /** Google Cloud TTS voice id (en-US-Chirp3-HD-Leda), Azure ShortName
     *  (en-US-AvaMultilingualNeural), or Inworld
     *  `<voiceId>:<modelId>` (Luna:inworld-tts-2). */
    providerVoiceId: string;
    /** Perceived gender, for the picker's label. */
    gender: VoiceGender;
    tier: VoiceTier;
    /** Azure only: an mstts express-as speaking style baked into the curated
     *  voice (softvoice, empathetic). Part of the voice's identity, not a user
     *  knob - "Harper" IS Harper-in-softvoice. */
    style?: string;
    /** Speaks languages beyond English natively - safe to use in a zh session
     *  (meditation-pal-c3a0.6). The picker hides voices without it when the
     *  session language isn't English. Only flag voices actually HEARD in zh:
     *  the Azure *Multilingual family (zh demo clips in voice-previews/) and
     *  the MAI-Voice-2 / DragonHD voices the dev heard handle zh without
     *  glitching (2026-08-31; a native-speaker quality pass is still pending).
     *  Google's en-US Chirp3-HD Leda is confirmed BAD at it (glitches), so its
     *  missing flag is a finding, not an oversight. */
    multilingual?: boolean;
    /** A native zh speaker judged this voice native-quality in Chinese
     *  (2026-08-31 listening pass). The other multilingual voices passed the
     *  glitch check but read as clearly accented to a native ear, so a zh
     *  session that never picked a voice is steered here instead of the
     *  flagged default (views/session.ts language swap), and the picker
     *  surfaces these first in zh sessions. */
    zhNative?: boolean;
    /** A rule for the LLM about the text this voice will read, sent to the
     *  client as CloudVoice.promptNote and appended to the system prompt while
     *  the voice is in use. For a provider-side synthesis bug we'd rather steer
     *  around than lose the voice over; drop it once the provider fixes it. */
    promptNote?: string;
    /** Multiplied into the requested rate before synthesis, so the speed
     *  slider means roughly the same words-per-minute on every voice. The MAI
     *  and DragonHD voices read the audition sample in 19-24s where the norm
     *  is ~13s; these biases close about half that gap (deliberately not all
     *  of it - the unhurried delivery is why they were picked). Tuned by ear,
     *  not formula.
     *
     *  MUTUALLY EXCLUSIVE with `style`: on MAI-Voice-2 any <prosody> tag
     *  silently reverts express-as to the standard voice (measured
     *  2026-08-31), so routes/tts.effectiveRate forces rate 1 whenever a
     *  style is present - a paceBias on a styled voice would be dead config
     *  that reads as if it worked. */
    paceBias?: number;
    /** The default when the client doesn't specify a voice. */
    default?: boolean;
}

export const CURATED_VOICES: readonly CuratedVoice[] = [
    // Premium tier: Google Chirp3-HD (~$30/1M), most natural/expressive.
    // Pulcherrima reads androgynous despite Google's "female" label.
    { name: 'Pulcherrima', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Pulcherrima', gender: 'androgynous', tier: 'premium' },
    { name: 'Sadachbia', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Sadachbia', gender: 'male', tier: 'premium' },
    { name: 'Leda', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Leda', gender: 'female', tier: 'premium' },
    // Value tier: Google Neural2 (~$16/1M, about half), still natural and calm.
    // Unauditioned picks, refine after listening (meditation-pal-b7i).
    { name: 'Vega', provider: 'google', providerVoiceId: 'en-US-Neural2-F', gender: 'female', tier: 'value' },
    { name: 'Rigel', provider: 'google', providerVoiceId: 'en-US-Neural2-J', gender: 'male', tier: 'value' },
    // Azure AI Speech: auditioned picks (2026-08-30). The MAI-Voice-2 voices
    // are naturally unhurried and the `style` ones bake in the calmest
    // express-as register the voice supports; multilingual entries (Ada, Davis)
    // also speak zh natively - groundwork for meditation-pal-c3a0. ~$15/1M
    // (MAI Flash), ~$16/1M (multilingual) and ~$22/1M (DragonHD), so premium
    // placement (Ada aside) at below-Chirp3-HD burn: tier is QUALITY/placement
    // only, and the picker's credits/hr badge shows the lower real cost.
    // MAI-Voice-2.1-Flash rather than 2-Flash: same price and styles, and
    // Microsoft's docs cover only 2.1.
    { name: 'Ada (GB)', provider: 'azure', multilingual: true, providerVoiceId: 'en-GB-AdaMultilingualNeural', gender: 'female', tier: 'value' },
    { name: 'Davis', provider: 'azure', multilingual: true, providerVoiceId: 'en-US-DavisMultilingualNeural', gender: 'male', tier: 'premium', style: 'empathetic' },
    { name: 'Ethan', provider: 'azure', multilingual: true, providerVoiceId: 'en-US-Ethan:MAI-Voice-2.1-Flash', gender: 'male', tier: 'premium', style: 'softvoice' },
    // Harper's softvoice is the point ("breathy, almost sleepy" - the dev's
    // words). It reads a touch brisker than her plain voice (~19s vs ~24s on
    // the audition sample); the speed slider makes that back up if wanted.
    // Default (dev pick 2026-08-31): the softvoice register suits the app, and
    // a zh session that never picks a voice gets one that can actually speak
    // it. (zh sessions are further steered client-side to a zhNative voice -
    // Harper's zh reads accented to a native ear.)
    // Azure intermittently garbles Harper's synthesis of a reply that opens
    // with "Right" (provider-side; 2.1 did NOT fix it: 5/24 onsets cut on
    // 2.1-Flash, the same as 2-Flash, 2026-10-07). The prompt note steers the
    // LLM off that opener; meditation-pal-nkni tracks re-checking the bug or
    // finding a replacement voice.
    {
        name: 'Harper',
        provider: 'azure',
        multilingual: true,
        providerVoiceId: 'en-US-Harper:MAI-Voice-2.1-Flash',
        gender: 'female',
        tier: 'premium',
        style: 'softvoice',
        default: true,
        promptNote: 'Never begin a reply with the word "Right" (as in "Right." or "Right, so..."): the voice that reads your replies stumbles on that opener. Start with any other word.',
    },
    { name: 'Isla (AU)', provider: 'azure', multilingual: true, providerVoiceId: 'en-AU-Isla:MAI-Voice-2.1-Flash', gender: 'female', tier: 'premium', paceBias: 1.1 },
    { name: 'Serena', provider: 'azure', multilingual: true, zhNative: true, providerVoiceId: 'en-US-Serena:DragonHDLatestNeural', gender: 'female', tier: 'premium', paceBias: 1.1 },
    // Inworld: dev picks from the 2026-10-07 audition. TTS-2 is ~$25/1M and
    // TTS-2 Flash ~$15/1M, both under Chirp3-HD. English only, so none carries
    // `multilingual`. Wren and Silas are DESIGNED voices (Inworld voice design,
    // from the "soft breathy" and "warm low" descriptions): they exist only in
    // the Inworld workspace behind INWORLD_API_KEY, so a key from any other
    // account 404s them. Wren was picked on Flash; the rest on TTS-2.
    { name: 'Luna', provider: 'inworld', providerVoiceId: 'Luna:inworld-tts-2', gender: 'female', tier: 'premium' },
    { name: 'Wren', provider: 'inworld', providerVoiceId: 'keen-banjo-6800__design-voice-22273db5:inworld-tts-2-flash', gender: 'female', tier: 'value' },
    { name: 'Silas', provider: 'inworld', providerVoiceId: 'keen-banjo-6800__design-voice-446019ec:inworld-tts-2', gender: 'male', tier: 'premium' },
    { name: 'Clive (GB)', provider: 'inworld', providerVoiceId: 'Clive:inworld-tts-2', gender: 'male', tier: 'premium' },
];

/** Default-voice preference order behind the `default: true` pick, one voice
 *  per provider, so a deploy missing the flagged default's key still speaks
 *  instead of 502ing every no-voice request. Ordering is a dev taste call -
 *  edit freely. */
const DEFAULT_VOICE_CHAIN = ['Harper', 'Leda', 'Luna'];

/** The flagged default; with `available` (the providers whose keys are
 *  configured), the first choice in the chain that can actually synthesize. */
export function defaultVoice(available?: ReadonlySet<TtsProvider>): CuratedVoice {
    const flagged = CURATED_VOICES.find((v) => v.default) ?? CURATED_VOICES[0]!;
    if (!available || available.has(flagged.provider)) return flagged;
    for (const name of DEFAULT_VOICE_CHAIN) {
        const v = CURATED_VOICES.find((c) => c.name === name);
        if (v && available.has(v.provider)) return v;
    }
    return CURATED_VOICES.find((v) => available.has(v.provider)) ?? flagged;
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
    /** Azure express-as style carried by a curated voice (never on passthrough). */
    style?: string;
    /** Per-voice pace normalization (CuratedVoice.paceBias); never on passthrough. */
    paceBias?: number;
}

/**
 * Resolve a client-supplied voice to (provider, voiceId). Accepts a curated
 * short name ("Leda", "Harper"), a raw Google or Azure voice id (power-user
 * passthrough), or empty → the default (steered by `available` to a provider
 * with a key - see defaultVoice). The meter bills per char at the RESOLVED
 * provider's rate, so an unrecognized value can't be a billing problem.
 */
export function resolveVoice(
    voice: string | undefined,
    available?: ReadonlySet<TtsProvider>
): ResolvedVoice {
    if (!voice) {
        const d = defaultVoice(available);
        return {
            provider: d.provider,
            voiceId: d.providerVoiceId,
            ...(d.style ? { style: d.style } : {}),
            ...(d.paceBias ? { paceBias: d.paceBias } : {}),
        };
    }
    const curated = CURATED_VOICES.find((v) => v.name === voice);
    if (curated)
        return {
            provider: curated.provider,
            voiceId: curated.providerVoiceId,
            ...(curated.style ? { style: curated.style } : {}),
            ...(curated.paceBias ? { paceBias: curated.paceBias } : {}),
        };
    // A short name that is no longer curated (a removed voice, e.g. Mira,
    // 2026-09-01) falls back to the default rather than the passthrough below:
    // real Google/Azure ids always carry locale hyphens, so a bare word could
    // only error upstream on every turn of that user's session.
    if (!voice.includes('-')) return resolveVoice(undefined, available);
    // Raw passthrough accepts Google and Azure ids, which encode their own tier
    // (Inworld voices must come through the curated short names). Azure
    // ShortNames end in "Neural" (en-US-SaraNeural, zh-CN-XiaochenNeural,
    // en-US-Andrew_DragonHDLatestNeural) or name an MAI-Voice model; Google's
    // tiers never do (Neural2 ids continue "Neural2-F").
    if (/Neural$/.test(voice) || voice.includes('MAI-Voice')) return { provider: 'azure', voiceId: voice };
    return { provider: 'google', voiceId: voice };
}
