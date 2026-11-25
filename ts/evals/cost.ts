/**
 * Dollar cost of an eval call at aloud cloud's list prices, read from the
 * hosted price table (server/src/pricing/providers.ts). Models not in the
 * table (local Ollama, candidates never priced) have no cost.
 */

import { allowedModels, pricingFor, type ModelPricing } from '../server/src/pricing/providers.js';
import { openRouterSlug } from '../server/src/pricing/openrouter-hosts.js';
import type { ProviderId } from '../server/src/contract.js';
import type { TrialUsage } from './records.js';

const PRICED_PROVIDERS: ReadonlySet<string> = new Set<ProviderId>([
    'anthropic',
    'openai',
    'google',
    'openrouter',
    'groq',
]);

// Mirrors llmCostUsd (server/src/pricing/meter.ts) for one request with no
// 1-hour cache writes. meter.ts itself can't be imported here: it resolves
// @aloud/core at runtime, which only works under server/tsconfig.json, and the
// evals run under plain `npx tsx`.
function costOf(p: ModelPricing, u: TrialUsage): number | null {
    if (u.inputTokens === null && u.outputTokens === null) return null;
    const input = u.inputTokens ?? 0;
    const output = u.outputTokens ?? 0;
    const read = u.cacheReadTokens ?? 0;
    const write = u.cacheCreationTokens ?? 0;
    const prompt = input + read + write;
    const r = p.longPrompt && prompt > p.longPrompt.over ? p.longPrompt : p;
    return input * r.input + output * r.output + read * r.cacheRead + write * r.cacheCreation;
}

export function callCostUsd(provider: string, model: string, usage: TrialUsage): number | null {
    if (!PRICED_PROVIDERS.has(provider)) return null;
    const p =
        pricingFor(provider as ProviderId, model) ??
        // An OpenRouter slug the catalog serves under another id (the Kimi slot).
        allowedModels().find((m) => m.provider === provider && openRouterSlug(m.model) === model);
    return p ? costOf(p, usage) : null;
}

/** For a call that names only its model (a soak call record): the first
 *  priced entry with that provider-native id. */
export function costByModelId(model: string, usage: TrialUsage): number | null {
    const p = allowedModels().find((m) => m.model === model || openRouterSlug(m.model) === model);
    return p ? costOf(p, usage) : null;
}
