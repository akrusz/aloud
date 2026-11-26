/**
 * Every piece of prompt text that reaches a model, as it is sent: the real
 * constants, and the real builders called with stand-in arguments ({like
 * this}). Reach is defined in dev-docs/prompt-writing.md, "When you touch a
 * prompt". cli.ts (npm run prompts:check) hashes these against
 * ts/prompt-ledger.json.
 *
 * A piece that embeds or assembles others holds them as {their id}
 * (`compose`), so an edit shows on the piece whose words changed and nowhere
 * else. A new prompt belongs here; one this file misses is a prompt the
 * release check cannot see.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { LLMProvider, Message } from '../../src/llm/index.js';
import { systemNoteAsUserText } from '../../src/llm/base.js';
import * as prompts from '../../src/facilitation/prompts.js';
import { PromptBuilder, type PromptConfig } from '../../src/facilitation/prompts.js';
import { ZH_LANGUAGE_FRAGMENT } from '../../src/facilitation/language.js';
import {
    FELT_SENSE_MODE,
    FELT_SENSE_OPENER_ANGLES,
    FELT_SENSE_PHASES,
    FELT_SENSE_SYSTEM_PROMPT,
} from '../../src/facilitation/felt-sense.js';
import { StagedModeController } from '../../src/facilitation/modes.js';
import { buildSmartCheckinEvent } from '../../src/facilitation/smart-checkin.js';
import { buildTimerApproachEvent, buildTimerCompletionEvent } from '../../src/facilitation/session-timer.js';
import { generateSessionSummary } from '../../src/facilitation/summary.js';
import { buildResumeContext, RESUME_COMPRESS_CHARS } from '../../src/facilitation/resume.js';
import type { SessionState } from '../../src/facilitation/session.js';
import * as noting from '../../src/facilitation/noting.js';
import { generateNotingLabel } from '../../src/facilitation/noting.js';
import { JUDGE_SPECS, judgeState, type JudgeSpec } from '../../src/facilitation/utterance-judge.js';
import { COMMAND_SPECS } from '../../src/facilitation/voice-command-specs.js';
import { SETUP_SPECS } from '../../src/facilitation/setup-command-specs.js';
import { LOCAL_SETUP_SYSTEM_PROMPT } from '../../src/facilitation/setup-local.js';
import { CURATED_VOICES } from '../../server/src/providers/voice-catalog.js';
import { INSTRUCTION_TREATMENTS, instructionFor } from '../../server/scripts/audition/sources.js';
import { JUDGE_RULES, loadRubric, type Rubric, type RubricDimension } from '../../evals/rubric.js';
import { judgeInstructions, panelPrompt, retryPrompt, signalsOf } from '../../evals/judge-core.js';
import type { Fixture } from '../../evals/fixtures.js';
import { heldRoleRubric, holdsSessionRubric, judgeSessionRun, rubricSection } from '../../soak/judge.js';
import { LlmSimUser } from '../../soak/sim-user.js';
import * as scenarios from '../../soak/scenarios.js';
import { checkSubscriptionIsolation } from '../../soak/providers.js';
import type { Persona, Scenario, SessionRunResult } from '../../soak/types.js';
import type { Reach } from './ledger.js';

export interface PromptPiece {
    id: string;
    reach: Reach;
    /** Repo-relative, for `git diff`. */
    file: string;
    text: string;
}

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const PROMPTS = 'ts/src/facilitation/prompts.ts';
const FELT = 'ts/src/facilitation/felt-sense.ts';
const MODES = 'ts/src/facilitation/modes.ts';
const NOTING = 'ts/src/facilitation/noting.ts';
const RUBRIC = 'ts/evals/rubric.md';

/** One text for a builder's several outputs. */
const variants = (...texts: string[]): string => texts.join('\n\n---\n\n');

/** `lines` lines of a file from the one holding `from`, for text no import
 *  reaches. Anchor on code, not wording, or a reword breaks the registry. */
function source(file: string, from: string, lines: number): string {
    const all = readFileSync(`${REPO}${file}`, 'utf8').split('\n');
    const at = all.findIndex((l) => l.includes(from));
    if (at < 0) throw new Error(`prompt registry: "${from}" is gone from ${file}; fix its anchor in scripts/prompt-ledger/registry.ts`);
    return all.slice(at, at + lines).join('\n');
}

