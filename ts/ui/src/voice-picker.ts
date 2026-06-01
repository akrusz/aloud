/**
 * Voice picker — scoring, modal rendering, preview.
 *
 * Port of src/web/static/js/voice-picker.js. The classes used by
 * renderVoiceList (.voice-row, .voice-tier-label, .voice-row-name,
 * .voice-row-preview, etc.) come from the lifted CSS, so visual
 * styling lands automatically.
 *
 * Scoring tiers (descending):
 *   3  Premium  — explicit "Premium" in name
 *   2  Quality  — "Enhanced", "Online", "Natural"
 *   1  Standard — Google, known-good macOS voice list, Piper
 *   0  Other    — everything else
 *
 * A separate "Best" group appears above the tiers and is reserved for the
 * genuinely top-quality voices: the hosted (aloud cloud) voices and Chrome's
 * cloud voices. Local engines (macOS Premium, Piper) are good but sort into the
 * Premium/Standard tiers below rather than Best.
 */

import type { TtsEngine } from '../../src/platform/index.js';

import { createTtsForVoice } from './adapters/tts-picker.js';
import { cloudUrl } from './cloud-base.js';
import { appUrl } from './app-base.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Raw voice metadata returned from `/api/voices`. */
export interface ServerVoice {
    name: string;
    lang?: string;
    engine?: string;
    recommended?: boolean;
    needs_download?: boolean;
    downloaded?: boolean;
    size_display?: string;
    /** Shared model-file basename; repeated across multi-speaker voices. */
    model?: string;
}

/** A curated hosted voice from the server's GET /v1/voices (mirrors the
 *  server's CloudVoice contract by hand). */
export interface CloudVoice {
    name: string;
    gender: 'female' | 'male' | 'androgynous';
    /** Relative cost tier for the picker's $ indicator. Optional for resilience
     *  against an older server that doesn't send it. */
    tier?: 'premium' | 'value';
    /** Estimated credits/hr at a typical talk profile (server-computed). */
    creditsPerHourTypical?: number;
}

/** Scored, sorted voice entry for the picker UI. */
export interface ScoredVoice {
    name: string;
    lang: string;
    score: number;
    engine: string | undefined;
    /** Display-only engine override for the badge. Playback still routes by
     *  `engine`; this just lets a browser-sourced macOS voice read "macOS"
     *  instead of "Browser" (detected via the com.apple voiceURI). */
    displayEngine?: string;
    /** Backing browser SpeechSynthesisVoice when available. */
    browserVoice?: SpeechSynthesisVoice;
    recommended?: boolean;
    needsDownload?: boolean;
    downloaded?: boolean;
    sizeDisplay?: string;
    /** Shared model-file basename; speakers sharing it download together. */
    model?: string;
    /** Small muted label after the name (e.g. a hosted voice's gender). */
    note?: string;
    /** Cost tier for a hosted voice — drives the "$"/"$$" cost badge. */
    costTier?: 'premium' | 'value';
    /** Estimated credits/hr for a hosted voice (shown in the badge tooltip). */
    creditsPerHour?: number;
}

export const TIER_LABELS: Record<number, string> = {
    3: 'Premium',
    2: 'Quality',
    1: 'Standard',
    0: 'Other',
};

const ENGINE_LABELS: Record<string, string> = {
    macos: 'macOS',
    piper: 'Piper',
    elevenlabs: 'ElevenLabs',
    browser: 'Browser',
    aloud: 'aloud',
};

export const PREVIEW_PHRASE = "Welcome to aloud. I'll be your facilitator.";

/** Map a scored voice's engine + name to the prefixed id stored in
 *  SessionSetup/AppSettings: `browser:` / `aloud:` / `server:` (default). */
export function prefixedVoiceId(engine: string | undefined, name: string): string {
    const prefix = engine === 'browser' ? 'browser:' : engine === 'aloud' ? 'aloud:' : 'server:';
    return `${prefix}${name}`;
}

