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

/**
 * Endpointing under mid-thought pauses (meditation-pal-0uw7 / m56t): the same
 * reflective lines, each with a `say` [[slnc]] pause dropped after a dangling
 * word, at lengths that straddle the adaptive silence window (3s base, up to
 * 5s with speech, +4s when a speculative pass sees an unfinished clause).
 * Run once with speculation on and once off: the finals-per-line column says
 * where each configuration cuts the speaker, and sttBilled says what each
 * paid. Two sentence-complete pauses are controls: a cut there is a legitimate
 * end of turn, not an endpointing miss.
 */
const PAUSE_LINES: readonly string[] = [
    "I'm noticing a kind of tightness in my [[slnc 2000]] chest, right around the center.",
    "There's this feeling that comes up when I think about [[slnc 3500]] my brother, and how we left things.",
    "It's hard to describe. It's sort of [[slnc 4500]] heavy, like something pressing down on me.",
    'When I stay with it, I notice that I want to [[slnc 6000]] pull away from it and think about something else.',
    "I think part of me is afraid that if I really feel this, then [[slnc 8000]] it won't stop.",
    "Okay. That feels a little softer now. [[slnc 4500]] There's more room in my breath.",
    "I'm going to stay with the [[slnc 5000]] warmth in my hands for a little while.",
    "It's like the feeling has a color, and the color is [[slnc 7000]] something between grey and blue.",
    "Thank you. That's enough for today.",
];

const PAUSES_BASE: Omit<WebScenario, 'id' | 'title'> = {
    persona: SILENCE_SEEKER,
    modeId: 'exploration',
    focuses: ['emotions'],
    directiveness: 1,
    verbosity: 'low',
    checkinTiming: 'fixed',
    silenceCheckinSec: 300,
    silenceModeEnabled: false,
    script: [...PAUSE_LINES],
    scriptWaitSec: 3,
    silentFacilitator: true,
    finalsSettleMs: 9000,
    realMinutes: 8,
    maxWaitSec: 5,
    fakeMinutes: 8,
    maxUserTurns: PAUSE_LINES.length,
};

export const PAUSE_SCENARIOS: readonly WebScenario[] = [
    {
        ...PAUSES_BASE,
        id: 'pauses',
        title: 'Mid-thought pauses with speculative passes ON (the default)',
        sttSpeculation: true,
    },
    {
        ...PAUSES_BASE,
        id: 'pauses-nospec',
        title: 'Mid-thought pauses with speculative passes OFF (one transcription per turn)',
        sttSpeculation: false,
    },
];

export function getWebScenarios(ids: string[] | 'all'): WebScenario[] {
    // The pause experiments are opt-in by id: they measure a knob, not the
    // product, and would double the matrix's wall time.
    if (ids === 'all') return [...WEB_SCENARIOS];
    const byId = new Map([...WEB_SCENARIOS, ...PAUSE_SCENARIOS].map((s) => [s.id, s]));
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
            ...(scenario.sttSpeculation !== undefined ? { sttSpeculation: scenario.sttSpeculation } : {}),
        },
    };
}
