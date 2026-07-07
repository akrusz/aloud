/**
 * Native mobile sign-in (Capacitor) — Google + Apple via
 * @capgo/capacitor-social-login (meditation-pal-tpj4).
 *
 * The web GIS button and Apple JS SDK can't run from the app's capacitor://
 * origin (not a valid OAuth JavaScript origin), so inside the native app we
 * use the plugin's native account-picker flows instead. Both providers hand
 * back an OpenID Connect ID token, which we pass straight into the SAME server
 * calls the web/desktop flows use — googleSignIn(idToken) / appleSignIn(idToken)
 * (cloud-auth.ts) — so there's no new server surface; the server just has to
 * accept the native client IDs as token audiences.
 *
 * Config (build-time, inlined by Vite; see vite-env.d.ts):
 *   - VITE_GOOGLE_IOS_CLIENT_ID  — the iOS OAuth client id (Google Cloud).
 *   - VITE_GOOGLE_CLIENT_ID      — the existing web client id, reused as the
 *                                  plugin's webClientId (Android/token audience).
 *   - VITE_APPLE_CLIENT_ID       — the existing Apple Services ID.
 *   - VITE_APPLE_REDIRECT_URL    — optional; only Android's Apple flow needs it
 *                                  (iOS ignores it). Absent → iOS-only Apple.
 *
 * Everything here is a no-op off Capacitor: the render functions return false
 * when not in the native app or when the provider isn't configured, so callers
 * (sign-in-modal.ts) drop the button and fall back to email. The plugin is
 * lazy-imported so web/desktop bundles don't pull it in.
 *
 * App Store note: Guideline 4.8 requires that if the iOS app offers Google
 * sign-in it ALSO offers Apple — so configure both for the iOS store build.
 */

import type { SignInHandlers } from './google-signin.js';
import { googleClientId, appleClientId, googleSignIn, appleSignIn } from './cloud-auth.js';
import { isCapacitor, capacitorPlatform } from './is-desktop.js';

function googleIosClientId(): string {
    return import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID ?? '';
}
function appleNativeRedirectUrl(): string {
    return import.meta.env.VITE_APPLE_REDIRECT_URL ?? '';
}

/**
 * Native Google is available when we're in the app and have the client id the
 * platform's flow needs: iOS uses its own iOS OAuth client id; Android uses the
 * web client id. Missing that id → no button (email carries the modal).
 */
export function isNativeGoogleConfigured(): boolean {
    if (!isCapacitor()) return false;
    return capacitorPlatform() === 'ios' ? googleIosClientId() !== '' : googleClientId() !== '';
}
/**
 * Native Apple is available:
 *   - iOS  → ALWAYS. Sign in with Apple is a first-party system capability keyed
 *            to the app's bundle id; it needs no Services ID (that's the web /
 *            Android redirect flow). The server verifies the native token's
 *            `aud` = bundle id (APPLE_CLIENT_IDS must include it). The app must
 *            carry the Sign in with Apple entitlement (App.entitlements).
 *   - Android → only when a Services ID + redirect URL are configured (the
 *            web-style flow); unset for the beta, so Apple is iOS-only there.
 */
export function isNativeAppleConfigured(): boolean {
    if (!isCapacitor()) return false;
    if (capacitorPlatform() === 'ios') return true;
    return appleClientId() !== '' && appleNativeRedirectUrl() !== '';
}

// Lazy plugin load + one-time initialize(). Memoized: the first render/login
// triggers it, later callers await the same promise.
type SocialLogin = typeof import('@capgo/capacitor-social-login').SocialLogin;
let initPromise: Promise<SocialLogin> | null = null;
function ensureInit(): Promise<SocialLogin> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const { SocialLogin } = await import('@capgo/capacitor-social-login');
        const options: Parameters<SocialLogin['initialize']>[0] = {};
        // exactOptionalPropertyTypes: build each config with only the keys we
        // actually have — never assign `undefined` to an optional field.
        if (googleIosClientId() || googleClientId()) {
            options.google = {
                mode: 'online',
                ...(googleIosClientId() ? { iOSClientId: googleIosClientId() } : {}),
                ...(googleClientId() ? { webClientId: googleClientId() } : {}),
            };
        }
        // Enable the Apple provider whenever it's usable here: on iOS always
        // (system flow off the bundle id — clientId optional), on Android only
        // when the Services ID + redirect are set. On iOS with no Services ID
        // that's an empty apple config, which is valid and turns the provider on.
        if (isNativeAppleConfigured()) {
            options.apple = {
                ...(appleClientId() ? { clientId: appleClientId() } : {}),
                ...(appleNativeRedirectUrl() ? { redirectUrl: appleNativeRedirectUrl() } : {}),
            };
        }
        await SocialLogin.initialize(options);
        return SocialLogin;
    })();
    return initPromise;
}

function makeButton(label: string, extraClass: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-secondary ${extraClass}`;
    btn.textContent = label;
    return btn;
}

/** Render a native "Continue with Google" button. Returns false (render nothing)
 *  when not applicable, so the caller drops the host element. */
export async function renderNativeGoogleSignInButton(
    container: HTMLElement,
    handlers: SignInHandlers
): Promise<boolean> {
    if (!isNativeGoogleConfigured()) return false;
    const btn = makeButton('Continue with Google', 'signin-google-native-btn');
    btn.addEventListener('click', () => void runNativeGoogle(btn, handlers));
    container.appendChild(btn);
    return true;
}

async function runNativeGoogle(btn: HTMLButtonElement, handlers: SignInHandlers): Promise<void> {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
        const SocialLogin = await ensureInit();
        const { result } = await SocialLogin.login({
            provider: 'google',
            options: { scopes: ['email', 'profile'] },
        });
        // Online mode returns idToken; the offline branch (serverAuthCode) is
        // never hit since we initialize with mode:'online'.
        const idToken = 'idToken' in result ? result.idToken : null;
        if (!idToken) throw new Error('Google sign-in did not return an ID token.');
        handlers.onSignedIn(await googleSignIn(idToken));
    } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

/** Render a native "Continue with Apple" button. Returns false when not
 *  applicable. Pair with Google on iOS (App Store Guideline 4.8). */
export async function renderNativeAppleSignInButton(
    container: HTMLElement,
    handlers: SignInHandlers
): Promise<boolean> {
    if (!isNativeAppleConfigured()) return false;
    const btn = makeButton('Continue with Apple', 'signin-apple-native-btn');
    btn.addEventListener('click', () => void runNativeApple(btn, handlers));
    container.appendChild(btn);
    return true;
}

async function runNativeApple(btn: HTMLButtonElement, handlers: SignInHandlers): Promise<void> {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
        const SocialLogin = await ensureInit();
        const { result } = await SocialLogin.login({
            provider: 'apple',
            options: { scopes: ['email', 'name'] },
        });
        if (!result.idToken) throw new Error('Apple sign-in did not return an identity token.');
        handlers.onSignedIn(await appleSignIn(result.idToken));
    } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}
