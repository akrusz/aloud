/**
 * Model picker - fetches a provider's models from `/app/v1/models/<provider>`
 * and populates a <select>. The BYOK key (localStorage) is forwarded as
 * `x-provider-key` for the backend to query with (OpenRouter needs none,
 * claude_proxy is static).
 *
 * When nothing comes back - no key, backend unreachable, or a provider with no
 * live list - we render a reason, NOT a free-text box: a model picker should
 * only appear when we can list the provider's currently-accessible models.
 */

import { cloudUrl } from './cloud-base.js';
import { appUrl } from './app-base.js';
import { getApiKey, hasApiKey } from './api-keys.js';
import { probeOllamaDirect } from './ollama-direct.js';
import { rateSuffix } from './credit-rate.js';
import { loadAppSettings, saveAppSettings } from './app-settings.js';
import type { Provider } from './settings.js';

/** Providers that authenticate with a user-supplied key (BYOK). The hosted
 *  service ('aloud'), local Ollama, and the subscription claude_proxy don't. */
function providerNeedsKey(provider: string): boolean {
    return !['aloud', 'ollama', 'claude_proxy'].includes(provider);
}

/** Display names for the aloud cloud allowlist, so the dropdown reads "Claude
 *  Opus 5" not "claude-opus-5". Unknown ids fall back to prettyModelName.
 *  The option VALUE keeps the raw id; only the label changes. */
const CLOUD_MODEL_NAMES: Record<string, string> = {
    'claude-fable-5': 'Claude Fable 5',
    'claude-opus-5': 'Claude Opus 5',
    'claude-opus-4-8': 'Claude Opus 4.8',
    'claude-opus-4-5': 'Claude Opus 4.5',
    'claude-3-opus-20240229': 'Claude Opus 3',
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
    'gpt-5.6-sol': 'GPT-5.6 Sol',
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.4': 'GPT-5.4',
    'moonshotai/kimi-k2': 'Kimi K2',
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
 * ⭐ TWEAK ME to change which models carry the "may be slower" note. Purely
 * local, no network. We disable reasoning wherever possible (Opus included), so
 * most heavy models answer at normal speed; the exceptions are models whose
 * reasoning can't be turned off (Fable and its Mythos sibling), which think
 * before every reply. (Kimi K2 0711 doesn't reason at all; its K3 successor was
 * dropped from the hosted list over exactly that 7-12s always-on delay.)
 * Substring-matched against the model id/alias, so one entry covers every
 * variant - cloud "provider/model" values and bare claude_proxy aliases alike.
 */
export const SLOW_MODEL_MARKERS: readonly string[] = ['fable', 'mythos'];

export function isSlowModel(value: string): boolean {
    const v = value.toLowerCase();
    return SLOW_MODEL_MARKERS.some((m) => v.includes(m));
}

/** Shown under the picker (and in the session info panel) when a slow model is
 *  selected. Copy - tune freely. */
export const SLOW_MODEL_NOTE =
    'This model responds more slowly than others.';

/**
 * The nearest still-standard Claude subscription model, for when the selected
 * one can't be served (e.g. Anthropic pulls Fable from the subscription). Fable
 * → Opus, Opus → Sonnet, everything else → Sonnet, the dependable default. Null
 * when the model IS the safe default.
 */
export function nearestSubscriptionModel(model: string): string | null {
    const m = model.toLowerCase();
    if (m.includes('fable')) return 'opus';
    if (m === 'opus' || m.includes('claude-3-opus') || m.includes('opus-')) return 'sonnet';
    if (m === 'sonnet' || m === 'haiku') return null;
    return 'sonnet';
}

/** Subscription aliases resolve to "the latest of this family", so there's no
 *  exact version to show - label them "(latest)" as the picker does. Mirrors
 *  claude_proxy_models() in providers.rs. */
const SUBSCRIPTION_ALIAS_NAMES: Record<string, string> = {
    opus: 'Opus (latest)',
    fable: 'Fable (latest)',
    sonnet: 'Sonnet (latest)',
    haiku: 'Haiku (latest)',
};

/**
 * Readable model name for history + the session info panel. Cloud values are
 * "provider/model" (strip the provider); claude_proxy uses bare aliases resolved
 * to "(latest)". The provider is recorded separately, so this is model only.
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
 * Ask the desktop shell whether the local Claude subscription can serve `model`
 * right now (a small cached probe against the `claude` CLI). Meaningful only on
 * desktop for claude_proxy; anywhere else, or on error, 'unknown' leaves the
 * model shown optimistically.
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
    /** Typical-session credits/hr for a hosted model (/me/models), absent for
     *  free providers. Lets the setup screen sum a session estimate without
     *  re-fetching. */
    creditsPerHour?: number | null;
    /** Pre-select when the user hasn't chosen (aloud cloud only, from
     *  /me/models). At most one option carries it. */
    isDefault?: boolean;
    /** Expanded-tier (aloud cloud only): hidden until the user opts into "Show
     *  all available models". Older and niche models with distinct voices. */
    expanded?: boolean;
}

