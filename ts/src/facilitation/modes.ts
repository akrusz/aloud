/**
 * Meditation modes as data, not forks: the ModeSpec registry.
 *
 * A mode bundles what the engine needs to run a different facilitation flow:
 * base system prompt, which user-tunable dimensions still compose, opener and
 * check-in pools, and for staged modes an ordered phase list. The session view
 * looks the spec up by id; the rest of the engine stays mode-agnostic.
 *
 * Staged modes put a small state machine on top of the LLM: the active phase's
 * guidance is appended to the system prompt each turn, and the LLM signals
 * movement by prefixing [NEXT]/[BACK], parsed like [HOLD]. Advancement is
 * conservative - the protocol section tells the model to stay put when unsure,
 * since rushing a meditator past an unfinished step is the worst failure mode.
 * Future staged modes (NEDERA, meditation-pal-hysr) ride the same rails and can
 * add corroboration requirements on top.
 */

import { BASE_SYSTEM_PROMPT, HOLD_PREFIX } from './prompts.js';
import {
    NOTING_SYSTEM_PROMPT,
    NOTING_CHECK_IN_PROMPTS,
    NOTING_STATIC_OPENER,
} from './noting.js';
import { FELT_SENSE_MODE } from './felt-sense.js';

// Spec types

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
 * Which user-tunable prompt dimensions compose into the system prompt. Fields
 * default to true (classic exploration); staged modes usually turn all off,
 * since the protocol defines attention, tone, guidance, and brevity itself.
 * The setup UI hides controls a mode turns off, so no stale stored value leaks.
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
    /** Static opener pool (fallback when the LLM opener fails). Omitted = the
     *  classic exploration pools keyed off focuses/qualities. */
    openers?: readonly string[];
    /** Instruction for the LLM-generated opener. Omitted = classic exploration
     *  wording built from the active dimensions. */
    openerPrompt?: string;
    /** Rotating entry invitations folded into the LLM opener one at a time, so
     *  sessions don't all begin the same way. Each must be a faithful doorway
     *  into the mode. Only used alongside openerPrompt. */
    openerAngles?: readonly string[];
    /** Check-in pool for long silences. Omitted = CHECK_IN_PROMPTS. */
    checkIns?: readonly string[];
    /** Ordered phases, present only for staged modes. */
    phases?: readonly ModePhase[];
    /** The mode doesn't compose directiveness but still shows the slider as a
     *  timing-only "Check-in pace" control (patient <-> attentive). The session
     *  view feeds the pace through PromptConfig.directiveness, whose only
     *  remaining effect here is check-in timing ([WAIT] bias, pacing seed,
     *  directive check-ins). */
    checkinPaceSlider?: boolean;
}

// Stage signals: [NEXT] / [BACK], parsed like [HOLD].

export type StageSignal = 'advance' | 'back' | 'none';

/** Literal tokens the LLM prefixes to a reply to move through the arc. What the
 *  prompts ask for; the parser below also accepts sloppier renderings. */
export const NEXT_PREFIX = '[NEXT]';
export const BACK_PREFIX = '[BACK]';

/** Opening of the check-in timing token, e.g. "[WAIT:12m]": smart timing, where
 *  the LLM sets how long the following silence is protected before the next
 *  check-in may fire. */
export const WAIT_PREFIX = '[WAIT:';

// --- Token grammar ---------------------------------------------------------
//
// Models render control tokens imperfectly, and every near-miss has two costs:
// the signal isn't honored, AND the token gets spoken. So the grammar is
// deliberately loose about presentation while staying strict about which words
// count as tokens.
//
// Tolerated: inner whitespace ("[ HOLD ]"), angle brackets from models that
// default to XML-ish tags ("<HOLD>"), and a wrapping layer of markdown, quotes,
// or redundant brackets ("**[HOLD]**", "([NEXT])", "[[HOLD]]"). The wrapper is
// consumed WITH the token, so stripping never leaves an orphan "( )" or "** **"
// behind to be read aloud.
//
// Not tolerated: bare words. "(hold)" and a reply opening "Back to the breath"
// are ordinary facilitation language, so a token always needs a bracket.

/** Markdown emphasis, quotes, or a redundant bracket layer around a token. */
const WRAP_OPEN = String.raw`[*_"'“‘([{]*\s*`;
const WRAP_CLOSE = String.raw`\s*[*_"'”’)\]}]*`;
/** The token's own delimiters. `[` is what we ask for; `<` and `{` are the
 *  common slips. Parens are handled separately (PAREN_*), case-sensitively. */
const DELIM_OPEN = String.raw`[[<{]\s*`;
const DELIM_CLOSE = String.raw`\s*[\]>}]`;

