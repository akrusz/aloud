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

/** Friendly display names for the aloud cloud allowlist, so the dropdown reads
 *  "Claude Opus 4.8" rather than the raw "claude-opus-4-8" id. Unknown ids fall
 *  back to a generic prettifier (drop any date stamp, Title-Case the words). The
 *  option VALUE keeps the raw id — only the label changes. */
const CLOUD_MODEL_NAMES: Record<string, string> = {
    'claude-fable-5': 'Claude Fable 5',
    'claude-opus-4-8': 'Claude Opus 4.8',
    'claude-3-opus-20240229': 'Claude Opus 3',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.4': 'GPT-5.4',
};

export function prettyModelName(model: string): string {
    const known = CLOUD_MODEL_NAMES[model];
    if (known) return known;
    return model
        .replace(/[-_]\d{6,8}$/, '') // strip a trailing yyyymmdd date stamp
        .split('/')
        .pop()!
        .split(/[-_]/)
        .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
}

/**
 * Hardcoded, per-model list of "slower" markers. We disable reasoning wherever
 * we can (including for Opus), so most heavier models answer at normal speed —
 * the exception is models whose reasoning is always on and can't be turned off
 * (Fable, and its Mythos sibling), which think before every reply and so run
 * slower. Matched as a substring against the model id/alias, so one entry
 * covers every variant — works for the cloud "provider/model" values and the
 * bare claude_proxy aliases alike. Purely local (no network) — edit this list
 * to tune which models carry the "may be slower" note.
 */
export const SLOW_MODEL_MARKERS: readonly string[] = ['fable', 'mythos'];

export function isSlowModel(value: string): boolean {
    const v = value.toLowerCase();
    return SLOW_MODEL_MARKERS.some((m) => v.includes(m));
}

/** Shown under the picker (and in the session info panel) when a slow model is
 *  selected. Copy — tune freely. */
export const SLOW_MODEL_NOTE =
    'This model responds more slowly than others.';

/**
 * The "most similar still-standard" Claude subscription model to fall back to
 * when the selected one can't be served (e.g. Anthropic pulls Fable from the
 * subscription). Fable's nearest peer is Opus; Opus falls to Sonnet; everything
 * else lands on Sonnet, the dependable default. Returns null when the given
 * model IS the safe default (nothing more to fall back to).
 */
export function nearestSubscriptionModel(model: string): string | null {
    const m = model.toLowerCase();
    if (m.includes('fable')) return 'opus';
    if (m === 'opus' || m.includes('claude-3-opus') || m.includes('opus-')) return 'sonnet';
    if (m === 'sonnet' || m === 'haiku') return null;
    return 'sonnet';
}

/** Subscription aliases resolve to "the latest of this family", so we don't
 *  have an exact version to show — label them the same "(latest)" way the
 *  picker does. Mirrors claude_proxy_models() in providers.rs. */
const SUBSCRIPTION_ALIAS_NAMES: Record<string, string> = {
    opus: 'Opus (latest)',
    fable: 'Fable (latest)',
    sonnet: 'Sonnet (latest)',
    haiku: 'Haiku (latest)',
};

/**
 * A readable name for the model a session is running on, for history + the
 * session info panel. Cloud values are "provider/model" (strip the provider);
 * the subscription (claude_proxy) uses bare aliases resolved to "(latest)".
 * The provider is recorded separately, so this stays just the model name.
 */
export function sessionModelLabel(provider: string, model: string): string {
    if (!model) return prettyModelName(provider);
    if (provider === 'aloud') {
        const slash = model.indexOf('/');
        return prettyModelName(slash > 0 ? model.slice(slash + 1) : model);
    }
    if (provider === 'claude_proxy') {
        return SUBSCRIPTION_ALIAS_NAMES[model.toLowerCase()] ?? prettyModelName(model);
    }
    return prettyModelName(model);
}