/** The "Show all available models" state, shared by every mounted picker
 *  (setup + settings) and persisted in AppSettings.showAllModels. Cached at
 *  module level so a re-render doesn't wait on storage. */
let showAllModels: boolean | null = null;

async function loadShowAllModels(): Promise<boolean> {
    if (showAllModels === null) showAllModels = (await loadAppSettings()).showAllModels;
    return showAllModels;
}

async function setShowAllModels(value: boolean): Promise<void> {
    showAllModels = value;
    const s = await loadAppSettings();
    await saveAppSettings({ ...s, showAllModels: value });
}

const cache = new Map<string, ModelOption[]>();
let providerStatusCache: Record<string, { available: boolean; models?: string[] }> | null = null;

/** Fetch model options for a provider. Null when the endpoint isn't reachable
 *  (e.g. no app backend), so callers can render an empty state. */
export async function fetchModels(provider: string): Promise<ModelOption[] | null> {
    if (cache.has(provider)) return cache.get(provider)!;

    // aloud cloud publishes its allowlisted models with pricing at /v1/me/models
    // (public, no auth). The value encodes provider/model so buildProvider can
    // route the turn - model ids can contain slashes themselves (openrouter), so
    // the LEADING segment is the provider.
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
                    expanded?: boolean;
                }>;
            };
            if (!data.models?.length) return null;
            // Hosted models cost credits, so the label carries the cloud-rate
            // badge ("N☁️") - the only provider where the picker shows it.
            const opts: ModelOption[] = data.models.map((m) => ({
                value: `${m.provider}/${m.model}`,
                label: `${prettyModelName(m.model)}${rateSuffix(m.creditsPerHour)}`,
                creditsPerHour: m.creditsPerHour ?? null,
                isDefault: m.default ?? false,
                expanded: m.expanded ?? false,
            }));
            cache.set(provider, opts);
            return opts;
        } catch {
            return null;
        }
    }

    // Ollama models come from the app backend's curated /app/v1/providers list.
    // Without that backend (e.g. Vite dev alone), probe the Ollama daemon
    // directly via the /ollama proxy - the same source capabilities.ts trusts -
    // so local models still populate.
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
        // The BYOK key travels only to the loopback (desktop) or same-origin
        // (web) backend, which uses it to query the provider.
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
 * Render a <select> of model options for a provider, or an explanatory empty
 * state when none can be listed (see renderUnavailable - no free-text fallback).
 * The returned refresh(provider) re-populates the same DOM slot when the
 * provider changes.
 */
