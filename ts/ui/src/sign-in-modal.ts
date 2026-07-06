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

import { renderGoogleSignInButton, renderDesktopGoogleSignInButton } from './google-signin.js';
import { renderAppleSignInButton } from './apple-signin.js';
import { isDesktopSync, isCapacitor } from './is-desktop.js';
import { checkAndShowGifts } from './gift-modal.js';
import {
    emailLogin,
    emailSignup,
    isAppleSignInConfigured,
    isInteractiveSignInConfigured,
    type AuthResponse,
} from './cloud-auth.js';
import { manageModalFocus } from './modal-focus.js';

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
        // Focus into the dialog now, restore on close; Tab cycles inside.
        const releaseFocus = manageModalFocus(overlay);

        let settled = false;
        const close = (result: boolean): void => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey);
            releaseFocus();
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
            // A just-signed-in user may have clouds waiting to be accepted.
            void checkAndShowGifts();
        };

        overlay.querySelector('#signin-modal-close')?.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
        document.addEventListener('keydown', onKey);

        // Google/Apple web popups (GIS / Apple JS) can't run in the desktop
        // (Tauri) webview — its custom-scheme origin isn't a valid OAuth
        // JavaScript origin. So on desktop we swap Google for a native loopback
        // PKCE flow (system browser → 127.0.0.1, meditation-pal-fae) and still
        // hide Apple (its native flow isn't wired yet). On web/local each button
        // no-ops + removes its host when unconfigured. Email works everywhere.
        const oauth = overlay.querySelector<HTMLElement>('#signin-oauth')!;
        const googleHost = overlay.querySelector<HTMLElement>('#signin-google-button')!;
        const appleHost = overlay.querySelector<HTMLElement>('#signin-apple-button')!;
        // Drop the whole OAuth block + its "or" divider once we know nothing
        // rendered — otherwise a lone "or" dangles above the form.
        const dropEmptyOauth = (): void => {
            if (oauth.childElementCount === 0) {
                oauth.remove();
                overlay.querySelector('.signin-divider')?.remove();
            }
        };
        if (isCapacitor()) {
            // Native mobile app. The web GIS button and Apple JS both need a
            // real https OAuth JavaScript origin, which the capacitor:// (or
            // https://localhost) app origin isn't — so neither can render here.
            // Native Google/Apple sign-in (their own plugins + OAuth console
            // reconfig) isn't wired yet (meditation-pal-tpj4); until it is, drop
            // both OAuth buttons and lean on email, which is a plain fetch and
            // works from any origin. Show a "coming soon" note only when OAuth is
            // actually configured upstream, so it reads as pending rather than
            // as a missing feature.
            googleHost.remove();
            appleHost.remove();
            dropEmptyOauth();
            if (isInteractiveSignInConfigured()) {
                const note = document.createElement('p');
                note.className = 'provider-hint signin-apple-soon';
                note.textContent =
                    'Sign in with Google or Apple is coming soon in the app. For now, sign in with email below, or set a password on the web app and use it here.';
                overlay.querySelector('.signin-modal')?.appendChild(note);
            }
        } else if (isDesktopSync()) {
            appleHost.remove(); // desktop Apple OAuth not wired yet (meditation-pal-fae)
            const ok = renderDesktopGoogleSignInButton(googleHost, {
                onSignedIn,
                onError: (e) => showError(e.message),
            });
            if (!ok) googleHost.remove();
            dropEmptyOauth();
            // Apple sign-in works on web but not yet in the desktop app (Apple
            // forbids the loopback redirect the Google flow uses). Point an
            // Apple-only user at a path that works here today. Only shown when
            // Apple is actually configured upstream, so it reads as "coming soon"
            // rather than a feature that doesn't exist. (meditation-pal-fae)
            if (isAppleSignInConfigured()) {
                const note = document.createElement('p');
                note.className = 'provider-hint signin-apple-soon';
                note.textContent =
                    'Sign in with Apple is coming soon on desktop. For now, use Google above, or set a password on the web app and sign in with email.';
                overlay.querySelector('.signin-modal')?.appendChild(note);
            }
        } else {
            void renderGoogleSignInButton(googleHost, {
                onSignedIn,
                onError: (e) => showError(e.message),
            }).then((ok) => {
                if (!ok) googleHost.remove();
                dropEmptyOauth();
            });
            void renderAppleSignInButton(appleHost, {
                onSignedIn,
                onError: (e) => showError(e.message),
            }).then((ok) => {
                if (!ok) appleHost.remove();
                dropEmptyOauth();
            });
        }

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