type ProbeStatus = 'available' | 'unavailable' | 'cli_missing' | 'unknown';

/**
 * Ask the desktop shell whether the local Claude subscription can actually
 * serve `model` right now (it runs a tiny cached probe against the `claude`
 * CLI). Only meaningful on desktop for claude_proxy; anywhere else, or on any
 * error, returns 'unknown' so the caller leaves the model shown optimistically.
 */
export async function probeClaudeProxyModel(model: string): Promise<ProbeStatus> {
    try {
        const resp = await fetch(appUrl(`/llm/claude_proxy/probe?model=${encodeURIComponent(model)}`));
        if (!resp.ok) return 'unknown';
        const data = (await resp.json()) as { status?: ProbeStatus };
        return data.status ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

interface ModelOption {
    value: string;
    label: string;
    /** Typical-session credits/hr for a hosted model (from /me/models). Absent
     *  for free providers (BYOK/local/Ollama). Lets the setup screen sum a
     *  combined session estimate without re-fetching. */
    creditsPerHour?: number | null;
    /** The model to pre-select when the user hasn't chosen one (aloud cloud only,
     *  from /me/models). At most one option carries it; absent everywhere else. */
    isDefault?: boolean;
}

const cache = new Map<string, ModelOption[]>();
let providerStatusCache: Record<string, { available: boolean; models?: string[] }> | null = null;

/**
 * Fetch model options for a provider. Returns null when the endpoint
 * isn't reachable (e.g. no app backend), so callers can swap in a text input
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
                models?: Array<{
                    provider: string;
                    model: string;
                    creditsPerHour?: number | null;
                    default?: boolean;
                }>;
            };
            if (!data.models?.length) return null;
            // Hosted models cost credits, so append the cloud-rate badge ("N☁️")
            // to the label — the only provider where the picker shows it.
            const opts: ModelOption[] = data.models.map((m) => ({
                value: `${m.provider}/${m.model}`,
                label: `${prettyModelName(m.model)}${rateSuffix(m.creditsPerHour)}`,
                creditsPerHour: m.creditsPerHour ?? null,
                isDefault: m.default ?? false,
            }));
            cache.set(provider, opts);
            return opts;
        } catch {
            return null;
        }
    }

    // Ollama models come from /app/v1/providers (the app backend's aggregated,
    // curated list). When that backend isn't running (e.g. Vite dev without
    // the app backend), fall back to probing the Ollama daemon directly via
    // the /ollama proxy, the same source capabilities.ts trusts, so local
    // models still populate without the app backend.
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
            <select id="model-select" data-provider="${attr(provider)}">${optionsHTML}</select>${legend}
            <p class="model-slow-note hidden" id="model-slow-note">${escape(SLOW_MODEL_NOTE)}</p>`;
        const sel = container.querySelector<HTMLSelectElement>('#model-select')!;
        const slowNote = container.querySelector<HTMLElement>('#model-slow-note')!;
        // The user wants the picker to always show a concrete model name
        // (no "(provider default)" placeholder), so if the persisted value
        // doesn't match anything in the list we promote the flagged default
        // (aloud cloud marks one, e.g. Opus 4.8), falling back to the first
        // model when none is flagged. Keeps the displayed model honest about
        // what's actually going to run.
        const matched = models.find((m) => m.value === currentValue);
        const promoted = matched ?? models.find((m) => m.isDefault) ?? models[0];
        if (promoted) {
            sel.value = promoted.value;
            currentValue = promoted.value;
        }
        // Unobtrusive heads-up when a reasoning/heavier model is picked — its
        // replies can lag a quick chat model.
        const updateSlowNote = (): void => {
            slowNote.classList.toggle('hidden', !isSlowModel(currentValue));
        };
        updateSlowNote();
        // Notify after every (re)load — promoted or matched — so a consumer
        // (e.g. the setup session-cost estimate) always learns the settled
        // selection once a provider's models arrive, not only when promoted.
        onChange(currentValue);
        sel.addEventListener('change', () => {
            currentValue = sel.value;
            updateSlowNote();
            onChange(currentValue);
        });
        // For the Claude subscription, check whether the local `claude` CLI can
        // still serve any listed-but-removable model (Fable) — Anthropic has
        // long hinted at pulling models from subscriptions. Non-blocking: the
        // dropdown renders immediately; if a probe says "unavailable" we grey
        // that option out and, if it was the active one, drop to its nearest peer.
        if (provider === 'claude_proxy') {
            void annotateSubscriptionAvailability(sel, updateSlowNote);
        }
    }

    /**
     * Probe removable subscription models (currently just Fable) and reflect the
     * result in the live <select>: an unavailable model is disabled + relabelled,
     * and if it was selected we switch to its nearest peer (Fable → Opus) and
     * notify. Best-effort — an 'unknown' result leaves everything as shown.
     */
    async function annotateSubscriptionAvailability(
        sel: HTMLSelectElement,
        updateSlowNote: () => void
    ): Promise<void> {
        const removable = currentModels.filter((m) => /fable/i.test(m.value));
        for (const m of removable) {
            const status = await probeClaudeProxyModel(m.value);
            if (status !== 'unavailable') continue;
            const opt = Array.from(sel.options).find((o) => o.value === m.value);
            if (opt) {
                opt.disabled = true;
                opt.textContent = `${m.label} — unavailable on your subscription`;
            }
            if (currentValue === m.value) {
                const fallback = nearestSubscriptionModel(m.value) ?? 'sonnet';
                const target =
                    currentModels.find((o) => o.value === fallback) ?? currentModels[0];
                if (target) {
                    sel.value = target.value;
                    currentValue = target.value;
                    updateSlowNote();
                    onChange(currentValue);
                }
            }
        }
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
                ? `Add an API key to load models.`
                : `Couldn't load ${provider} models. Check the key or your connection.`;
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
                No local models found. Install Ollama and download a model below.
            </p>`;
    }

    /** aloud cloud scales to zero when idle, so a cold visit may not answer the
     *  first request(s) while the machine boots. Show a reassuring "waking"
     *  note rather than an error while we retry. */
    function renderCloudWaking(): void {
        container.innerHTML = `
            <p class="model-cloud-waking" id="model-cloud-waking">
                Waking up aloud cloud - this can take a few seconds…
            </p>`;
    }

    /** aloud cloud didn't answer after several retries. Say so plainly and give a
     *  manual Retry, since it may just be a slow cold start. */
    function renderCloudUnreachable(): void {
        container.innerHTML = `
            <p class="model-unavailable" id="model-cloud-down">
                aloud cloud is temporarily unreachable. It may be waking up -
                <button type="button" class="model-retry-btn" id="model-cloud-retry">try again</button>.
            </p>`;
        container
            .querySelector<HTMLButtonElement>('#model-cloud-retry')
            ?.addEventListener('click', () => void refresh('aloud'));
    }

    async function refresh(provider: string): Promise<void> {
        currentModels = [];
        container.innerHTML = `
            <select disabled><option>Loading models…</option></select>`;
        let models = await fetchModels(provider);
        // aloud cloud may be cold-starting: Fly boots the machine on the request
        // and serves once it's up, so a first miss isn't a real failure. Show the
        // "waking" note and retry a few times with backoff before giving up.
        if (!models && provider === 'aloud') {
            for (const ms of [1500, 2500, 4000, 6000]) {
                renderCloudWaking();
                await new Promise((resolve) => setTimeout(resolve, ms));
                models = await fetchModels(provider);
                if (models) break;
            }
        }
        if (models && models.length > 0) {
            renderSelect(provider, models);
        } else if (provider === 'ollama') {
            renderOllamaEmpty();
        } else if (provider === 'aloud') {
            renderCloudUnreachable();
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
