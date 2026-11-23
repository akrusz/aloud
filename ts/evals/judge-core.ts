/**
 * Phase 2, the pure part: a panel (every model's reply to one fixture at one
 * run index, shuffled and lettered), the judge's instructions built from
 * rubric.md, the panel as the judge reads it, and strict validation of what
 * comes back. judge.ts runs it; tests drive it directly.
 */

import { createHash } from 'node:crypto';

import { defaultPromptConfig, getMode, parseTurnSignals } from '../src/facilitation/index.js';
import type { Focus, ModeComposes, ModeSpec, Quality, Verbosity } from '../src/facilitation/index.js';
import type { DimensionId } from './dimensions.js';
import type { Fixture } from './fixtures.js';
import type { JudgeVerdictRecord, PanelReplyVerdict, Trial } from './records.js';
import { JUDGE_RULES, weightAt, type Rubric, type RubricDimension } from './rubric.js';

// --- Settings in plain words ---------------------------------------------------

export const GUIDANCE_NAMES: Record<number, string> = {
    1: 'Following',
    2: 'Somewhat following',
    3: 'Balanced',
    4: 'Somewhat directing',
    5: 'Directing',
};
const LENGTH_NAMES: Record<Verbosity, string> = { low: 'Brief', medium: 'Medium', high: 'Longer' };
const FOCUS_NAMES: Record<Focus, string> = {
    body_sensations: 'Body & sensations',
    emotions: 'Emotions & feeling tone',
    inner_parts: 'Parts & inner world',
    open_awareness: 'Open awareness',
};
const QUALITY_NAMES: Record<Quality, string> = {
    playful: 'Playful & light',
    compassionate: 'Compassionate',
    loving: 'Loving & kind',
    spacious: 'Spacious',
    effortless: 'Effortless',
    feeling_good: 'Feeling good',
};
const MODE_NAMES: Record<Fixture['mode'], string> = {
    exploration: 'Exploration',
    felt_sense: 'Felt sense',
    noting: 'Noting',
};

export function guidanceOf(fx: Fixture): number {
    return fx.config?.directiveness ?? defaultPromptConfig.directiveness;
}

/** The bullet of a mode's own prompt that sets its length ("... under 20
 *  words ..."), quoted as written so the judge reads what the facilitator read. */
function lengthRuleOf(mode: ModeSpec): string | null {
    const line = mode.basePrompt.split('\n').find((l) => /^-\s/.test(l) && /\b\d+\s+words\b/i.test(l));
    return line ? line.replace(/^-\s+/, '').trim() : null;
}

/** The settings in words. A setting the mode does not compose (felt sense
 *  composes none) is left out, since the facilitator never heard it, and the
 *  mode's own length rule is quoted in its place. */