// Known high-quality macOS base voice names (without Premium/Enhanced suffix).
const MACOS_QUALITY_VOICES =
    /^(Ava|Allison|Samantha|Susan|Tom|Zoe|Karen|Daniel|Moira|Fiona|Tessa|Lee|Majed|Luciana|Joana|Mónica)$/i;

/** True on macOS/iOS, where local speechSynthesis voices are Apple's. */
function isMac(): boolean {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreVoice(name: string, engine?: string): number {
    const baseName = name.replace(/\s*\(.*\)$/, '');
    if (/Premium/i.test(name)) return 3;
    // ElevenLabs is premium cloud TTS; keep it in the Quality tier even though
    // its voice names carry no quality keyword (it no longer rides the server
    // "recommended" flag — see buildScoredVoiceList).
    if (engine === 'elevenlabs') return 2;
    if (/Enhanced/i.test(name)) return 2;
    if (/Online|Natural/i.test(name)) return 2;
    if (/^Google/i.test(name)) return 1;
    if (MACOS_QUALITY_VOICES.test(baseName)) return 1;
    if (engine === 'piper') return 1;
    return 0;
}

/**
 * Build a scored, sorted voice list from server + browser voices.
 * Server voices come first when present (they're what actually speak
 * through Flask's TTS engines). Browser voices fill in when
 * `includeBrowserVoices` is true and the server engine is browser-only
 * or no server is reachable.
 *
 * Filters to English plus the navigator's primary language.
 */
export function buildScoredVoiceList(
    serverVoices: readonly ServerVoice[] | null,
    includeBrowserVoices: boolean,
    hostedVoices: readonly CloudVoice[] = []
): ScoredVoice[] {
    const langPrefix = (navigator.language || 'en').split(/[-_]/)[0];
    const browserVoices =
        includeBrowserVoices && typeof speechSynthesis !== 'undefined'
            ? speechSynthesis.getVoices()
            : [];

    const browserByName = new Map<string, SpeechSynthesisVoice>();
    for (const v of browserVoices) browserByName.set(v.name, v);

    const scored: ScoredVoice[] = [];
    const seen = new Set<string>();

    // Curated hosted voices (only present when the server is reachable + has a
    // TTS key) lead the "Best" tier — the genuinely top-quality option. The
    // Best tier is reserved for these and Chrome's cloud voices; local engines
    // (macOS Premium, Piper) sort into Premium/Standard below, per the
    // developer's preference (they're good, but not as good as cloud neural).
    for (const hv of hostedVoices) {
        scored.push({
            name: hv.name,
            lang: 'en-US',
            score: 3,
            engine: 'aloud',
            recommended: true,
            note: hv.gender,
            ...(hv.tier ? { costTier: hv.tier } : {}),
            ...(hv.creditsPerHourTypical != null ? { creditsPerHour: hv.creditsPerHourTypical } : {}),
        });
        seen.add(hv.name);
    }

    if (serverVoices) {
        for (const sv of serverVoices) {
            const vLang = (sv.lang ?? '').split(/[-_]/)[0];
            if (vLang !== 'en' && vLang !== langPrefix) continue;

            const score = scoreVoice(sv.name, sv.engine);

            let browserVoice = browserByName.get(sv.name);
            if (!browserVoice && !sv.name.includes('(')) {
                const baseName = sv.name.replace(/\s*\(.*\)$/, '');
                browserVoice = browserByName.get(baseName);
            }

            const entry: ScoredVoice = {
                name: sv.name,
                lang: sv.lang ?? '',
                score,
                engine: sv.engine,
            };
            if (browserVoice) entry.browserVoice = browserVoice;
            if (sv.needs_download) {
                entry.needsDownload = true;
                if (sv.downloaded) entry.downloaded = true;
                if (sv.size_display) entry.sizeDisplay = sv.size_display;
                if (sv.model) entry.model = sv.model;
            }
            // NOTE: we intentionally do NOT promote server-"recommended" voices
            // (macOS Premium, Piper Libritts) into the Best tier — they sort by
            // score into Premium/Standard. Best is hosted + Chrome cloud only.
            scored.push(entry);
            seen.add(sv.name);
            if (browserVoice) seen.add(browserVoice.name);
        }
    }

    // Browser-only voices not already covered.
    for (const v of browserVoices) {
        if (seen.has(v.name)) continue;
        const vLang = (v.lang || '').split(/[-_]/)[0];
        if (vLang !== 'en' && vLang !== langPrefix) continue;

        let score = scoreVoice(v.name);
        // Non-local browser voices (Chrome/Edge cloud) are the genuinely good
        // ones — bump their score and float them into the Best tier alongside
        // the hosted voices (developer preference: cloud-neural over local).
        const remote = !v.localService;
        if (remote) score = Math.max(score, 2);
        const recommended = remote;
        // macOS system voices reach us through the browser (engine stays
        // 'browser' so playback routes to speechSynthesis), but tag them "macOS"
        // in the badge. Safari exposes a com.apple voiceURI; Chrome on macOS
        // uses a plain-name voiceURI, so the reliable signal is "on a Mac, a
        // local voice is an Apple voice" (the only local TTS engine there).
        const isApple =
            (v.voiceURI || '').startsWith('com.apple') || (isMac() && (v.localService ?? false));

        scored.push({
            name: v.name,
            lang: v.lang || '',
            score,
            engine: 'browser',
            ...(isApple ? { displayEngine: 'macos' } : {}),
            browserVoice: v,
            ...(recommended ? { recommended: true } : {}),
        });
        seen.add(v.name);
    }

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ar = a.recommended ? 1 : 0;
        const br = b.recommended ? 1 : 0;
        if (ar !== br) return br - ar;
        return a.name.localeCompare(b.name);
    });

    return scored;
}

