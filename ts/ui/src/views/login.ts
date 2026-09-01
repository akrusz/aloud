/**
 * Login view - password gate for hosted/multi-user deploys. The form posts to
 * `/login`, handled by the backing server. Served standalone (Vite dev,
 * Capacitor) there is no such route; the router is responsible for not
 * mounting this view.
 */

import { t } from '../i18n.js';

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
                <h1>${t('Welcome')}</h1>
                <p class="setup-subtitle">${t('Enter the password to continue.')}</p>
            </div>
            <form method="post" action="/login" class="setup-form">
                ${errorHtml}
                <div class="form-group">
                    <input type="password" name="password" placeholder="${t('Password')}" autofocus>
                </div>
                <button type="submit" class="btn btn-primary btn-begin">${t('Log In')}</button>
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
