/**
 * Login view — password gate for hosted/multi-user deploys.
 *
 * The form posts to `/login`. When the TS UI is served behind a backend
 * that handles that route this view's form submits through it. When
 * served standalone (Vite dev, Capacitor, etc.) auth is a no-op and
 * this view shouldn't get mounted in the first place — that gating
 * decision is for whoever wires the router.
 */

export interface LoginViewHandle {
    show(error?: string | null): void;
    hide(): void;
}

export function mountLoginView(root: HTMLElement): LoginViewHandle {
    function render(error: string | null): void {
        const errorHtml = error
            ? `<div class="provider-hint">${escapeHtml(error)}</div>`
            : '';
        root.innerHTML = `
        <div class="setup-container" style="max-width: 360px;">
            <div class="setup-header">
                <h1>Welcome</h1>
                <p class="setup-subtitle">Enter the password to continue.</p>
            </div>
            <form method="post" action="/login" class="setup-form">
                ${errorHtml}
                <div class="form-group">
                    <input type="password" name="password" placeholder="Password" autofocus>
                </div>
                <button type="submit" class="btn btn-primary btn-begin">Log In</button>
            </form>
        </div>`;
    }

    return {
        show(error: string | null = null) {
            render(error ?? null);
        },
        hide() {
            root.innerHTML = '';
        },
    };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}
