/**
 * Voice picker - scoring, modal rendering, preview. renderVoiceList's classes
 * (.voice-row, .voice-tier-label, …) come from the base CSS.
 *
 * Scoring tiers (descending):
 *   4  Very Good - "Premium" in the name (Apple Premium) + hosted Neural2 ("value")
 *   3  Good      - Piper (desktop)
 *   2  Quality   - "Enhanced", "Online", "Natural"
 *   1  Standard  - Google, known-good macOS voices
 *   0  Other     - everything else
 *
 * A "Best" group sits above the tiers, reserved for hosted Chirp3-HD ("premium")
 * and Chrome's cloud voices. Per the developer's preference cloud-neural beats
 * local, and the cheaper Neural2 tier sits a notch below Chirp3-HD, so Neural2
 * and Apple Premium drop into "Very Good" and Piper into "Good".
 */

import type { TtsEngine } from '../../src/platform/index.js';

import { createTtsForVoice, createCloudAloudPreviewTts } from './adapters/tts-picker.js';
import { rateBadge, RATE_LEGEND, RATE_LEGEND_TITLE, withCloudOutline } from './credit-rate.js';
import { cloudUrl } from './cloud-base.js';
import { appUrl } from './app-base.js';
import { t } from './i18n.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Raw voice metadata returned from `/app/v1/voices`. */
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

/** A curated hosted voice from GET /v1/voices (hand-mirrors the server's
 *  CloudVoice contract). */
export interface CloudVoice {
    name: string;
    gender: 'female' | 'male' | 'androgynous';
    /** Relative cost tier for the picker's $ indicator. Optional so an older
     *  server that doesn't send it still works. */
    tier?: 'premium' | 'value';
    /** Estimated credits/hr at a typical talk profile (server-computed). */
    creditsPerHourTypical?: number;
    /** Speaks languages beyond English natively; ungated by session language. */
    multilingual?: boolean;
    /** Native-quality Chinese to a native ear; zh sessions default to and
     *  surface these first. */
    zhNative?: boolean;
    /** Pace fixed server-side (styled voices always synthesize at rate 1). */
    fixedPace?: boolean;
}

/** Scored, sorted voice entry for the picker UI. */
export interface ScoredVoice {
    name: string;
    lang: string;
    score: number;
    engine: string | undefined;
    /** Display-only badge override; playback still routes by `engine`. Lets a
     *  browser-sourced macOS voice read "macOS" instead of "Browser". */
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
    /** Cost tier for a hosted voice - drives the "$"/"$$" cost badge. */
    costTier?: 'premium' | 'value';
    /** Estimated credits/hr for a hosted voice (shown in the badge tooltip). */
    creditsPerHour?: number;
    /** Doesn't speak the session's language (meditation-pal-c3a0.6): rendered
     *  dimmed with a language badge, sunk below its tier-mates, still pickable
     *  (the mismatch is a warning, not a wall). */
    langMismatch?: boolean;
    /** Pace fixed server-side (styled Azure voices; CloudVoice.fixedPace) -
     *  the speed slider grays out while this voice is selected. */
    fixedPace?: boolean;
    /** Native-quality Chinese (CloudVoice.zhNative): sorts first among
     *  zh-capable tier-mates in a zh session, and is what a no-voice zh
     *  session swaps to. */
    zhNative?: boolean;
}

export const TIER_LABELS: Record<number, string> = {
    4: 'Very Good',
    3: 'Good',
    2: 'Quality',
    1: 'Standard',
    0: 'Other',
};

