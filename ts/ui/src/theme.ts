/**
 * Theme management: light / dark / system preference. Manual overrides decay
 * after a few hours so the app trends back toward the system preference.
 *
 * Priority:
 *   1. localStorage 'themeMode' = 'dark' | 'light'         (sticky, no expiry)
 *   2. localStorage 'theme'      = { value, ts }            (4h expiry)
 *   3. prefers-color-scheme media query
 *   4. Time-of-day fallback (light 7am–7pm, dark otherwise)
 */

export type Theme = 'light' | 'dark';

const TOGGLE_TTL_MS = 4 * 60 * 60 * 1000;
const STICKY_KEY = 'themeMode';
const TOGGLE_KEY = 'theme';

interface ToggleRecord {
    value: Theme;
    ts: number;
}

function readToggle(): Theme | null {
    const sticky = localStorage.getItem(STICKY_KEY);
    if (sticky === 'dark' || sticky === 'light') return sticky;

    const raw = localStorage.getItem(TOGGLE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<ToggleRecord>;
        if (
            (parsed.value === 'dark' || parsed.value === 'light') &&
            typeof parsed.ts === 'number' &&
            Date.now() - parsed.ts < TOGGLE_TTL_MS
        ) {
            return parsed.value;
        }
    } catch {
        // Fall through.
    }
    localStorage.removeItem(TOGGLE_KEY);
    return null;
}

function systemPreference(): Theme | null {
    if (!window.matchMedia) return null;
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return null;
}

function timeOfDayFallback(): Theme {
    const hour = new Date().getHours();
    return hour >= 7 && hour < 19 ? 'light' : 'dark';
}

export function resolveTheme(): Theme {
    return readToggle() ?? systemPreference() ?? timeOfDayFallback();
}

export function applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
}

export function toggleTheme(): Theme {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next: Theme = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(TOGGLE_KEY, JSON.stringify({ value: next, ts: Date.now() } satisfies ToggleRecord));
    return next;
}

/**
 * One-time listener for OS color-scheme flips (including macOS "Auto" at
 * sunset). Leaves a sticky Settings choice or a fresh (≤4h) manual toggle
 * alone. Idempotent.
 *
 * Boot-time application lives in main.ts, pre-DOM to dodge FOUC; this is only
 * the live-update path.
 */
let systemThemeWatcherWired = false;
export function watchSystemTheme(onChange?: (theme: Theme) => void): void {
    if (systemThemeWatcherWired) return;
    systemThemeWatcherWired = true;
    if (!window.matchMedia) return;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        // Respect Settings ('themeMode') and any recent manual toggle (<4h).
        if (readToggle() !== null) return;
        const next: Theme = e.matches ? 'dark' : 'light';
        applyTheme(next);
        const btn = document.querySelector<HTMLElement>('[data-theme-toggle]');
        if (btn) updateThemeIcon(btn);
        onChange?.(next);
    });
}

// ---------------------------------------------------------------------------
// Toggle button
// ---------------------------------------------------------------------------

const SUN_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="5"/>' +
    '<line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>' +
    '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>' +
    '<line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>' +
    '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>' +
    '</svg>';

const MOON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' +
    '</svg>';

export function updateThemeIcon(btn: HTMLElement): void {
    const theme = document.documentElement.getAttribute('data-theme');
    // The icon shows what you'd switch TO: sun in dark mode, moon in light.
    btn.innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;
}

/** Click to flip, plus an 8-clicks-in-4s easter egg. Idempotent, so it's safe
 *  to call after each render. */
export function initThemeToggle(btn: HTMLElement): void {
    if ((btn as HTMLElement & { _aloudThemeWired?: boolean })._aloudThemeWired) return;
    (btn as HTMLElement & { _aloudThemeWired?: boolean })._aloudThemeWired = true;

    updateThemeIcon(btn);

    let themeClicks: number[] = [];
    btn.addEventListener('click', () => {
        toggleTheme();
        updateThemeIcon(btn);

        // Easter egg: 8 toggles in 4 seconds
        const now = Date.now();
        themeClicks.push(now);
        if (themeClicks.length >= 8 && now - themeClicks[themeClicks.length - 8]! < 4000) {
            themeClicks = [];
            const u = new SpeechSynthesisUtterance('the system... is down...');
            const savedVoiceName = localStorage.getItem('aloud-voice');
            if (savedVoiceName) {
                const voice = speechSynthesis.getVoices().find((v) => v.name === savedVoiceName);
                if (voice) u.voice = voice;
            }
            const savedSpeed = localStorage.getItem('aloud-speed');
            if (savedSpeed) {
                const parsed = parseInt(savedSpeed, 10);
                if (!Number.isNaN(parsed)) u.rate = parsed / 180;
            }
            speechSynthesis.speak(u);
        }
        if (themeClicks.length > 8) themeClicks = themeClicks.slice(-8);
    });
}
