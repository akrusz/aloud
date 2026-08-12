/**
 * Sign-in modal: the just-in-time gate (and a Settings affordance) for hosted
 * sign-in (meditation-pal-rfb / s75). Offers every configured method over a
 * dimmed overlay: Google, Apple, and an email/password form.
 *
 * Free credits come from a TRUSTED identity (Google/Apple); an email signup gets
 * an account but no credits until it connects one (meditation-pal-116), which
 * the copy says. Reuses the `.voice-modal-*` classes.
 */

import { renderGoogleSignInButton, renderDesktopGoogleSignInButton } from './google-signin.js';
import { renderAppleSignInButton } from './apple-signin.js';
import {
    renderNativeGoogleSignInButton,
    renderNativeAppleSignInButton,
} from './native-signin.js';
import { isDesktopSync, isCapacitor } from './is-desktop.js';
import { checkAndShowGifts } from './gift-modal.js';
import {
    emailLogin,
    emailSignup,
    isAppleSignInConfigured,
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
 * Resolves true after a successful sign-in, by which point the session token is
 * cached. Resolves false on dismiss (close, overlay click, Escape) and when a
 * second call finds one already open.
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
                    <label class="checkbox-label signin-updates-optin hidden" id="signin-updates-row">
                        <input type="checkbox" id="signin-email-updates">
                        <span>Email me occasional updates about aloud (we'll never share or sell your address)</span>
                    </label>
                    <button type="submit" class="btn btn-primary signin-email-submit" id="signin-email-submit">
                        Sign in
                    </button>
                    <button type="button" class="signin-email-toggle" id="signin-email-toggle">
                        New here? Create an account
                    </button>
                </form>
                <div class="provider-hint signin-modal-error hidden" id="signin-modal-error"></div>
                <p class="provider-hint signin-oauth-hint hidden" id="signin-oauth-hint"></p>
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
            overlay.querySelector('#signin-oauth-hint')?.classList.add('hidden');
            overlay.querySelector('#signin-modal-error')?.classList.add('hidden');
        };
        const onSignedIn = (auth: AuthResponse): void => {
            options.onSignedIn?.(auth);
            close(true);
            // They may have clouds waiting to be accepted.
            void checkAndShowGifts();
        };

        overlay.querySelector('#signin-modal-close')?.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
        document.addEventListener('keydown', onKey);

        // The GIS / Apple JS popups can't run in the Tauri webview: its
        // custom-scheme origin isn't a valid OAuth JavaScript origin. So desktop
        // swaps Google for a loopback PKCE flow (system browser to 127.0.0.1,
        // meditation-pal-fae) and hides Apple, whose native flow isn't wired
        // yet. On web each button removes its host when unconfigured. Email
        // works everywhere.
        const oauth = overlay.querySelector<HTMLElement>('#signin-oauth')!;
        const googleHost = overlay.querySelector<HTMLElement>('#signin-google-button')!;
        const appleHost = overlay.querySelector<HTMLElement>('#signin-apple-button')!;
        // Drop the OAuth block and its "or" divider once we know nothing
        // rendered, else a lone "or" dangles above the form.
        const dropEmptyOauth = (): void => {
            if (oauth.childElementCount === 0) {
                oauth.remove();
                overlay.querySelector('.signin-divider')?.remove();
            }
        };
        if (isCapacitor()) {
            // Native mobile: the capacitor:// (or https://localhost) origin
            // isn't a valid OAuth JavaScript origin, so use the native
            // account-picker flows (native-signin.ts). Each renderer returns
            // false when its provider isn't configured, dropping its button and
            // leaving email to carry the modal.
            void renderNativeGoogleSignInButton(googleHost, {
                onSignedIn,
                onError: (e) => showError(e.message),
            }).then((ok) => {
                if (!ok) googleHost.remove();
                dropEmptyOauth();
            });
            void renderNativeAppleSignInButton(appleHost, {
                onSignedIn,
                onError: (e) => showError(e.message),
            }).then((ok) => {
                if (!ok) appleHost.remove();
                dropEmptyOauth();
            });
        } else if (isDesktopSync()) {
            appleHost.remove(); // desktop Apple OAuth not wired yet (meditation-pal-fae)
            const ok = renderDesktopGoogleSignInButton(googleHost, {
                onSignedIn,
                onError: (e) => showError(e.message),
            });
            if (!ok) googleHost.remove();
            dropEmptyOauth();
            // Apple sign-in works on web but not in the desktop app: Apple
            // forbids the loopback redirect the Google flow uses. Point an
            // Apple-only user at a path that works today. Shown only when Apple
            // is configured upstream, so it reads as "coming soon" rather than a
            // feature that doesn't exist. (meditation-pal-fae)
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
    const updatesRow = overlay.querySelector<HTMLElement>('#signin-updates-row')!;
    const updatesEl = overlay.querySelector<HTMLInputElement>('#signin-email-updates')!;
    let mode: 'login' | 'signup' = 'login';

    toggle.addEventListener('click', () => {
        mode = mode === 'login' ? 'signup' : 'login';
        submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
        toggle.textContent =
            mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in';
        passEl.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
        // The updates opt-in only makes sense when creating an account; an
        // existing account manages it from the Account page.
        updatesRow.classList.toggle('hidden', mode !== 'signup');
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
        const action =
            mode === 'login'
                ? emailLogin(email, password)
                : emailSignup(email, password, updatesEl.checked);
        action
            .then(cb.onSignedIn)
            .catch((err: unknown) => {
                submit.disabled = false;
                cb.showError(err instanceof Error ? err.message : String(err));
                showOauthHint(overlay);
            });
    });
}

/**
 * Shown only after an email attempt has already failed. An account created
 * through Google or Apple holds no password, so "incorrect email or password"
 * is true but unhelpful and "an account with this email already exists" is a
 * dead end - the pair reads as a lockout (a beta tester hit exactly that).
 *
 * Purely navigational: it points at the buttons that DID render and never
 * suggests making a password, since federated sign-in is the better default
 * for most people. It also keys off nothing but the fact that an attempt
 * failed, so it can't become the account-enumeration oracle that the server's
 * deliberately generic message exists to avoid.
 */
function showOauthHint(overlay: HTMLElement): void {
    const el = overlay.querySelector<HTMLElement>('#signin-oauth-hint');
    if (!el) return;
    const names: string[] = [];
    if (overlay.querySelector('#signin-google-button')) names.push('Google');
    if (overlay.querySelector('#signin-apple-button')) names.push('Apple');
    if (names.length === 0) return; // email is the only way in; nothing to point at
    el.textContent = `Signed up with ${names.join(' or ')}? Use the ${
        names.length > 1 ? 'buttons' : 'button'
    } above.`;
    el.classList.remove('hidden');
}

function escapeHtml(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
