/**
 * Tier-2-only checks, run alongside tier 1's runChecks (which still owns the
 * engine invariants - control tokens, timer completion, hold traps).
 *
 * These score the audio round trip: did the app hear what was said, did its own
 * voice get mistaken for the meditator, did barge-in and the mute command work.
 * A recognizer is never perfect, so the thresholds separate "speech is hard"
 * from "the session was not usable".
 */

import type { CheckFinding } from '../types.js';
import type { WebSessionRunResult } from './types.js';

/** Above this WER an utterance is treated as not understood. */
const GARBLED_WER = 0.5;
/** Fraction of utterances that may go unheard before it's a failure. */
const MISS_RATE_FAIL = 0.34;
const MISS_RATE_WARN = 0.15;

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
        : (sorted[mid] as number);
}

export function runAudioChecks(result: WebSessionRunResult): CheckFinding[] {
    const findings: CheckFinding[] = [];
    const add = (id: string, level: CheckFinding['level'], detail: string): void => {
        findings.push({ id, level, detail });
    };
    const byEvent = (kind: string, detail?: string) =>
        result.events.filter((e) => e.kind === kind && (detail === undefined || e.detail === detail));

    const spoken = result.spoken;
    if (spoken.length === 0) {
        add('no-utterances', 'fail', 'the simulated meditator never spoke (voice or driver problem)');
        return findings;
    }

    // Heard at all.
    const missed = spoken.filter((s) => s.heard === null && !s.echoDropped);
    const missRate = missed.length / spoken.length;
    const missDetail = `${missed.length}/${spoken.length} utterance(s) produced no recognizer final (${Math.round(missRate * 100)}%)`;
    if (missRate > MISS_RATE_FAIL) add('stt-miss-rate', 'fail', missDetail);
    else if (missRate > MISS_RATE_WARN) add('stt-miss-rate', 'warn', missDetail);
    else if (missed.length > 0) add('stt-miss-rate', 'info', missDetail);

    // Heard accurately. Median rather than mean: one mangled utterance in a
    // clean run is speech, a shifted median is a broken capture path.
    const wers = spoken.filter((s) => s.wer !== null).map((s) => s.wer as number);
    if (wers.length > 0) {
        const med = median(wers);
        add(
            'stt-accuracy',
            med > GARBLED_WER ? 'fail' : med > 0.25 ? 'warn' : 'info',
            `median word error rate ${Math.round(med * 100)}% over ${wers.length} heard utterance(s) ` +
                `(voice ${result.voiceId}, recognizer ${result.sttEngine})`
        );
        const garbled = spoken.filter((s) => (s.wer ?? 0) > GARBLED_WER);
        if (garbled.length > 0) {
            const worst = garbled[0] as (typeof garbled)[number];
            add(
                'stt-garbled',
                'warn',
                `${garbled.length} utterance(s) came through badly; first: said "${worst.said.slice(0, 80)}" → heard "${(worst.heard ?? '').slice(0, 80)}"`
            );
        }
    }

    // The echo guard turning on the meditator. In a loopback run the app hears
    // its own TTS, so this is the failure mode the topology is built to surface.
    const selfDropped = spoken.filter((s) => s.echoDropped);
    if (selfDropped.length > 0) {
        add(
            'echo-guard-false-positive',
            'fail',
            `${selfDropped.length} meditator utterance(s) were dropped as TTS echo; first: "${selfDropped[0]?.said.slice(0, 80)}"`
        );
    }
    const echoDrops = byEvent('audio', 'echo-dropped').length;
    if (echoDrops > 0) {
        add('echo-guard-activity', 'info', `${echoDrops} capture(s) dropped as the facilitator's own voice`);
    }

    // Recognizer latency: how long after playback the final arrived.
    const latencies = spoken.map((s) => s.latencyMs).filter((v): v is number => v !== null);
    if (latencies.length > 0) {
        add('stt-latency', 'info', `median ${Math.round(median(latencies))}ms from end of speech to final`);
    }

    // Scenario-specific gear.
    const scenario = result.scenario as WebSessionRunResult['scenario'] & {
        interrupt?: boolean;
        muteAfterSec?: number;
    };
    if (scenario.interrupt) {
        const bargeIns = byEvent('audio', 'barge-in').length;
        add(
            'barge-in',
            bargeIns > 0 ? 'info' : 'warn',
            bargeIns > 0
                ? `${bargeIns} barge-in(s) cancelled the facilitator's speech`
                : 'the meditator spoke over the facilitator but barge-in never fired'
        );
    }
    if (scenario.muteAfterSec !== undefined) {
        if (byEvent('audio', 'mute-took').length > 0) {
            add('mute-command', 'info', 'the spoken mute command stopped the mic');
        } else if (byEvent('audio', 'mute-missed').length > 0) {
            add('mute-command', 'fail', 'the spoken mute command did not mute the mic');
        }
    }

    // STT engine trouble the app surfaced on its own.
    const sttErrors = byEvent('stt', 'error');
    if (sttErrors.length > 0) {
        add(
            'stt-errors',
            sttErrors.length >= 3 ? 'fail' : 'warn',
            `${sttErrors.length} recognizer error(s); first: ${String(sttErrors[0]?.data?.message ?? 'unknown')}`
        );
    }

    return findings;
}