/** A provider that records what it is asked and answers `reply`. */
function recorder(reply: string): { provider: LLMProvider; calls: Array<{ system: string; messages: Message[] }> } {
    const calls: Array<{ system: string; messages: Message[] }> = [];
    const provider: LLMProvider = {
        model: 'stand-in',
        complete: async (messages, options) => {
            calls.push({ system: options?.system ?? '', messages });
            return { text: reply, finishReason: 'stop', tokensUsed: null };
        },
    };
    return { provider, calls };
}

const contents = (call: { messages: Message[] } | undefined): string => (call?.messages ?? []).map((m) => m.content).join('\n\n');

/** `text` with each known piece written as {its id}, longest first and
 *  repeated, so a piece that is itself made of pieces folds up too. */
function compose(text: string, known: ReadonlyArray<{ id: string; text: string }>): string {
    const byLength = known.filter((k) => k.text.length >= 20).sort((a, b) => b.text.length - a.text.length);
    let out = text;
    for (let before = ''; before !== out; ) {
        before = out;
        for (const k of byLength) out = out.split(k.text).join(`{${k.id}}`);
    }
    return out;
}

const jevText = (spec: JudgeSpec): string =>
    JSON.stringify(
        { situation: spec.situation, asks: Object.fromEntries(Object.entries(spec.asks).map(([k, a]) => [k, a.question])) },
        null,
        2
    );

const isPersona = (v: unknown): v is Persona =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && 'description' in v && 'id' in v;