export const ENGINE_LABELS: Record<string, string> = {
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
    // Apple "Premium" system voices: best local option, a rung below
    // cloud-neural, so "Very Good" alongside hosted Neural2 (scored in
    // buildScoredVoiceList).
    if (/Premium/i.test(name)) return 4;
    // ElevenLabs is premium cloud TTS - hold it in Quality even though its
    // voice names carry no quality keyword.
    if (engine === 'elevenlabs') return 2;
    if (/Enhanced/i.test(name)) return 2;
    if (/Online|Natural/i.test(name)) return 2;
    if (/^Google/i.test(name)) return 1;
    if (MACOS_QUALITY_VOICES.test(baseName)) return 1;
    // Piper (the desktop's bundled neural voices) tops the local tiers per the
    // developer's preference - they're genuinely solid.
    if (engine === 'piper') return 3;
    return 0;
}

/**
 * Scored, sorted voice list from server + browser voices, filtered to English
 * plus the navigator's primary language plus the session language. Server
 * voices lead when present (they're what the app backend's TTS engines
 * actually speak); browser voices fill in when `includeBrowserVoices` and no
 * server voice covers them.
 *
 * `sessionLang` (a 2-letter app code, default 'en') marks each entry that
 * can't speak that language with `langMismatch` - the picker dims those and
 * sinks them below their tier-mates rather than hiding them (c3a0.6).
 */
export function buildScoredVoiceList(
    serverVoices: readonly ServerVoice[] | null,
    includeBrowserVoices: boolean,
    hostedVoices: readonly CloudVoice[] = [],
    sessionLang = 'en'
): ScoredVoice[] {
    const langPrefix = (navigator.language || 'en').split(/[-_]/)[0];
    /** '' (unknown) reads as English - the catalog's overwhelming default. */
    const speaks = (voiceLang: string | undefined): boolean =>
        ((voiceLang || 'en').split(/[-_]/)[0] ?? 'en') === sessionLang;
    const browserVoices =
        includeBrowserVoices && typeof speechSynthesis !== 'undefined'
            ? speechSynthesis.getVoices()
            : [];

    const browserByName = new Map<string, SpeechSynthesisVoice>();
    for (const v of browserVoices) browserByName.set(v.name, v);

    const scored: ScoredVoice[] = [];
    const seen = new Set<string>();

    // Curated hosted voices (present only when the server is reachable and has a
    // TTS key) lead the "Best" tier, which is reserved for these and Chrome's
    // cloud voices.
    for (const hv of hostedVoices) {
        // Chirp3-HD ("premium") leads Best; the cheaper Neural2 ("value") voices
        // are still excellent but drop one rung to "Very Good" (4) alongside
        // Apple Premium. An older server omitting tier defaults to Best, the
        // safe direction.
        const isValue = hv.tier === 'value';
        scored.push({
            name: hv.name,
            lang: 'en-US',
            score: isValue ? 4 : 3,
            engine: 'aloud',
            ...(isValue ? {} : { recommended: true }),
            note: t(hv.gender),
            ...(hv.tier ? { costTier: hv.tier } : {}),
            ...(hv.creditsPerHourTypical != null ? { creditsPerHour: hv.creditsPerHourTypical } : {}),
            ...(hv.multilingual || speaks('en') ? {} : { langMismatch: true }),
            ...(hv.fixedPace ? { fixedPace: true } : {}),
            ...(hv.zhNative ? { zhNative: true } : {}),
        });
        seen.add(hv.name);
    }

    if (serverVoices) {
        for (const sv of serverVoices) {
            const vLang = (sv.lang ?? '').split(/[-_]/)[0];
            if (vLang !== 'en' && vLang !== langPrefix && vLang !== sessionLang) continue;

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
                ...(speaks(sv.lang) ? {} : { langMismatch: true }),
            };
            if (browserVoice) entry.browserVoice = browserVoice;
            if (sv.needs_download) {
                entry.needsDownload = true;
                if (sv.downloaded) entry.downloaded = true;
                if (sv.size_display) entry.sizeDisplay = sv.size_display;
                if (sv.model) entry.model = sv.model;
            }
            // Deliberately no promotion of server-"recommended" voices (macOS
            // Premium, Piper Libritts) into Best - they sort by score. Best is
            // hosted + Chrome cloud only.
            scored.push(entry);
            seen.add(sv.name);
            if (browserVoice) seen.add(browserVoice.name);
        }
    }

    // Browser-only voices not already covered.
    for (const v of browserVoices) {
        if (seen.has(v.name)) continue;
        const vLang = (v.lang || '').split(/[-_]/)[0];
        if (vLang !== 'en' && vLang !== langPrefix && vLang !== sessionLang) continue;

        let score = scoreVoice(v.name);
        // Non-local browser voices (Chrome/Edge cloud) are the genuinely good
        // ones - bump them into Best alongside the hosted voices.
        const remote = !v.localService;
        if (remote) score = Math.max(score, 2);
        const recommended = remote;
        // macOS system voices arrive through the browser (engine stays 'browser'
        // so playback routes to speechSynthesis) but badge as "macOS". Safari
        // exposes a com.apple voiceURI while Chrome on macOS uses a plain-name
        // one, so the reliable signal is "on a Mac, a local voice is an Apple
        // voice" - the only local TTS engine there.
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
            ...(speaks(v.lang) ? {} : { langMismatch: true }),
        });
        seen.add(v.name);
    }

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Voices that speak the session language surface above tier-mates that
        // don't (which render dimmed).
        const am = a.langMismatch ? 1 : 0;
        const bm = b.langMismatch ? 1 : 0;
        if (am !== bm) return am - bm;
        // In a zh session, native-audited voices outrank the merely capable.
        if (sessionLang === 'zh') {
            const an = a.zhNative ? 1 : 0;
            const bn = b.zhNative ? 1 : 0;
            if (an !== bn) return bn - an;
        }
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
    /** List un-downloaded Piper voices instead of collapsing them behind the
     *  "Show Piper voices" line. Set internally when that line is clicked. */
    showLockedPiper?: boolean;
    /** Session pickers (setup + in-session): hide voices that can't speak the
     *  session language, plus not-yet-downloaded Piper voices, behind one
     *  "Show all voices" line - dimming alone wasn't a clear enough signal.
     *  Settings omits this and shows the full catalog. */
    hideIncompatible?: boolean;
    /** Internal: the "Show all voices" line was clicked. */
    showAll?: boolean;
}

