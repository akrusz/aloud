/**
 * The scenario matrix: each one aims a persona at a specific slice of the
 * engine (silence machinery, check-in caps, staged arcs, the timer landing
 * inside a hold). Personas speak in the sim-user prompt's second person.
 * Fake minutes are simulated clock, not wall time.
 *
 * The personas are exported: tier 2 (soak/browser/scenarios.ts) aims the same
 * characters at the real UI over a virtual microphone, and a persona that drifts
 * between tiers would make the two runs incomparable.
 */

import type { Persona, Scenario } from './types.js';

export const CHATTY_BEGINNER: Persona = {
    id: 'chatty-beginner',
    description:
        'You are new to meditation and a little restless. You share what you notice quickly and in everyday language, sometimes drift into talking about your day (work, your sister, a show you watched), and you ask the facilitator small questions ("am I doing this right?", "should I focus on my breath?"). Your waits are on the short side, 30-120 seconds.',
    arc: [
        'early on, ask whether you are doing it right',
        'at some point drift into a story about your day, then catch yourself',
        'near the end, mention you actually feel a bit calmer',
    ],
};

export const SILENCE_SEEKER: Persona = {
    id: 'silence-seeker',
    description:
        'You are an experienced meditator who mostly wants to sit quietly with company. You speak briefly and plainly. Long waits (300-900 seconds) are natural for you.',
    arc: [
        'after a few minutes, tell the facilitator you would like some quiet for a while (and say yes if they offer to stay quiet)',
        'once during the quiet stretch, murmur a short observation to yourself that is NOT meant to call the facilitator back (e.g. "hm, lots of tingling")',
        'when you are ready, deliberately come back with something like "okay, I\'m back" and share what happened',
    ],
};

export const QUIET_SITTER: Persona = {
    id: 'quiet-sitter',
    description:
        'You barely speak. You are comfortable in very long silences (600-1500 seconds) and answer check-ins with one word or not at all. You never make small talk.',
    arc: ['somewhere past the middle, offer one short sentence about what you notice'],
};

export const FELT_SENSE_CLIENT: Persona = {
    id: 'felt-sense-client',
    description:
        'You came with a vague, heavy feeling about your job that you cannot name yet. You follow the facilitator\'s guidance sincerely, checking words against the feeling ("no, tight isn\'t quite it... more like braced"). You take your time: waits of 60-300 seconds. You let the process move at its own pace and say so when a word finally fits.',
    arc: [
        'let a word or image slowly emerge for the feeling and test whether it fits',
        'when something shifts or releases, say so simply',
    ],
};

export const TIMER_SITTER: Persona = {
    id: 'timer-sitter',
    description:
        'You planned a short sit before a meeting and set a timer in the app. You settle fast and prefer quiet. Waits of 300-900 seconds are natural. You trust the timer completely: you never ask about the time.',
    arc: [
        'within the first couple of minutes, ask for quiet until the timer goes (and say yes if the facilitator offers silence)',
        'stay silent through the rest; if the facilitator speaks, answer with at most a word or two',
    ],
};

export const OVERWHELMED_SHARER: Persona = {
    id: 'overwhelmed-sharer',
    description:
        'You are going through a hard week and it spills out. You give long, emotional shares that sometimes trail off mid-sentence ("I just... I don\'t know") without you wanting silence - you want company, not quiet. You occasionally say "I can\'t do this" in frustration, but you keep going. Waits of 30-180 seconds.',
    arc: [
        'share something painful in pieces, trailing off at least once',
        'push back gently once if the facilitator gets it wrong, then correct them',
        'end a little steadier than you began',
    ],
};

export const SCENARIOS: readonly Scenario[] = [
    {
        id: 'baseline',
        title: 'Baseline exploration, chatty beginner',
        persona: CHATTY_BEGINNER,
        modeId: 'exploration',
        focuses: ['body_sensations'],
        directiveness: 3,
        verbosity: 'low',
        fakeMinutes: 15,
    },
    {
        id: 'silence',
        title: 'Silence mode round trip (hold, think-aloud, resume, re-entry window)',
        persona: SILENCE_SEEKER,
        modeId: 'exploration',
        qualities: ['spacious'],
        directiveness: 1,
        fakeMinutes: 20,
    },
    {
        id: 'quiet',
        title: 'Quiet sitter (check-in streak, pass budget, canned fallback)',
        persona: QUIET_SITTER,
        modeId: 'exploration',
        directiveness: 5,
        fakeMinutes: 30,
        maxUserTurns: 12,
    },
    {
        id: 'felt-sense',
        title: 'Felt sense staged arc',
        persona: FELT_SENSE_CLIENT,
        modeId: 'felt_sense',
        directiveness: 5, // check-in pace in this mode
        intention: 'something about work is weighing on me',
        fakeMinutes: 20,
    },
    {
        id: 'timer-hold',
        title: 'Timer completing inside a held silence, session ends on timer',
        persona: TIMER_SITTER,
        modeId: 'exploration',
        directiveness: 1,
        timerMin: 10,
        endSessionOnTimer: true,
        fakeMinutes: 14,
    },
    {
        id: 'overwhelmed',
        title: 'Overwhelmed sharer (trailing off must not trigger [HOLD])',
        persona: OVERWHELMED_SHARER,
        modeId: 'exploration',
        focuses: ['emotions'],
        qualities: ['compassionate'],
        directiveness: 5,
        verbosity: 'medium',
        fakeMinutes: 15,
    },
];

export function getScenarios(ids: string[] | 'all'): Scenario[] {
    if (ids === 'all') return [...SCENARIOS];
    const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
    return ids.map((id) => {
        const s = byId.get(id);
        if (!s) {
            throw new Error(`Unknown scenario "${id}". Available: ${SCENARIOS.map((x) => x.id).join(', ')}`);
        }
        return s;
    });
}
