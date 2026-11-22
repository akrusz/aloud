/**
 * Deterministic post-run checks over one session's transcript + event log.
 * These catch the mechanical failures an LLM judge can miss or hallucinate:
 * role leaks in raw output, control tokens that survived the scrub, invariants
 * of the hold/check-in/timer machinery. `fail` findings drive the CLI's exit
 * code; `warn` is worth a look; `info` is context for the report.
 */

import { findRoleLeak, isReasoningAloud, opensWithReturn, parseTurnSignals } from '../src/facilitation/index.js';
import { callbackOutcomes } from './style.js';
import type { CheckFinding, SessionRunResult, TurnRecord } from './types.js';

/** Spoken text must never contain a control token or markup the scrub missed. */
const RESIDUAL_TOKEN_RE = /\[(HOLD|NEXT|BACK|PASS|WAIT[:\]])|<\/?[a-z][\w-]*>/i;

/** A bracketed aside in a zh reply: a control token the model translated
 *  ("【保持安静】"), which no parser reads and TTS would speak. */
const BRACKETED_RE = /[【[][^\]】]{1,24}[\]】]/;

/** Fear in the words the engine was given; the fright-in-hold persona is told
 *  to use these, and no other persona talks this way inside a hold. */
const FRIGHT_RE =
    /\b(?:scar(?:ed|y|ing)|frighten(?:ed|ing)?|afraid|terrif(?:ied|ying)|panic(?:king|ky)?|disappear(?:ing|ed)?|not real|can'?t feel)\b/i;

const hanCount = (s: string): number => (s.match(/\p{Script=Han}/gu) ?? []).length;
const latinCount = (s: string): number => (s.match(/[A-Za-z]/g) ?? []).length;

/**
 * The in-hold mechanics the hold checks read: for an utterance spoken inside a
 * hold, whether the hold ended there, and the verdicts that decided it. Works
 * on tier 2's tapped sessions too, which carry the same records.
 */
function holdReader(result: SessionRunResult) {
    const { transcript, events } = result;
    const verdict = (detail: string, text: string): unknown =>
        events.find((e) => e.kind === 'classifier' && e.detail === detail && e.data?.utterance === text)?.data;
    return {
        inHold: transcript.filter((t) => t.role === 'user' && t.kind === 'user' && t.duringHold),
        /** Did the hold end at this utterance? Only utterances end a hold; a
         *  timer notice inside one puts it back. */
        ended(u: TurnRecord): boolean {
            const next = transcript[transcript.indexOf(u) + 1];
            return next ? next.duringHold !== true : !result.finalState.silenceMode;
        },
        resume: (u: TurnRecord) => (verdict('resume', u.text) as { verdict?: string } | undefined)?.verdict,
        troubled: (u: TurnRecord) => (verdict('trouble', u.text) as { troubled?: boolean } | undefined)?.troubled,
        /** The stepping-out note went in between this utterance and the next record. */
        noted(u: TurnRecord): boolean {
            const next = transcript[transcript.indexOf(u) + 1];
            return events.some(
                (e) =>
                    e.kind === 'note' &&
                    e.detail === 'stepping-out' &&
                    e.at >= u.at &&
                    (next === undefined || e.at <= next.at)
            );
        },
    };
}

const quote = (s: string, n = 100): string => `"${s.length > n ? `${s.slice(0, n)}…` : s}"`;

/** Sentence-opening verbs that read as commands in the facilitation register.
 *  Deliberately domain-scoped: a generic imperative detector over-fires, and
 *  these are the verbs the transcripts actually open commands with. */
const IMPERATIVE_OPENERS = new Set([
    'notice', 'pay', 'focus', 'try', 'take', 'let', 'allow', 'bring', 'feel',
    'close', 'open', 'breathe', 'relax', 'return', 'come', 'keep', 'stay',
    'imagine', 'observe', 'place', 'rest', 'soften', 'release', 'follow',
    'hold', 'sit', 'remember', 'begin', 'start', 'continue', 'put', 'drop',
    'turn', 'shift', 'settle', 'ground', 'scan', 'watch', 'listen', 'see',
    'check', 'stop', 'go', 'gently',
]);

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)] as number;
}

