/**
 * Model liveness: verify the hosted allowlist against what providers actually
 * serve, so /me/models never offers a retired model. Every probe is a zero-token
 * metadata call (GET /models/<id> or the provider's list endpoint), swept at
 * boot and hourly from index.ts.
 *
 * FAIL OPEN is the rule everywhere: only a definitive "this id does not exist"
 * (a 404, or absence from a 200 list) marks a model gone. Missing keys, network
 * errors, timeouts, and provider 5xx all read 'unknown' and change nothing - a
 * provider status blip must never empty the catalog. A model marked gone comes
 * back the moment a later sweep sees it live again.
 */

import type { ProviderId } from '../contract.js';
import type { ProviderKeys } from '../config.js';
import { allowedModels, type ModelPricing } from './providers.js';
import { OPENROUTER_FALLBACKS } from '../providers/forward.js';

export type ProbeResult = 'live' | 'gone' | 'unknown';

export interface ModelProber {
    probe(provider: ProviderId, model: string): Promise<ProbeResult>;
}

/** Mirrors the core AnthropicProvider's pinned version header. */
const ANTHROPIC_API_VERSION = '2023-06-01';

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probes each provider's model-metadata endpoint with the server's own keys.
 * `fetchFn` is injectable for tests; production uses global fetch.
 */
export class HttpModelProber implements ModelProber {
    constructor(
        private readonly keys: ProviderKeys,
        private readonly fetchFn: typeof fetch = fetch
    ) {}

    async probe(provider: ProviderId, model: string): Promise<ProbeResult> {
        try {
            switch (provider) {
                case 'anthropic': {
                    if (!this.keys.anthropic) return 'unknown';
                    return await this.statusProbe(
                        `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`,
                        {
                            'x-api-key': this.keys.anthropic,
                            'anthropic-version': ANTHROPIC_API_VERSION,
                        }
                    );
                }
                case 'openai': {
                    if (!this.keys.openai) return 'unknown';
                    return await this.statusProbe(
                        `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
                        { authorization: `Bearer ${this.keys.openai}` }
                    );
                }
                case 'google': {
                    if (!this.keys.google) return 'unknown';
                    return await this.statusProbe(
                        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
                        { 'x-goog-api-key': this.keys.google }
                    );
                }
                case 'openrouter': {
                    // OpenRouter has no per-model GET; its public list is the
                    // authority. A slug counts as live while ANY link of its
                    // fallback chain is routable - the forwarder degrades along
                    // the same chain (forward.ts), so the turn still serves.
                    const resp = await this.fetchFn('https://openrouter.ai/api/v1/models', {
                        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
                    });
                    if (!resp.ok) return 'unknown';
                    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
                    if (!Array.isArray(data.data)) return 'unknown';
                    const listed = new Set(data.data.map((m) => m.id));
                    const chain = OPENROUTER_FALLBACKS[model] ?? [model];
                    return chain.some((id) => listed.has(id)) ? 'live' : 'gone';
                }
                default:
                    return 'unknown';
            }
        } catch {
            return 'unknown'; // network error / timeout: fail open
        }
    }

    /** 200 = live, 404 = gone, anything else (401, 429, 5xx) = unknown. */
    private async statusProbe(url: string, headers: Record<string, string>): Promise<ProbeResult> {
        const resp = await this.fetchFn(url, {
            headers,
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (resp.ok) return 'live';
        if (resp.status === 404) return 'gone';
        return 'unknown';
    }
}

/** Sweep outcome, for the boot/interval log line. */
export interface SweepReport {
    live: string[];
    gone: string[];
    unknown: string[];
}

/**
 * The liveness registry routes consult. Starts with everything presumed live
 * (a server that never sweeps - tests, misconfigured keys - serves the full
 * allowlist), and only a completed probe moves a model out of that state.
 */
export class ModelLiveness {
    private gone = new Set<string>();

    constructor(private readonly prober: ModelProber) {}

    isLive(provider: ProviderId, model: string): boolean {
        return !this.gone.has(`${provider}:${model}`);
    }

    /** The allowlist as currently servable - what /me/models publishes. */
    liveModels(): ModelPricing[] {
        return allowedModels().filter((m) => this.isLive(m.provider, m.model));
    }

    /** Probe every allowlisted model, concurrently. 'unknown' keeps the prior
     *  verdict (fail open); 'live'/'gone' overwrite it, so retired models drop
     *  and mistakenly-dropped ones recover on the next sweep. */
    async sweep(): Promise<SweepReport> {
        const report: SweepReport = { live: [], gone: [], unknown: [] };
        await Promise.all(
            allowedModels().map(async (m) => {
                const key = `${m.provider}:${m.model}`;
                const result = await this.prober.probe(m.provider, m.model);
                report[result].push(key);
                if (result === 'gone') this.gone.add(key);
                else if (result === 'live') this.gone.delete(key);
            })
        );
        return report;
    }
}