// ---------------------------------------------------------------------------
// Modal rendering
// ---------------------------------------------------------------------------

export interface RenderListOptions {
    /** Show an engine badge (e.g. "macOS") after the voice name. */
    showEngine?: boolean;
    /** Show an Uninstall button for downloaded Piper voices. */
    showUninstall?: boolean;
}

/**
 * Render the voice modal list into a container. Splits recommended
 * voices out into their own section, then groups the rest by tier.
 */
export function renderVoiceList(
    listEl: HTMLElement,
    voices: readonly ScoredVoice[],
    selectedName: string | null,
    options: RenderListOptions = {}
): void {
    listEl.innerHTML = '';

    if (voices.length === 0) {
        listEl.innerHTML =
            '<div class="voice-tier-label">No text-to-speech voices available</div>';
        return;
    }

    const recommended: ScoredVoice[] = [];
    const tiers: Record<number, ScoredVoice[]> = {};
    for (const v of voices) {
        if (v.recommended) {
            recommended.push(v);
        } else {
            (tiers[v.score] ??= []).push(v);
        }
    }

    if (recommended.length > 0) {
        appendTierLabel(listEl, 'Best');
        for (const v of recommended) appendRow(listEl, v, selectedName, options);
    }

    for (const tier of [3, 2, 1, 0] as const) {
        const items = tiers[tier];
        if (!items || items.length === 0) continue;
        appendTierLabel(listEl, TIER_LABELS[tier] ?? 'Other');
        for (const v of items) appendRow(listEl, v, selectedName, options);
    }
}

function appendTierLabel(parent: HTMLElement, text: string): void {
    const el = document.createElement('div');
    el.className = 'voice-tier-label';
    el.textContent = text;
    parent.appendChild(el);
}

