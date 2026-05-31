/**
 * Sign-in modal — the just-in-time gate (and a Settings affordance) for hosted
 * sign-in (meditation-pal-rfb). Renders the official Google button
 * (google-signin.ts) over a dimmed overlay; resolves true once the user signs
 * in and we hold a session token, false if they dismiss it.
 *
 * Reuses the `.voice-modal-*` classes for visual consistency with the app's
 * other modals, and appends to <body> so it floats above whatever view is
 * mounted (the just-in-time gate fires from the setup view before a session
 * mounts).
 */

import { renderGoogleSignInButton } from './google-signin.js';
import type { AuthResponse } from './server-auth.js';

const OVERLAY_ID = 'signin-modal-overlay';

export interface SignInModalOptions {
    /** Headline. Defaults to the session-gating prompt. */
    title?: string;
    /** Sub-line under the headline. Defaults to the free-credits pitch. */
    subtitle?: string;
    /** Notified with the account after a successful sign-in (e.g. so a Settings
     *  balance can refresh). The modal also resolves true. */
    onSignedIn?: (auth: AuthResponse) => void;
}

const DEFAULT_TITLE = 'Sign in to start';
const DEFAULT_SUBTITLE =
    'New accounts get free credits to try aloud. Google is used only to sign you in.';

/**
 * Show the sign-in modal. Resolves true after a successful sign-in (the session
 * token is cached by then), false if the user cancels / dismisses (close button,
 * overlay click, or Escape). A second call while one is already open is a no-op
 * that resolves false.
 */
export function showSignInModal(options: SignInModalOptions = {}): Promise<boolean> {
    if (document.getElementById(OVERLAY_ID)) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'voice-modal-overlay';
        overlay.innerHTML = `
            <div class="voice-modal signin-modal" role="dialog" aria-modal="true" aria-label="Sign in">
                <div class="voice-modal-header">
                    <span class="voice-modal-title">${escapeHtml(options.title ?? DEFAULT_TITLE)}</span>
                    <button type="button" class="voice-modal-close" id="signin-modal-close" aria-label="Close">&times;</button>
                </div>
                <p class="provider-hint signin-modal-subtitle">${escapeHtml(options.subtitle ?? DEFAULT_SUBTITLE)}</p>
                <div class="signin-modal-button" id="signin-modal-button"></div>
                <div class="provider-hint signin-modal-error hidden" id="signin-modal-error"></div>
            </div>`;
        document.body.appendChild(overlay);

        let settled = false;
        const close = (result: boolean): void => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(result);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') close(false);
        };
        const showError = (msg: string): void => {
            const el = overlay.querySelector<HTMLElement>('#signin-modal-error');
            if (!el) return;
            el.textContent = msg;
            el.classList.remove('hidden');
        };

        overlay.querySelector('#signin-modal-close')?.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
        document.addEventListener('keydown', onKey);

        const host = overlay.querySelector<HTMLElement>('#signin-modal-button')!;
        void renderGoogleSignInButton(host, {
            onSignedIn: (auth) => {
                options.onSignedIn?.(auth);
                close(true);
            },
            onError: (err) => showError(err.message),
        }).then((rendered) => {
            if (!rendered) showError('Google sign-in is unavailable in this build.');
        });
    });
}

function escapeHtml(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
