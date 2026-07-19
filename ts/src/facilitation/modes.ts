/**
 * Meditation modes as data, not forks — the ModeSpec registry.
 *
 * A mode bundles everything the engine needs to run a different facilitation
 * flow: its base system prompt, which user-tunable prompt dimensions still
 * compose with it, opener/check-in pools, and (for staged modes) an ordered
 * list of phases the facilitator moves through. The session view looks the
 * spec up by id; the rest of the engine stays mode-agnostic.
 *
 * Staged modes put a small state machine ON TOP of the LLM facilitation:
 * the active phase's guidance is appended to the system prompt each turn,
 * and the LLM itself signals movement by prefixing a reply with [NEXT] /
 * [BACK] — parsed exactly like [HOLD]. Advancement is deliberately
 * conservative: the protocol section tells the model to stay put when
 * unsure, because rushing a meditator past an unfinished step is the worst
 * failure mode. The same rails are intended to carry future staged modes
 * (e.g. NEDERA, meditation-pal-hysr), which can add corroboration
 * requirements on top.
 */

import { BASE_SYSTEM_PROMPT, HOLD_PREFIX } from './prompts.js';
import {
    NOTING_SYSTEM_PROMPT,
    NOTING_CHECK_IN_PROMPTS,
    NOTING_STATIC_OPENER,
} from './noting.js';
import { FELT_SENSE_MODE } from './felt-sense.js';

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export interface ModePhase {
    /** Stable id, persisted on SessionState.modePhase for resume. */
    id: string;
    /** Short user-visible hint shown in the session header ("sensing"). */
    label: string;
    /** One-line description used in the arc overview the model sees. */
    summary: string;
    /** Full facilitation guidance while this phase is active. */
    prompt: string;
}

/**
 * Which user-tunable prompt dimensions compose into the system prompt.
 * Every field defaults to true (classic exploration behavior); staged modes
 * typically turn everything off because the protocol defines attention,
 * tone, guidance level, and brevity itself. The setup UI hides the controls
 * for dimensions a mode turns off, so a stale stored value never leaks in.
 */
export interface ModeComposes {
    focuses?: boolean;
    qualities?: boolean;
    directiveness?: boolean;
    verbosity?: boolean;
    custom?: boolean;
}

export interface ModeSpec {
    /** Stable id, persisted on SessionState.meditationType. */
    id: string;
    /** User-facing mode name ("Exploration", "Felt sense"). */
    label: string;
    /** History-row label when it differs from `label` ("Noting circle"). */
    historyLabel?: string;
    /** parts[0] of the system prompt. */
    basePrompt: string;
    composes?: ModeComposes;
    /** Static opener pool (fallback when the LLM opener fails). Omitted =
     *  the classic exploration pools keyed off focuses/qualities. */
    openers?: readonly string[];
    /** Instruction for the LLM-generated opener. Omitted = classic
     *  exploration wording built from the active dimensions. */
    openerPrompt?: string;
    /** Check-in pool for long silences. Omitted = CHECK_IN_PROMPTS. */
    checkIns?: readonly string[];
    /** Ordered phases — present only for staged modes. */
    phases?: readonly ModePhase[];
    /** This mode doesn't compose directiveness but still offers the slider
     *  as a timing-only "Check-in pace" control (patient <-> attentive). The
     *  session view feeds the pace value through PromptConfig.directiveness,
     *  whose only remaining effect in such a mode is check-in timing (the
     *  [WAIT] bias + pacing seed + directive check-ins). */
    checkinPaceSlider?: boolean;
}

// ---------------------------------------------------------------------------
// Stage signals — [NEXT] / [BACK], parsed like [HOLD]
// ---------------------------------------------------------------------------

export type StageSignal = 'advance' | 'back' | 'none';

/** Literal tokens the LLM prefixes to a reply to move through the arc. */
export const NEXT_PREFIX = '[NEXT]';
export const BACK_PREFIX = '[BACK]';

/** Opening of the check-in timing token, e.g. "[WAIT:12m]" (smart timing:
 *  the LLM sets how long a following silence is protected before the next
 *  check-in may fire). */
export const WAIT_PREFIX = '[WAIT:';

// [WAIT:12m] / [WAIT:90s] / bare [WAIT:12] (minutes). Anchored — leading
// tokens only, like the other signals.
const WAIT_TOKEN_RE = /^\[WAIT:\s*(\d+)\s*(M(?:IN(?:UTE)?S?)?|S(?:EC(?:OND)?S?)?)?\s*\]/i;

