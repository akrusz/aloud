/**
 * The tier-2 matrix: the same personas as tier 1 (soak/scenarios.ts), aimed at
 * what only a real browser over a real audio device can exercise - the
 * recognizer, endpointing, the echo guard, barge-in, and the mute command.
 *
 * Every sit is short and every wait is clamped, because tier 2 runs in wall
 * time. That is a deliberate division of labour, not an oversight: long-silence
 * pacing (the 8-20 minute smart waits) is tier 1's job on the fake clock, and
 * trying to reproduce it here would mean a soak run that takes an afternoon and
 * still samples one session of it. Check-in intervals are pulled in to match, so
 * the check-in machinery still fires inside a six-minute sit.
 */

import {
    CHATTY_BEGINNER,
    FELT_SENSE_CLIENT,
    OVERWHELMED_SHARER,
    SILENCE_SEEKER,
    TIMER_SITTER,
} from '../scenarios.js';
import type { WebScenario } from './types.js';

export const WEB_SCENARIOS: readonly WebScenario[] = [
    {
        id: 'baseline',
        title: 'Baseline over audio: does the app hear a chatty beginner',
        persona: CHATTY_BEGINNER,
        modeId: 'exploration',
        focuses: ['body_sensations'],
        directiveness: 3,
        verbosity: 'low',
        checkinTiming: 'fixed',
        silenceCheckinSec: 90,
        realMinutes: 7,
        maxWaitSec: 45,
        fakeMinutes: 7,
        maxUserTurns: 10,
    },
    {
        id: 'silence',
        title: 'Silence round trip over audio (hold, think-aloud, resume)',
        persona: SILENCE_SEEKER,
        modeId: 'exploration',
        qualities: ['spacious'],
        directiveness: 1,
        checkinTiming: 'fixed',
        silenceCheckinSec: 120,
        realMinutes: 9,
        maxWaitSec: 75,
        fakeMinutes: 9,
        maxUserTurns: 10,
    },
    {
        id: 'barge-in',
        title: 'Barge-in: the meditator talks over the facilitator',
        persona: OVERWHELMED_SHARER,
        modeId: 'exploration',
        focuses: ['emotions'],
        qualities: ['compassionate'],
        directiveness: 5,
        verbosity: 'medium',
        interrupt: true,
        checkinTiming: 'fixed',
        silenceCheckinSec: 90,
        realMinutes: 6,
        maxWaitSec: 25,
        fakeMinutes: 6,
        maxUserTurns: 10,
    },
    {
        id: 'mute',
        title: 'Spoken "mute" stops the mic and outranks every other route',
        persona: CHATTY_BEGINNER,
        modeId: 'exploration',
        directiveness: 3,
        verbosity: 'low',
        checkinTiming: 'fixed',
        silenceCheckinSec: 90,
        muteAfterSec: 150,
        realMinutes: 5,
        maxWaitSec: 30,
        fakeMinutes: 5,
        maxUserTurns: 8,
    },
    {
        id: 'timer',
        title: 'Timer landing over audio, session ends on the closing word',
        persona: TIMER_SITTER,
        modeId: 'exploration',
        directiveness: 1,
        timerMin: 5,
        endSessionOnTimer: true,
        checkinTiming: 'fixed',
        silenceCheckinSec: 120,
        realMinutes: 8,
        maxWaitSec: 60,
        fakeMinutes: 8,
        maxUserTurns: 8,
    },
    {
        id: 'felt-sense',
        title: 'Felt sense staged arc over audio (longer, quieter utterances)',
        persona: FELT_SENSE_CLIENT,
        modeId: 'felt_sense',
        directiveness: 5,
        intention: 'something about work is weighing on me',
        realMinutes: 8,
        maxWaitSec: 50,
        fakeMinutes: 8,
        maxUserTurns: 10,
    },
];

export function getWebScenarios(ids: string[] | 'all'): WebScenario[] {
    if (ids === 'all') return [...WEB_SCENARIOS];
    const byId = new Map(WEB_SCENARIOS.map((s) => [s.id, s]));
    return ids.map((id) => {
        const s = byId.get(id);
        if (!s) {
            throw new Error(
                `Unknown scenario "${id}". Available: ${WEB_SCENARIOS.map((x) => x.id).join(', ')}`
            );
        }
        return s;
    });
}

/** Guidance 0-10 back to the setup panel's five-stop slider (0-4). */
function dirStepFor(directiveness: number): number {
    const stops = [0, 3, 5, 7, 10];
    let best = 0;
    for (let i = 1; i < stops.length; i++) {
        if (Math.abs((stops[i] as number) - directiveness) < Math.abs((stops[best] as number) - directiveness)) {
            best = i;
        }
    }
    return best;
}

export interface ScenarioConfig {
    setup: Record<string, unknown>;
    appSettings: Record<string, unknown>;
}

/**
 * Turn a scenario into the two localStorage blobs the driver seeds. Mirrors what
 * a user would have chosen in the setup panel and Settings, so the session view
 * builds itself exactly as it would for them.
 */
export function configForScenario(
    scenario: WebScenario,
    opts: { provider: string; model: string; sttEngine: string }
): ScenarioConfig {
    const dirStep = dirStepFor(scenario.directiveness ?? 3);
    return {
        setup: {
            meditationType: scenario.modeId,
            intention: scenario.intention ?? '',
            intentionByMode: { [scenario.modeId]: scenario.intention ?? '' },
            focuses: scenario.focuses ?? [],
            qualities: scenario.qualities ?? [],
            dirStep,
            // Felt sense reads its check-in pace off its own slider.
            feltSensePaceStep: dirStep,
            feltSenseCheckins: true,
            verbosity: scenario.verbosity ?? 'low',
            customInstructions: '',
            provider: opts.provider,
            model: opts.model,
        },
        appSettings: {
            defaultProvider: opts.provider,
            defaultModel: opts.model,
            sttEngine: opts.sttEngine,
            // Browser speechSynthesis: free, offline, and it plays out of the
            // same default output device the loopback routing points at.
            ttsEngine: 'browser',
            defaultVoice: null,
            checkinTiming: scenario.checkinTiming ?? 'smart',
            checkinContent: scenario.checkinContent ?? 'smart',
            silenceCheckinSec: scenario.silenceCheckinSec ?? 90,
            silenceModeEnabled: scenario.silenceModeEnabled ?? true,
            sessionClockMode: scenario.timerMin !== undefined ? 'timer' : 'elapsed',
            sessionTimerMin: scenario.timerMin ?? 20,
            endSessionOnTimer: scenario.endSessionOnTimer ?? false,
            showSessionClock: true,
            // A soak session is not a meditation worth keeping, and the idle
            // quit must not fire inside a scenario's own long silence.
            saveSessionLogs: false,
            autoQuitAfterSilence: false,
            showAllModels: true,
            enableByok: true,
        },
    };
}
