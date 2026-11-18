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
    /** Short display name shown + stored by the client (e.g. "Phoenix"). */
    name: string;
    /** Names the voice was published under before. Clients have them stored
     *  as picks, so resolveVoice still answers to them and /cloud/v1/voices
     *  lists them, which lets a client move a stored pick to `name`
     *  (ui voice-picker.ts renamedHostedVoice). */
    formerly?: readonly string[];
    /** The one language the voice is offered in: /cloud/v1/voices lists it
     *  only to a client that asks in that language (`?lang=`), so no English
     *  session, and no client older than the parameter, is offered a voice
     *  nobody has heard speak English. */
    only?: 'zh';
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
     *  surfaces these first in zh sessions. The client takes the first one
     *  it finds, so exactly one voice carries it: Serena did until
     *  2026-11-18, Xiaoyue since. */
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
    /** Level trim in dB, so every voice plays about as loud as the rest.
     *  For a new voice: render its as-shipped clip with gainDb 0
     *  (`npm run voices -- curated --only=<name>`), measure it
     *  (`ffmpeg -i <clip> -af ebur128=peak=true -f null -`), and take the
     *  1.5 dB step nearest to -22.4 LUFS minus its loudness (the catalog
     *  average, dev-docs/ts-server.md). Whole steps only (providers/mp3-gain.ts).
     *  No limiter behind a boost: true peak plus gainDb stays under -2 dBTP.
     *  A house voice's setup clips are levelled one by one when they are
     *  rendered (scripts/render-voice-clips.ts levelGain), whatever this is. */
    gainDb: number;
    /** Where the voice sits in a session with its gainDb on, when that is
     *  short of -22.4 LUFS because its peaks allow no more: the mean of a
     *  dozen takes of real lines. Its setup clips are levelled to this and
     *  not to the catalog's target, so the tour is as loud as the session
     *  it leads into. Move it with gainDb. */
    sessionLufs?: number;
    /** Azure only: a word spoken ahead of the text and cut off again
     *  (providers/mp3-lead-trim.ts), for a voice that swallows the opening
     *  word of its input. Sent only before a consonant-initial input
     *  (routes/tts.ts leadFor). Azure bills it, so billedCharsFor counts it. */
    lead?: string;
    /** A house voice for this language: it speaks the setup screen's fixed
     *  lines (core setup-lines.ts), pre-rendered to static clips by
     *  scripts/render-voice-clips.ts, which renders every voice carrying the
     *  flag. Two per language, a female and a male, for the voiced tour. */
    house?: 'en' | 'zh';
    /** The default when the client doesn't specify a voice. */
    default?: boolean;
}

