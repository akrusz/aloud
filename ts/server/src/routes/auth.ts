/**
 * Sign-in routes, mounted at /cloud/v1/auth: Google (web + desktop PKCE), Apple,
 * and email/password. Each verifies a proof, then creates an account, or links
 * the identity to the caller's existing account when the request carries a
 * session token (the "connect to claim free credits" flow), granting credits per
 * auth/identity.ts + quota/freetier.ts (meditation-pal-116).
 *
 * POST /dev is a local-only shortcut minting a session for a fixed dev account,
 * so the browser UI can exercise the metered proxy end-to-end. 404s unless
 * ALOUD_ENABLE_DEV_AUTH is set: explicit opt-in, never on by default.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { apiError } from '../contract.js';
import type {
    AppleAuthRequest,
    AuthResponse,
    EmailAuthRequest,
    GoogleAuthRequest,
    GoogleDesktopAuthRequest,
    SetPasswordRequest,
} from '../contract.js';
import type { Deps } from '../deps.js';
import { verifyGoogleIdToken, exchangeGoogleCode } from '../auth/google.js';
import { verifyAppleIdToken } from '../auth/apple.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { bearer, forwardedIp, ipRateLimit } from '../auth/middleware.js';
import { RateGuard } from '../quota/freetier.js';
import { verifySessionToken } from '../auth/session.js';
import { connectIdentity, issueAuthResponse, setAccountPassword, IdentityConflictError, EmailInUseError } from '../auth/identity.js';
import { normalizeEmail } from '../auth/email-key.js';
import { log } from '../logger.js';
import { errorJson } from '../http.js';

/** Loose shape check, enough to reject obvious garbage; real validity is proven
 *  later if/when the address is used. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

/** Account id from a valid bearer token on the request, if any. Used to link a
 *  freshly-verified identity to the already-signed-in account. */
async function callerAccountId(c: Context, deps: Deps): Promise<string | undefined> {
    const token = bearer(c);
    if (!token) return undefined;
    const claims = await verifySessionToken(token, deps.config.sessionSecret);
    return claims?.accountId;
}

/** Shared tail for federated (Google/Apple) sign-in once an identity is verified:
 *  connect/create the account (linking to the caller's when a bearer token is
 *  present), grant credits per the rules, issue a session. */
async function finishFederatedSignIn(
    c: Context,
    deps: Deps,
    provider: 'google' | 'apple',
    identity: { sub: string; email: string; emailVerified: boolean }
): Promise<Response> {
    // Client IP for velocity-based abuse detection (mass-account creation
    // clusters by IP/subnet).
    const signupIp = forwardedIp(c);
    const linkToAccountId = await callerAccountId(c, deps);
    try {
        const result = await connectIdentity(
            deps,
            {
                provider,
                sub: identity.sub,
                email: identity.email,
                emailVerified: identity.emailVerified,
            },
            { ...(signupIp ? { signupIp } : {}), ...(linkToAccountId ? { linkToAccountId } : {}) }
        );
        return c.json(await issueAuthResponse(deps, result.account, result.isNewAccount));
    } catch (err) {
        if (err instanceof IdentityConflictError || err instanceof EmailInUseError) {
            return errorJson(c, 'bad_request', err.message);
        }
        log.error(`${provider} connect failed`, { err: String(err) });
        return errorJson(c, 'internal', 'could not complete sign-in');
    }
}

