/**
 * Typed setup state + persistence. Maps the setup-form shape onto the
 * PromptBuilder's config. The slider is 0-4 for UX; DIRECTIVENESS_VALUES maps
 * it to 0/3/5/7/10 to line up with the DIRECTIVENESS_ADDITIONS keys.
 */

import type {
    Focus,
    Quality,
    Verbosity,
} from '../../src/facilitation/index.js';
import { LocalStorageKv } from './adapters/localstorage-kv.js';
import { loadAppSettings } from './app-settings.js';
import type { Capability, Capabilities } from './capabilities.js';

export type Provider =
    | 'aloud'
    | 'ollama'
    | 'claude_proxy'
    | 'anthropic'
    | 'openai'
    | 'openrouter'
    | 'venice'
    | 'groq';

export interface ProviderMeta {
    value: Provider;
    label: string;
    needsKey: boolean;
    /** Capability this provider needs. Omitted = always available (BYOK works
     *  from any browser with a key). The menu hides providers whose capability
     *  the environment can't reach. */
    requires?: Capability;
}

export const ALL_PROVIDERS: ReadonlyArray<ProviderMeta> = [
    // Credits-metered premium LLMs, no key or local model. The only LLM source
    // for the web tier (meditation-pal-vd3).
    { value: 'aloud', label: 'aloud cloud', needsKey: false, requires: 'cloud' },
    // Only when a local daemon is reachable (so, not on the hosted website).
    { value: 'ollama', label: 'Ollama (Local)', needsKey: false, requires: 'ollama' },
    // Shells out to the local `claude` CLI via the app backend - desktop only.
    { value: 'claude_proxy', label: 'Anthropic (Subscription)', needsKey: false, requires: 'flask' },
    { value: 'anthropic', label: 'Anthropic (API Key)', needsKey: true },
    { value: 'openai', label: 'OpenAI (API Key)', needsKey: true },
    { value: 'groq', label: 'Groq (API Key)', needsKey: true },
    { value: 'openrouter', label: 'OpenRouter (API Key)', needsKey: true },
    { value: 'venice', label: 'Venice.ai (API Key)', needsKey: true },
];

export interface ProviderAvailabilityOpts {
    /** Web mode (app-mode.isWebMode()): local providers off, BYOK off unless
     *  opted in. */
    webMode?: boolean;
    /** User opted into bring-your-own-key in web mode. */
    allowByok?: boolean;
}

/** Whether a provider belongs in the menu on this platform: a structural
 *  filter, NOT a runtime-readiness check. Readiness (key entered, Ollama daemon
 *  up, `claude` CLI logged in) shows via the ✘/✱ markers (provider-markers.ts),
 *  not by removing the option.
 *
 *  - Web: only browser-runnable providers. Ollama and claude_proxy can never run
 *    in a tab, so they're hidden regardless of what a stray local probe found;
 *    BYOK is opt-in (asking a public site's visitors for their key feels wrong).
 *  - Local (desktop / dev): nothing is removed; the markers say what's ready. */
export function isProviderAvailable(
    meta: ProviderMeta,
    caps: Capabilities,
    opts: ProviderAvailabilityOpts = {}
): boolean {
    if (opts.webMode) {
        if (meta.requires === 'ollama' || meta.requires === 'flask') return false;
        // Always offered on web - it's the point of the hosted app. Whether
        // it's reachable right now is a transient question, surfaced at the
        // model picker + Begin gate so the option never vanishes on a blip.
        if (meta.requires === 'cloud') return true;
        return opts.allowByok === true;
    }
    return true;
}

export function providerNeedsKey(p: Provider): boolean {
    return ALL_PROVIDERS.find((x) => x.value === p)?.needsKey ?? false;
}

/**
 * Pick a provider that can actually run in the current mode, given a seeded
 * default. The app default is 'ollama' (desktop-only), so a fresh web setup must
 * not stay on it, or the model picker shows a nonsensical "Install Ollama".
 * On web, an unavailable seed falls back to the first available provider, then
 * to 'aloud' when none is reachable, so the picker surfaces the "cloud
 * unreachable" message rather than the Ollama one. Local mode returns the seed
 * unchanged (readiness shows via markers).
 */
export function resolveSetupProvider(
    provider: Provider,
    caps: Capabilities,
    opts: ProviderAvailabilityOpts
): Provider {
    if (!opts.webMode) return provider;
    const available = ALL_PROVIDERS.filter((p) => isProviderAvailable(p, caps, opts));
    if (available.some((p) => p.value === provider)) return provider;
    return (available[0]?.value ?? 'aloud') as Provider;
}

