/**
 * Transient toast: a fixed banner at the bottom that fades in, auto-dismisses,
 * and can be clicked to dismiss early. Styles are `.error-toast` in the base
 * stylesheet. Works anywhere in the app, so errors raised outside a live
 * session still get a surface.
 */

const TOAST_DURATION_MS = 5000;
const FADE_MS = 300;

/**
 * Inline `bottom` that clears any visible fixed bottom bar (settings/setup
 * footer, mobile bottom nav) - the CSS default (2rem) straddles them halfway.
 * Empty string when no bar is up, letting the stylesheet default apply.
 * Measured per show: bars differ per view and layout size, and a toast is too
 * short-lived to need resize tracking.
 */
function bottomClearingBars(): string {
    let barTop = Infinity;
    const bars = document.querySelectorAll<HTMLElement>(
        '.settings-footer, .setup-footer, .bottom-nav'
    );
    for (const el of bars) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.top < window.innerHeight) barTop = Math.min(barTop, r.top);
    }
    if (barTop === Infinity) return '';
    return `${Math.round(window.innerHeight - barTop) + 12}px`;
}

export function showErrorToast(message: string): void {
    showToast(message, 'error');
}


export function showSuccessToast(message: string): void {
    showToast(message, 'success');
}

// One shared element for the auto-save tick: rapid settings tweaks retrigger
// it (text swap + timer reset) instead of stacking banners, and it lives
// briefly - it's an acknowledgment, not an announcement.
const SAVED_TICK_MS = 1500;
let savedEl: HTMLDivElement | null = null;
let savedHideTimer: number | undefined;

/** Small transient "Saved!" acknowledgment for auto-applying forms. */
export function showSavedTick(message = 'Saved!'): void {
    if (typeof document === 'undefined') return;
    if (!savedEl || !savedEl.isConnected) {
        savedEl = document.createElement('div');
        savedEl.className = 'error-toast toast-success';
        savedEl.setAttribute('role', 'status');
        savedEl.addEventListener('click', () => hideSavedTick());
        document.body.appendChild(savedEl);
    }
    savedEl.textContent = message;
    savedEl.style.bottom = bottomClearingBars();
    void savedEl.offsetHeight;
    savedEl.classList.add('visible');
    clearTimeout(savedHideTimer);
    savedHideTimer = window.setTimeout(hideSavedTick, SAVED_TICK_MS);
}

function hideSavedTick(): void {
    clearTimeout(savedHideTimer);
    if (!savedEl) return;
    const el = savedEl;
    savedEl = null;
    el.classList.remove('visible');
    setTimeout(() => el.remove(), FADE_MS);
}

function showToast(message: string, variant: 'error' | 'success'): void {
    if (typeof document === 'undefined') return;
    const toast = document.createElement('div');
    toast.className = variant === 'success' ? 'error-toast toast-success' : 'error-toast';
    toast.setAttribute('role', variant === 'success' ? 'status' : 'alert');
    toast.textContent = message;
    toast.style.bottom = bottomClearingBars();
    document.body.appendChild(toast);

    let removed = false;
    const remove = (): void => {
        if (removed) return;
        removed = true;
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), FADE_MS);
    };

    // Force a reflow so the opacity transition runs on the class add.
    void toast.offsetHeight;
    toast.classList.add('visible');
    toast.addEventListener('click', remove);
    setTimeout(remove, TOAST_DURATION_MS);
}
