/**
 * Sign-in modal — the just-in-time gate (and a Settings affordance) for hosted
 * sign-in (meditation-pal-rfb / s75). Offers every configured method over a
 * dimmed overlay: Google, Apple, and an email/password form (sign in / create
 * account). Resolves true once a session token is held, false on dismiss.
 *
 * Free credits come from a TRUSTED identity (Google/Apple); an email signup gets
 * an account but no credits until it connects one (meditation-pal-116) — the
 * copy says so. Reuses the `.voice-modal-*` classes for visual consistency.
 */

import { renderGoogleSignInButton } from './google-signin.js';
import { renderAppleSignInButton } from './apple-signin.js';
import { emailLogin, emailSignup, type AuthResponse } from './cloud-auth.js';

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

const DEFAULT_TITLE = 'Sign in to aloud cloud';
const DEFAULT_SUBTITLE =
    'Sign up for free. Connect Google or Apple and we\'ll give you free credits to try aloud cloud!';

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
                <div class="signin-oauth" id="signin-oauth">
                    <div class="signin-modal-button" id="signin-google-button"></div>
                    <div class="signin-modal-button" id="signin-apple-button"></div>
                </div>
                <div class="signin-divider"><span>or</span></div>
                <form class="signin-email-form" id="signin-email-form" novalidate>
                    <input type="email" id="signin-email" placeholder="you@example.com"
                        autocomplete="email" required class="signin-input" />
                    <input type="password" id="signin-password" placeholder="Password"
                        autocomplete="current-password" required class="signin-input" />
                    <button type="submit" class="btn btn-primary signin-email-submit" id="signin-email-submit">
                        Sign in
                    </button>
                    <button type="button" class="signin-email-toggle" id="signin-email-toggle">
                        New here? Create an account
                    </button>
                </form>
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
        const clearError = (): void => {
            overlay.querySelector('#signin-modal-error')?.classList.add('hidden');
        };
        const onSignedIn = (auth: AuthResponse): void => {
            options.onSignedIn?.(auth);
            close(true);
        };

        overlay.querySelector('#signin-modal-close')?.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
        document.addEventListener('keydown', onKey);

        // OAuth buttons — each no-ops (and removes its host) when unconfigured.
        const googleHost = overlay.querySelector<HTMLElement>('#signin-google-button')!;
        const appleHost = overlay.querySelector<HTMLElement>('#signin-apple-button')!;
        void renderGoogleSignInButton(googleHost, { onSignedIn, onError: (e) => showError(e.message) }).then(
            (ok) => {
                if (!ok) googleHost.remove();
            }
        );
        void renderAppleSignInButton(appleHost, { onSignedIn, onError: (e) => showError(e.message) }).then(
            (ok) => {
                if (!ok) appleHost.remove();
            }
        );

        // Email form — toggles between sign-in and create-account.
        wireEmailForm(overlay, { onSignedIn, showError, clearError });
    });
}

function wireEmailForm(
    overlay: HTMLElement,
    cb: { onSignedIn: (a: AuthResponse) => void; showError: (m: string) => void; clearError: () => void }
): void {
    const form = overlay.querySelector<HTMLFormElement>('#signin-email-form')!;
    const emailEl = overlay.querySelector<HTMLInputElement>('#signin-email')!;
    const passEl = overlay.querySelector<HTMLInputElement>('#signin-password')!;
    const submit = overlay.querySelector<HTMLButtonElement>('#signin-email-submit')!;
    const toggle = overlay.querySelector<HTMLButtonElement>('#signin-email-toggle')!;
    let mode: 'login' | 'signup' = 'login';

    toggle.addEventListener('click', () => {
        mode = mode === 'login' ? 'signup' : 'login';
        submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
        toggle.textContent =
            mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in';
        passEl.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
        cb.clearError();
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        cb.clearError();
        const email = emailEl.value.trim();
        const password = passEl.value;
        if (!email || !password) {
            cb.showError('Enter your email and password.');
            return;
        }
        submit.disabled = true;
        const action = mode === 'login' ? emailLogin(email, password) : emailSignup(email, password);
        action
            .then(cb.onSignedIn)
            .catch((err: unknown) => {
                submit.disabled = false;
                cb.showError(err instanceof Error ? err.message : String(err));
            });
    });
}

function escapeHtml(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