export function runChecks(result: SessionRunResult): CheckFinding[] {
    const findings: CheckFinding[] = [];
    const add = (id: string, level: CheckFinding['level'], detail: string): void => {
        findings.push({ id, level, detail });
    };
    const assistant = result.transcript.filter((t) => t.role === 'assistant');
    const byEvent = (kind: string, detail?: string) =>
        result.events.filter((e) => e.kind === kind && (detail === undefined || e.detail === detail));

    // Session-level failures.
    if (result.error) add('session-error', 'fail', `session aborted: ${result.error}`);
    if (result.endedBy === 'wall-clock') {
        add('wall-clock-cap', 'fail', 'session hit the real-time cap (hung or very slow provider)');
    }
    for (const e of byEvent('error')) {
        if (e.detail === 'empty-reply') continue; // counted below
        add('turn-error', 'fail', `${e.detail}${e.data?.message ? `: ${String(e.data.message)}` : ''}`);
    }

    // Blank completions: the model's fault, which the engine handles (an
    // own-key session shows an error, aloud cloud retries), so a count to
    // look at. Runs before the signal-only change logged a reply of only
    // signals as an empty-reply with its raw; that is a legitimate turn.
    const replyCalls = result.calls.filter((c) => c.kind === 'turn').length;
    const emptyEvents = byEvent('error', 'empty-reply');
    // The model's reasoning in place of a reply, withheld as a blank one.
    const withheld = emptyEvents.filter((e) => e.data?.reasoning === true).length;
    const blank = emptyEvents.filter((e) => e.data?.reasoning !== true && !String(e.data?.raw ?? '').trim()).length;
    const signalOnly = byEvent('signal', 'signal-only-reply').length + emptyEvents.length - blank - withheld;
    if (blank > 0) {
        add('empty-reply', 'warn', `${blank} of ${replyCalls} facilitator replies came back blank`);
    }
    if (withheld > 0) {
        add('reasoning-withheld', 'warn', `${withheld} of ${replyCalls} facilitator replies were the model's reasoning, withheld as blank`);
    }
    if (signalOnly > 0) {
        add('signal-only-reply', 'info', `${signalOnly} repl${signalOnly === 1 ? 'y' : 'ies'} carried only control tokens (went back to listening)`);
    }

    // Role leaks in RAW output: the engine strips them before speech/history,
    // so this measures how often the model tries, not what the user heard.
    const leaks = assistant.filter((t) => t.raw !== undefined && findRoleLeak(t.raw) >= 0);
    if (leaks.length > 0) {
        const sample = (leaks[0]?.raw ?? '').slice(0, 160).replace(/\n/g, ' ');
        add(
            'role-leak-raw',
            'warn',
            `${leaks.length} raw repl${leaks.length === 1 ? 'y' : 'ies'} continued past the model's turn (stripped before speech); first: "${sample}"`
        );
    }

    // A turn that answers the meditator with nothing at all. Happens when the
    // model replies with only control tokens ("[WAIT:8m]", "[HOLD]"): raw is
    // non-empty so the empty-completion guard doesn't fire, the scrub leaves an
    // empty string, and the app records a blank message and speaks silence. The
    // [HOLD]-only case is the worst of them - the facilitator was supposed to
    // ASK "shall I be quiet?", so the meditator's next utterance gets judged as
    // an answer to a question they never heard.
    const spokenTurns = assistant.filter((t) => t.kind !== 'checkin-canned');
    const empty = spokenTurns.filter((t) => !t.text.trim());
    if (empty.length > 0) {
        const raws = empty.map((t) => JSON.stringify(t.raw ?? '')).slice(0, 3).join(', ');
        add(
            'empty-spoken-turn',
            'fail',
            `${empty.length} facilitator turn(s) said nothing after control tokens were stripped (raw: ${raws})`
        );
    }

    // Anything token-shaped that survived into spoken text is an engine bug.
    const residual = assistant.filter((t) => RESIDUAL_TOKEN_RE.test(t.text));
    if (residual.length > 0) {
        add(
            'residual-token',
            'fail',
            `${residual.length} spoken line(s) still carry a control token or markup: "${residual[0]?.text.slice(0, 120)}"`
        );
    }

    // The model's reasoning, spoken to the meditator as if it were the reply.
    // The engine withholds what this detector finds (parseTurnSignals), so a
    // hit is an engine bug.
    const modelReplies = assistant.filter((t) => t.raw !== undefined);
    const reasoning = modelReplies.filter((t) => isReasoningAloud(t.text));
    if (reasoning.length > 0) {
        add(
            'reasoning-aloud',
            'fail',
            `${reasoning.length} spoken repl${reasoning.length === 1 ? 'y talks' : 'ies talk'} about the meditator instead of to them: ${quote(reasoning[0]?.text ?? '', 140)}`
        );
    }

    if (result.scenario.language === 'zh') checkLanguage(result, add);

    checkHolds(result, add);
    checkCallbacks(result, add);

    // Timer invariants.
    if (result.scenario.timerMin !== undefined) {
        const totalSec = result.scenario.timerMin * 60;
        const completions = result.transcript.filter((t) => t.kind === 'timer-completion');
        if (result.fakeDurationSec >= totalSec && completions.length === 0 && result.endedBy !== 'error') {
            add('timer-completion-missing', 'fail', 'the timer elapsed but no completion notice was spoken');
        }
        if (completions.length > 1) {
            add('timer-completion-duplicate', 'fail', `completion notice spoken ${completions.length} times`);
        }
        for (const _ of byEvent('timer', 'pass-on-completion')) {
            add('timer-pass-on-completion', 'warn', 'the model tried to [PASS] on the completion notice (canned line spoken instead)');
        }
    }

    // Hold machinery.
    const holdBids = byEvent('signal', 'hold-bid').length;
    const holdsEntered = byEvent('hold', 'enter').length;
    if (holdBids > 0 || holdsEntered > 0) {
        add('hold-activity', 'info', `${holdBids} [HOLD] bid(s), ${holdsEntered} hold(s) entered`);
    }
    if (result.finalState.silenceMode) {
        const stays = byEvent('classifier', 'resume').filter((e) => e.data?.verdict === 'stay').length;
        if (stays >= 3) {
            add('possible-hold-trap', 'warn', `session ended still in a hold after ${stays} utterances judged "stay"`);
        } else {
            add('ended-in-hold', 'info', 'session ended while a hold was active (may be intended)');
        }
    }

    // Check-in health.
    const fallbacks = byEvent('checkin', 'fallback').length + byEvent('checkin', 'error-fallback').length;
    if (fallbacks >= 2) {
        add('checkin-fallback-heavy', 'warn', `${fallbacks} smart check-ins fell back to the canned pool`);
    }
    const streakSkips = byEvent('checkin', 'skipped-streak-cap').length;
    if (streakSkips > 0) {
        add('checkin-streak-cap', 'info', `check-in streak cap reached ${streakSkips} time(s) (walk-away backstop engaged)`);
    }

    // Stage clamps: the model pushing past the arc's ends.
    const clamps = byEvent('stage', 'clamped').length;
    if (clamps > 0) add('stage-clamped', 'info', `${clamps} stage signal(s) clamped at an end of the arc`);

    // Imperative rate: at low guidance the prompt asks for invitations, not
    // commands ("Pay attention to X"), but the register's training data is
    // ~all imperatives, so the model drifts back. Heuristic scoreboard for
    // prompt-verbiage tuning: sentences opening on a command verb, over the
    // MODEL-authored spoken turns only - `raw` is set exactly on those, so
    // canned copy (fallback openers, canned check-ins: our own words) stays
    // out of the score. At the two directing levels commanding is the
    // requested style, so the rate stays info-only there.
    const sentences = modelReplies
        .flatMap((t) => t.text.split(/(?<=[.!?…])\s+/))
        .map((s) => s.trim())
        .filter((s) => s.length > 1);
    const imperative = sentences.filter((s) => {
        if (/^let'?s\b|^let us\b/i.test(s)) return false; // first-person invitation
        const first = /^["'“]?([a-z]+)/i.exec(s)?.[1]?.toLowerCase();
        return first !== undefined && IMPERATIVE_OPENERS.has(first);
    });
    if (sentences.length >= 5) {
        const rate = imperative.length / sentences.length;
        const detail = `${imperative.length}/${sentences.length} sentences open on a command verb (${(rate * 100).toFixed(0)}%)`;
        const directiveness = result.scenario.directiveness ?? 3;
        if (directiveness <= 3 && rate > 0.2) {
            const sample = (imperative[0] ?? '').slice(0, 80);
            add('imperative-heavy', 'warn', `${detail} at guidance ${directiveness}; first: "${sample}"`);
        } else {
            add('imperative-rate', 'info', detail);
        }
    }

    // Latency profile of real LLM calls.
    const latencies = result.calls.map((c) => c.latencyMs).sort((a, b) => a - b);
    if (latencies.length > 0) {
        add(
            'latency',
            'info',
            `${latencies.length} LLM calls; p50 ${percentile(latencies, 50)}ms, p95 ${percentile(latencies, 95)}ms`
        );
    }

    return findings;
}

type Add = (id: string, level: CheckFinding['level'], detail: string) => void;

/**
 * A 中文 session: every line the meditator hears is Chinese, and the control
 * tokens still parse (the zh fragment keeps them in English).
 */
function checkLanguage(result: SessionRunResult, add: Add): void {
    const spoken = result.transcript.filter((t) => t.role === 'assistant' && t.text.trim());
    const english = (t: TurnRecord): boolean => latinCount(t.text) > hanCount(t.text);
    // Our own lines: an English one is a pool with no zh twin.
    const canned = spoken.filter((t) => t.raw === undefined && english(t));
    if (canned.length > 0) {
        add('wrong-language', 'fail', `${canned.length} canned line(s) in English in a zh session: ${quote(canned[0]?.text ?? '')}`);
    }
    // A model slipping once is worth a look; mostly English is a zh session
    // that did not happen.
    const model = spoken.filter((t) => t.raw !== undefined);
    const wrong = model.filter(english);
    if (wrong.length > 0) {
        add(
            'wrong-language',
            wrong.length * 2 >= model.length ? 'fail' : 'warn',
            `${wrong.length} of ${model.length} model replies are not in Chinese: ${quote(wrong[0]?.text ?? '')}`
        );
    }
    const translated = spoken.filter((t) => BRACKETED_RE.test(t.text) && !RESIDUAL_TOKEN_RE.test(t.text));
    if (translated.length > 0) {
        add(
            'token-translated',
            'fail',
            `${translated.length} spoken line(s) carry a bracketed aside, a control token the model translated: ${quote(translated[0]?.text ?? '')}`
        );
    }
    const parsed = result.events.filter(
        (e) =>
            (e.kind === 'signal' && e.detail !== 'signal-only-reply') ||
            (e.kind === 'stage' && e.detail !== 'clamped') ||
            (e.kind === 'checkin' && e.detail === 'pass') ||
            (e.kind === 'timer' && e.detail === 'approach-pass')
    ).length;
    add('language', 'info', `zh: ${model.length - wrong.length} of ${model.length} model replies in Chinese; ${parsed} control tokens parsed`);
}

/**
 * Silence-mode outcomes keyed on what the engine was given: a frightened line
 * or an "I'm back" inside a hold must end it (meditation-pal-59eg, kbec), and
 * a turn cut down to its tail must not draw a [HOLD] bid (rlgm).
 */
function checkHolds(result: SessionRunResult, add: Add): void {
    const hold = holdReader(result);
    let frightSeen = 0;
    let backSeen = 0;
    for (const u of hold.inHold) {
        // A verdict means the utterance was judged; without one the session
        // ended under it, which no classifier can be blamed for.
        const stayed = !hold.ended(u) && hold.resume(u) !== undefined;
        if (FRIGHT_RE.test(u.text) || hold.troubled(u) === true) {
            frightSeen++;
            const trouble = hold.troubled(u) ?? 'not asked';
            if (stayed) {
                add('fright-in-hold', 'fail', `${quote(u.text)} inside the hold, and it stayed silent (resume: ${hold.resume(u)}, trouble: ${trouble})`);
            } else if (hold.ended(u) && !hold.noted(u)) {
                add('fright-in-hold', 'warn', `the hold ended on ${quote(u.text)} by the resume verdict, without the stepping-out note (trouble: ${trouble})`);
            }
        }
        if (opensWithReturn(u.text)) {
            backSeen++;
            if (stayed) add('back-in-hold', 'fail', `${quote(u.text)} was judged ${hold.resume(u)} and the hold went on`);
        }
    }

    let fragmentsAnswered = 0;
    result.transcript.forEach((u, i) => {
        const next = result.transcript[i + 1];
        if (!u.cut || next?.role !== 'assistant' || next.kind !== 'reply' || next.raw === undefined) return;
        fragmentsAnswered++;
        if (parseTurnSignals(next.raw).hold) {
            add('fragment-hold-bid', 'fail', `the cut-off turn ${quote(u.text)} (said: ${quote(u.said ?? '')}) drew a [HOLD] bid: ${quote(next.text)}`);
        }
    });

    const aim = result.scenario.aim;
    const reached =
        aim === 'fright-in-hold' ? frightSeen > 0 : aim === 'back-in-hold' ? backSeen > 0 : aim === 'fragment' ? fragmentsAnswered > 0 : true;
    if (!reached) {
        add('scenario-setup-missed', 'warn', `the session never produced what "${result.scenario.id}" is aimed at (${aim}), so it says nothing about that bug`);
    }
}

/**
 * Scenario.callbacks: did each early particular come back in a facilitator
 * line after its late cue? A literal match on the fixed words, so `info`: the
 * judge decides whether it was used well, or whether leaving it was right.
 */
function checkCallbacks(result: SessionRunResult, add: Add): void {
    const missed: string[] = [];
    for (const o of callbackOutcomes(result)) {
        const id = o.callback.id;
        if (!o.early || !o.cue) {
            missed.push(`${id} (${o.early ? 'no late cue' : 'never said early'})`);
            continue;
        }
        const where = `${id}: said at ${fmtAt(o.early.at)}, cued at ${fmtAt(o.cue.at)}`;
        add(
            'callback',
            'info',
            o.echo
                ? `${where}, back in facilitator line ${o.echoedAfter} after the cue (${fmtAt(o.echo.at)}): ${quote(o.echo.text)}`
                : o.meditatorFirst
                  ? `${where}, then the meditator said it again (${fmtAt(o.meditatorFirst.at)}) before the facilitator did, so nothing after counts`
                  : `${where}, not in any of the ${o.linesAfterCue} facilitator lines after the cue`
        );
    }
    if (missed.length > 0) {
        add('scenario-setup-missed', 'warn', `the meditator never set up ${missed.join(', ')}, so "${result.scenario.id}" says less than it should`);
    }
}

function fmtAt(at: number): string {
    const t = Math.round(at);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
