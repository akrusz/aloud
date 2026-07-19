/**
 * Settings page - Ollama recommendation + model management UI.
 *
 * Renders the per-machine recommendation block from `/app/v1/providers`
 * (computed in `src-tauri/src/providers.rs`) as a curated tier list with
 * Download / Remove, plus any models pulled outside those tiers.
 *
 * A controls bar manages the daemon: Install when absent, Restart + Upgrade
 * when present. Those stream NDJSON `{status}` lines from the desktop backend
 * (`ollama_tools.rs`); Windows / no-Homebrew return a 400 + download URL the
 * bar opens for a manual install.
 */

import { appUrl } from './app-base.js';
import { probeOllamaDirect } from './ollama-direct.js';
import { confirmDialog, alertDialog } from './dialog.js';

interface Tier {
    model: string;
    label: string;
    download: string;
    ram: string;
    note: string;
    min_gb: number;
    fits: boolean;
    installed: boolean;
}

interface OtherModel {
    model: string;
    size: string;
}

interface OllamaInfo {
    available?: boolean;
    installed?: boolean;
    models?: string[];
    hint?: string;
    version?: string | null;
    outdated?: boolean;
    min_version?: string;
    recommendation?: {
        ram_gb?: number | null;
        recommended_model?: string;
        recommended_label?: string;
        tiers?: Tier[];
        other_installed?: OtherModel[];
    };
}

export interface OllamaSettingsHandle {
    /** Re-fetch /app/v1/providers and re-render. */
    refresh(): Promise<void>;
    /** Hide the section (provider switched away from Ollama). */
    hide(): void;
}

export interface OllamaSettingsOptions {
    /** Called when the installed-model set changes (a pull or remove finished),
     *  so the caller can refresh the standard model picker. */
    onModelsChanged?: () => void | Promise<void>;
}

/**
 * Mount the recommendation UI into `el`. Call the returned `refresh()` once the
 * modal is open, and again whenever the provider switches back to Ollama.
 */
