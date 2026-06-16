/**
 * Typed setup state + persistence.
 *
 * Maps the existing setup-form shape onto the PromptBuilder's
 * config shape. The slider is 0-4 for UX; we map to 0/3/5/7/10 for
 * the PromptBuilder so it lines up with the Python implementation's
 * DIRECTIVENESS_ADDITIONS keys.
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
    /** Capability this provider needs to be usable. Omitted = always available
     *  (BYOK providers work from any browser with a key). The menu hides
     *  providers whose capability the environment can't reach. */
    requires?: Capability;
}

export const ALL_PROVIDERS: ReadonlyArray<ProviderMeta> = [
    // aloud cloud: no key, no local model — credits-metered premium
    // LLMs. The only LLM source for the web tier (meditation-pal-vd3). Shown
    // only when aloud cloud is reachable.
    { value: 'aloud', label: 'aloud cloud', needsKey: false, requires: 'cloud' },
    // Local Ollama — only when a daemon is actually reachable (e.g. not on the
    // hosted website).
    { value: 'ollama', label: 'Ollama (Local)', needsKey: false, requires: 'ollama' },
    // claude_proxy shells out to the local `claude` CLI via Flask — desktop only.
    { value: 'claude_proxy', label: 'Anthropic (Subscription)', needsKey: false, requires: 'flask' },
    { value: 'anthropic', label: 'Anthropic (API Key)', needsKey: true },
    { value: 'openai', label: 'OpenAI (API Key)', needsKey: true },
    { value: 'groq', label: 'Groq (API Key)', needsKey: true },
    { value: 'openrouter', label: 'OpenRouter (API Key)', needsKey: true },
    { value: 'venice', label: 'Venice.ai (API Key)', needsKey: true },
];

export interface ProviderAvailabilityOpts {
    /** Web mode — the hosted browser deployment (app-mode.isWebMode()): Ollama +
     *  local providers off, BYOK off unless opted in. Defaults by environment
     *  (desktop/dev = local, hosted browser = web); a dev override can force it
     *  (see app-mode.ts). */
    webMode?: boolean;
    /** User opted into bring-your-own-key in web mode. */
    allowByok?: boolean;
}

/** Whether a provider belongs in the menu at all on this platform — a
 *  structural filter, NOT a runtime-readiness check. Runtime readiness (a key
 *  entered, the Ollama daemon up, the `claude` CLI logged in) is shown via the
 *  ✘/✱ markers (provider-markers.ts), not by removing the option.
 *
 *  - Web (the hosted demo): only browser-runnable providers. Ollama (local
 *    daemon) and claude_proxy (local CLI) can NEVER run in a tab, so they're
 *    hidden regardless of what a stray local probe found; aloud cloud needs the
 *    service; BYOK API providers are opt-in (asking a public site's visitors for
 *    their own key feels wrong).
 *  - Local (desktop / full dev): nothing is removed — every provider is
 *    platform-possible, and the markers say which are ready.
 *  - A future mobile build would filter here too (hide claude_proxy; decide
 *    whether BYOK defaults on). */
export function isProviderAvailable(
    meta: ProviderMeta,
    caps: Capabilities,
    opts: ProviderAvailabilityOpts = {}
): boolean {
    if (opts.webMode) {
        if (meta.requires === 'ollama' || meta.requires === 'flask') return false;
        if (meta.requires === 'cloud') return caps.cloud;
        return opts.allowByok === true;
    }
    return true;
}

export function providerNeedsKey(p: Provider): boolean {
    return ALL_PROVIDERS.find((x) => x.value === p)?.needsKey ?? false;
}

/** The modes the setup tab bar offers — ModeSpec ids from facilitation/modes.ts.
 *  (SessionState.meditationType is a plain string for forward compatibility;
 *  this union is just the UI's closed list of tabs.) */
export type MeditationType = 'exploration' | 'noting' | 'felt_sense';

