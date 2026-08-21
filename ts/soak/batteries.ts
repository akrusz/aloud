/**
 * Named batteries: a whole pre-release check as one word, so the decision of
 * what to run and who plays which role is made once, reviewed once, and not
 * re-improvised at the prompt each release.
 *
 * Every battery here is held to "no role collisions" by
 * tests/soak-roles.test.ts (see roles.ts for why that matters), so a preset can
 * never be the thing that quietly contaminates a scoreboard. Individual flags
 * still override anything a battery sets.
 *
 * Tier 2 (the browser/audio harness) is deliberately not part of a battery: it
 * runs in real time and owns the machine's audio, so it stays an explicit
 * `npm run soak:web`. Batteries are the fast, parallel, walk-away check.
 */

import type { RoleSpecs } from './roles.js';

export interface Battery {
    id: string;
    /** One line, shown by --list-batteries. */
    description: string;
    roles: RoleSpecs;
    /** Scenario ids, or 'all'. */
    scenarios: string[] | 'all';
    /** Runs per scenario. */
    sessions: number;
    concurrency?: number;
}

/**
 * The default cast. Judge is deliberately a different family from the default
 * facilitator - see roles.ts. Meditator and classifiers run on Haiku: cheap,
 * fast, and (for the classifiers) what the shipped app actually uses.
 */
export const DEFAULT_ROLES: RoleSpecs = {
    facilitators: ['anthropic'],
    user: 'anthropic:claude-haiku-4-5',
    utility: 'anthropic:claude-haiku-4-5',
    judge: 'openai:gpt-5.5',
};

export const BATTERIES: readonly Battery[] = [
    {
        id: 'smoke',
        description: 'Two scenarios, one session each. "Did I break the engine?" in a few minutes.',
        roles: DEFAULT_ROLES,
        scenarios: ['baseline', 'silence'],
        sessions: 1,
        concurrency: 2,
    },
    {
        id: 'pre-release',
        description:
            'The full matrix, two sessions per scenario. The walk-away check before cutting a release.',
        roles: DEFAULT_ROLES,
        scenarios: 'all',
        sessions: 2,
        concurrency: 4,
    },
    {
        id: 'models',
        description:
            'Facilitator comparison across three families, judged by a fourth that is not in the contest.',
        roles: {
            // OpenAI is the judge below, so it is NOT a contestant: a judge in
            // its own contest is the collision this battery exists to avoid.
            facilitators: ['anthropic', 'groq', 'openrouter'],
            user: 'anthropic:claude-haiku-4-5',
            utility: 'anthropic:claude-haiku-4-5',
            judge: 'openai:gpt-5.5',
        },
        scenarios: 'all',
        sessions: 2,
        concurrency: 4,
    },
];

export function getBattery(id: string): Battery {
    const battery = BATTERIES.find((b) => b.id === id);
    if (!battery) {
        throw new Error(
            `Unknown battery "${id}". Available: ${BATTERIES.map((b) => b.id).join(', ')}`
        );
    }
    return battery;
}