/** Render the modal list: recommended voices in their own section, the rest
 *  grouped by tier. */
export function renderVoiceList(
    listEl: HTMLElement,
    voices: readonly ScoredVoice[],
    selectedName: string | null,
    options: RenderListOptions = {}
): void {
    listEl.innerHTML = '';

    if (voices.length === 0) {
        listEl.innerHTML =
            `<div class="voice-tier-label">${t('No text-to-speech voices available')}</div>`;
        return;
    }

    // A pickerful of not-yet-downloaded Piper rows is noise for anyone who
    // hasn't opted into local voices: until a first model is installed, they
    // collapse behind a single "Show Piper voices" line.
    const lockedPiper = new Set(
        voices.filter((v) => v.engine === 'piper' && v.needsDownload && !v.downloaded)
    );
    const collapsePiper =
        !options.hideIncompatible &&
        !options.showLockedPiper &&
        lockedPiper.size > 0 &&
        !voices.some((v) => v.engine === 'piper' && v.downloaded);

    // Session pickers hide language-incompatible voices and locked Piper
    // voices behind one "Show all voices" line (the model picker's expander
    // pattern). The current selection always stays visible, even incompatible -
    // hiding what's selected would misreport the session.
    const hidden = new Set<ScoredVoice>();
    if (options.hideIncompatible && !options.showAll) {
        for (const v of voices) {
            if (v.name === selectedName) continue;
            if (v.langMismatch || lockedPiper.has(v)) hidden.add(v);
        }
    }

    const recommended: ScoredVoice[] = [];
    const tiers: Record<number, ScoredVoice[]> = {};
    for (const v of voices) {
        if (collapsePiper && lockedPiper.has(v)) continue;
        if (hidden.has(v)) continue;
        if (v.recommended) {
            recommended.push(v);
        } else {
            (tiers[v.score] ??= []).push(v);
        }
    }

    if (recommended.length > 0) {
        appendTierLabel(listEl, t('Best'));
        for (const v of recommended) appendRow(listEl, v, selectedName, options);
    }

    for (const tier of [4, 3, 2, 1, 0] as const) {
        const items = tiers[tier];
        if (!items || items.length === 0) continue;
        appendTierLabel(listEl, t(TIER_LABELS[tier] ?? 'Other'));
        for (const v of items) appendRow(listEl, v, selectedName, options);
    }

    if (collapsePiper) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'voice-more-piper';
        more.textContent = t('More options: show {n} Piper voices (local, free download)', { n: lockedPiper.size });
        more.onclick = () =>
            renderVoiceList(listEl, voices, selectedName, { ...options, showLockedPiper: true });
        listEl.appendChild(more);
    }

    if (options.hideIncompatible && (hidden.size > 0 || options.showAll)) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'voice-more-piper';
        toggle.textContent = options.showAll ? t('Show fewer voices ▲') : t('Show all voices ▼');
        toggle.onclick = () =>
            renderVoiceList(listEl, voices, selectedName, { ...options, showAll: !options.showAll });
        listEl.appendChild(toggle);
    }

    // Show the "☁️ per hour" legend in the header only when a paid hosted voice
    // is actually listed, so a local-only picker stays clean.
    const legend = listEl.closest('.voice-modal')?.querySelector('.voice-modal-legend');
    if (legend) {
        legend.classList.toggle('hidden', !voices.some((v) => rateBadge(v.creditsPerHour)));
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
    if (entry.langMismatch) row.classList.add('voice-row-lang-mismatch');
    if (entry.name === selectedName) row.classList.add('selected');
    row.dataset['voiceName'] = entry.name;
    // Speakers sharing a model file share data-model, so an in-flight download
    // can disable all their Download buttons at once.
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
    // Hosted-voice rate badge: "N☁️" ≈ N credits/hr, colored by tier (green
    // value, amber premium) so a pricier voice reads pricier at a glance
    // (meditation-pal-b7i).
    const rateText = rateBadge(entry.creditsPerHour);
    if (rateText) {
        const cost = document.createElement('span');
        cost.className = entry.costTier
            ? `voice-row-cost voice-row-cost-${entry.costTier}`
            : 'voice-row-cost';
        cost.innerHTML = withCloudOutline(rateText);
        const tierWord =
            entry.costTier === 'premium' ? t('Premium') : entry.costTier === 'value' ? t('Value') : t('Cloud');
        cost.title = t(
            '{tier} voice · est. ≈ {rate} credits/hour at a concise (exploration) pace (noting mode uses fewer)',
            { tier: tierWord, rate: entry.creditsPerHour!.toFixed(1) }
        );
        nameSpan.appendChild(cost);
    }
    if (options.showEngine && (entry.displayEngine ?? entry.engine)) {
        const eng = entry.displayEngine ?? entry.engine!;
        const badge = document.createElement('span');
        badge.className = 'voice-row-engine';
        badge.textContent = eng === 'browser' ? t('Browser') : (ENGINE_LABELS[eng] ?? eng);
        nameSpan.appendChild(badge);
    }
    if (entry.langMismatch) {
        // No badge (session pickers hide these behind "Show all voices", so a
        // per-row tag was noise); the dimmed style plus this tooltip carry it.
        row.title = t('This voice may not speak the session language well');
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
                unBtn.textContent = t('Uninstall');
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
            dlBtn.textContent = t('Download');
            dlBtn.dataset['voiceName'] = entry.name;
            dlBtn.dataset['engine'] = entry.engine ?? '';
            row.appendChild(dlBtn);
        }
    }

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'voice-row-preview';
    previewBtn.textContent = t('Preview');
    previewBtn.dataset['voiceName'] = entry.name;
    if (entry.needsDownload && !entry.downloaded) {
        previewBtn.classList.add('preview-unavailable');
        previewBtn.title = t('Download this voice first to preview it');
    }
    row.appendChild(previewBtn);

    parent.appendChild(row);
}

