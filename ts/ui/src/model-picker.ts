/**
 * Model picker — fetches available models per provider from
 * `/app/v1/models/<provider>` and populates a <select>.
 *
 * The provider's API key lives in the UI's BYOK store (localStorage), so it's
 * forwarded as `x-provider-key`; the app backend uses it to query the
 * provider's models endpoint (OpenRouter needs none, claude_proxy is static).
 * When the endpoint returns nothing — no key set, the backend is unreachable,
 * or a provider with no live list — we render NO selector (just a reason), not
 * a free-text box: a model picker should only appear when we can list the
 * provider's currently-accessible models.
 */

import { cloudUrl } from './cloud-base.js';
import { appUrl } from './app-base.js';
import { getApiKey, hasApiKey } from './api-keys.js';
import { probeOllamaDirect } from './ollama-direct.js';
import { rateSuffix, RATE_LEGEND, RATE_LEGEND_TITLE } from './credit-rate.js';
import type { Provider } from './settings.js';

/** Providers that authenticate with a user-supplied key (BYOK). The hosted
 *  service ('aloud'), local Ollama, and the subscription claude_proxy don't. */
function providerNeedsKey(provider: string): boolean {
    return !['aloud', 'ollama', 'claude_proxy'].includes(provider);
}

interface ModelOption {
    value: string;
    label: string;
    /** Typical-session credits/hr for a hosted model (from /me/models). Absent
     *  for free providers (BYOK/local/Ollama). Lets the setup screen sum a
     *  combined session estimate without re-fetching. */
    creditsPerHour?: number | null;
}

const cache = new Map<string, ModelOption[]>();
let providerStatusCache: Record<string, { available: boolean; models?: string[] }> | null = null;

/**
 * Fetch model options for a provider. Returns null when the endpoint
 * isn't reachable (e.g. no Flask), so callers can swap in a text input
 * gracefully.
 */
export async function fetchModels(provider: string): Promise<ModelOption[] | null> {
    if (cache.has(provider)) return cache.get(provider)!;

    // aloud cloud publishes its allowlisted models (with pricing) at
    // /v1/me/models — public, no auth. The option value encodes provider/model
    // so buildProvider can route the turn (model ids may themselves contain a
    // slash, e.g. openrouter, so the leading segment is the provider).
    if (provider === 'aloud') {
        try {
            const resp = await fetch(cloudUrl('/me/models'));
            if (!resp.ok) return null;
            const data = (await resp.json()) as {
                models?: Array<{ provider: string; model: string; creditsPerHour?: number | null }>;
            };
            if (!data.models?.length) return null;
            // Hosted models cost credits, so append the cloud-rate badge ("N☁️")
            // to the label — the only provider where the picker shows it.
            const opts: ModelOption[] = data.models.map((m) => ({
                value: `${m.provider}/${m.model}`,
                label: `${m.model}${rateSuffix(m.creditsPerHour)}`,
                creditsPerHour: m.creditsPerHour ?? null,
            }));
            cache.set(provider, opts);
            return opts;
        } catch {
            return null;
        }
    }

    // Ollama models come from /api/providers (the app backend's aggregated,
    // curated list) — same shape as the Python setup.js handling. When that
    // backend isn't running (e.g. Vite dev without Flask), fall back to probing
    // the Ollama daemon directly via the /ollama proxy, the same source
    // capabilities.ts trusts, so local models still populate without Flask.
    if (provider === 'ollama') {
        const status = await fetchProviderStatus();
        const fromBackend = status?.['ollama']?.models ?? [];
        const names = fromBackend.length ? fromBackend : (await probeOllamaDirect()).models;
        if (!names.length) return null;
        const opts: ModelOption[] = names.map((m: string) => ({ value: m, label: m }));
        cache.set(provider, opts);
        return opts;
    }

    try {
        // Forward the BYOK key so the backend can query the provider; it only
        // travels to the loopback (desktop) or same-origin (web) backend.
        const key = await getApiKey(provider as Provider);
        const resp = await fetch(appUrl(`/models/${encodeURIComponent(provider)}`), {
            headers: key ? { 'x-provider-key': key } : {},
        });
        if (!resp.ok) return null;
        const data = (await resp.json()) as ModelOption[];
        if (!Array.isArray(data) || data.length === 0) return null;
        cache.set(provider, data);
        return data;
    } catch {
        return null;
    }
}