const NAMED_BODY = String.raw`HOLD|NEXT|BACK|PASS`;
const WAIT_BODY = String.raw`WAIT\s*:\s*(\d+)\s*(M(?:IN(?:UTE)?S?)?|S(?:EC(?:OND)?S?)?)?`;

const WAIT_TOKEN_RE = new RegExp(
    `^${WRAP_OPEN}${DELIM_OPEN}(?:${WAIT_BODY})${DELIM_CLOSE}${WRAP_CLOSE}`,
    'i'
);
const NAMED_TOKEN_RE = new RegExp(
    `^${WRAP_OPEN}${DELIM_OPEN}(${NAMED_BODY})${DELIM_CLOSE}${WRAP_CLOSE}`,
    'i'
);
/** A leading token missing one delimiter ("[HOLD Take your time", "HOLD] ..."):
 *  honored only at position 0, and only when the word stands alone, so
 *  "BACKground" and ordinary prose are untouched. */
const HALF_TOKEN_RE = new RegExp(
    String.raw`^(?:\[\s*(${NAMED_BODY})(?=[\s.,;:!?]|$)|(${NAMED_BODY})\s*\])`,
    'i'
);
/** Parenthesized tokens, ALL-CAPS only. "(HOLD)" is a mangled token; "(hold)"
 *  is a facilitator saying hold, so case is the only safe discriminator here. */
const PAREN_TOKEN_SRC = `${WRAP_OPEN}\\(\\s*(${NAMED_BODY})\\s*\\)${WRAP_CLOSE}`;
const PAREN_TOKEN_RE = new RegExp(`^${PAREN_TOKEN_SRC}`);

/**
 * Match a leading [WAIT:Nm] token. Returns the interval in seconds (unit
 * defaults to minutes) plus the matched length so callers can strip it.
 * Clamping is the pacing layer's policy, not done here.
 */
export function matchWaitToken(text: string): { seconds: number; length: number } | null {
    const m = WAIT_TOKEN_RE.exec(text);
    if (!m) return null;
    const n = Number(m[1]);
    const seconds = (m[2] ?? 'm').toLowerCase().startsWith('s') ? n : n * 60;
    return { seconds, length: m[0].length };
}

/** Match a leading [HOLD]/[NEXT]/[BACK]/[PASS], however rendered. */
function matchNamedToken(text: string): { name: string; length: number } | null {
    const m = NAMED_TOKEN_RE.exec(text) ?? PAREN_TOKEN_RE.exec(text) ?? HALF_TOKEN_RE.exec(text);
    const name = m && (m[1] ?? m[2]);
    return name ? { name: name.toUpperCase(), length: m[0].length } : null;
}

// Every control token the app knows, wherever it appears. Used by
// scrubControlTokens only; semantic parsing stays anchored.
const ANY_CONTROL_TOKEN_RE = new RegExp(
    `${WRAP_OPEN}${DELIM_OPEN}(?:${NAMED_BODY}|${WAIT_BODY}|WAIT)${DELIM_CLOSE}${WRAP_CLOSE}`,
    'gi'
);
/** The paren form, scrubbed globally but still ALL-CAPS only (no `i` flag). */
const ANY_PAREN_TOKEN_RE = new RegExp(PAREN_TOKEN_SRC, 'g');

/**
 * Anything else shaped like a control token: a bracketed ALL-CAPS word the model
 * invented ("[PAUSE]", "<SILENCE>", "[WAIT:]"). Never honored, but the user must
 * never hear or read a tag, so unrecognized ones are dropped too. Requires all
 * caps, which no ordinary facilitation line uses, so real bracketed prose lives.
 */