/** The modes the setup tab bar offers - ModeSpec ids from facilitation/modes.ts.
 *  (SessionState.meditationType is a plain string for forward compatibility;
 *  this union is just the UI's closed list of tabs.) */
export type MeditationType = 'exploration' | 'noting' | 'felt_sense';

export interface SessionSetup {
    /** Which top-level meditation mode the user is in. */
    meditationType: MeditationType;
    /**
     * The ACTIVE mode's intention - what sessions, prompts, and history consume.
     * The setup view keeps it in sync with intentionByMode[meditationType] (and
     * load normalizes it), so downstream code never sees the per-mode split.
     */
    intention: string;
    /**
     * Per-mode intention drafts. Exploration's "intention" and felt sense's
     * "something to sit with" are different inputs, so each tab keeps its own
     * text rather than leaking one value across mode switches. Noting has no
     * intention field.
     */
    intentionByMode: Partial<Record<MeditationType, string>>;
    focuses: Focus[];
    qualities: Quality[];
    /** UI slider value 0-4. Map via DIRECTIVENESS_VALUES below. */
    dirStep: number;
    /**
     * Felt sense's "Check-in pace" slider (0-4). Same stops and mapping as
     * dirStep but kept separate: it drives ONLY smart check-in timing (patient
     * <-> attentive), never directiveness, which the felt-sense protocol owns.
     */
    feltSensePaceStep: number;
    /**
     * Felt sense's "Check in if I'm quiet" toggle. Felt sense owns its own
     * check-in timing rather than deferring to the app-level Check-In Timing
     * setting (which isn't reachable from the setup page): on = smart timing
     * paced by feltSensePaceStep, off = no silence check-ins at all.
     */
    feltSenseCheckins: boolean;
    verbosity: Verbosity;
    customInstructions: string;
    provider: Provider;
    model: string;
    /**
     * Voice ID from voices.ts. null = use the browser's default voice.
     * Format: 'browser:<voiceURI>' or 'server:<engine-voice-name>'.
     */
    voice: string | null;
    /** TTS rate in words-per-minute. Browser TTS normalizes; server TTS passes through. */
    ttsRate: number;
    /**
     * Noting circle participants (noting mode only). Empty = solo noting. Each
     * LLM participant takes a turn after you with a 1-2 word label in its own
     * voice.
     */
    notingParticipants: NotingParticipantConfig[];
    /** Play a sound when it becomes the user's turn in the noting circle. */
    notingUserTurnCue: boolean;
    /** Which cue sound to play; null = the built-in synth chime. */
    notingUserTurnCueSound: NotingSound | null;
}

export type NotingReactive = 'none' | 'low' | 'high';
export type NotingTiming = 'adaptive' | 'fixed';

/** Sound effects bundled in ui/public/audio. */
export const NOTING_SOUNDS = ['bell', 'bottle', 'card', 'crow', 'plop', 'poof', 'rattle'] as const;
export type NotingSound = (typeof NOTING_SOUNDS)[number];

/**
 * One noting-circle participant: an AI noting a generated label, a fixed phrase
 * spoken aloud, or a sound effect. Timing is adaptive (matches the user's
 * cadence) or a fixed number of seconds before the turn.
 */
/**
 * Whether a session in this mode will actually call an LLM.
 *
 * Exploration and the staged modes always do. A noting circle only does when a
 * participant is an AI: 'fixed' participants speak a set phrase and 'sound'
 * ones play a cue, and the facilitator's opener is NOTING_STATIC_OPENER, so a
 * circle of those (or a solo circle with none at all) generates no text.
 *
 * One predicate because three places have to agree - the cloud gate, the setup
 * pickers, and the noting view. When they disagreed, a circle that makes zero
 * LLM calls still demanded sign-in, which broke the "noting works with no
 * account" claim the store listing rests on (meditation-pal-vr3w).
 */
export function sessionNeedsLlm(
    mode: MeditationType,
    participants: NotingParticipantConfig[] | undefined
): boolean {
    if (mode !== 'noting') return true;
    return (participants ?? []).some((p) => p.type === 'llm');
}

export type NotingParticipantConfig =
    | {
          type: 'llm';
          /** Voice id ('browser:<name>' | 'server:<name>'). */
          voice: string | null;
          /** How much this participant reacts to what others have noted. */
          reactive: NotingReactive;
          timing: NotingTiming;
          /** Seconds before this turn, when timing === 'fixed'. */
          fixedDelaySec: number;
      }
    | {
          type: 'fixed';
          voice: string | null;
          /** The phrase this participant always says. */
          phrase: string;
          timing: NotingTiming;
          fixedDelaySec: number;
      }
    | {
          type: 'sound';
          /** A bundled effect, or 'chime' for the built-in synth chime. */
          sound: NotingSound | 'chime';
          timing: NotingTiming;
          fixedDelaySec: number;
      };