export async function promptPieces(): Promise<PromptPiece[]> {
    const out: PromptPiece[] = [];
    const add = (reach: Reach, file: string, id: string, text: string): void => {
        out.push({ id, reach, file, text });
    };
    const own = (text: string): string => compose(text, out);

    // --- session: what a meditator hears, or what is saved for them --------
    for (const name of [
        'VOICE_STYLE_FRAGMENT',
        'HOLD_SIGNAL_FRAGMENT',
        'REALTIME_VOICE_FRAGMENT',
        'STEPPING_OUT_FRAGMENT',
        'WAIT_SIGNAL_FRAGMENT',
        'DIMENSIONS_PREAMBLE',
        'STEPPING_OUT_NOTE',
    ] as const) {
        add('session', PROMPTS, `prompts/${name}`, prompts[name]);
    }
    add('session', PROMPTS, 'prompts/BASE_SYSTEM_PROMPT', own(prompts.BASE_SYSTEM_PROMPT));
    for (const via of ['voice', 'screen'] as const) {
        add('session', PROMPTS, `prompts/appControlsFragment/${via}`, prompts.appControlsFragment(via));
    }
    add('session', PROMPTS, 'prompts/appControlsChangeNote', own(variants(...(['voice', 'screen'] as const).map(prompts.appControlsChangeNote))));
    add('session', PROMPTS, 'prompts/COMMAND_ANSWER_NOTE', prompts.COMMAND_ANSWER_NOTE);
    // The defaults at guidance 4, 3 and 2: the assemblies below meet the last two.
    for (const [tier, sec] of [['active', 90], ['moderate', 180], ['long', 300]] as const) {
        add('session', PROMPTS, `prompts/waitBiasFragment/${tier}`, prompts.waitBiasFragment(sec));
    }
    for (const [key, text] of Object.entries(prompts.FOCUS_PROMPTS)) add('session', PROMPTS, `prompts/FOCUS_PROMPTS/${key}`, text);
    for (const [key, text] of Object.entries(prompts.QUALITY_PROMPTS)) add('session', PROMPTS, `prompts/QUALITY_PROMPTS/${key}`, text);
    for (const [key, text] of Object.entries(prompts.DIRECTIVENESS_ADDITIONS)) add('session', PROMPTS, `prompts/DIRECTIVENESS_ADDITIONS/${key}`, text);
    for (const [key, text] of Object.entries(prompts.VERBOSITY_ADDITIONS)) add('session', PROMPTS, `prompts/VERBOSITY_ADDITIONS/${key}`, text);
    add('session', 'ts/src/facilitation/language.ts', 'language/ZH_LANGUAGE_FRAGMENT', ZH_LANGUAGE_FRAGMENT);
    for (const voice of CURATED_VOICES) {
        if (voice.promptNote) add('session', 'ts/server/src/providers/voice-catalog.ts', `voices/${voice.name}/promptNote`, voice.promptNote);
    }

    add('session', FELT, 'felt-sense/FELT_SENSE_SYSTEM_PROMPT', own(FELT_SENSE_SYSTEM_PROMPT));
    for (const p of FELT_SENSE_PHASES) add('session', FELT, `felt-sense/phase/${p.id}`, `${p.label}\n${p.summary}\n\n${p.prompt}`);
    const standInArc = new StagedModeController({
        id: 'stand-in',
        label: '{mode}',
        basePrompt: '',
        phases: [{ id: 'stand-in', label: '{label}', summary: '{summary}', prompt: '{prompt}' }],
    });
    add('session', MODES, 'felt-sense/stage-frame', standInArc.promptSection());
    add('session', MODES, 'felt-sense/stage-note', standInArc.phaseNote());

    // Every composing option on, so the assembly shows each wrapper and the order.
    const everything: Partial<PromptConfig> = {
        waitSignal: true,
        appControls: 'voice',
        language: 'zh-CN',
        voiceNote: '{voice note}',
        customInstructions: '{their words}',
    };
    add('session', PROMPTS, 'prompts/buildSystemPrompt', own(new PromptBuilder({
        config: { ...everything, focuses: ['body_sensations'], qualities: ['playful'], directiveness: 3, verbosity: 'medium' },
    }).buildSystemPrompt()));
    add('session', PROMPTS, 'felt-sense/buildSystemPrompt', own(new PromptBuilder({ mode: FELT_SENSE_MODE, config: everything })
        .buildSystemPrompt(standInArc.promptSection())));

    const opener = (config: Partial<PromptConfig>, intention = '', firstSit = false): string =>
        new PromptBuilder({ config }).buildOpenerPrompt(intention, { firstSit });
    add('session', PROMPTS, 'prompts/buildOpenerPrompt', variants(
        opener({ directiveness: 1 }),
        opener({ directiveness: 2, focuses: ['body_sensations'], qualities: ['playful'] }, '{intention}'),
        opener({ directiveness: 3 }),
        opener({ directiveness: 4 }),
        opener({}, '', true)
    ));
    add('session', FELT, 'felt-sense/opener', variants(...FELT_SENSE_OPENER_ANGLES.map((_, i, all) =>
        new PromptBuilder({ mode: FELT_SENSE_MODE, random: () => i / all.length }).buildOpenerPrompt('{intention}'))));

    add('session', 'ts/src/facilitation/smart-checkin.ts', 'smart-checkin/buildSmartCheckinEvent', variants(
        buildSmartCheckinEvent(300, 1),
        buildSmartCheckinEvent(600, 2, { suggestion: 'offered', withWaitHint: true, passedSecAgo: 300 }),
        buildSmartCheckinEvent(60, 3, { suggestion: 'expected', passedSecAgo: 120 }),
        buildSmartCheckinEvent(900, 1, { suggestion: 'expected', passedSecAgo: 60 })
    ));
    const TIMER = 'ts/src/facilitation/session-timer.ts';
    add('session', TIMER, 'session-timer/approach', variants(buildTimerApproachEvent(180, 30), buildTimerApproachEvent(60, 10, { staged: true })));
    add('session', TIMER, 'session-timer/completion', variants(buildTimerCompletionEvent(30), buildTimerCompletionEvent(20, { endsSession: true, staged: true })));

    const summary = recorder('{note}');
    const sat = [
        { role: 'assistant' as const, content: '{facilitator line}' },
        { role: 'user' as const, content: '{meditator line}' },
        { role: 'user' as const, content: '{meditator line}' },
    ];
    await generateSessionSummary(summary.provider, sat, { language: 'en' });
    await generateSessionSummary(summary.provider, sat, { language: 'en', noting: true });
    await generateSessionSummary(summary.provider, sat, { language: 'zh-CN', noting: true });
    add('session', 'ts/src/facilitation/summary.ts', 'summary/SUMMARY_SYSTEM_PROMPT', summary.calls[0]?.system ?? '');
    add('session', 'ts/src/facilitation/summary.ts', 'summary/request', variants(...summary.calls.map(contents)));

    const prior = (content: string): SessionState =>
        ({ exchanges: [{ role: 'user', content }], notes: '{recap}', notesAreRecap: true }) as unknown as SessionState;
    const long = prior('x'.repeat(RESUME_COMPRESS_CHARS + 1));
    const handOff = { priorModelLabel: '{earlier model}', currentModelLabel: '{this model}' };
    add('session', 'ts/src/facilitation/resume.ts', 'resume/buildResumeContext', variants(
        ...[buildResumeContext(long, true, handOff), buildResumeContext(long, true), buildResumeContext(prior('{line}'), true, handOff)]
            .map((entries) => entries[0]?.content ?? '')
    ));
    add('session', 'ts/ui/src/views/session.ts', 'session-view/resume-opener', source('ts/ui/src/views/session.ts', 'const instruction = resuming', 4));
    add('session', 'ts/src/llm/anthropic.ts', 'llm/resume-stub', source('ts/src/llm/anthropic.ts', "if (out[0]?.role === 'assistant') {", 3));
    add('session', 'ts/src/llm/base.ts', 'llm/systemNoteAsUserText', systemNoteAsUserText('{note}'));
    add('session', 'ts/src-tauri/src/llm.rs', 'rust/format_history-system-note', source('ts/src-tauri/src/llm.rs', 'if m.role == "system" {', 2));

    for (const name of [
        'NOTING_LABEL_SYSTEM_PROMPT',
        'NOTING_LABEL_CONTEXT',
        'NOTING_LABEL_AVOID_SELF_REPEAT',
        'NOTING_LABEL_REACTIVE_LOW',
        'NOTING_LABEL_REACTIVE_HIGH',
        'NOTING_LABEL_REACTIVE_NONE',
    ] as const) {
        add('session', NOTING, `noting/${name}`, noting[name]);
    }
    const label = recorder('{label}');
    await generateNotingLabel(label.provider, { language: 'zh-CN', context: ['{context}'], ownLabels: ['{own_labels}'], reactive: 'high' });
    add('session', NOTING, 'noting/label-request', own(`${label.calls[0]?.system ?? ''}\n\n${contents(label.calls[0])}`));
    add('session', 'ts/server/src/providers/tts.ts', 'tts/MEDITATION_INSTRUCTION', source('ts/server/src/providers/tts.ts', 'const MEDITATION_INSTRUCTION =', 3));

    // --- support: runs in production, never heard ---------------------------
    for (const name of ['RESUME_INTENT_SYSTEM_PROMPT', 'HOLD_REQUEST_SYSTEM_PROMPT', 'HOLD_CONFIRM_SYSTEM_PROMPT', 'TROUBLE_SYSTEM_PROMPT'] as const) {
        add('support', PROMPTS, `prompts/${name}`, prompts[name]);
    }
    for (const [id, spec] of Object.entries(JUDGE_SPECS)) add('support', 'ts/src/facilitation/utterance-judge.ts', `jev/${id}`, jevText(spec));
    for (const [id, spec] of Object.entries(COMMAND_SPECS)) add('support', 'ts/src/facilitation/voice-command-specs.ts', `jev/${id}`, jevText(spec));
    for (const [id, spec] of Object.entries(SETUP_SPECS)) add('support', 'ts/src/facilitation/setup-command-specs.ts', `jev/${id}`, jevText(spec));
    add('support', 'ts/src/facilitation/utterance-judge.ts', 'jev/BEFORE_NOTE',
        judgeState('command', '', { before: { meditator: '{line}' } }).situation.slice(COMMAND_SPECS.command.situation.length));
    add('support', 'ts/src/facilitation/setup-local.ts', 'setup-local/LOCAL_SETUP_SYSTEM_PROMPT', LOCAL_SETUP_SYSTEM_PROMPT);

    // --- dev: evals, soak, scripts --------------------------------------------
    // Read the way each judge reads it, so the text is what the judge is sent.
    const rubric = loadRubric();
    const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    for (const title of JUDGE_RULES) add('dev', RUBRIC, `rubric/rule/${slug(title)}`, rubric.rules[title] ?? '');
    for (const d of rubric.dimensions.values()) add('dev', RUBRIC, `rubric/${d.id}`, d.text);
    add('dev', RUBRIC, 'rubric/12', holdsSessionRubric());
    add('dev', RUBRIC, 'rubric/held-the-role', heldRoleRubric());

    const JUDGE_CORE = 'ts/evals/judge-core.ts';
    const dim = (id: RubricDimension['id'], binary: boolean, upwardOnly: boolean): RubricDimension =>
        ({ id, name: '{name}', binary, weight: { kind: 'fixed', low: 4, high: 3 }, text: '{text}', upwardOnly });
    const standInRubric: Rubric = {
        rules: Object.fromEntries(JUDGE_RULES.map((t) => [t, `{rubric/rule/${slug(t)}}`])),
        dimensions: new Map([['2', dim('2', true, false)], ['3', dim('3', false, false)], ['E2', dim('E2', false, true)]]),
        types: [],
        fileHash: '',
    };
    const fixture: Fixture = {
        id: 'stand-in',
        mode: 'felt_sense',
        phase: 'sensing',
        config: { focuses: ['body_sensations'], qualities: ['playful'], directiveness: 3, verbosity: 'medium' },
        history: [{ role: 'assistant', content: '{facilitator line}' }, { role: 'user', content: '{meditator turn}' }],
        dims: ['2', '3', 'E2'],
        expect: {},
        description: '',
    };
    add('dev', JUDGE_CORE, 'eval-judge/instructions', judgeInstructions(standInRubric, fixture).system);
    add('dev', JUDGE_CORE, 'eval-judge/panel', panelPrompt({
        fixture,
        run: 0,
        seed: '',
        replies: [
            { letter: 'A', model: '', spoken: '{reply}', signals: signalsOf('[NEXT] [HOLD] [WAIT:5m] {reply}') },
            { letter: 'B', model: '', spoken: '{reply}', signals: signalsOf('[BACK] {reply}') },
        ],
        key: {},
        skipped: [],
    }));
    add('dev', JUDGE_CORE, 'eval-judge/retry', retryPrompt(['{error}']));

    const soakJudge = recorder('{"overall": 5}');
    const scenario: Scenario = {
        id: 'stand-in',
        title: '{title}',
        persona: { id: 'stand-in', description: '' },
        modeId: 'exploration',
        focuses: ['body_sensations'],
        qualities: ['playful'],
        intention: '{intention}',
        timerMin: 20,
        endSessionOnTimer: true,
        language: 'zh',
        transform: { recognizer: 'web-speech', cut: { turns: [2], seed: 1 } },
        fakeMinutes: 20,
    };
    const result: SessionRunResult = {
        scenario,
        runIndex: 0,
        startedAt: '',
        facilitatorModel: '',
        fakeDurationSec: 1200,
        transcript: [
            { at: 10, role: 'assistant', kind: 'opener', text: '{line}' },
            { at: 60, role: 'user', kind: 'user', text: '{line}', duringHold: true },
            { at: 300, role: 'assistant', kind: 'checkin', text: '{line}' },
            { at: 310, role: 'user', kind: 'event', text: '{event}' },
            { at: 900, role: 'assistant', kind: 'timer-approach', text: '{line}' },
        ],
        events: [],
        calls: [],
        endedBy: 'sim-end',
        finalState: { silenceMode: false, awaitingHoldConfirm: false },
    };
    await judgeSessionRun(soakJudge.provider, result);
    const conduct = ['13', '14'].map((id) => ({ id: `rubric/${id}`, text: rubricSection(id).text }));
    add('dev', 'ts/soak/judge.ts', 'soak-judge/system', compose(soakJudge.calls[0]?.system ?? '', [...out, ...conduct]));
    add('dev', 'ts/soak/judge.ts', 'soak-judge/session', contents(soakJudge.calls[0]));

    const sim = recorder('WAIT: 60');
    await new LlmSimUser(sim.provider, { id: 'stand-in', description: '{persona}', arc: ['{arc}'] }, 'zh').nextAction({
        transcript: [{ who: 'facilitator', text: '{line}' }, { who: 'you', text: '{line}' }],
        elapsedMin: 5,
        plannedMin: 20,
        inSilence: true,
        situation: '{situation}',
    });
    add('dev', 'ts/soak/sim-user.ts', 'sim-user/system', sim.calls[0]?.system ?? '');
    add('dev', 'ts/soak/sim-user.ts', 'sim-user/turn', contents(sim.calls[0]));
    add('dev', 'ts/soak/orchestrator.ts', 'sim-user/situations', source('ts/soak/orchestrator.ts', 'situation = silenceMode', 3));
    for (const persona of Object.values(scenarios).filter(isPersona)) {
        add('dev', 'ts/soak/scenarios.ts', `persona/${persona.id}`, [persona.description, ...(persona.arc ?? [])].join('\n- '));
    }

    const probe = recorder('NONE');
    await checkSubscriptionIsolation(probe.provider);
    add('dev', 'ts/soak/providers.ts', 'soak/subscription-probe', `${probe.calls[0]?.system ?? ''}\n\n${contents(probe.calls[0])}`);
    add('dev', 'ts/src-tauri/src/llm.rs', 'rust/claude_cli_round_trip', source('ts/src-tauri/src/llm.rs', 'async fn claude_cli_round_trip()', 4));
    add('dev', 'ts/src-tauri/src/llm.rs', 'rust/claude_cli_leaves_out_user_setup', source('ts/src-tauri/src/llm.rs', 'async fn claude_cli_leaves_out_user_setup()', 8));
    add('dev', 'ts/server/scripts/audition/sources.ts', 'audition/instructionFor', variants(
        ...INSTRUCTION_TREATMENTS.flatMap((t) => [0.8, 1, 1.2].map((rate) => instructionFor(t, rate) ?? '')).filter(Boolean)
    ));

    return out;
}