export const CURATED_VOICES: readonly CuratedVoice[] = [
    // Premium tier: Google Chirp3-HD (~$30/1M), most natural/expressive.
    // Named for stars like the rest, but ones a recognizer can spell: the
    // voice picks by spoken name, and "Pulcherrima" and "Sadachbia" (Google's
    // names) seldom came back right (2026-11-15). Phoenix reads androgynous
    // despite Google's "female" label.
    { name: 'Phoenix', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Pulcherrima', gender: 'androgynous', tier: 'premium', gainDb: 0 },
    { name: 'Orion', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Sadachbia', gender: 'male', tier: 'premium', gainDb: 0 },
    { name: 'Leda', provider: 'google', providerVoiceId: 'en-US-Chirp3-HD-Leda', gender: 'female', tier: 'premium', gainDb: 0 },
    // Value tier: Google Neural2 (~$16/1M, about half), still natural and calm.
    // Unauditioned picks, refine after listening (meditation-pal-b7i).
    { name: 'Vega', provider: 'google', providerVoiceId: 'en-US-Neural2-F', gender: 'female', tier: 'value', gainDb: -3 },
    { name: 'Rigel', provider: 'google', providerVoiceId: 'en-US-Neural2-J', gender: 'male', tier: 'value', gainDb: -3 },
    // Azure AI Speech: auditioned picks (2026-08-30). The MAI-Voice-2 voices
    // are naturally unhurried and the `style` ones bake in the calmest
    // express-as register the voice supports; multilingual entries (Ada, Davis)
    // also speak zh natively - groundwork for meditation-pal-c3a0. ~$15/1M
    // (MAI Flash), ~$16/1M (multilingual) and ~$22/1M (DragonHD), so premium
    // placement (Ada aside) at below-Chirp3-HD burn: tier is QUALITY/placement
    // only, and the picker's credits/hr badge shows the lower real cost.
    // MAI-Voice-2.1-Flash rather than 2-Flash: same price and styles, and
    // Microsoft's docs cover only 2.1.
    { name: 'Ada (GB)', provider: 'azure', multilingual: true, providerVoiceId: 'en-GB-AdaMultilingualNeural', gender: 'female', tier: 'value', gainDb: -4.5 },
    { name: 'Davis', provider: 'azure', multilingual: true, providerVoiceId: 'en-US-DavisMultilingualNeural', gender: 'male', tier: 'premium', style: 'empathetic', gainDb: -1.5 },
    { name: 'Ethan', provider: 'azure', multilingual: true, providerVoiceId: 'en-US-Ethan:MAI-Voice-2.1-Flash', gender: 'male', tier: 'premium', style: 'softvoice', gainDb: 3, house: 'en' },
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
        gainDb: -4.5,
        house: 'en',
        default: true,
        promptNote: 'Never begin a reply with the word "Right" (as in "Right." or "Right, so..."): the voice that reads your replies stumbles on that opener. Start with any other word.',
        // Softvoice swallows a consonant-initial opening word on most takes
        // ("Back to Exploration" lost "Back" 6 of 7), never one behind a
        // spoken lead (0 of 40 through synthFor, 2026-11-16).
        lead: 'Okay.',
    },
    { name: 'Isla (AU)', provider: 'azure', multilingual: true, providerVoiceId: 'en-AU-Isla:MAI-Voice-2.1-Flash', gender: 'female', tier: 'premium', paceBias: 1.1, gainDb: -4.5 },
    // No paceBias on the DragonHD voices: Serena carried 1.1 until the dev
    // heard it as a bit fast in both languages (2026-11-14).
    { name: 'Serena', provider: 'azure', multilingual: true, providerVoiceId: 'en-US-Serena:DragonHDLatestNeural', gender: 'female', tier: 'premium', gainDb: 3, sessionLufs: -24.3 },
    // Serena's model with a Mandarin persona; the dev heard it in both
    // languages (2026-11-14).
    // The zh house voices go by Chinese names that local Whisper writes right
    // (dev-docs/voice-commands.md), here 大海; Azure calls this one Yunfan, and
    // so did the catalog until 2026-11-17.
    { name: 'Dahai', formerly: ['Yunfan'], provider: 'azure', multilingual: true, providerVoiceId: 'zh-CN-Yunfan:DragonHDLatestNeural', gender: 'male', tier: 'premium', house: 'zh', gainDb: 3, sessionLufs: -27.7 },
    // 小月, Azure's Xiaoqiu (晓秋): the zh female house voice since
    // 2026-11-17, picked on measures alone (dev-docs/ts-server.md); the dev
    // heard her and Dahai on 2026-11-18 and made her the zh default
    // (zhNative). A plain neural voice, so a line comes out the
    // same on every take, at -20.6 LUFS before gain. A zh-CN voice, not one of
    // Azure's multilingual ones, so its English is unheard and it is `only`
    // for zh; `multilingual` is what keeps a zh session from marking it as
    // the wrong language.
    { name: 'Xiaoyue', provider: 'azure', multilingual: true, zhNative: true, only: 'zh', providerVoiceId: 'zh-CN-XiaoqiuNeural', gender: 'female', tier: 'premium', house: 'zh', gainDb: -1.5 },
    // Inworld: dev picks from the 2026-10-07 audition. TTS-2 is ~$25/1M and
    // TTS-2 Flash ~$15/1M, both under Chirp3-HD. English only, so none carries
    // `multilingual`. Wren and Silas are DESIGNED voices (Inworld voice design,
    // from the "soft breathy" and "warm low" descriptions): they exist only in
    // the Inworld workspace behind INWORLD_API_KEY, so a key from any other
    // account 404s them. Wren was picked on Flash; the rest on TTS-2.
    { name: 'Luna', provider: 'inworld', providerVoiceId: 'Luna:inworld-tts-2', gender: 'female', tier: 'premium', gainDb: 0 },
    { name: 'Wren', provider: 'inworld', providerVoiceId: 'keen-banjo-6800__design-voice-22273db5:inworld-tts-2-flash', gender: 'female', tier: 'value', gainDb: 3 },
    { name: 'Silas', provider: 'inworld', providerVoiceId: 'keen-banjo-6800__design-voice-446019ec:inworld-tts-2', gender: 'male', tier: 'premium', gainDb: 3 },
    { name: 'Clive (GB)', provider: 'inworld', providerVoiceId: 'Clive:inworld-tts-2', gender: 'male', tier: 'premium', gainDb: 1.5 },
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

/** The same line in Chinese, for a multilingual voice auditioned from a zh
 *  app (`lang=zh` on the preview route). Mirrors the client's zh entry for
 *  PREVIEW_PHRASE (ui/src/i18n/zh.ts); keep in sync. */
export const PREVIEW_PHRASE_ZH = '欢迎来到 aloud。我是你的引导者。';

/** The route uses `provider` to pick the key + synth call; `voiceId` is the
 *  provider-native id. */
export interface ResolvedVoice {
    provider: TtsProvider;
    voiceId: string;
    /** Azure express-as style carried by a curated voice (never on passthrough). */
    style?: string;
    /** Per-voice pace normalization (CuratedVoice.paceBias); never on passthrough. */
    paceBias?: number;
    /** Per-voice level trim (CuratedVoice.gainDb); never on passthrough. */
    gainDb?: number;
    /** Spoken lead to cut off again (CuratedVoice.lead); never on passthrough. */
    lead?: string;
}

function resolvedFrom(v: CuratedVoice): ResolvedVoice {
    return {
        provider: v.provider,
        voiceId: v.providerVoiceId,
        ...(v.style ? { style: v.style } : {}),
        ...(v.paceBias ? { paceBias: v.paceBias } : {}),
        ...(v.gainDb ? { gainDb: v.gainDb } : {}),
        ...(v.lead ? { lead: v.lead } : {}),
    };
}

/**
 * Resolve a client-supplied voice to (provider, voiceId). Accepts a curated
 * short name ("Leda", "Harper") or one it had before (`formerly`), a raw
 * Google or Azure voice id (power-user passthrough), or empty → the default
 * (steered by `available` to a provider with a key - see defaultVoice). The
 * meter bills per char at the RESOLVED
 * provider's rate, so an unrecognized value can't be a billing problem.
 */
export function resolveVoice(
    voice: string | undefined,
    available?: ReadonlySet<TtsProvider>
): ResolvedVoice {
    if (!voice) return resolvedFrom(defaultVoice(available));
    const curated = CURATED_VOICES.find((v) => v.name === voice || v.formerly?.includes(voice));
    if (curated) return resolvedFrom(curated);
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