export const DIRECTIVENESS_VALUES: readonly number[] = [0, 3, 5, 7, 10];

/** Display names for the five guidance-slider stops (indexed by dirStep). */
export const GUIDANCE_LEVEL_LABELS: readonly string[] = [
    'Following',
    'Somewhat following',
    'Balanced',
    'Somewhat directing',
    'Directing',
];

/** Display names for the five felt-sense check-in pace stops (indexed by
 *  feltSensePaceStep). Same wait mapping as the guidance stops (20m -> 30s),
 *  framed as presence during silence rather than directiveness. */
export const CHECKIN_PACE_LABELS: readonly string[] = [
    'Very patient',
    'Patient',
    'Moderate',
    'Attentive',
    'Very attentive',
];

export const VERBOSITY_LABELS: Readonly<Record<Verbosity, string>> = {
    low: 'Brief',
    medium: 'Medium',
    high: 'Longer',
};

export const FOCUS_LABELS: Readonly<Record<Focus, string>> = {
    body_sensations: 'Body & sensations',
    emotions: 'Emotions & feeling tone',
    inner_parts: 'Parts & inner world',
    open_awareness: 'Open awareness',
};

export const QUALITY_LABELS: Readonly<Record<Quality, string>> = {
    playful: 'Playful & light',
    compassionate: 'Compassionate',
    loving: 'Loving & kind',
    spacious: 'Spacious',
    effortless: 'Effortless',
    feeling_good: 'Feeling good',
};

export function dirStepToBackend(step: number): number {
    const v = DIRECTIVENESS_VALUES[Math.max(0, Math.min(step, DIRECTIVENESS_VALUES.length - 1))];
    return v ?? 3;
}

export const defaultSetup: SessionSetup = {
    meditationType: 'exploration',
    intention: '',
    intentionByMode: {},
    focuses: ['body_sensations', 'emotions'],
    qualities: ['feeling_good'],
    dirStep: 2,
    feltSensePaceStep: 1,
    feltSenseCheckins: true,
    verbosity: 'medium',
    customInstructions: '',
    provider: 'ollama',
    model: '',
    voice: null,
    ttsRate: 160,
    // One AI participant, adaptive timing. (voice: null = inherit the default.)
    notingParticipants: [{ type: 'llm', voice: null, reactive: 'low', timing: 'adaptive', fixedDelaySec: 4 }],
    notingUserTurnCue: false,
    notingUserTurnCueSound: null,
};

const SETTINGS_KEY = 'preview:setup';
// Lazy for the same reason as app-settings.ts: importing this module for a pure
// helper must not construct a storage backend (LocalStorageKv throws outside a
// browser).
let lazyKv: LocalStorageKv | null = null;
function kv(): LocalStorageKv {
    if (!lazyKv) lazyKv = new LocalStorageKv();
    return lazyKv;
}

export async function loadSetup(): Promise<SessionSetup> {
    // Two inheritance rules, on purpose:
    //
    //  - provider/model: the app default only *seeds* a fresh setup; a
    //    per-session override in 'preview:setup' wins.
    //
    //  - voice/ttsRate: the app-level default is canonical and ALWAYS wins.
    //    There is no per-session voice; the setup picker writes through to app
    //    settings (setup.ts:persistDefaultVoice). Fix for meditation-pal-9hu:
    //    setup.voice used to shadow the Settings default forever, so changing
    //    the default voice never took effect.
    const s = await loadAppSettings();
    const base: SessionSetup = {
        ...defaultSetup,
        provider: s.defaultProvider,
        model: s.defaultModel,
    };
    const raw = await kv().get(SETTINGS_KEY);
    let merged = base;
    if (raw) {
        try {
            merged = { ...base, ...(JSON.parse(raw) as Partial<SessionSetup>) };
        } catch {
            merged = base;
        }
    }
    // App-level voice/rate win; clobber anything an older 'preview:setup' has.
    merged.voice = s.defaultVoice;
    merged.ttsRate = s.defaultTtsRate;
    // Migrate a pre-split setup (one shared intention, no per-mode map): credit
    // the legacy text to the mode it was last used with, then make `intention`
    // canonical for the active mode so another tab's value can't leak in.
    if (!merged.intentionByMode || Object.keys(merged.intentionByMode).length === 0) {
        merged.intentionByMode = merged.intention
            ? { [merged.meditationType]: merged.intention }
            : {};
    }
    merged.intention = merged.intentionByMode[merged.meditationType] ?? '';
    return merged;
}

export async function saveSetup(setup: SessionSetup): Promise<void> {
    await kv().set(SETTINGS_KEY, JSON.stringify(setup));
}
