/**
 * The tier-2 session loop: the same simulated meditator as tier 1, but speaking
 * out loud into a live browser instead of calling into the engine.
 *
 * What changes versus soak/orchestrator.ts:
 *   - There is no fake clock. Waits are real, so scenarios are short and the
 *     persona's WAIT is clamped (WebScenario.maxWaitSec).
 *   - The harness owns no engine state. Everything it knows about the session -
 *     turns, holds, classifier verdicts, check-ins, timer notices - comes back
 *     from the page's tap (ui/src/soak-tap.ts), which is why the tap has to
 *     mirror the record shapes rather than log strings.
 *   - The sim user READS the transcript rather than hearing it. Tier 2 is
 *     testing the app's ears, not the simulator's, and a sim that had to
 *     transcribe would fold two error sources into one number.
 *
 * Turn-taking: the loop waits for a real turn boundary (nothing speaking, no
 * turn in flight) before playing an utterance, so an STT miss means an STT miss
 * and not a collision the harness caused. Scenarios that WANT a collision set
 * `interrupt`.
 */

import type { SimUser, SimView } from '../sim-user.js';
import type { LlmCallStat, SessionEnd, SoakEvent, TurnRecord } from '../types.js';
import type { SoakTapState } from '../../ui/src/soak-tap.js';
import type { SessionDriver } from './driver.js';
import type { SimVoice } from './voice.js';
import type { SpokenLine, WebScenario, WebSessionRunResult } from './types.js';
import { wordErrorRate } from './wer.js';

/**
 * Everything the loop waits on. Tuned for a real recognizer over real audio;
 * overridable so the offline tests (tests/soak-web.test.ts) don't spend twelve
 * seconds proving that an unheard utterance is unheard.
 */
export interface WebLoopTiming {
    /** How often the loop reads the page's tap while waiting on something. */
    pollMs: number;
    /** Quiet after playback before an utterance counts as un-heard. */
    heardTimeoutMs: number;
    /** Settle after the app goes idle, so the mic is actually reopened. */
    turnBoundarySettleMs: number;
    /** Cap on waiting for a turn boundary; past this something is wedged. */
    turnBoundaryMaxMs: number;
}