export interface SessionSetup {
    /** Which top-level meditation mode the user is in. */
    meditationType: MeditationType;
    /**
     * The ACTIVE mode's intention — what sessions, prompts, and history
     * consume. Kept in sync with intentionByMode[meditationType] by the
     * setup view (and normalized on load), so downstream code never has
     * to know about the per-mode split.
     */
    intention: string;
    /**
     * Per-mode intention drafts. Exploration's "intention" and felt
     * sense's "something to sit with" are semantically different inputs,
     * so each tab keeps its own text instead of sharing one value that
     * leaks across mode switches. Noting has no intention field — its
     * slot stays empty.
     */
    intentionByMode: Partial<Record<MeditationType, string>>;
    preset: string | null;
    focuses: Focus[];
    qualities: Quality[];
    /** UI slider value 0-4. Map via DIRECTIVENESS_VALUES below. */
    dirStep: number;
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
     * Noting circle participants (noting mode only). Empty = solo noting (just
     * you + an opener). Each LLM participant takes a turn after you, generating
     * a 1–2 word label in its own voice.
     */
    notingParticipants: NotingParticipantConfig[];
    /** Play a sound when it becomes the user's turn in the noting circle. */
    notingUserTurnCue: boolean;
    /** Which cue sound to play; null = the built-in synth chime. */
    notingUserTurnCueSound: NotingSound | null;
}

export type NotingReactive = 'none' | 'low' | 'high';
export type NotingTiming = 'adaptive' | 'fixed';

/** Sound effects bundled in ui/public/audio (and src/web/static/audio). */
export const NOTING_SOUNDS = ['bell', 'bottle', 'card', 'crow', 'plop', 'poof', 'rattle'] as const;
export type NotingSound = (typeof NOTING_SOUNDS)[number];

/**
 * One configured noting-circle participant. Mirrors the Flask participant
 * model: an AI that notes a generated label, a fixed phrase spoken aloud, or a
 * sound effect. Timing is adaptive (matches the user's cadence) or a fixed
 * number of seconds before the participant takes its turn.
 */
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

export function dirStepToBackend(step: number): number {
    const v = DIRECTIVENESS_VALUES[Math.max(0, Math.min(step, DIRECTIVENESS_VALUES.length - 1))];
    return v ?? 3;
}

export const defaultSetup: SessionSetup = {
    meditationType: 'exploration',
    intention: '',
    intentionByMode: {},
    preset: 'pleasant_play',
    focuses: ['body_sensations', 'emotions'],
    qualities: ['playful', 'feeling_good'],
    dirStep: 1,
    verbosity: 'medium',
    customInstructions: '',
    provider: 'ollama',
    model: '',
    voice: null,
    ttsRate: 160,
    // Default circle: one AI participant at the settings default voice, middle
    // reactivity, adaptive timing. (voice: null = inherit the resolved default.)
    notingParticipants: [{ type: 'llm', voice: null, reactive: 'low', timing: 'adaptive', fixedDelaySec: 4 }],
    notingUserTurnCue: false,
    notingUserTurnCueSound: null,
};

const SETTINGS_KEY = 'preview:setup';
const kv = new LocalStorageKv();

export async function loadSetup(): Promise<SessionSetup> {
    // Two different inheritance rules, on purpose:
    //
    //  - provider/model: the app default merely *seeds* a fresh setup; a
    //    per-session override persisted in 'preview:setup' wins. (Trying a
    //    different provider for one session is a reasonable thing to want.)
    //
    //  - voice/ttsRate: the app-level default is *canonical* and ALWAYS wins.
    //    There is no separate per-session voice — the setup picker writes
    //    through to app settings (see setup.ts:persistDefaultVoice). This is
    //    the fix for meditation-pal-9hu: previously any setup interaction
    //    persisted setup.voice, which then shadowed the Settings default
    //    forever, so changing the default voice never took effect.
    const s = await loadAppSettings();
    const base: SessionSetup = {
        ...defaultSetup,
        provider: s.defaultProvider,
        model: s.defaultModel,
    };
    const raw = await kv.get(SETTINGS_KEY);
    let merged = base;
    if (raw) {
        try {
            merged = { ...base, ...(JSON.parse(raw) as Partial<SessionSetup>) };
        } catch {
            merged = base;
        }
    }
    // App-level voice/rate are the single source of truth — clobber any
    // value that an older 'preview:setup' may have persisted.
    merged.voice = s.defaultVoice;
    merged.ttsRate = s.defaultTtsRate;
    // Migrate a pre-split setup (single shared intention, no per-mode map):
    // credit the legacy text to the mode it was last used with. Then make
    // `intention` canonical-for-the-active-mode, so a value typed under a
    // different tab can't leak into this one.
    if (!merged.intentionByMode || Object.keys(merged.intentionByMode).length === 0) {
        merged.intentionByMode = merged.intention
            ? { [merged.meditationType]: merged.intention }
            : {};
    }
    merged.intention = merged.intentionByMode[merged.meditationType] ?? '';
    return merged;
}

export async function saveSetup(setup: SessionSetup): Promise<void> {
    await kv.set(SETTINGS_KEY, JSON.stringify(setup));
}