/**
 * Match a leading [WAIT:Nm] token. Returns the requested interval in seconds
 * (unit defaults to minutes) plus the matched length so callers can strip it.
 * No clamping here — that's the pacing layer's policy.
 */
export function matchWaitToken(text: string): { seconds: number; length: number } | null {
    const m = WAIT_TOKEN_RE.exec(text);
    if (!m) return null;
    const n = Number(m[1]);
    const seconds = (m[2] ?? 'm').toLowerCase().startsWith('s') ? n : n * 60;
    return { seconds, length: m[0].length };
}

// Every control token the app knows, wherever it appears: [HOLD]/[NEXT]/
// [BACK], [PASS] (smart-checkin.ts declines with it), and the [WAIT:Nm]
// grammar. Used by scrubControlTokens only — semantic parsing stays anchored.
const ANY_CONTROL_TOKEN_RE =
    /\[(?:HOLD|NEXT|BACK|PASS)\]|\[WAIT:\s*\d+\s*(?:M(?:IN(?:UTE)?S?)?|S(?:EC(?:OND)?S?)?)?\s*\]/gi;

/**
 * Remove known control tokens ANYWHERE in text that is about to be spoken.
 * Small models misplace tokens mid-reply ("Sure. [HOLD] Want some quiet?");
 * a misplaced token is never honored — signals are parsed leading-only — but
 * without this it would be read aloud by TTS. Unknown bracketed text is left
 * alone: only the app's own token vocabulary is scrubbed.
 */
export function scrubControlTokens(text: string): string {
    return text
        .replace(ANY_CONTROL_TOKEN_RE, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ +([,.;:!?])/g, '$1')
        .trim();
}

export interface TurnSignals {
    /** A [HOLD] token was present — enter silence mode (same as parseHoldSignal). */
    hold: boolean;
    stage: StageSignal;
    /** Seconds from a [WAIT:Nm] token, or null when absent. Unclamped. */
    waitSec: number | null;
    /** Response with leading control tokens stripped and any stray mid-text
     *  ones scrubbed (scrubControlTokens); this is what gets spoken. */
    cleanText: string;
}

/**
 * Parse the control tokens ([HOLD], [NEXT], [BACK], [WAIT:Nm]) off the start
 * of an LLM reply, in any order and combination. Tokens appearing mid-text
 * are never honored — only a leading run counts, mirroring parseHoldSignal —
 * but they are scrubbed from cleanText so a misplaced token is never spoken
 * (or recorded back into history, where it would re-teach the placement). If
 * the model emits contradictory tokens, the first one wins.
 */
export function parseTurnSignals(response: string): TurnSignals {
    let text = response.trim();
    let hold = false;
    let stage: StageSignal = 'none';
    let waitSec: number | null = null;
    for (;;) {
        const upper = text.toUpperCase();
        const wait = matchWaitToken(text);
        if (wait) {
            if (waitSec === null) waitSec = wait.seconds;
            text = text.slice(wait.length).trimStart();
        } else if (upper.startsWith(HOLD_PREFIX)) {
            hold = true;
            text = text.slice(HOLD_PREFIX.length).trimStart();
        } else if (upper.startsWith(NEXT_PREFIX)) {
            if (stage === 'none') stage = 'advance';
            text = text.slice(NEXT_PREFIX.length).trimStart();
        } else if (upper.startsWith(BACK_PREFIX)) {
            if (stage === 'none') stage = 'back';
            text = text.slice(BACK_PREFIX.length).trimStart();
        } else {
            break;
        }
    }
    return { hold, stage, waitSec, cleanText: scrubControlTokens(text) };
}

// ---------------------------------------------------------------------------
// Staged-mode controller
// ---------------------------------------------------------------------------

/**
 * Tracks the active phase of a staged mode and renders the per-phase system
 * prompt section. One instance lives for the duration of a session; the
 * session view applies each turn's parsed StageSignal and persists the
 * resulting phase id (SessionState.modePhase) so an interrupted session
 * resumes where it left off.
 */
export class StagedModeController {
    readonly spec: ModeSpec;
    private index: number;

