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
 * A judge scoring its own family's output is the one that quietly ruins a
 * scoreboard: LLM judges prefer writing like their own, so a same-family judge
 * inflates one row. In a `--facilitator=a,b,c` comparison that bias lands on
 * ONE contestant, which is worse than applying to all of them - the ranking is
 * then partly an artifact of who the judge is. So a facilitator is fairly
 * judged when at least one judge comes from another family; with several
 * judges the report shows each one's scores apart and marks the cells where a
 * judge shares the facilitator's family. A sim meditator sharing the
 * facilitator's model is the other collision: the two halves of the
 * conversation stop being independent.
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

import { ROSTER } from '../evals/models.js';
import { buildProviderFromSpec } from './providers.js';
import type { LLMProvider } from '../src/llm/index.js';

export interface RoleSpecs {
    /** Provider specs or eval roster ids under test; more than one is a
     *  comparison run. */
    facilitators: string[];
    /** The simulated meditator. */
    user: string;
    /** Cheap model behind the silence classifiers. */
    utility: string;
    /** One judge or several (each scores every session, reported side by
     *  side); null when --no-judge. */
    judge: string | readonly string[] | null;
}

export interface ResolvedRole {
    /** What the CLI was given, e.g. "anthropic" or "openai:gpt-5.5". */
    spec: string;
    /** What that resolved to, e.g. "claude-sonnet-5-5". */
    model: string;
    provider: LLMProvider;
}

export interface ResolvedRoles {
    facilitators: ResolvedRole[];
    user: ResolvedRole;
    utility: ResolvedRole;
    /** The first judge, the one single-judge readers see (baseline.ts, tier 2). */
    judge: ResolvedRole | null;
    judges: ResolvedRole[];
}

export interface RoleCollision {
    /** Short id for tests and report anchors. */
    id: 'judge-same-family' | 'meditator-is-facilitator';
    model: string;
    /** One sentence: what is shared, and what it costs the result. */
    detail: string;
}

/** An eval roster id ("opus-5.5", ts/evals/models.ts) as a provider spec;
 *  anything else is already one. */
export function specOf(spec: string): string {
    const entry = ROSTER.find((m) => m.id === spec);
    return entry ? `${entry.provider}:${entry.model}` : spec;
}

function resolve(spec: string): ResolvedRole {
    const provider = buildProviderFromSpec(specOf(spec));
    return { spec, model: provider.model, provider };
}

export function judgeSpecs(judge: RoleSpecs['judge']): string[] {
    if (judge === null) return [];
    return typeof judge === 'string' ? [judge] : [...judge];
}

export function resolveRoles(specs: RoleSpecs): ResolvedRoles {
    const judges = judgeSpecs(specs.judge).map(resolve);
    return {
        facilitators: specs.facilitators.map(resolve),
        user: resolve(specs.user),
        utility: resolve(specs.utility),
        judge: judges[0] ?? null,
        judges,
    };
}

/** Who trained a model, read off its id. The lab is what a judge's taste
 *  follows, not the provider that serves it (Kimi via OpenRouter, Gemma on
 *  Ollama). */
export function modelFamily(model: string): string {
    const id = model.toLowerCase();
    if (/claude|opus|sonnet|haiku|fable/.test(id)) return 'anthropic';
    if (/(?:^|\/)(?:gpt|chatgpt|o\d)/.test(id)) return 'openai';
    if (/gemini|gemma/.test(id)) return 'google';
    if (/kimi|moonshot/.test(id)) return 'moonshot';
    if (/qwen|bonsai/.test(id)) return 'alibaba';
    if (/llama|muse/.test(id)) return 'meta';
    if (/deepseek/.test(id)) return 'deepseek';
    if (/grok|x-ai/.test(id)) return 'xai';
    if (/mistral|mixtral/.test(id)) return 'mistral';
    return id.split(/[/:]/)[0] ?? id;
}

export function sameFamily(a: string, b: string): boolean {
    return modelFamily(a) === modelFamily(b);
}

/**
 * Collisions that make a run's numbers mean less than they appear to. Compared
 * on the RESOLVED model, not the spec string, so "anthropic" and
 * "anthropic:claude-sonnet-5-5" are correctly seen as the same casting.
 */
export function findRoleCollisions(roles: ResolvedRoles): RoleCollision[] {
    const found: RoleCollision[] = [];
    const facilitatorModels = new Set(roles.facilitators.map((f) => f.model));
    const comparison = facilitatorModels.size > 1;
    const judgeModels = [...new Set(roles.judges.map((j) => j.model))];

    for (const model of facilitatorModels) {
        if (judgeModels.length === 0 || !judgeModels.every((j) => sameFamily(j, model))) continue;
        const judges = judgeModels.join(' and ');
        const subject = judgeModels.length > 1 ? `every judge (${judges}) is` : `the judge (${judges}) is`;
        found.push({
            id: 'judge-same-family',
            model,
            detail:
                `${subject} from the ${modelFamily(model)} family, like ` +
                (comparison
                    ? `one of the facilitators (${model}), so that row is scored by its own family while its rivals are scored by an outsider - the ranking is partly an artifact of the casting`
                    : `the facilitator (${model}), so the scores are partly self-evaluation`),
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
        `judge ${roles.judges.map((j) => j.model).join(' + ') || 'off'}`,
    ].join(' · ');
}