export function mountOllamaSettings(
    el: HTMLElement,
    options: OllamaSettingsOptions = {}
): OllamaSettingsHandle {
    const onModelsChanged = options.onModelsChanged;

    async function refresh(): Promise<void> {
        let info: OllamaInfo = {};
        try {
            const resp = await fetch(appUrl('/providers'));
            if (resp.ok) {
                const data = (await resp.json()) as { ollama?: OllamaInfo };
                info = data.ollama ?? {};
            }
        } catch {
            // Backend unreachable — fall through to the direct probe below.
        }
        // If the app backend didn't report Ollama state (not running in dev, or
        // errored), probe the daemon directly so a running Ollama isn't shown a
        // misleading "Install Ollama" button. Tier recommendations still need
        // the backend, so the hint says so.
        if (!info.installed && !info.version && !info.recommendation) {
            const direct = await probeOllamaDirect();
            if (direct.installed) {
                info = {
                    installed: true,
                    version: direct.version,
                    models: direct.models,
                    hint: 'Ollama is running. Start the app backend to manage models and see size recommendations.',
                };
            }
        }
        el.classList.remove('hidden');
        el.innerHTML = renderHTML(info);
        wireButtons();
    }

    function hide(): void {
        el.classList.add('hidden');
        el.innerHTML = '';
    }

    /** Wire each Download/Remove button + the daemon controls bar. */
    function wireButtons(): void {
        el.querySelectorAll<HTMLButtonElement>('.ollama-pull-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                void pullModel(btn);
            });
        });
        el.querySelectorAll<HTMLButtonElement>('.ollama-remove-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                void removeModel(btn);
            });
        });
        const restart = el.querySelector<HTMLButtonElement>('.ollama-restart-btn');
        restart?.addEventListener('click', () => {
            void runDaemonTool(restart, appUrl('/ollama/restart'), { refreshModels: false });
        });
        const upgrade = el.querySelector<HTMLButtonElement>('.ollama-upgrade-btn');
        upgrade?.addEventListener('click', () => {
            void runDaemonTool(upgrade, appUrl('/ollama/upgrade'), { refreshModels: true });
        });
        const install = el.querySelector<HTMLButtonElement>('.ollama-install-btn');
        install?.addEventListener('click', () => {
            void runDaemonTool(install, appUrl('/install/ollama'), { refreshModels: true });
        });
    }

    /**
     * Run a daemon lifecycle action (restart / upgrade / install) that streams
     * NDJSON `{status}` lines. A 400 carrying a `download_url` (Windows / no
     * Homebrew) opens that page instead. Upgrade/install also refresh the model
     * picker, since availability may change.
     */
    async function runDaemonTool(
        btn: HTMLButtonElement,
        url: string,
        opts: { refreshModels: boolean }
    ): Promise<void> {
        const bar = el.querySelector<HTMLElement>('.ollama-tool-progress');
        const statusEl = bar?.querySelector<HTMLElement>('.ollama-tool-status') ?? null;
        const originalText = btn.textContent;
        const controls = el.querySelectorAll<HTMLButtonElement>('.ollama-tools button');
        controls.forEach((b) => (b.disabled = true));
        btn.textContent = 'Working…';
        bar?.classList.remove('hidden');
        if (statusEl) statusEl.textContent = 'Starting…';

        try {
            const resp = await fetch(url, { method: 'POST' });
            if (resp.status === 400) {
                const data = (await resp.json().catch(() => ({}))) as {
                    error?: string;
                    download_url?: string;
                };
                if (data.download_url) {
                    window.open(data.download_url, '_blank', 'noopener');
                    if (statusEl) {
                        statusEl.textContent =
                            data.error ?? 'Opening the download page…';
                    }
                    return;
                }
                throw new Error(data.error ?? 'Request failed (400).');
            }
            if (!resp.ok || !resp.body) throw new Error(`server returned ${resp.status}`);
            const finalMessage = await consumeStatusStream(resp.body, statusEl);
            if (statusEl && finalMessage) statusEl.textContent = finalMessage;
            await refresh();
            if (opts.refreshModels && onModelsChanged) await onModelsChanged();
        } catch (err) {
            if (statusEl) statusEl.textContent = (err as Error).message;
        } finally {
            // refresh() may have re-rendered (replacing these nodes); guard.
            if (btn.isConnected) {
                btn.textContent = originalText ?? '';
                controls.forEach((b) => (b.disabled = false));
            }
        }
    }

    async function pullModel(btn: HTMLButtonElement): Promise<void> {
        const model = btn.dataset['model'];
        if (!model) return;
        const tile = btn.closest<HTMLElement>('.ollama-tier, .ollama-other-row');
        const progressEl = tile?.querySelector<HTMLElement>('.ollama-pull-progress');
        const fillEl = progressEl?.querySelector<HTMLElement>('.ollama-pull-bar-fill');
        const statusEl = progressEl?.querySelector<HTMLElement>('.ollama-pull-status');

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        progressEl?.classList.remove('hidden');

        try {
            const resp = await fetch(appUrl('/ollama/pull'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model }),
            });
            if (!resp.ok || !resp.body) throw new Error(`server returned ${resp.status}`);
            await consumePullStream(resp.body, fillEl ?? null, statusEl ?? null);
            await refresh();
            if (onModelsChanged) await onModelsChanged();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = originalText ?? 'Download';
            if (statusEl) statusEl.textContent = (err as Error).message;
        }
    }

    async function removeModel(btn: HTMLButtonElement): Promise<void> {
        const model = btn.dataset['model'];
        if (!model) return;
        if (
            !(await confirmDialog(
                `Remove ${model}?\n\nThis will delete the model from disk. You can re-download it later.`,
                { okLabel: 'Remove', danger: true }
            ))
        ) {
            return;
        }
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
            const resp = await fetch(appUrl('/ollama/delete'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model }),
            });
            if (!resp.ok) {
                const data = (await resp.json().catch(() => ({}))) as { error?: string };
                throw new Error(data.error ?? `server returned ${resp.status}`);
            }
            await refresh();
            if (onModelsChanged) await onModelsChanged();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = originalText ?? 'Remove';
            void alertDialog(`Failed to remove model: ${(err as Error).message}`);
        }
    }

    return { refresh, hide };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderHTML(info: OllamaInfo): string {
    const controls = renderControls(info);
    const rec = info.recommendation;
    if (!rec || !rec.tiers || rec.tiers.length === 0) {
        // Daemon unreachable / no tiers: still show the controls bar, so an
        // Install button appears when it's missing.
        const hint = info.hint ? `<p class="ollama-rec-hint">${escapeHtml(info.hint)}</p>` : '';
        return controls + hint;
    }

    let html = controls;

    if (info.outdated && info.version) {
        html += `<div class="ollama-outdated-banner">
            <div class="ollama-outdated-message">
                Your Ollama (v${escapeHtml(info.version)}) is outdated and may not be able
                to download recent models. Update Ollama to
                v${escapeHtml(info.min_version ?? '0.21.0')}+.
            </div>
        </div>`;
    }

    if (rec.ram_gb) {
        html += `<p class="ollama-rec-detected">Your system has ${rec.ram_gb} GB RAM.</p>`;
    }

    html += '<div class="ollama-tiers">';
    for (const t of rec.tiers) {
        // With known RAM, hide tiers that can't run, to keep the list short. If
        // detection failed, show everything so the user can still pick.
        if (rec.ram_gb && !t.fits && !t.installed) continue;
        html += renderTier(t, rec.recommended_model);
    }
    html += '</div>';

    if (rec.other_installed && rec.other_installed.length > 0) {
        html += '<div class="ollama-others-heading">Other installed models</div>';
        html += '<div class="ollama-tiers">';
        for (const m of rec.other_installed) {
            html += renderOtherInstalled(m);
        }
        html += '</div>';
    }

    return html;
}