export function authRoutes(deps: Deps): Hono {
    const app = new Hono();

    // Email/password is the credential-guessing surface (federated sign-in is
    // rate-limited upstream by Google/Apple, and scrypt verification burns real
    // CPU per attempt), so cap attempts per IP. 10/min is generous for a human
    // mistyping a password and useless for an online brute force.
    const emailAuthGuard = new RateGuard(10, 60_000);
    app.use('/email/*', ipRateLimit(emailAuthGuard));

    app.post('/google', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<GoogleAuthRequest>;
        if (!body.idToken) return errorJson(c, 'bad_request', 'idToken required');

        let identity;
        try {
            identity = await verifyGoogleIdToken(body.idToken, deps.config.googleClientIds);
        } catch (err) {
            log.warn('google verify failed', { err: String(err) });
            return errorJson(c, 'unauthenticated', 'invalid Google sign-in');
        }
        return finishFederatedSignIn(c, deps, 'google', identity);
    });

    // Desktop (Tauri) loopback PKCE (meditation-pal-fae): the app caught an
    // authorization code on its 127.0.0.1 listener; redeem it here, where the
    // client secret stays server-side, then finish exactly like /google.
    app.post('/google/desktop', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<GoogleDesktopAuthRequest>;
        if (!body.code || !body.codeVerifier || !body.redirectUri) {
            return errorJson(c, 'bad_request', 'code, codeVerifier, redirectUri required');
        }
        const { googleDesktopClientId, googleDesktopClientSecret } = deps.config;
        if (!googleDesktopClientId || !googleDesktopClientSecret) {
            return errorJson(c, 'internal', 'desktop Google sign-in is not configured');
        }
        let identity;
        try {
            const idToken = await exchangeGoogleCode({
                code: body.code,
                codeVerifier: body.codeVerifier,
                redirectUri: body.redirectUri,
                clientId: googleDesktopClientId,
                clientSecret: googleDesktopClientSecret,
            });
            identity = await verifyGoogleIdToken(idToken, deps.config.googleClientIds);
        } catch (err) {
            log.warn('google desktop verify failed', { err: String(err) });
            return errorJson(c, 'unauthenticated', 'invalid Google sign-in');
        }
        return finishFederatedSignIn(c, deps, 'google', identity);
    });

    app.post('/apple', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<AppleAuthRequest>;
        if (!body.idToken) return errorJson(c, 'bad_request', 'idToken required');

        let identity;
        try {
            identity = await verifyAppleIdToken(body.idToken, deps.config.appleClientIds);
        } catch (err) {
            log.warn('apple verify failed', { err: String(err) });
            return errorJson(c, 'unauthenticated', 'invalid Apple sign-in');
        }
        return finishFederatedSignIn(c, deps, 'apple', identity);
    });

    // Signup creates an UNTRUSTED 'email' identity: an account with NO free
    // credits until it connects Google/Apple (meditation-pal-116).
    app.post('/email/signup', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<EmailAuthRequest>;
        const email = (body.email ?? '').trim().toLowerCase();
        const password = body.password ?? '';
        if (!EMAIL_RE.test(email)) return errorJson(c, 'bad_request', 'a valid email is required');
        if (password.length < MIN_PASSWORD_LEN) {
            return errorJson(c, 'bad_request', `password must be at least ${MIN_PASSWORD_LEN} characters`);
        }
        // The canonical mailbox is the identity key, so j.o.h.n+x@gmail.com and
        // john@gmail.com are one password identity (sign up once, log in with any
        // variant). Guard against BOTH a duplicate password identity and the
        // mailbox already owning an account via Google/Apple: an unverified signup
        // must never attach to, or shadow, a verified account.
        const canonicalSub = normalizeEmail(email);
        if (
            (await deps.store.getIdentity('email', canonicalSub)) ||
            (await deps.store.findLiveAccountByEmail(email))
        ) {
            return errorJson(c, 'bad_request', 'an account with this email already exists - try signing in');
        }

        const signupIp = forwardedIp(c);
        const linkToAccountId = await callerAccountId(c, deps);

        try {
            const result = await connectIdentity(
                deps,
                { provider: 'email', sub: canonicalSub, email, emailVerified: false },
                {
                    secretHash: await hashPassword(password),
                    ...(signupIp ? { signupIp } : {}),
                    ...(linkToAccountId ? { linkToAccountId } : {}),
                    ...(body.emailUpdates === true ? { emailUpdates: true } : {}),
                }
            );
            return c.json(await issueAuthResponse(deps, result.account, result.isNewAccount));
        } catch (err) {
            log.error('email signup failed', { err: String(err) });
            return errorJson(c, 'internal', 'could not create the account');
        }
    });

    app.post('/email/login', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<EmailAuthRequest>;
        const email = (body.email ?? '').trim().toLowerCase();
        const password = body.password ?? '';
        // One generic message for both "no such email" and "wrong password", so
        // the endpoint doesn't confirm which emails are registered.
        const reject = () => errorJson(c, 'unauthenticated', 'incorrect email or password');

        // Match the canonical mailbox used at signup, so any dot/+tag variant
        // logs into the one password identity.
        const identity = await deps.store.getIdentity('email', normalizeEmail(email));
        if (!identity?.secretHash || !(await verifyPassword(password, identity.secretHash))) {
            return reject();
        }
        const account = await deps.store.getAccountById(identity.accountId);
        if (!account) return reject();
        return c.json(await issueAuthResponse(deps, account, false));
    });

    // Add (or change) a password on the signed-in account, so a Google/Apple user
    // can also sign in with email + password. Bearer-required: only the owner
    // sets their own password, keyed on the account's own verified email (never a
    // client-supplied address), so it can't attach a password to someone else's
    // mailbox or mint free credits. Under the same /email/* IP rate limit.
    app.post('/email/set-password', async (c) => {
        const accountId = await callerAccountId(c, deps);
        if (!accountId) return errorJson(c, 'unauthenticated', 'sign in first');
        const account = await deps.store.getAccountById(accountId);
        if (!account || account.deletedAt != null) return errorJson(c, 'unauthenticated', 'sign in first');
        const body = (await c.req.json().catch(() => ({}))) as Partial<SetPasswordRequest>;
        const password = body.password ?? '';
        if (password.length < MIN_PASSWORD_LEN) {
            return errorJson(c, 'bad_request', `password must be at least ${MIN_PASSWORD_LEN} characters`);
        }
        try {
            await setAccountPassword(deps, account, await hashPassword(password));
            return c.json(await issueAuthResponse(deps, account, false));
        } catch (err) {
            if (err instanceof IdentityConflictError) return errorJson(c, 'bad_request', err.message);
            log.error('set-password failed', { err: String(err) });
            return errorJson(c, 'internal', 'could not set the password');
        }
    });

    // Stable identity for the single local dev account, reused across sign-ins so
    // the ledger and history persist for a server run.
    const DEV_GOOGLE_SUB = 'dev:local';

    app.post('/dev', async (c) => {
        // Explicit opt-in (ALOUD_ENABLE_DEV_AUTH) rather than "off when
        // ALOUD_ENV=production", so a deploy that forgets an env var can't ship a
        // credential-free sign-in. Behave as if the route doesn't exist.
        if (!deps.config.enableDevAuth) {
            return c.json(apiError('bad_request', 'dev sign-in is disabled'), 404);
        }

        const existing = await deps.store.getIdentity('google', DEV_GOOGLE_SUB);
        let response: AuthResponse;
        if (!existing) {
            // First call: mint the dev account + identity + grant via the shared path.
            const result = await connectIdentity(deps, {
                provider: 'google',
                sub: DEV_GOOGLE_SUB,
                email: 'dev@localhost',
                emailVerified: true,
            });
            response = await issueAuthResponse(deps, result.account, result.isNewAccount);
            log.info('dev sign-in', { accountId: result.account.id, isNewAccount: true });
        } else {
            const account = await deps.store.getAccountById(existing.accountId);
            if (!account) throw new Error('dev identity points at a missing account');
            // Keep local testing unblocked: refill the dev account when it runs dry.
            if ((await deps.ledger.balance(account.id)) <= 0) {
                await deps.ledger.grant(account.id, deps.config.freeSignupCredits, 'dev top-up');
            }
            response = await issueAuthResponse(deps, account, false);
            log.info('dev sign-in', { accountId: account.id, isNewAccount: false });
        }
        return c.json(response);
    });

    return app;
}
