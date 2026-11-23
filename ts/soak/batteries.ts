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

import { ROSTER } from '../evals/models.js';
import { isFacilitatorPick } from './prices.js';
import type { RoleSpecs } from './roles.js';

/**
 * What aloud offers as a facilitator today, as eval roster ids: the roster's
 * shipped models that the hosted price table puts on the picker (not an
 * unlisted or utility-only entry). Read at load, so the models battery
 * follows the allowlist without an edit here.
 */
export const SHIPPED_FACILITATORS: readonly string[] = ROSTER.filter(
    (m) => m.shipped && isFacilitatorPick(m.provider, m.model)
).map((m) => m.id);

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
    user: 'anthropic:claude-haiku-5-5',
    utility: 'anthropic:claude-haiku-5-5',
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
            'Every facilitator aloud ships, head to head, scored by two judges from different families so no contestant is judged by its own family alone.',
        roles: {
            facilitators: [...SHIPPED_FACILITATORS],
            // Off the contest on purpose: Haiku 5.5 is a contestant, and a
            // meditator sharing a facilitator's model is a collision.
            user: 'anthropic:claude-haiku-4-5-20251001',
            utility: 'anthropic:claude-haiku-5-5',
            judge: ['openai:gpt-6-sol', 'anthropic:claude-opus-5-5'],
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
