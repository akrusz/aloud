/**
 * What aloud cloud asks OpenRouter for when a session names one of its LLM
 * models, and where that may be served. A module with no imports, so the evals
 * and the soak harness can send what the server sends without pulling the
 * server in.
 */

/** Catalog id to the slug OpenRouter is asked for, where they differ.
 *
 *  The Kimi slot kept the id `moonshotai/kimi-k2` when OpenRouter stopped
 *  serving that model (2026-11-23) and K2.6 took its place, because builds up
 *  to v2.21.0 decide the trouble check from the id they are given (core
 *  CHECKED_MODELS) and know only that one: under its own id K2.6 would run
 *  unchecked on them, and it needs the check as K2 did (dev-docs/stepping-out.md).
 *  Saved picks stay put too. The id can become the slug once the minimum
 *  client version is past v2.21.0. */
const OPENROUTER_SLUGS: Readonly<Record<string, string>> = {
    'moonshotai/kimi-k2': 'moonshotai/kimi-k2.6',
};

export function openRouterSlug(model: string): string {
    return OPENROUTER_SLUGS[model] ?? model;
}

/** The hosts a slug may be served by, in the order tried. OpenRouter otherwise
 *  picks among every host of a slug by price and load, and Kimi K2.6's include
 *  Moonshot itself, SiliconFlow (both Singapore) and StreamLake (China). The
 *  price-table entry's rates are the first host's.
 *
 *  A second host has to answer when the first cannot: Parasail (US, int4) was
 *  Kimi's until it refused nearly every call as rate-limited upstream for an
 *  evening (2026-11-25). Time a candidate over spaced single calls first. */
export const OPENROUTER_HOSTS: Readonly<Record<string, readonly string[]>> = {
    'moonshotai/kimi-k2.6': ['coreweave', 'crusoe'], // both US; fp4 and bf16
};

/** What a request for `slug` carries beside the messages: its pinned hosts
 *  and nothing outside them, none that trains on or keeps what it is sent.
 *  Undefined for a slug with no pin. */
export function openRouterRouting(slug: string): { provider: Record<string, unknown> } | undefined {
    const hosts = OPENROUTER_HOSTS[slug];
    if (!hosts) return undefined;
    return { provider: { order: [...hosts], allow_fallbacks: false, data_collection: 'deny', zdr: true } };
}