/** Update the checkmark/selected state without re-rendering the list. */
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
 * Speak the preview phrase through the right engine for a voice. `voiceName` is
 * the raw name, not the prefixed id SessionSetup stores; `engine` forces a
 * backend when the same name exists across several.
 *
 * Rejects on a real failure (not signed in, out of credits, server unreachable,
 * autoplay blocked) so the caller can say WHY a preview was silent - swallowing
 * these hid hosted-voice problems, especially on mobile. Cancelling one preview
 * by starting another resolves quietly.
 */
export async function previewVoice(
    voiceName: string,
    rate?: number,
    engine?: string
): Promise<void> {
    stopPreview();
    try {
        let ttsEngine: TtsEngine;
        if (engine === 'aloud') {
            // Hosted voices preview through the PUBLIC, free endpoint - no
            // sign-in, no credits. Selecting one for a real session still goes
            // through the authed, metered path.
            ttsEngine = createCloudAloudPreviewTts(voiceName);
        } else {
            // Prefixed id for createTtsForVoice; assume server unless the engine
            // is explicitly 'browser'.
            const id = engine === 'browser' ? `browser:${voiceName}` : `server:${voiceName}`;
            ({ engine: ttsEngine } = await createTtsForVoice(id));
        }
        activePreviewEngine = ttsEngine;
        const text =
            voiceName === 'Zarvox' ? 'Come. On. Fahoogwuhgods.' : t(PREVIEW_PHRASE);
        await ttsEngine.speak(text, rate !== undefined ? { rate } : undefined);
    } finally {
        if (activePreviewEngine) {
            // Engines handle double-cancel safely.
            void activePreviewEngine.cancel();
            activePreviewEngine = null;
        }
    }
}