    constructor(spec: ModeSpec, initialPhaseId?: string) {
        if (!spec.phases || spec.phases.length === 0) {
            throw new Error(`Mode '${spec.id}' has no phases`);
        }
        this.spec = spec;
        const idx = initialPhaseId
            ? spec.phases.findIndex((p) => p.id === initialPhaseId)
            : 0;
        // An unknown persisted id (e.g. a phase renamed between releases)
        // falls back to the first phase rather than failing the session.
        this.index = idx >= 0 ? idx : 0;
    }

    get phases(): readonly ModePhase[] {
        return this.spec.phases as readonly ModePhase[];
    }

    get phase(): ModePhase {
        return this.phases[this.index] as ModePhase;
    }

    get phaseIndex(): number {
        return this.index;
    }

    /**
     * Apply an LLM stage signal, clamped at both ends of the arc.
     * Returns true when the active phase actually changed.
     */
    apply(signal: StageSignal): boolean {
        const last = this.phases.length - 1;
        const next =
            signal === 'advance'
                ? Math.min(this.index + 1, last)
                : signal === 'back'
                  ? Math.max(this.index - 1, 0)
                  : this.index;
        const changed = next !== this.index;
        this.index = next;
        return changed;
    }

    /**
     * The system-prompt section for the active phase: arc overview, the
     * phase's guidance, and the movement protocol. Pass the result to
     * PromptBuilder.buildSystemPrompt(). Rebuilt every turn; a phase shift
     * invalidates the prompt-cache prefix once, which is acceptable
     * (meditation-pal-jqvh).
     */
    promptSection(): string {
        return buildStageSection(this.spec, this.index);
    }
}

function buildStageSection(spec: ModeSpec, index: number): string {
    const phases = spec.phases as readonly ModePhase[];
    const phase = phases[index] as ModePhase;
    const first = index === 0;
    const last = index === phases.length - 1;
    const arc = phases
        .map(
            (p, i) =>
                `${i + 1}. ${p.label}: ${p.summary}${i === index ? '  <- you are here' : ''}`
        )
        .join('\n');

    const lines = [
        'Session arc — this practice moves through stages. The meditator does not see this list; you hold it for them:',
        arc,
        '',
        phase.prompt.trim(),
        '',
        `Moving between stages — ${NEXT_PREFIX} / ${BACK_PREFIX} signals:`,
        'You decide movement through the arc with a hidden control token at the very start of your reply (stripped before speech, like [HOLD]):',
    ];
    if (!last) {
        lines.push(
            `- Start with ${NEXT_PREFIX} when the stage guidance above says this stage's work is complete — shown by the meditator's own words, not by your hopes for them. The rest of that same reply should already be facilitating the next stage, naturally.`
        );
    }
    if (!first) {
        lines.push(
            `- Start with ${BACK_PREFIX} when the meditator needs the previous stage again (contact lost, too much too fast, or the guidance above says so).`
        );
    }
    lines.push(
        '- When unsure, stay: no token. Moving too early is far worse than staying a little long.',
        '- Never mention stages, steps, or these tokens out loud. The arc is invisible; you simply speak naturally.',
        `- A stage token can combine with [HOLD] when silence is also right, e.g. "${NEXT_PREFIX} [HOLD] Take all the time you need."`
    );
    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The classic mode. No openers/openerPrompt here on purpose: PromptBuilder's
 *  built-in pools (keyed off focuses/qualities/directiveness) are richer than
 *  a flat list, so this spec behaves identically to passing no mode at all. */
export const EXPLORATION_MODE: ModeSpec = {
    id: 'exploration',
    label: 'Exploration',
    basePrompt: BASE_SYSTEM_PROMPT,
};

/** Registered for labels/registry completeness; the noting circle has its own
 *  orchestration (noting.ts + the noting-session view) and doesn't run
 *  through PromptBuilder. */
export const NOTING_MODE: ModeSpec = {
    id: 'noting',
    label: 'Noting',
    historyLabel: 'Noting circle',
    basePrompt: NOTING_SYSTEM_PROMPT,
    composes: { focuses: false, qualities: false, directiveness: false, verbosity: false, custom: false },
    openers: [NOTING_STATIC_OPENER],
    checkIns: NOTING_CHECK_IN_PROMPTS,
};

const MODES: ReadonlyMap<string, ModeSpec> = new Map(
    [EXPLORATION_MODE, NOTING_MODE, FELT_SENSE_MODE].map((m) => [m.id, m])
);

export function getMode(id: string | undefined): ModeSpec | undefined {
    return id !== undefined ? MODES.get(id) : undefined;
}

export function listModes(): ModeSpec[] {
    return [...MODES.values()];
}
