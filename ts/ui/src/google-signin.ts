/**
 * Google Identity Services (GIS) wrapper, the browser half of hosted sign-in
 * (meditation-pal-rfb). Loads Google's script on demand, renders the official
 * button, and hands the ID token to the server (`googleSignIn` in cloud-auth.ts)
 * to verify and mint our session.
 *
 * Gated on a client id (`isGoogleSignInConfigured()`): with none, the entry
 * points no-op so a dev build falls back to local dev sign-in. Nothing runs at
 * import time; GIS only loads when a sign-in surface mounts.
 *
 * The slice of the GIS API we use is declared locally below rather than
 * depending on `@types/google.accounts`.
 *
 * Mounted by sign-in-modal.ts: `renderGoogleSignInButton` on web,
 * `renderDesktopGoogleSignInButton` (loopback PKCE) under the Tauri shell.
 */

import {
    googleClientId,
    googleDesktopClientId,
    googleSignIn,
    desktopGoogleSignIn,
    type AuthResponse,
} from './cloud-auth.js';
import { appUrl } from './app-base.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

// --- Minimal GIS typings (only what we call) --------------------------------

interface CredentialResponse {
    /** The Google ID token (a JWT). Absent if the user dismissed the flow. */
    credential?: string;
}

interface IdConfiguration {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
}

interface GsiButtonConfiguration {
    type?: 'standard' | 'icon';
    theme?: 'outline' | 'filled_blue' | 'filled_black';
    size?: 'small' | 'medium' | 'large';
    text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
    shape?: 'rectangular' | 'pill' | 'circle' | 'square';
    logo_alignment?: 'left' | 'center';
    /** Fixed button width in px (max 400). Pinning it makes GIS render at this
     *  width from the start instead of briefly filling the container, which
     *  reads as a "full-width then snaps narrow" flash. */
    width?: number;
}

interface GoogleAccountsId {
    initialize(config: IdConfiguration): void;
    renderButton(parent: HTMLElement, options: GsiButtonConfiguration): void;
    prompt(): void;
    disableAutoSelect(): void;
}

type GisWindow = typeof window & {
    google?: { accounts: { id: GoogleAccountsId } };
};

export interface SignInHandlers {
    /** Called with the new session + account after a successful sign-in. */
    onSignedIn: (auth: AuthResponse) => void;
    /** Called if GIS fails to load or the server rejects the token. */
    onError?: (err: Error) => void;
}

let scriptPromise: Promise<GoogleAccountsId> | null = null;

/** Inject the GIS script once and resolve with `google.accounts.id`. Memoized,
 *  so repeated callers share one load. Rejects when the script can't load
 *  (offline, blocked); callers should fall back gracefully. */
function loadGis(): Promise<GoogleAccountsId> {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise<GoogleAccountsId>((resolve, reject) => {
        const existing = (window as GisWindow).google?.accounts?.id;
        if (existing) return resolve(existing);

        const script = document.createElement('script');
        script.src = GIS_SRC;
        script.async = true;
        script.defer = true;
        script.onload = () => {
            const id = (window as GisWindow).google?.accounts?.id;
            if (id) resolve(id);
            else reject(new Error('Google Identity Services loaded but is unavailable'));
        };
        script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
        document.head.appendChild(script);
    });
    return scriptPromise;
}

/** The GIS callback: trade the ID token for a session, then notify the caller.
 *  Shared by the button and One Tap. */
function makeCallback(handlers: SignInHandlers): (r: CredentialResponse) => void {
    return (response) => {
        if (!response.credential) {
            handlers.onError?.(new Error('Google sign-in returned no credential'));
            return;
        }
        googleSignIn(response.credential)
            .then(handlers.onSignedIn)
            .catch((err: unknown) =>
                handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
            );
    };
}

/**
 * Render the official Google button into `container`. Returns false without
 * rendering when no client id is configured, so callers can show a dev-sign-in
 * affordance instead.
 */
export async function renderGoogleSignInButton(
    container: HTMLElement,
    handlers: SignInHandlers,
    button: GsiButtonConfiguration = {
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        width: 240,
    }
): Promise<boolean> {
    const clientId = googleClientId();
    if (!clientId) return false;
    try {
        const id = await loadGis();
        id.initialize({ client_id: clientId, callback: makeCallback(handlers) });
        id.renderButton(container, button);
        return true;
    } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        return false;
    }
}

/**
 * Google One Tap (a non-modal prompt), an optional companion to the button.
 * Returns false when unconfigured or it couldn't start.
 */
export async function promptGoogleOneTap(handlers: SignInHandlers): Promise<boolean> {
    const clientId = googleClientId();
    if (!clientId) return false;
    try {
        const id = await loadGis();
        id.initialize({
            client_id: clientId,
            callback: makeCallback(handlers),
            cancel_on_tap_outside: false,
        });
        id.prompt();
        return true;
    } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        return false;
    }
}

/**
 * Desktop (Tauri) Google sign-in. The GIS button can't run in the webview's
 * custom-scheme origin, so a plain button drives the loopback PKCE flow: POST to
 * the embedded server (`/app/v1/google-oauth`), which opens the system browser
 * and catches the redirect on 127.0.0.1, then finish at the hosted
 * `/cloud/v1/auth/google/desktop`. Returns false when no desktop client id is
 * configured, and the caller removes the host. (meditation-pal-fae)
 */
export function renderDesktopGoogleSignInButton(
    container: HTMLElement,
    handlers: SignInHandlers
): boolean {
    if (!googleDesktopClientId()) return false;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary signin-google-desktop-btn';
    btn.textContent = 'Continue with Google';
    btn.addEventListener('click', () => void runDesktopGoogleSignIn(btn, handlers));
    container.appendChild(btn);
    return true;
}

async function runDesktopGoogleSignIn(
    btn: HTMLButtonElement,
    handlers: SignInHandlers
): Promise<void> {
    const clientId = googleDesktopClientId();
    if (!clientId) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Waiting for your browser…';
    try {
        // The embedded server runs the browser dance and returns the code,
        // blocking until the user finishes or it times out.
        const res = await fetch(appUrl('/google-oauth'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ client_id: clientId }),
        });
        if (!res.ok) {
            const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
            throw new Error(msg || `Google sign-in failed (${res.status}).`);
        }
        const out = (await res.json()) as {
            code: string;
            codeVerifier: string;
            redirectUri: string;
        };
        handlers.onSignedIn(await desktopGoogleSignIn(out));
    } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}