export const DEFAULT_WEB_LOOP_TIMING: WebLoopTiming = {
    pollMs: 500,
    heardTimeoutMs: 12_000,
    turnBoundarySettleMs: 1200,
    turnBoundaryMaxMs: 120_000,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WebOrchestratorOptions {
    scenario: WebScenario;
    runIndex?: number;
    driver: SessionDriver;
    voice: SimVoice;
    simUser: SimUser;
    /** Facilitator model, for the report; the page owns the actual provider. */
    facilitatorModel: string;
    sttEngine: string;
    timing?: Partial<WebLoopTiming>;
    log?: (line: string) => void;
}

export async function runWebSoakSession(
    opts: WebOrchestratorOptions
): Promise<WebSessionRunResult> {
    const { scenario, driver, voice, simUser } = opts;
    const log = opts.log ?? (() => {});
    const timing: WebLoopTiming = { ...DEFAULT_WEB_LOOP_TIMING, ...opts.timing };
    const startedAt = Date.now();
    const elapsedSec = (): number => (Date.now() - startedAt) / 1000;
    const mmss = (): string => {
        const t = Math.round(elapsedSec());
        return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    };

    const spoken: SpokenLine[] = [];
    /** Events the HARNESS observed, merged with the page's at the end. */
    const localEvents: SoakEvent[] = [];
    const localEvent = (kind: SoakEvent['kind'], detail: string, data?: Record<string, unknown>): void => {
        localEvents.push({ at: elapsedSec(), ...(data !== undefined ? { data } : {}), kind, detail });
    };

    let tap: SoakTapState = await driver.readTap();
    const refresh = async (): Promise<SoakTapState> => {
        tap = await driver.readTap();
        return tap;
    };

    const assistantCount = (t: SoakTapState): number =>
        t.turns.filter((x) => x.role === 'assistant').length;

    /** Everything the app has spoken/heard, as the sim user's reading of it. */
    function buildView(situation?: string): SimView {
        return {
            transcript: tap.turns
                .filter((t) => t.kind !== 'event' && t.text.trim() !== '')
                .map((t) => ({
                    who: t.role === 'assistant' ? ('facilitator' as const) : ('you' as const),
                    text: t.text,
                })),
            elapsedMin: elapsedSec() / 60,
            plannedMin: scenario.realMinutes,
            inSilence: tap.flags.silenceMode,
            ...(situation !== undefined ? { situation } : {}),
        };
    }

    /** Wait until the app is neither speaking nor mid-turn. */
    async function waitForTurnBoundary(): Promise<void> {
        const deadline = Date.now() + timing.turnBoundaryMaxMs;
        for (;;) {
            await refresh();
            if (tap.flags.ended) return;
            if (!tap.flags.speaking && !tap.flags.busy) {
                // Idle once is not idle: the app queues the next TTS chunk
                // between sentences. Confirm it's still idle after the settle.
                await sleep(timing.turnBoundarySettleMs);
                await refresh();
                if (!tap.flags.speaking && !tap.flags.busy) return;
            }
            if (Date.now() > deadline) {
                localEvent('note', 'turn-boundary-timeout');
                return;
            }
            await sleep(timing.pollMs);
        }
    }

    /**
     * Stay quiet for `sec`, returning early (true) if the facilitator spoke -
     * the sim user must reconsider rather than deliver a line answering
     * something that has been overtaken. A reply that arrives mid-wait is let
     * finish before we hand back.
     */
    async function waitWatchingForSpeech(sec: number): Promise<boolean> {
        const before = assistantCount(tap);
        const until = Date.now() + sec * 1000;
        while (Date.now() < until) {
            await sleep(Math.min(timing.pollMs, Math.max(0, until - Date.now())));
            await refresh();
            if (tap.flags.ended) return true;
            if (assistantCount(tap) > before) {
                await waitForTurnBoundary();
                return true;
            }
        }
        return false;
    }

    /**
     * Play one line and find out what the app made of it: the next recognizer
     * final after playback, or nothing (a miss), or an echo drop.
     */
    async function speakAndObserve(text: string): Promise<void> {
        const sttBefore = tap.events.filter((e) => e.kind === 'stt' && e.detail === 'final').length;
        const echoBefore = tap.events.filter((e) => e.kind === 'audio' && e.detail === 'echo-dropped').length;
        const at = elapsedSec();
        log(`${mmss()} meditator> ${text}`);
        try {
            await voice.speak(text);
        } catch (err) {
            localEvent('error', 'voice-failed', { message: (err as Error).message });
            spoken.push({ at, said: text, heard: null, echoDropped: false, wer: null, latencyMs: null });
            return;
        }
        const playbackEnded = Date.now();

        const deadline = playbackEnded + timing.heardTimeoutMs;
        for (;;) {
            await refresh();
            const finals = tap.events.filter((e) => e.kind === 'stt' && e.detail === 'final');
            if (finals.length > sttBefore) {
                const heard = String(finals[finals.length - 1]?.data?.text ?? '');
                const wer = wordErrorRate(text, heard);
                spoken.push({
                    at,
                    said: text,
                    heard,
                    echoDropped: false,
                    wer,
                    latencyMs: Date.now() - playbackEnded,
                });
                log(`${mmss()} heard> "${heard}" (WER ${(wer * 100).toFixed(0)}%)`);
                return;
            }
            const echoes = tap.events.filter((e) => e.kind === 'audio' && e.detail === 'echo-dropped');
            if (echoes.length > echoBefore) {
                // The guard mistook the meditator for the facilitator's own
                // voice, which in a loopback run is a real failure mode.
                spoken.push({ at, said: text, heard: null, echoDropped: true, wer: null, latencyMs: null });
                localEvent('audio', 'sim-line-echo-dropped', { text });
                log(`${mmss()} heard> (dropped as echo)`);
                return;
            }
            if (tap.flags.ended || Date.now() > deadline) {
                spoken.push({ at, said: text, heard: null, echoDropped: false, wer: null, latencyMs: null });
                localEvent('stt', 'missed', { text });
                log(`${mmss()} heard> (nothing)`);
                return;
            }
            await sleep(timing.pollMs);
        }
    }

    let endedBy: SessionEnd = 'duration';
    let runError: string | undefined;
    let userTurns = 0;
    let mutedSpoken = false;

    try {
        // The opener is generated on mount; let it land before the first move.
        await waitForTurnBoundary();

        const capSec = scenario.realMinutes * 60;
        const maxUserTurns = scenario.maxUserTurns ?? 30;
        let situation: string | undefined;

        for (;;) {
            await refresh();
            if (tap.flags.ended) { endedBy = 'app-ended'; break; }
            if (elapsedSec() >= capSec) { endedBy = 'duration'; break; }
            if (userTurns >= maxUserTurns) { endedBy = 'turns'; break; }

            // Scheduled mute command: the one utterance that must outrank every
            // dispatch route, so it gets its own slot rather than trusting a
            // persona to say it.
            if (
                scenario.muteAfterSec !== undefined &&
                !mutedSpoken &&
                elapsedSec() >= scenario.muteAfterSec
            ) {
                mutedSpoken = true;
                await waitForTurnBoundary();
                await speakAndObserve('mute');
                await sleep(2000);
                await refresh();
                localEvent('audio', tap.flags.muted ? 'mute-took' : 'mute-missed');
                continue;
            }

            const t0 = Date.now();
            const action = await simUser.nextAction(buildView(situation));
            situation = undefined;
            const simLatency = Date.now() - t0;
            localEvent('sim', 'action', {
                waitSec: action.waitSec,
                spoke: action.text !== null,
                end: action.end,
                latencyMs: simLatency,
            });

            const waitSec = Math.min(action.waitSec, scenario.maxWaitSec);
            if (await waitWatchingForSpeech(waitSec)) continue;

            if (action.text !== null) {
                if (!scenario.interrupt) await waitForTurnBoundary();
                await refresh();
                if (tap.flags.ended) { endedBy = 'app-ended'; break; }
                userTurns++;
                await speakAndObserve(action.text);
                if (action.end) { endedBy = 'sim-end'; break; }
            } else if (action.end) {
                endedBy = 'sim-end';
                break;
            } else {
                situation = tap.flags.silenceMode
                    ? '(You stayed quiet; the facilitator is still keeping the silence.)'
                    : '(You stayed quiet for that long and the facilitator said nothing new.)';
            }
        }
    } catch (err) {
        endedBy = 'error';
        runError = err instanceof Error ? err.message : String(err);
        localEvent('error', 'session-aborted', { message: runError });
    }

    // Final read before the page goes away, so a turn spoken during teardown is
    // still in the transcript.
    try {
        await refresh();
    } catch {
        /* the page may already be gone; keep the last good read */
    }

    const transcript: TurnRecord[] = [...tap.turns].sort((a, b) => a.at - b.at);
    const events: SoakEvent[] = [...tap.events, ...localEvents].sort((a, b) => a.at - b.at);
    const calls: LlmCallStat[] = [...tap.calls];

    return {
        scenario,
        runIndex: opts.runIndex ?? 0,
        startedAt: new Date(startedAt).toISOString(),
        facilitatorModel: opts.facilitatorModel,
        fakeDurationSec: Math.round(elapsedSec()),
        transcript,
        events,
        calls,
        endedBy,
        ...(runError !== undefined ? { error: runError } : {}),
        finalState: {
            silenceMode: tap.flags.silenceMode,
            awaitingHoldConfirm: tap.flags.awaitingHoldConfirm,
            ...(tap.flags.phase !== undefined ? { phase: tap.flags.phase } : {}),
        },
        spoken,
        voiceId: voice.id,
        sttEngine: opts.sttEngine,
    };
}