export function settingsLine(fx: Fixture): string {
    const g = guidanceOf(fx);
    const mode = getMode(fx.mode);
    let head = `Mode: ${MODE_NAMES[fx.mode]}`;
    if (mode?.phases && fx.phase) {
        const i = mode.phases.findIndex((p) => p.id === fx.phase);
        const phase = mode.phases[i];
        if (phase) head += `, stage ${i + 1} of ${mode.phases.length}, "${phase.label}"`;
    }
    const focuses = fx.config?.focuses ?? [];
    const qualities = fx.config?.qualities ?? [];
    const settings: Array<[keyof ModeComposes, string, string]> = [
        ['focuses', 'focus', `Focus: ${focuses.length ? focuses.map((f) => FOCUS_NAMES[f]).join(', ') : 'none set'}`],
        ['qualities', 'vibe', `Vibe: ${qualities.length ? qualities.map((q) => QUALITY_NAMES[q]).join(', ') : 'none set'}`],
        ['directiveness', 'guidance', `Guidance level: ${g} of 5, ${GUIDANCE_NAMES[g] ?? '?'}`],
        ['verbosity', 'reply length', `Reply length: ${LENGTH_NAMES[fx.config?.verbosity ?? defaultPromptConfig.verbosity]}`],
    ];
    const parts = [head];
    const missing: string[] = [];
    for (const [key, name, line] of settings) {
        if (mode?.composes?.[key] === false) missing.push(name);
        else parts.push(line);
    }
    if (missing.length) {
        const last = missing.pop() as string;
        parts.push(`This mode has no ${missing.length ? `${missing.join(', ')} or ${last}` : last} setting`);
        const rule = mode?.composes?.verbosity === false ? lengthRuleOf(mode) : null;
        if (rule) parts.push(`On length, its own instructions say: "${rule}"`);
    }
    return parts.map((p) => (/[.!?]"?$/.test(p) ? p : `${p}.`)).join(' ');
}

// --- Panels --------------------------------------------------------------------

/** 32-bit FNV-1a, then mulberry32: a reproducible order from a string. */
function rng(seed: string): () => number {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function seededOrder<T>(items: readonly T[], seed: string): T[] {
    const out = [...items];
    const next = rng(seed);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
}

/** The control signals the app would act on, in words a judge can weigh. */
export function signalsOf(raw: string): string[] {
    const s = parseTurnSignals(raw);
    const out: string[] = [];
    if (s.hold) out.push('a silence bid ([HOLD]: the app offers to go quiet)');
    if (s.stage === 'advance') out.push('moved the felt-sense stage on ([NEXT])');
    if (s.stage === 'back') out.push('moved the felt-sense stage back ([BACK])');
    if (s.waitSec !== null) out.push(`asked for ${Math.round(s.waitSec / 60)} minutes of protected quiet ([WAIT])`);
    return out;
}

export interface PanelReply {
    letter: string;
    model: string;
    spoken: string;
    signals: string[];
    promptHash?: string;
}

export interface Panel {
    fixture: Fixture;
    run: number;
    seed: string;
    /** In letter order. */
    replies: PanelReply[];
    key: Record<string, string>;
    /** Errors and empty replies: left out, reported from Phase 1. */
    skipped: Array<{ model: string; why: 'error' | 'empty' }>;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Every model's reply to `fx` at run index `run`, blinded. The seed salt is
 *  the judge, so each judge sees its own order and a position bias the two
 *  share cannot pass for agreement. */
export function buildPanel(
    fx: Fixture,
    run: number,
    trials: ReadonlyArray<Trial>,
    seedSalt: string
): Panel {
    const skipped: Panel['skipped'] = [];
    const usable: Trial[] = [];
    for (const t of [...trials].sort((a, b) => a.model.localeCompare(b.model))) {
        if (t.error) skipped.push({ model: t.model, why: 'error' });
        else if (t.spoken.trim() === '') skipped.push({ model: t.model, why: 'empty' });
        else usable.push(t);
    }
    const seed = `${fx.id}#${run}#${seedSalt}`;
    const replies = seededOrder(usable, seed).map((t, i) => ({
        letter: LETTERS[i] as string,
        model: t.model,
        spoken: t.spoken.trim(),
        signals: signalsOf(t.raw),
        ...(t.promptHash !== undefined && { promptHash: t.promptHash }),
    }));
    return {
        fixture: fx,
        run,
        seed,
        replies,
        key: Object.fromEntries(replies.map((r) => [r.letter, r.model])),
        skipped,
    };
}

// --- What the judge is told ----------------------------------------------------

export interface Instructions {
    system: string;
    /** 12 hex of sha256 over `system`: the panel's rubric hash. */
    hash: string;
    dims: RubricDimension[];
    binary: DimensionId[];
    /** Scale dimensions every reply must be scored on. */
    required: DimensionId[];
    /** Scored only when the move is made (E2, E3). */
    optional: DimensionId[];
}

const unbold = (s: string) => s.replace(/\*\*/g, '');

/** The judge's instructions for one fixture, from rubric.md: the rules that
 *  apply to a judge, then each dimension the fixture exercises, verbatim.
 *  Throws on a dimension the rubric does not define. */
export function judgeInstructions(rubric: Rubric, fx: Fixture): Instructions {
    const g = guidanceOf(fx);
    const dims = fx.dims.map((id) => {
        const d = rubric.dimensions.get(id);
        if (!d) throw new Error(`${fx.id}: rubric.md has no section for dimension ${id}`);
        return d;
    });
    const rules = JUDGE_RULES.map((title) => {
        const r = rubric.rules[title];
        if (!r) throw new Error(`rubric.md has no "${title}" rule under "How it's judged"`);
        return `- ${unbold(r)}`;
    });
    const binary = dims.filter((d) => d.binary).map((d) => d.id);
    const required = dims.filter((d) => !d.binary && !d.upwardOnly).map((d) => d.id);
    const optional = dims.filter((d) => !d.binary && d.upwardOnly).map((d) => d.id);
    const sections = dims.map((d) => {
        const w = d.weight ? weightAt(d.weight, g) : null;
        const how = d.binary ? 'binary: pass or fail' : d.upwardOnly ? '1 to 5, only when the move is made' : '1 to 5';
        const weight =
            d.weight?.kind === 'overriding'
                ? 'outweighs everything else on this turn'
                : w !== null
                  ? `weight at this guidance level: ${Number(w.toFixed(2))}`
                  : 'weight not set';
        // A numbered section's own "### N." line would repeat the heading above.
        const body = d.text.replace(/^###[^\n]*\n+/, '');
        return [`### ${d.id}${d.group ? ` (${d.group})` : ''}: ${d.name} [${how}; ${weight}]`, '', body].join('\n');
    });
    const list = (ids: readonly string[]) => (ids.length ? ids.join(', ') : 'none on this turn');
    const system = [
        "You judge replies from aloud, a voice meditation facilitator. The meditator's eyes are closed and every reply is spoken aloud to them; they never see text. All the replies below answer the same meditator turn under the same settings. They are shown unlabelled, as letters, in random order.",
        '',
        "How it's judged:",
        ...rules,
        '',
        'Score this turn on these dimensions only. Every other dimension is n/a here.',
        '',
        ...sections.flatMap((s) => [s, '']),
        'Answer with one JSON object and nothing else, in this shape:',
        '{',
        '  "replies": {',
        '    "A": {',
        '      "fails": [{ "dim": "<binary dimension id>", "quote": "<the exact words from reply A that fail it>" }],',
        '      "scores": { "<scale dimension id>": <whole number 1 to 5> },',
        '      "note": "<at most 20 words: what decided this reply>"',
        '    }',
        '  },',
        '  "ranking": ["<best letter>", "...", "<worst letter>"],',
        '  "top": { "dim": "<dimension id>", "why": "<one sentence>" },',
        '  "bottom": { "dim": "<dimension id>", "why": "<one sentence>" }',
        '}',
        '- One entry in "replies" for every letter, and no others.',
        `- "fails" lists only binary dimensions (${list(binary)}), each with the words quoted exactly from that reply. A reply that fails none has "fails": [].`,
        `- "scores" gives every reply a score on each of: ${list(required)}.` +
            (optional.length ? ` Score ${list(optional)} only when the reply makes that move; leave it out otherwise.` : ''),
        '- "ranking" orders every letter, best first, with no ties.',
        '- "top" names the dimension that decided first place, "bottom" the one that decided last place.',
    ].join('\n');
    return {
        system,
        hash: createHash('sha256').update(system).digest('hex').slice(0, 12),
        dims,
        binary,
        required,
        optional,
    };
}

/** The panel as the judge reads it: settings, the conversation, the turn, the replies. */
export function panelPrompt(panel: Panel): string {
    const fx = panel.fixture;
    const history = fx.history;
    const turn = history[history.length - 1];
    const before = history.slice(0, -1);
    const lines = [`Settings: ${settingsLine(fx)}`, ''];
    if (before.length) {
        lines.push('The conversation so far:');
        for (const h of before) lines.push(`${h.role === 'user' ? 'Meditator' : 'Facilitator'}: ${h.content}`);
        lines.push('');
    }
    lines.push(`The meditator's turn these replies answer:`, `Meditator: ${turn?.content ?? ''}`, '', 'The replies:');
    for (const r of panel.replies) {
        lines.push('', `${r.letter}: ${r.spoken}`);
        if (r.signals.length) lines.push(`   (Also signalled: ${r.signals.join('; ')}.)`);
    }
    return lines.join('\n');
}

// --- What comes back -----------------------------------------------------------

export interface ParsedVerdict {
    replies: Record<string, PanelReplyVerdict>;
    /** Letters, best first. */
    ranking: string[];
    top?: { dim: string; why: string };
    bottom?: { dim: string; why: string };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The JSON object in a reply that may carry fences or prose around it. */
export function extractJson(text: string): unknown {
    const unfenced = text.replace(/```(?:json)?/gi, '');
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in the answer');
    return JSON.parse(unfenced.slice(start, end + 1));
}

const norm = (s: string) =>
    s
        .toLowerCase()
        .replace(/[‘’ʼ]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();

/** A quote is found when its words appear in the reply, ignoring case,
 *  curly quotes, and an ellipsis between quoted pieces. */
export function quoteFound(reply: string, quote: string): boolean {
    const r = norm(reply);
    const pieces = norm(quote)
        .replace(/^["'\s]+|["'\s.]+$/g, '')
        .split(/\s*(?:\.\.\.|…)\s*/)
        .filter(Boolean);
    return pieces.length > 0 && pieces.every((p) => r.includes(p));
}

function letterOf(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const m = /^\s*(?:reply\s+)?([A-Za-z])\s*$/i.exec(v);
    return m ? (m[1] as string).toUpperCase() : null;
}

function decided(v: unknown, applicable: ReadonlySet<string>, which: string, warnings: string[]) {
    if (!isObj(v)) {
        warnings.push(`no "${which}"`);
        return undefined;
    }
    const dim = String(v['dim'] ?? '').trim();
    const why = typeof v['why'] === 'string' ? v['why'] : '';
    if (!applicable.has(dim)) warnings.push(`"${which}" names ${dim || 'no dimension'}, not one on this turn`);
    return { dim, why };
}

/** Lenient about the wrapping, strict about the content: unknown or missing
 *  letters, scores out of range or missing, a fail on a dimension that is not
 *  binary on this turn, and a ranking that is not every letter once are all
 *  errors. A misquote and stray extras are warnings. */
export function parseVerdict(
    text: string,
    panel: Panel,
    ins: Instructions
): { verdict?: ParsedVerdict; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    let json: unknown;
    try {
        json = extractJson(text);
    } catch (err) {
        return { errors: [`not JSON: ${err instanceof Error ? err.message : String(err)}`], warnings };
    }
    if (!isObj(json) || !isObj(json['replies'])) return { errors: ['no "replies" object'], warnings };
    const letters = new Set(panel.replies.map((r) => r.letter));
    const byLetter = new Map(panel.replies.map((r) => [r.letter, r]));
    const binary = new Set<string>(ins.binary);
    const scale = new Set<string>([...ins.required, ...ins.optional]);
    const applicable = new Set<string>(ins.dims.map((d) => d.id));
    const replies: Record<string, PanelReplyVerdict> = {};
    for (const [rawKey, v] of Object.entries(json['replies'])) {
        const letter = letterOf(rawKey);
        if (!letter || !letters.has(letter)) {
            errors.push(`unknown reply letter ${rawKey}`);
            continue;
        }
        const reply = byLetter.get(letter) as PanelReply;
        if (!isObj(v)) {
            errors.push(`${letter}: not an object`);
            continue;
        }
        const fails: PanelReplyVerdict['fails'] = [];
        for (const f of Array.isArray(v['fails']) ? v['fails'] : []) {
            if (!isObj(f)) continue;
            const dim = String(f['dim'] ?? '').trim();
            const quote = typeof f['quote'] === 'string' ? f['quote'].trim() : '';
            if (!binary.has(dim)) {
                errors.push(`${letter}: a fail on ${dim || '?'}, which is not a binary dimension on this turn`);
                continue;
            }
            if (!quote) errors.push(`${letter}: a fail on ${dim} with no quoted words`);
            const found = quoteFound(reply.spoken, quote);
            if (!found) warnings.push(`${letter}: the quote for ${dim} is not in the reply`);
            fails.push({ dim, quote, quoteFound: found });
        }
        const scores: Record<string, number> = {};
        const given = isObj(v['scores']) ? v['scores'] : {};
        for (const [dim, raw] of Object.entries(given)) {
            if (!scale.has(dim)) {
                warnings.push(`${letter}: a score for ${dim}, not a scale dimension on this turn (dropped)`);
                continue;
            }
            const n = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isInteger(n) || n < 1 || n > 5) {
                errors.push(`${letter}: ${dim} scored ${JSON.stringify(raw)}, not a whole number from 1 to 5`);
                continue;
            }
            scores[dim] = n;
        }
        for (const dim of ins.required) {
            if (scores[dim] === undefined && !errors.some((e) => e.startsWith(`${letter}: ${dim} scored`))) {
                errors.push(`${letter}: no score for ${dim}`);
            }
        }
        const note = typeof v['note'] === 'string' ? v['note'].trim() : '';
        replies[letter] = {
            spoken: reply.spoken,
            signals: reply.signals,
            fails,
            scores,
            ...(note && { note }),
        };
    }
    for (const l of letters) if (!replies[l] && !errors.some((e) => e.startsWith(`${l}:`))) errors.push(`no entry for reply ${l}`);
    const ranking = Array.isArray(json['ranking']) ? json['ranking'].map(letterOf) : [];
    const rankLetters = ranking.filter((l): l is string => l !== null);
    if (rankLetters.length !== letters.size || new Set(rankLetters).size !== letters.size || rankLetters.some((l) => !letters.has(l))) {
        errors.push(`"ranking" must list every letter once (${[...letters].join(', ')}); got ${JSON.stringify(json['ranking'] ?? null)}`);
    }
    const top = decided(json['top'], applicable, 'top', warnings);
    const bottom = decided(json['bottom'], applicable, 'bottom', warnings);
    if (errors.length) return { errors, warnings };
    return {
        verdict: { replies, ranking: rankLetters, ...(top && { top }), ...(bottom && { bottom }) },
        errors,
        warnings,
    };
}

/** The message that asks for a corrected answer. */
export function retryPrompt(errors: readonly string[]): string {
    return `Your answer could not be used:\n${errors.map((e) => `- ${e}`).join('\n')}\nAnswer again with the corrected JSON object only.`;
}

/** --resume: a stored verdict still stands when it is not an error, was made
 *  from the same instructions, and judged the same models' same replies. */
export function isCurrentVerdict(v: JudgeVerdictRecord, panel: Panel, rubricHash: string): boolean {
    if (v.error || v.rubricHash !== rubricHash || !v.promptHashes) return false;
    const models = panel.replies.map((r) => r.model);
    if (v.models.length !== models.length || !models.every((m) => v.models.includes(m))) return false;
    return panel.replies.every((r) => (v.promptHashes?.[r.model] ?? '') === (r.promptHash ?? ''));
}

/** A judge model's family, from its provider-native id. */
export function familyOfModelId(id: string): string {
    const m = id.toLowerCase();
    if (m.startsWith('claude')) return 'anthropic';
    if (/^(gpt|o\d|chatgpt)/.test(m)) return 'openai';
    if (m.startsWith('gemini') || m.startsWith('gemma')) return 'google';
    if (m.startsWith('qwen') || m.startsWith('bonsai')) return 'alibaba';
    if (m.includes('/')) return m.split('/')[0] as string;
    return 'other';
}

/** The verdict in the stored shape, unblinded: per model id, not per letter. */
export function toRecord(
    panel: Panel,
    ins: Instructions,
    parsed: ParsedVerdict,
    extra: Pick<JudgeVerdictRecord, 'staleInputs' | 'sameFamily' | 'warnings' | 'attempts' | 'latencyMs' | 'usage' | 'costUsd'>
): JudgeVerdictRecord {
    const model = (letter: string) => panel.key[letter] as string;
    const ranking = parsed.ranking.map(model);
    const replies = Object.fromEntries(Object.entries(parsed.replies).map(([l, v]) => [model(l), v]));
    const gateFails = Object.entries(replies)
        .filter(([, v]) => v.fails.length > 0)
        .map(([m]) => m);
    return {
        fixture: panel.fixture.id,
        run: panel.run,
        models: panel.replies.map((r) => r.model),
        key: panel.key,
        seed: panel.seed,
        dims: ins.dims.map((d) => d.id),
        rubricHash: ins.hash,
        promptHashes: Object.fromEntries(panel.replies.map((r) => [r.model, r.promptHash ?? ''])),
        winner: ranking[0] ?? 'tie',
        ...(ranking.length >= 3 && { worst: ranking[ranking.length - 1] as string }),
        rationale: parsed.top?.why ?? '',
        gateFails,
        replies,
        ranking,
        decided: { ...(parsed.top && { top: parsed.top }), ...(parsed.bottom && { bottom: parsed.bottom }) },
        ...stripUndefined(extra),
    };
}

/** A panel whose judging failed, kept so the failure is on record. */
export function errorRecord(panel: Panel, ins: Instructions, error: string, extra: Pick<JudgeVerdictRecord, 'attempts' | 'latencyMs' | 'staleInputs'>): JudgeVerdictRecord {
    return {
        fixture: panel.fixture.id,
        run: panel.run,
        models: panel.replies.map((r) => r.model),
        key: panel.key,
        seed: panel.seed,
        dims: ins.dims.map((d) => d.id),
        rubricHash: ins.hash,
        promptHashes: Object.fromEntries(panel.replies.map((r) => [r.model, r.promptHash ?? ''])),
        winner: '',
        rationale: '',
        error,
        ...stripUndefined(extra),
    };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
