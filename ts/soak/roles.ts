/**
 * Who plays what, and which pairings invalidate the result.
 *
 * A soak run casts four roles, and two of them must not be the same model:
 *
 *   facilitator  the thing under test
 *   meditator    the simulated user driving the session
 *   classifiers  the cheap utility model behind the silence yes/no calls
 *   judge        scores the finished transcript
 *
 * A judge scoring its own output is the one that quietly ruins a scoreboard:
 * LLM judges prefer their own generations, so a same-model judge inflates one
 * row. In a `--facilitator=a,b,c` comparison that bias lands on ONE contestant,
 * which is worse than applying to all of them - the ranking is then partly an
 * artifact of who the judge is. A sim meditator sharing the facilitator's model
 * is the other one: the two halves of the conversation stop being independent.
 *
 * Classifiers sharing the facilitator's model is NOT a collision. That's what
 * the shipped app does (views/session.ts buildUtilityProvider runs Haiku next to
 * whatever is facilitating), so matching it is realism, not contamination.
 *
 * Defaults and batteries are held to "no collisions" by tests
 * (tests/soak-roles.test.ts). An explicit override may still collide - the run
 * proceeds, but it says so on the way in and the report stamps it next to the
 * scores, so a contaminated number never travels without its caveat.
 */

import { buildProviderFromSpec } from './providers.js';
import type { LLMProvider } from '../src/llm/index.js';

export interface RoleSpecs {
    /** Provider specs under test; more than one is a comparison run. */
    facilitators: string[];
    /** The simulated meditator. */
    user: string;
    /** Cheap model behind the silence classifiers. */
    utility: string;
    /** Null when --no-judge. */
    judge: string | null;
}

export interface ResolvedRole {
    /** What the CLI was given, e.g. "anthropic" or "openai:gpt-5.5". */
    spec: string;
    /** What that resolved to, e.g. "claude-sonnet-5". */
    model: string;
    provider: LLMProvider;
}

export interface ResolvedRoles {
    facilitators: ResolvedRole[];
    user: ResolvedRole;
    utility: ResolvedRole;
    judge: ResolvedRole | null;
}

export interface RoleCollision {
    /** Short id for tests and report anchors. */
    id: 'judge-is-facilitator' | 'meditator-is-facilitator';
    model: string;
    /** One sentence: what is shared, and what it costs the result. */
    detail: string;
}

function resolve(spec: string): ResolvedRole {
    const provider = buildProviderFromSpec(spec);
    return { spec, model: provider.model, provider };
}

export function resolveRoles(specs: RoleSpecs): ResolvedRoles {
    return {
        facilitators: specs.facilitators.map(resolve),
        user: resolve(specs.user),
        utility: resolve(specs.utility),
        judge: specs.judge === null ? null : resolve(specs.judge),
    };
}

/**
 * Collisions that make a run's numbers mean less than they appear to. Compared
 * on the RESOLVED model, not the spec string, so "anthropic" and
 * "anthropic:claude-sonnet-5" are correctly seen as the same casting.
 */
export function findRoleCollisions(roles: ResolvedRoles): RoleCollision[] {
    const found: RoleCollision[] = [];
    const facilitatorModels = new Set(roles.facilitators.map((f) => f.model));

    if (roles.judge && facilitatorModels.has(roles.judge.model)) {
        const comparison = roles.facilitators.length > 1;
        found.push({
            id: 'judge-is-facilitator',
            model: roles.judge.model,
            detail:
                `the judge and ${comparison ? 'one of the facilitators' : 'the facilitator'} are both ${roles.judge.model}, ` +
                (comparison
                    ? 'so that model is scoring its own transcripts while its rivals are scored by an outsider - the ranking is partly an artifact of the casting'
                    : 'so the scores are partly self-evaluation'),
        });
    }
    if (facilitatorModels.has(roles.user.model)) {
        found.push({
            id: 'meditator-is-facilitator',
            model: roles.user.model,
            detail: `the simulated meditator and the facilitator are both ${roles.user.model}, so both halves of the conversation share a model's habits`,
        });
    }
    return found;
}

/** One line naming every role's model, for the console and the report header. */
export function describeRoles(roles: ResolvedRoles): string {
    const facilitators = roles.facilitators.map((f) => f.model).join(' vs ');
    return [
        `facilitator ${facilitators}`,
        `meditator ${roles.user.model}`,
        `classifiers ${roles.utility.model}`,
        `judge ${roles.judge?.model ?? 'off'}`,
    ].join(' · ');
}
