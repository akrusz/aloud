/**
 * Transient toast: a fixed banner at the bottom that fades in, auto-dismisses,
 * and can be clicked to dismiss early. Styles are `.error-toast` in the base
 * stylesheet. Works anywhere in the app, so errors raised outside a live
 * session still get a surface.
 */

const TOAST_DURATION_MS = 5000;
const FADE_MS = 300;

export function showErrorToast(message: string): void {
    showToast(message, 'error');
}


export function showSuccessToast(message: string): void {
    showToast(message, 'success');
}

function showToast(message: string, variant: 'error' | 'success'): void {
    if (typeof document === 'undefined') return;
    const toast = document.createElement('div');
    toast.className = variant === 'success' ? 'error-toast toast-success' : 'error-toast';
    toast.setAttribute('role', variant === 'success' ? 'status' : 'alert');
    toast.textContent = message;
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