function appendRow(
    parent: HTMLElement,
    entry: ScoredVoice,
    selectedName: string | null,
    options: RenderListOptions
): void {
    const row = document.createElement('div');
    row.className = 'voice-row';
    if (entry.needsDownload && !entry.downloaded) row.classList.add('voice-row-locked');
    if (entry.name === selectedName) row.classList.add('selected');
    row.dataset['voiceName'] = entry.name;
    // Speakers sharing one model file carry the same data-model, so a download
    // in flight can disable all their Download buttons at once.
    if (entry.model) row.dataset['model'] = entry.model;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'voice-row-name';
    nameSpan.textContent = entry.name;
    if (entry.note) {
        const note = document.createElement('span');
        note.className = 'voice-row-engine';
        note.textContent = entry.note;
        nameSpan.appendChild(note);
    }
    // Cost indicator for hosted voices: "$" (value/Neural2) vs "$$" (premium/
    // Chirp3-HD), so a pricier voice reads as pricier at a glance. The tooltip
    // carries the concrete credits/hr (meditation-pal-b7i).
    if (entry.costTier) {
        const cost = document.createElement('span');
        cost.className = `voice-row-cost voice-row-cost-${entry.costTier}`;
        cost.textContent = entry.costTier === 'premium' ? '$$' : '$';
        const tierWord = entry.costTier === 'premium' ? 'Premium' : 'Value';
        cost.title =
            entry.creditsPerHour != null
                ? `${tierWord} voice · ≈ ${entry.creditsPerHour} credits/hr`
                : `${tierWord} voice`;
        nameSpan.appendChild(cost);
    }
    if (options.showEngine && (entry.displayEngine ?? entry.engine)) {
        const eng = entry.displayEngine ?? entry.engine!;
        const badge = document.createElement('span');
        badge.className = 'voice-row-engine';
        badge.textContent = ENGINE_LABELS[eng] ?? eng;
        nameSpan.appendChild(badge);
    }
    row.appendChild(nameSpan);

    if (entry.name === selectedName) {
        const check = document.createElement('span');
        check.className = 'voice-row-check';
        check.textContent = '✓';
        row.appendChild(check);
    }

    if (entry.needsDownload) {
        if (entry.downloaded) {
            if (options.showUninstall) {
                const unBtn = document.createElement('button');
                unBtn.type = 'button';
                unBtn.className = 'voice-row-uninstall';
                unBtn.textContent = 'Uninstall';
                unBtn.dataset['voiceName'] = entry.name;
                unBtn.dataset['engine'] = entry.engine ?? '';
                row.appendChild(unBtn);
            }
        } else {
            if (entry.sizeDisplay) {
                const size = document.createElement('span');
                size.className = 'voice-row-size';
                size.textContent = entry.sizeDisplay;
                row.appendChild(size);
            }
            const dlBtn = document.createElement('button');
            dlBtn.type = 'button';
            dlBtn.className = 'voice-row-download';
            dlBtn.textContent = 'Download';
            dlBtn.dataset['voiceName'] = entry.name;
            dlBtn.dataset['engine'] = entry.engine ?? '';
            row.appendChild(dlBtn);
        }
    }

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'voice-row-preview';
    previewBtn.textContent = 'Preview';
    previewBtn.dataset['voiceName'] = entry.name;
    if (entry.needsDownload && !entry.downloaded) {
        previewBtn.classList.add('preview-unavailable');
        previewBtn.title = 'Download this voice first to preview it';
    }
    row.appendChild(previewBtn);

    parent.appendChild(row);
}

/**
 * Update the checkmark/selected state without re-rendering the whole list.
 */