export function mountModelPicker(
    container: HTMLElement,
    initialProvider: string,
    initialValue: string,
    onChange: (value: string) => void
): { refresh: (provider: string) => Promise<void>; getValue: () => string; getRate: () => number } {
    let currentValue = initialValue;
    // Loaded options, so getRate() can map the selection to credits/hr without
    // another fetch.
    let currentModels: ModelOption[] = [];

    container.innerHTML = `
        <select id="model-select" disabled>
            <option value="">Loading models…</option>
        </select>`;

    function renderSelect(provider: string, models: ModelOption[]): void {
        currentModels = models;
        // Curated vs expanded tier (aloud cloud only): expanded models hide
        // until the user opts in, EXCEPT the currently-selected one - toggling
        // off must never silently switch an existing choice.
        const showAll = showAllModels === true;
        const visible =
            provider === 'aloud' && !showAll
                ? models.filter((m) => !m.expanded || m.value === currentValue)
                : models;
        const optionsHTML = visible
            .map((m) => `<option value="${attr(m.value)}">${escape(m.label)}</option>`)
            .join('');
        // Under the hosted selector, the tier toggle (it took over the slot the
        // rate legend used to fill; the ☁️ badges read fine without it).
        const toggle =
            provider === 'aloud'
                ? `<p class="credit-rate-legend"><button type="button" class="btn-link" id="model-show-all">${escape(
                      showAll ? 'Show fewer models ▲' : 'Show all available models ▼'
                  )}</button></p>`
                : '';
        container.innerHTML = `
            <select id="model-select" data-provider="${attr(provider)}">${optionsHTML}</select>${toggle}
            <p class="model-slow-note hidden" id="model-slow-note">${escape(SLOW_MODEL_NOTE)}</p>`;
        const sel = container.querySelector<HTMLSelectElement>('#model-select')!;
        const slowNote = container.querySelector<HTMLElement>('#model-slow-note')!;
        container
            .querySelector<HTMLButtonElement>('#model-show-all')
            ?.addEventListener('click', () => {
                void setShowAllModels(!showAll);
                renderSelect(provider, models);
            });
        // The picker always shows a concrete model name, never a "(provider
        // default)" placeholder: an unmatched persisted value promotes the
        // flagged default (aloud cloud marks one), else the first model. Keeps
        // the displayed model honest about what will actually run.
        const matched = visible.find((m) => m.value === currentValue);
        const promoted = matched ?? visible.find((m) => m.isDefault) ?? visible[0];
        if (promoted) {
            sel.value = promoted.value;
            currentValue = promoted.value;
        }
        const updateSlowNote = (): void => {
            slowNote.classList.toggle('hidden', !isSlowModel(currentValue));
        };
        updateSlowNote();
        // Notify after every (re)load, promoted or matched, so consumers (e.g.
        // the setup session-cost estimate) always learn the settled selection
        // once a provider's models arrive.
        onChange(currentValue);
        sel.addEventListener('change', () => {
            currentValue = sel.value;
            updateSlowNote();
            onChange(currentValue);
        });
        // Can the local `claude` CLI still serve a listed-but-removable model
        // (Fable)? Anthropic has long hinted at pulling models from
        // subscriptions. Non-blocking - the dropdown renders immediately.
        if (provider === 'claude_proxy') {
            void annotateSubscriptionAvailability(sel, updateSlowNote);
        }
    }

    /**
     * Probe removable subscription models (currently just Fable) and reflect it
     * in the live <select>: an unavailable model is disabled + relabelled, and a
     * selected one switches to its nearest peer with a notify. Best-effort - an
     * 'unknown' result leaves everything as shown.
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
                opt.textContent = `${m.label} - unavailable on your subscription`;
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
     * No model list could be fetched. Deliberately no free-text fallback - a
     * selector only appears when we can list the provider's currently-accessible
     * models. Show why (missing key vs unreachable) so the user knows what to fix.
     */
    async function renderUnavailable(provider: string): Promise<void> {
        const reason =
            providerNeedsKey(provider) && !(await hasApiKey(provider as Provider))
                ? `Add an API key to load models.`
                : `Couldn't load ${provider} models. Check the key or your connection.`;
        container.innerHTML = `<p class="model-unavailable" id="model-none">${escape(reason)}</p>`;
    }

    /** Ollama empty state: naming a model is useless when the daemon has none to
     *  run, so point at the Ollama manager below. */
    function renderOllamaEmpty(): void {
        container.innerHTML = `
            <p class="ollama-rec-hint" id="model-ollama-empty">
                No local models found. Install Ollama and download a model below.
            </p>`;
    }

    /** A first miss is usually a network blip - a "connecting" note beats an
     *  error while we retry. */
    function renderCloudConnecting(): void {
        container.innerHTML = `
            <p class="model-cloud-waking" id="model-cloud-waking">
                Connecting to aloud cloud…
            </p>`;
    }

    /** No answer after several retries. Say so plainly, with a manual Retry. */
    function renderCloudUnreachable(): void {
        container.innerHTML = `
            <p class="model-unavailable" id="model-cloud-down">
                Can't reach aloud cloud. Check your connection and
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
        // A miss may be a transient network hiccup rather than a real outage,
        // so retry with backoff before giving up.
        if (!models && provider === 'aloud') {
            for (const ms of [1500, 2500, 4000, 6000]) {
                renderCloudConnecting();
                await new Promise((resolve) => setTimeout(resolve, ms));
                models = await fetchModels(provider);
                if (models) break;
            }
        }
        if (models && models.length > 0) {
            // The tier toggle's persisted state must be known before the first
            // hosted render, or the curated filter would flicker.
            if (provider === 'aloud') await loadShowAllModels();
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
        // Credits/hr of the selected hosted model, 0 for free providers, summed
        // into the setup session estimate.
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