/**
 * Daemon controls bar. Install when Ollama is absent; Restart + Upgrade when
 * it's present. A shared, hidden progress line shows streamed status text.
 */
function renderControls(info: OllamaInfo): string {
    const installed = info.installed === true || Boolean(info.version);
    const buttons = installed
        ? `<button type="button" class="btn btn-small ollama-restart-btn">Restart Ollama</button>
           <button type="button" class="btn btn-small ollama-upgrade-btn">Upgrade Ollama</button>`
        : `<button type="button" class="btn btn-small ollama-install-btn">Install Ollama</button>`;
    return `<div class="ollama-tools">
        ${buttons}
        <div class="ollama-tool-progress hidden"><span class="ollama-tool-status"></span></div>
    </div>`;
}

/** One curated tier as a condensed flex row: model + label (+ badge) on the
 *  head line, size + note beneath, action button on the right. */
function renderTier(t: Tier, recommendedModel: string | undefined): string {
    const isRecommended = t.model === recommendedModel;
    const rowClass = isRecommended
        ? 'ollama-tier-row ollama-tier-recommended'
        : 'ollama-tier-row';

    const badge = isRecommended
        ? ' <span class="ollama-tier-badge">recommended</span>'
        : '';
    const sizeText = `${escapeHtml(t.download)} download, ${escapeHtml(t.ram)} in memory`;

    const actions = t.installed
        ? `<div class="ollama-tier-actions">
            <span class="ollama-tier-installed">Installed</span>
            <button type="button" class="btn btn-small ollama-remove-btn" data-model="${escapeAttr(t.model)}">Remove</button>
          </div>`
        : `<div class="ollama-tier-actions">
            <button type="button" class="btn btn-small ollama-pull-btn" data-model="${escapeAttr(t.model)}">Download</button>
          </div>`;

    return `<div class="${rowClass}">
        <div class="ollama-tier-info">
            <div class="ollama-tier-head"><strong>${escapeHtml(t.model)}</strong> - ${escapeHtml(t.label)}${badge}</div>
            <div class="ollama-tier-size">${sizeText}</div>
            ${t.note ? `<div class="ollama-tier-note">${escapeHtml(t.note)}</div>` : ''}
        </div>
        ${actions}
        <div class="ollama-pull-progress hidden">
            <div class="ollama-pull-bar"><div class="ollama-pull-bar-fill"></div></div>
            <div class="ollama-pull-status"></div>
        </div>
    </div>`;
}

function renderOtherInstalled(m: OtherModel): string {
    const sizeText = m.size ? `${escapeHtml(m.size)} on disk` : '';
    return `<div class="ollama-tier-row">
        <div class="ollama-tier-info">
            <div class="ollama-tier-head"><strong>${escapeHtml(m.model)}</strong></div>
            ${sizeText ? `<div class="ollama-tier-size">${sizeText}</div>` : ''}
        </div>
        <div class="ollama-tier-actions">
            <span class="ollama-tier-installed">Installed</span>
            <button type="button" class="btn btn-small ollama-remove-btn" data-model="${escapeAttr(m.model)}">Remove</button>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// NDJSON stream consumer
// ---------------------------------------------------------------------------

/** Read the `/app/v1/ollama/pull` NDJSON stream, advancing the progress bar and
 *  status text. Throws on an error line so the caller can restore the button. */
async function consumePullStream(
    body: ReadableStream<Uint8Array>,
    fillEl: HTMLElement | null,
    statusEl: HTMLElement | null
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg: { status?: string; error?: string; total?: number; completed?: number };
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg.status === 'error') throw new Error(msg.error ?? 'pull failed');
            if (statusEl) statusEl.textContent = msg.status ?? '';
            if (
                typeof msg.total === 'number' &&
                typeof msg.completed === 'number' &&
                msg.total > 0 &&
                fillEl
            ) {
                const pct = Math.min(100, Math.round((msg.completed / msg.total) * 100));
                fillEl.style.width = `${pct}%`;
            }
        }
    }
}

/**
 * Read a daemon-tool NDJSON stream (restart / upgrade / install), echoing each
 * `{status}` into `statusEl` as a live log. Resolves with the terminal `done`
 * message; throws on a `status:"error"` line.
 */
async function consumeStatusStream(
    body: ReadableStream<Uint8Array>,
    statusEl: HTMLElement | null
): Promise<string | undefined> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalMessage: string | undefined;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg: { status?: string; error?: string; message?: string };
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg.status === 'error') throw new Error(msg.error ?? 'operation failed');
            if (msg.status === 'done') {
                finalMessage = msg.message ?? 'Done.';
                if (statusEl) statusEl.textContent = finalMessage;
                continue;
            }
            if (statusEl && msg.status) statusEl.textContent = msg.status;
        }
    }
    return finalMessage;
}

// ---------------------------------------------------------------------------
// Pure helpers (kept exported for tests)
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => {
        switch (ch) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}

function escapeAttr(s: string): string {
    return escapeHtml(s);
}

export const __test = { renderHTML, renderTier };