async function fetchProviderStatus(): Promise<typeof providerStatusCache | null> {
    if (providerStatusCache !== null) return providerStatusCache;
    try {
        const resp = await fetch(appUrl('/providers'));
        if (!resp.ok) return null;
        const data = (await resp.json()) as Record<
            string,
            { available: boolean; models?: string[] }
        >;
        providerStatusCache = data;
        return data;
    } catch {
        return null;
    }
}

/**
 * Render a <select> of model options for a given provider. When the
 * fetch fails, replace the select with a free-form text input so the
 * user can type a model name anyway.
 *
 * The returned function lets the caller refresh the picker when the
 * provider changes — call refresh(newProvider) and the same DOM slot
 * gets re-populated.
 */
export function mountModelPicker(
    container: HTMLElement,
    initialProvider: string,
    initialValue: string,
    onChange: (value: string) => void
): { refresh: (provider: string) => Promise<void>; getValue: () => string; getRate: () => number } {
    let currentValue = initialValue;
    // The options currently loaded, so getRate() can map the selected value to
    // its credits/hr without another fetch.
    let currentModels: ModelOption[] = [];

    container.innerHTML = `
        <select id="model-select" disabled>
            <option value="">Loading models…</option>
        </select>`;

    function renderSelect(provider: string, models: ModelOption[]): void {
        currentModels = models;
        const optionsHTML = models
            .map((m) => `<option value="${attr(m.value)}">${escape(m.label)}</option>`)
            .join('');
        // Only the hosted ('aloud') models carry the cloud-rate badge, so the
        // legend explaining it belongs only under that provider's selector.
        const legend =
            provider === 'aloud'
                ? `<p class="credit-rate-legend" title="${attr(RATE_LEGEND_TITLE)}">${escape(RATE_LEGEND)}</p>`
                : '';
        container.innerHTML = `
            <select id="model-select" data-provider="${attr(provider)}">${optionsHTML}</select>${legend}`;
        const sel = container.querySelector<HTMLSelectElement>('#model-select')!;
        // The user wants the picker to always show a concrete model name
        // (no "(provider default)" placeholder), so if the persisted value
        // doesn't match anything in the list we promote the first model
        // to the active selection and persist it. Keeps the displayed
        // model honest about what's actually going to run.
        const matched = models.find((m) => m.value === currentValue);
        if (matched) {
            sel.value = matched.value;
        } else if (models[0]) {
            sel.value = models[0].value;
            currentValue = models[0].value;
        }
        // Notify after every (re)load — promoted or matched — so a consumer
        // (e.g. the setup session-cost estimate) always learns the settled
        // selection once a provider's models arrive, not only when promoted.
        onChange(currentValue);
        sel.addEventListener('change', () => {
            currentValue = sel.value;
            onChange(currentValue);
        });
    }

    /**
     * No model list could be fetched. Per product direction, we do NOT fall
     * back to a free-text box — a model selector only appears when we can list
     * the provider's currently-accessible models. Show why instead (missing key
     * vs. unreachable), so the user knows what to fix.
     */
    async function renderUnavailable(provider: string): Promise<void> {
        const reason =
            providerNeedsKey(provider) && !(await hasApiKey(provider as Provider))
                ? `Add a ${provider} API key to load its models.`
                : `Couldn't load ${provider} models — check the key or your connection.`;
        container.innerHTML = `<p class="model-unavailable" id="model-none">${escape(reason)}</p>`;
    }

    /**
     * Ollama-specific empty state. Unlike BYOK providers — where a hand-typed
     * model name is the legitimate fallback — typing a model name when no local
     * model is present is useless: the daemon has nothing to run. So show a
     * pointer to the Ollama manager below instead of a dead text box.
     */
    function renderOllamaEmpty(): void {
        container.innerHTML = `
            <p class="ollama-rec-hint" id="model-ollama-empty">
                No local models found — install Ollama and download a model below.
            </p>`;
    }

    async function refresh(provider: string): Promise<void> {
        currentModels = [];
        container.innerHTML = `
            <select disabled><option>Loading models…</option></select>`;
        const models = await fetchModels(provider);
        if (models && models.length > 0) {
            renderSelect(provider, models);
        } else if (provider === 'ollama') {
            renderOllamaEmpty();
        } else {
            await renderUnavailable(provider);
        }
    }

    void refresh(initialProvider);
    return {
        refresh,
        getValue: () => currentValue,
        // Credits/hr of the selected hosted model; 0 for free providers (their
        // options carry no rate). Used to sum the setup session estimate.
        getRate: () => currentModels.find((m) => m.value === currentValue)?.creditsPerHour ?? 0,
    };
}

function attr(s: string): string {
    return escape(s);
}

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}