/**
 * A previewVoice() rejection as a short user-facing line, shared so all three
 * pickers (setup / settings / in-session) report the same way. Matches on error
 * name/message rather than importing the cloud error classes, which keeps this
 * free of cloud-auth coupling and node-testable.
 */
export function previewErrorMessage(err: unknown): string {
    const name = err instanceof Error ? err.name : '';
    const msg = err instanceof Error ? err.message : String(err);
    if (name === 'CloudSignInRequiredError') {
        return t('Sign in to aloud cloud (in Settings) to preview these voices.');
    }
    // The iOS/mobile autoplay gate: the fetch consumes the tap's user-gesture
    // window, so the play that follows is blocked with NotAllowedError.
    if (name === 'NotAllowedError') {
        return t('Tap preview again to play this voice (your browser blocked the first play).');
    }
    if (/\b401\b/.test(msg)) return t('aloud cloud needs you to sign in again (in Settings).');
    if (/\b402\b/.test(msg) || /credit/i.test(msg)) {
        return t('aloud cloud voices need credits to preview. Add credits, or pick a free voice.');
    }
    if (/\b403\b/.test(msg)) return t('Verify your email to use aloud cloud voices.');
    // A speechSynthesis voice that couldn't render, most often a Microsoft
    // "Online (Natural)" voice, which needs a live connection.
    if (/^speechSynthesis /.test(msg)) {
        return t("That browser voice wouldn't play - the “Online” / “Natural” voices need a connection and aren't always available. Try another voice, or aloud cloud.");
    }
    return t("Couldn't play that voice preview. Check your connection and try again.");
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
    /** Speed slider - omit to hide the footer. */
    speedSliderId?: string;
    speedLabelId?: string;
    /** Initial slider value (wpm). */
    speedValue?: number;
}