const TAG_SHAPED_RE = /[*_"']*[[<{]\s*[A-Z][A-Z0-9 _:.-]{0,23}\s*[\]>}][*_"']*/g;

/**
 * A reasoning block and its CONTENTS - local models reason in <think> by
 * default (deepseek-r1, qwen3), and a hosted one told not to think can still
 * leak a <thinking>. Dropping only the tags would leave the reasoning to be read
 * aloud, which is worse. CLOSED blocks only: an unclosed one (reasoning cut off
 * by the token cap) just loses its tag below, since a stray spoken line beats a
 * silent turn.
 */
const REASONING_BLOCK_RE = /<(think|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Any other XML/HTML-shaped tag, contents kept. A spoken turn never needs
 * markup, so this is a blanket net rather than a list of tags that have bitten
 * us. Requires a letter straight after the "<", so prose survives ("3 < 5").
 */
const XML_TAG_RE = /<\/?[a-z][\w.:-]*(?:\s[^<>]*?)?\/?>/gi;

/**
 * Remove control tokens ANYWHERE in text about to be spoken. Small models
 * misplace them mid-reply ("Sure. [HOLD] Want some quiet?"); a misplaced token
 * is never honored (signals parse leading-only) but would otherwise be read
 * aloud. Also drops reasoning blocks and stray markup (REASONING_BLOCK_RE,
 * XML_TAG_RE), tag-shaped leftovers (TAG_SHAPED_RE), and tidies the punctuation
 * a removal can strand.
 *
 * In code, not a prompt rule: the models most likely to emit markup are the
 * local ones least likely to follow an instruction not to.
 */
export function scrubControlTokens(text: string): string {
    return text
        .replace(REASONING_BLOCK_RE, ' ')
        .replace(ANY_CONTROL_TOKEN_RE, ' ')
        .replace(ANY_PAREN_TOKEN_RE, ' ')
        .replace(TAG_SHAPED_RE, ' ')
        .replace(XML_TAG_RE, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ +([,.;:!?])/g, '$1')
        // Punctuation or a list marker the removal stranded at the front.
        .replace(/^[\s,.;:!?]+/, '')
        .replace(/^[-*•]\s+/, '')
        .trim();
}

export interface TurnSignals {
    /** A [HOLD] token was present: enter silence mode (as parseHoldSignal). */
    hold: boolean;
    stage: StageSignal;
    /** Seconds from a [WAIT:Nm] token, or null when absent. Unclamped. */
    waitSec: number | null;
    /** What gets spoken: leading control tokens stripped, stray mid-text ones
     *  scrubbed (scrubControlTokens). */
    cleanText: string;
}

/**
 * Parse control tokens ([HOLD], [NEXT], [BACK], [WAIT:Nm]) off the start of an
 * LLM reply, in any order and combination. Only a leading run is honored (as in
 * parseHoldSignal), but mid-text tokens are scrubbed from cleanText so they are
 * never spoken or recorded back into history, where they'd re-teach the bad
 * placement. Contradictory tokens: first wins.
 */
export function parseTurnSignals(response: string): TurnSignals {
    // Reasoning blocks come off FIRST: a leaked <think>…</think> in front of
    // the reply would hide the leading token run, costing the signal too.
    let text = response.replace(REASONING_BLOCK_RE, ' ').trim();
    let hold = false;
    let stage: StageSignal = 'none';
    let waitSec: number | null = null;
    for (;;) {
        const wait = matchWaitToken(text);
        if (wait) {
            if (waitSec === null) waitSec = wait.seconds;
            text = text.slice(wait.length).trimStart();
            continue;
        }
        const named = matchNamedToken(text);
        if (!named) break;
        if (named.name === 'HOLD') hold = true;
        else if (named.name === 'NEXT') { if (stage === 'none') stage = 'advance'; }
        else if (named.name === 'BACK') { if (stage === 'none') stage = 'back'; }
        text = text.slice(named.length).trimStart();
    }
    return { hold, stage, waitSec, cleanText: scrubControlTokens(text) };
}

// Staged-mode controller

/**
 * Tracks the active phase of a staged mode and renders its system-prompt
 * section. One instance per session; the session view applies each turn's
 * StageSignal and persists the phase id (SessionState.modePhase) so an
 * interrupted session resumes where it left off.
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
        // An unknown persisted id (a phase renamed between releases) falls back
        // to the first phase rather than failing the session.
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
     * System-prompt section for the active phase: arc overview, phase guidance,
     * movement protocol. Pass to PromptBuilder.buildSystemPrompt(). Rebuilt each
     * turn; a phase shift invalidates the prompt-cache prefix once, which is
     * acceptable (meditation-pal-jqvh).
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
        'Session arc: this practice moves through stages. The meditator does not see this list; you hold it for them:',
        arc,
        '',
        phase.prompt.trim(),
        '',
        `Moving between stages, the ${NEXT_PREFIX} / ${BACK_PREFIX} signals:`,
        'You decide movement through the arc with a hidden control token at the very start of your reply (stripped before speech, like [HOLD]):',
    ];
    if (!last) {
        lines.push(
            `- Start with ${NEXT_PREFIX} when the stage guidance above says this stage's work is complete, shown by the meditator's own words, not by your hopes for them. The rest of that same reply should already be facilitating the next stage, naturally.`
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

// Registry

/** The classic mode. No openers/openerPrompt on purpose: PromptBuilder's pools
 *  (keyed off focuses/qualities/directiveness) are richer than a flat list, so
 *  this spec behaves as if no mode were passed. */
export const EXPLORATION_MODE: ModeSpec = {
    id: 'exploration',
    label: 'Exploration',
    basePrompt: BASE_SYSTEM_PROMPT,
};

/** Registered for labels and registry completeness; the noting circle has its
 *  own orchestration (noting.ts + the noting-session view) and never runs
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
