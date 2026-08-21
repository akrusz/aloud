/**
 * Deterministic post-run checks over one session's transcript + event log.
 * These catch the mechanical failures an LLM judge can miss or hallucinate:
 * role leaks in raw output, control tokens that survived the scrub, invariants
 * of the hold/check-in/timer machinery. `fail` findings drive the CLI's exit
 * code; `warn` is worth a look; `info` is context for the report.
 */

import { findRoleLeak } from '../src/facilitation/index.js';
import type { CheckFinding, SessionRunResult } from './types.js';

/** Spoken text must never contain a control token or markup the scrub missed. */
const RESIDUAL_TOKEN_RE = /\[(HOLD|NEXT|BACK|PASS|WAIT[:\]])|<\/?[a-z][\w-]*>/i;

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
        add('turn-error', 'fail', `${e.detail}${e.data?.message ? `: ${String(e.data.message)}` : ''}`);
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