/**
 * Gray the modal's speed footer while a fixed-pace voice is selected (styled
 * Azure voices: the rate knob no-ops server-side, so an active slider would
 * lie). Call on modal open and again on every selection change; `wpm` restores
 * the readout when the pick moves back to an adjustable voice.
 */
export function voiceHasFixedPace(
    voiceName: string | null,
    list: readonly ScoredVoice[]
): boolean {
    return Boolean(voiceName && list.find((v) => v.name === voiceName)?.fixedPace);
}

/** The pace half of a voice label: "160 wpm", or "fixed speed" when the voice's
 *  rate is set server-side. Every surface that pairs a voice with its wpm goes
 *  through this so none of them promise a speed the server won't apply. */
export function voiceRateLabel(
    voiceName: string | null,
    list: readonly ScoredVoice[],
    wpm: number
): string {
    return voiceHasFixedPace(voiceName, list) ? t('fixed speed') : t('{rate} wpm', { rate: wpm });
}

export function syncSpeedControlForVoice(
    slider: HTMLInputElement,
    label: HTMLElement,
    voiceName: string | null,
    list: readonly ScoredVoice[],
    wpm: number
): void {
    const fixed = voiceHasFixedPace(voiceName, list);
    slider.disabled = fixed;
    slider.closest('.voice-modal-footer')?.classList.toggle('voice-modal-footer-fixed', fixed);
    label.textContent = voiceRateLabel(voiceName, list, wpm);
}

export function renderVoiceModalHTML(cfg: VoiceModalConfig): string {
    const title = cfg.title ?? t('Choose Voice');
    const speedValue = cfg.speedValue ?? 110;
    const footer = cfg.speedSliderId
        ? `
        <div class="voice-modal-footer">
            <label class="voice-modal-speed-label" for="${cfg.speedSliderId}">${t('Speed')}</label>
            <input type="range" id="${cfg.speedSliderId}" class="slider-stops" min="60" max="240"
                value="${speedValue}" step="10">
            <span class="voice-modal-speed-value" id="${cfg.speedLabelId ?? ''}">${t('{wpm} wpm', { wpm: speedValue })}</span>
        </div>`
        : '';
    return `
    <div class="voice-modal-overlay hidden" id="${cfg.modalId}">
        <div class="voice-modal">
            <div class="voice-modal-header">
                <span class="voice-modal-titlewrap">
                    <span class="voice-modal-title">${title}</span>
                    <span class="voice-modal-legend hidden" title="${t(RATE_LEGEND_TITLE)}">${withCloudOutline(t(RATE_LEGEND))}</span>
                </span>
                <button type="button" class="voice-modal-close" id="${cfg.closeId}">&times;</button>
            </div>
            <div class="voice-modal-list" id="${cfg.listId}"></div>${footer}
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// /app/v1/voices loader
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
        // The app backend isn't reachable - we'll fall back to browser voices only.
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
 * Consumes the desktop Rust server's NDJSON stream so callers stay
 * backend-agnostic; resolves once the model is on disk, rejects on an error line
 * or transport failure.
 *
 * Multi-speaker voices share one model file, so after this resolves a re-fetch
 * of /app/v1/voices reports `downloaded:true` for every speaker of that model.
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
            // "done"/"already_downloaded" need no action - the loop ends when
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
 * Disable (or re-enable) the Download buttons of every row sharing `model`,
 * while one speaker of a multi-speaker model downloads, so the user can't kick
 * off the same 100 MB fetch from a sibling. `exceptBtn` (the clicked button,
 * showing live percent) is left alone.
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
 * Cumulative download percent (0–100). `completed` spans all files while `total`
 * is only the current file's size, so `completed` exceeds `total` once we roll
 * onto the tiny `.onnx.json`; taking the larger keeps the bar monotonic and
 * pinned near 100% for that last hop.
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
 * Fetch the curated hosted voices. Caches [] when the server is unreachable or
 * has no TTS key, so the picker only surfaces hosted voices that can actually
 * speak (availability-driven menus).
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
