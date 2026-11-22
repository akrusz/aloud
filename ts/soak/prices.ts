/**
 * The hosted price table (server/src/pricing/providers.ts), for cost per
 * session and for casting the models battery from what aloud ships.
 *
 * Loaded through a computed specifier on purpose. The table's type imports
 * reach server/src/contract.ts, whose `@aloud/core/*` imports resolve only
 * under the server's tsconfig paths, so a static import fails the soak and
 * tests typecheck. At run time the table module has no imports left and loads
 * anywhere. With those paths in soak/tsconfig.json and tests/tsconfig.json
 * this becomes a plain import and PricedModel can go.
 */

import type { CallUsage } from './types.js';

interface TokenRates {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}

/** The fields of the table's ModelPricing this harness reads. */
export interface PricedModel extends TokenRates {
    provider: string;
    model: string;
    expanded?: boolean;
    unlisted?: boolean;
    utilityOnly?: boolean;
    longPrompt?: TokenRates & { over: number };
}

const TABLE_MODULE = '../server/src/pricing/providers.js';
const table = (await import(TABLE_MODULE)) as { allowedModels(): PricedModel[] };

/** Model ids are unique across the table's providers, so the id alone finds
 *  an entry. Undefined for anything the hosted service does not sell (Ollama,
 *  a model it dropped). */
export function priceFor(model: string): PricedModel | undefined {
    return table.allowedModels().find((m) => m.model === model);
}

/** Offered as a facilitator on the picker (curated or behind "show all"). */
export function isFacilitatorPick(provider: string, model: string): boolean {
    const p = table.allowedModels().find((m) => m.provider === provider && m.model === model);
    return p !== undefined && !p.unlisted && !p.utilityOnly;
}

/**
 * USD for one call at the hosted list price, or null when the model is not in
 * the table or the call reported no input tokens. Mirrors meter.ts llmCostUsd,
 * which cannot load outside the server (it imports @aloud/core at run time).
 */
export function callCostUsd(model: string | undefined, usage: CallUsage): number | null {
    const p = model === undefined ? undefined : priceFor(model);
    if (!p || usage.inputTokens === undefined) return null;
    const fresh = usage.inputTokens;
    const read = usage.cacheReadTokens ?? 0;
    const write = usage.cacheCreationTokens ?? 0;
    const r = p.longPrompt && fresh + read + write > p.longPrompt.over ? p.longPrompt : p;
    return fresh * r.input + (usage.outputTokens ?? 0) * r.output + read * r.cacheRead + write * r.cacheCreation;
}
