/**
 * Sign in with Apple JS wrapper (meditation-pal-s75) — the browser half of Apple
 * sign-in, mirroring google-signin.ts. Loads Apple's script on demand, runs the
 * popup flow, and hands the returned identity token to the server (`appleSignIn`
 * in cloud-auth.ts), which verifies it against Apple's JWKS and mints our session.
 *
 * Gated on a runtime/build Services ID (`appleClientId()` —
 * `isAppleSignInConfigured()`): with none, the entry points no-op so a build
 * without Apple configured simply doesn't show the button.
 *
 * Apple validates the redirectURI against the Services ID's registered Return
 * URLs even in popup mode, so it must match exactly what you configure in the
 * Apple Developer portal (see dev-docs/deploy.md). We use this build's origin +
 * base path.
 */

import { appleClientId, appleSignIn, type AuthResponse } from './cloud-auth.js';

const APPLE_JS_SRC =
    'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

// --- Minimal Sign in with Apple JS typings (only what we call) --------------

interface AppleAuthorization {
    id_token?: string;
    code?: string;
    state?: string;
}
interface AppleSignInResponse {
    authorization?: AppleAuthorization;
}
interface AppleAuthApi {
    init(config: {
        clientId: string;
        scope?: string;
        redirectURI: string;
        usePopup?: boolean;
    }): void;
    signIn(): Promise<AppleSignInResponse>;
}
type AppleWindow = typeof window & { AppleID?: { auth: AppleAuthApi } };

export interface AppleSignInHandlers {
    onSignedIn: (auth: AuthResponse) => void;
    onError?: (err: Error) => void;
}

let scriptPromise: Promise<AppleAuthApi> | null = null;

function loadAppleJs(): Promise<AppleAuthApi> {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise<AppleAuthApi>((resolve, reject) => {
        const existing = (window as AppleWindow).AppleID?.auth;
        if (existing) return resolve(existing);
        const script = document.createElement('script');
        script.src = APPLE_JS_SRC;
        script.async = true;
        script.defer = true;
        script.onload = () => {
            const auth = (window as AppleWindow).AppleID?.auth;
            if (auth) resolve(auth);
            else reject(new Error('Sign in with Apple loaded but is unavailable'));
        };
        script.onerror = () => reject(new Error('Failed to load Sign in with Apple'));
        document.head.appendChild(script);
    });
    return scriptPromise;
}

/** The Return URL Apple validates against — this build's origin + base path. */
function redirectURI(): string {
    const base = import.meta.env.BASE_URL ?? '/';
    return `${window.location.origin}${base}`;
}

/**
 * Render an "Continue with Apple" button into `container`. No-op (returns false)
 * when no Services ID is configured, so callers can decide whether to show it.
 */
export async function renderAppleSignInButton(
    container: HTMLElement,
    handlers: AppleSignInHandlers
): Promise<boolean> {
    const clientId = appleClientId();
    if (!clientId) return false;
    let auth: AppleAuthApi;
    try {
        auth = await loadAppleJs();
        auth.init({ clientId, scope: 'name email', redirectURI: redirectURI(), usePopup: true });
    } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        return false;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'apple-signin-button';
    btn.innerHTML = `<span aria-hidden="true"></span>Continue with Apple`;
    btn.addEventListener('click', () => {
        btn.disabled = true;
        auth
            .signIn()
            .then((res) => {
                const idToken = res.authorization?.id_token;
                if (!idToken) throw new Error('Apple sign-in returned no identity token');
                return appleSignIn(idToken);
            })
            .then(handlers.onSignedIn)
            .catch((err: unknown) => {
                btn.disabled = false;
                // Apple throws a popup_closed_by_user-style error on cancel; only
                // surface real failures.
                const e = err instanceof Error ? err : new Error(String(err));
                if (!/popup_closed|cancel/i.test(e.message)) handlers.onError?.(e);
            });
    });
    container.appendChild(btn);
    return true;
}