export function updateVoiceSelection(
    listEl: HTMLElement,
    selectedName: string
): void {
    const rows = listEl.querySelectorAll<HTMLElement>('.voice-row');
    rows.forEach((row) => {
        const isSelected = row.dataset['voiceName'] === selectedName;
        row.classList.toggle('selected', isSelected);
        const existing = row.querySelector<HTMLElement>('.voice-row-check');
        if (isSelected && !existing) {
            const check = document.createElement('span');
            check.className = 'voice-row-check';
            check.textContent = '✓';
            const preview = row.querySelector<HTMLElement>('.voice-row-preview');
            if (preview) row.insertBefore(check, preview);
            else row.appendChild(check);
        } else if (!isSelected && existing) {
            existing.remove();
        }
    });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

let activePreviewEngine: TtsEngine | null = null;

/**
 * Construct the right TTS engine for the voice and speak the preview
 * phrase. `voiceId` here is the raw voice name (not the 'server:'/
 * 'browser:' prefixed id used by SessionSetup) — matches Python's
 * previewVoice() signature. Engine override lets callers force a
 * specific backend when the same voice name exists across engines.
 */
export async function previewVoice(
    voiceName: string,
    rate?: number,
    engine?: string
): Promise<void> {
    stopPreview();
    try {
        // Build a prefixed id that createTtsForVoice understands. We
        // assume server voices unless the engine is explicitly 'browser' or
        // 'aloud' (the hosted Google voices).
        const id =
            engine === 'browser'
                ? `browser:${voiceName}`
                : engine === 'aloud'
                  ? `aloud:${voiceName}`
                  : `server:${voiceName}`;
        const { engine: ttsEngine } = await createTtsForVoice(id);
        activePreviewEngine = ttsEngine;
        const text =
            voiceName === 'Zarvox' ? 'Come. On. Fahoogwuhgods.' : PREVIEW_PHRASE;
        await ttsEngine.speak(text, rate !== undefined ? { rate } : undefined);
    } catch {
        // Preview failures are non-fatal — the user can try a different
        // voice or check that Flask is running.
    } finally {
        if (activePreviewEngine) {
            // Best-effort cleanup; the engine handles double-cancel safely.
            void activePreviewEngine.cancel();
            activePreviewEngine = null;
        }
    }
}

export function stopPreview(): void {
    if (activePreviewEngine) {
        void activePreviewEngine.cancel();
        activePreviewEngine = null;
    }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

// ---------------------------------------------------------------------------
// Modal HTML helpers
// ---------------------------------------------------------------------------

export interface VoiceModalConfig {
    /** id for the overlay div. */
    modalId: string;
    /** id for the close button. */
    closeId: string;
    /** id for the list container. */
    listId: string;
    title?: string;
    /** Speed slider — omit to hide the footer. */
    speedSliderId?: string;
    speedLabelId?: string;
    /** Initial slider value (wpm). */
    speedValue?: number;
}

/**
 * Render the picker_modal markup. Mirrors templates/_voice_modal.html.
 */
export function renderVoiceModalHTML(cfg: VoiceModalConfig): string {
    const title = cfg.title ?? 'Choose Voice';
    const speedValue = cfg.speedValue ?? 110;
    const footer = cfg.speedSliderId
        ? `
        <div class="voice-modal-footer">
            <label class="voice-modal-speed-label" for="${cfg.speedSliderId}">Speed</label>
            <input type="range" id="${cfg.speedSliderId}" min="60" max="240"
                value="${speedValue}" step="10">
            <span class="voice-modal-speed-value" id="${cfg.speedLabelId ?? ''}">${speedValue} wpm</span>
        </div>`
        : '';
    return `
    <div class="voice-modal-overlay hidden" id="${cfg.modalId}">
        <div class="voice-modal">
            <div class="voice-modal-header">
                <span class="voice-modal-title">${title}</span>
                <button type="button" class="voice-modal-close" id="${cfg.closeId}">&times;</button>
            </div>
            <div class="voice-modal-list" id="${cfg.listId}"></div>${footer}
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// /api/voices loader
// ---------------------------------------------------------------------------

const SERVER_VOICES_URL = '/voices';
let serverVoicesCache: ServerVoice[] | null = null;

export async function fetchServerVoices(force = false): Promise<ServerVoice[] | null> {
    if (!force && serverVoicesCache !== null) return serverVoicesCache;
    try {
        const response = await fetch(appUrl(SERVER_VOICES_URL));
        if (!response.ok) return null;
        const data = (await response.json()) as ServerVoice[];
        serverVoicesCache = data;
        return serverVoicesCache;
    } catch {
        // Flask isn't reachable — we'll fall back to browser voices only.
        return null;
    }
}

export function invalidateServerVoicesCache(): void {
    serverVoicesCache = null;
}

const DOWNLOAD_MODEL_URL = '/tts/download-model';
const UNINSTALL_MODEL_URL = '/tts/uninstall-model';

export interface DownloadProgress {
    /** Cumulative bytes downloaded across the voice's files. */
    completed: number;
    /** Content-length of the file currently downloading (0 if unknown). */
    total: number;
    file: string;
}

/**
 * Download a Piper voice model, streaming byte progress via `onProgress`.
 * Resolves once the model is on disk (`done` / `already_downloaded`), rejects
 * on an error line or transport failure. Consumes the NDJSON stream emitted by
 * both backends (Flask and the desktop Rust server), so callers stay
 * backend-agnostic.
 *
 * Multi-speaker voices share one model file — after this resolves, re-fetch
 * `/api/voices` and every speaker for that model reports `downloaded:true`.
 */
export async function downloadVoiceModel(
    voiceName: string,
    engine: string | undefined,
    onProgress?: (p: DownloadProgress) => void
): Promise<void> {
    const resp = await fetch(appUrl(DOWNLOAD_MODEL_URL), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voice: voiceName, engine: engine ?? '' }),
    });
    if (!resp.ok || !resp.body) throw new Error(`server returned ${resp.status}`);

    const reader = resp.body.getReader();
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
            let msg: {
                status?: string;
                error?: string;
                total?: number;
                completed?: number;
                file?: string;
            };
            try {
                msg = JSON.parse(line);
            } catch {
                continue; // ignore a partial/garbled line
            }
            if (msg.status === 'error') throw new Error(msg.error || 'download failed');
            if (msg.status === 'downloading' && onProgress) {
                onProgress({
                    completed: msg.completed ?? 0,
                    total: msg.total ?? 0,
                    file: msg.file ?? '',
                });
            }
            // "done"/"already_downloaded" need no action; the loop ends when
            // the server closes the stream.
        }
    }
}

/** Remove a downloaded Piper voice model. Resolves on success. */
export async function uninstallVoiceModel(
    voiceName: string,
    engine: string | undefined
): Promise<void> {
    const resp = await fetch(appUrl(UNINSTALL_MODEL_URL), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voice: voiceName, engine: engine ?? '' }),
    });
    if (!resp.ok) throw new Error(`server returned ${resp.status}`);
}

/**
 * Disable (or re-enable) the Download buttons of every voice row sharing
 * `model` — used while one speaker of a multi-speaker model is downloading, so
 * the user can't kick off the same 100 MB fetch from a sibling. `exceptBtn`
 * (the clicked button, showing live percent) is left alone.
 */
export function setModelDownloadsDisabled(
    listEl: HTMLElement,
    model: string | undefined,
    disabled: boolean,
    exceptBtn?: HTMLButtonElement
): void {
    if (!model) return;
    const sel =
        typeof CSS !== 'undefined' && CSS.escape
            ? `.voice-row[data-model="${CSS.escape(model)}"] .voice-row-download`
            : `.voice-row[data-model="${model}"] .voice-row-download`;
    listEl.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => {
        if (b !== exceptBtn) b.disabled = disabled;
    });
}

/**
 * Cumulative download percent (0–100). `completed` is cumulative across files
 * while `total` is the current file's size, so once we roll onto the tiny
 * `.onnx.json` `completed` exceeds `total`; clamping to the larger of the two
 * keeps the bar monotonic and pinned at ~100% for that last hop.
 */
export function downloadPercent(p: DownloadProgress): number {
    const denom = Math.max(p.total, p.completed);
    if (denom <= 0) return 0;
    return Math.min(100, Math.round((p.completed / denom) * 100));
}

// ---------------------------------------------------------------------------
// /v1/voices loader (aloud cloud)
// ---------------------------------------------------------------------------

let cloudVoicesCache: CloudVoice[] | null = null;

/**
 * Fetch the curated hosted voices from the server. Returns [] (cached) when the
 * server is unreachable or has no TTS key — so the picker only surfaces hosted
 * voices that can actually speak (availability-driven menus).
 */
export async function fetchCloudVoices(force = false): Promise<CloudVoice[]> {
    if (!force && cloudVoicesCache !== null) return cloudVoicesCache;
    try {
        const response = await fetch(cloudUrl('/voices'));
        cloudVoicesCache = response.ok ? ((await response.json()) as CloudVoice[]) : [];
    } catch {
        cloudVoicesCache = [];
    }
    return cloudVoicesCache;
}

export function invalidateCloudVoicesCache(): void {
    cloudVoicesCache = null;
}
