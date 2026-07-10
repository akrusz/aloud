/**
 * POST /v1/auth/google — exchange a Google ID token for an aloud session. On the
 * first sign-in with a Google identity it creates an account (or, when the
 * request carries a session token, links Google to that existing account — the
 * "connect to claim free credits" flow) and grants free credits per the rules in
 * auth/identity.ts + quota/freetier.ts (meditation-pal-116).
 *
 * POST /v1/auth/dev — local-only shortcut that mints a session for a fixed dev
 * account without Google, so the browser UI can exercise the metered proxy
 * end-to-end. 404s unless ALOUD_ENABLE_DEV_AUTH is set (explicit opt-in, set in
 * the local .env) — a dev convenience, never on by default.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { ERROR_STATUS, apiError } from '../contract.js';
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
import { ipRateLimit } from '../auth/middleware.js';
import { RateGuard } from '../quota/freetier.js';
import { verifySessionToken } from '../auth/session.js';
import { connectIdentity, issueAuthResponse, setAccountPassword, IdentityConflictError, EmailInUseError } from '../auth/identity.js';
import { normalizeEmail } from '../auth/email-key.js';
import { log } from '../logger.js';

/** Loose email shape check — enough to reject obvious garbage; real validity is
 *  proven later if/when the address is used. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

/** The account id from a (valid) bearer token on the request, if any — used to
 *  link a freshly-verified identity to the already-signed-in account. */
async function callerAccountId(c: Context, deps: Deps): Promise<string | undefined> {
    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    const [scheme, token] = (header ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
    const claims = await verifySessionToken(token, deps.config.sessionSecret);
    return claims?.accountId;
}

/** Shared tail for federated (Google/Apple) sign-in once an identity is verified:
 *  connect/create the account (linking to the caller's account when a bearer
 *  token is present), grant credits per the rules, and issue a session. */
async function finishFederatedSignIn(
    c: Context,
    deps: Deps,
    provider: 'google' | 'apple',
    identity: { sub: string; email: string; emailVerified: boolean }
): Promise<Response> {
    // Client IP for velocity-based abuse detection (mass-account creation
    // clusters by IP/subnet). x-forwarded-for is set by Fly/Render; first hop.
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const signupIp = fwd || c.req.header('x-real-ip') || undefined;
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
            return c.json(apiError('bad_request', err.message), ERROR_STATUS.bad_request);
        }
        log.error(`${provider} connect failed`, { err: String(err) });
        return c.json(apiError('internal', 'could not complete sign-in'), ERROR_STATUS.internal);
    }
}

export function authRoutes(deps: Deps): Hono {
    const app = new Hono();

    // Email/password endpoints are the credential-guessing surface (federated
    // sign-in is rate-limited upstream by Google/Apple, and scrypt verification
    // burns real CPU per attempt) — cap attempts per IP. 10/min is generous for
    // a human mistyping a password and useless for an online brute force.
    const emailAuthGuard = new RateGuard(10, 60_000);
    app.use('/email/*', ipRateLimit(emailAuthGuard));

    app.post('/google', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<GoogleAuthRequest>;
        if (!body.idToken) {
            return c.json(apiError('bad_request', 'idToken required'), ERROR_STATUS.bad_request);
        }

        let identity;
        try {
            identity = await verifyGoogleIdToken(body.idToken, deps.config.googleClientIds);
        } catch (err) {
            log.warn('google verify failed', { err: String(err) });
            return c.json(apiError('unauthenticated', 'invalid Google sign-in'), ERROR_STATUS.unauthenticated);
        }
        return finishFederatedSignIn(c, deps, 'google', identity);
    });

    // Desktop (Tauri) loopback PKCE: the app caught an authorization code on its
    // 127.0.0.1 listener; redeem it here (the client secret stays server-side) and
    // finish exactly like /google. (meditation-pal-fae)
    app.post('/google/desktop', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<GoogleDesktopAuthRequest>;
        if (!body.code || !body.codeVerifier || !body.redirectUri) {
            return c.json(
                apiError('bad_request', 'code, codeVerifier, redirectUri required'),
                ERROR_STATUS.bad_request
            );
        }
        const { googleDesktopClientId, googleDesktopClientSecret } = deps.config;
        if (!googleDesktopClientId || !googleDesktopClientSecret) {
            return c.json(
                apiError('internal', 'desktop Google sign-in is not configured'),
                ERROR_STATUS.internal
            );
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
            return c.json(apiError('unauthenticated', 'invalid Google sign-in'), ERROR_STATUS.unauthenticated);
        }
        return finishFederatedSignIn(c, deps, 'google', identity);
    });

    app.post('/apple', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<AppleAuthRequest>;
        if (!body.idToken) {
            return c.json(apiError('bad_request', 'idToken required'), ERROR_STATUS.bad_request);
        }

        let identity;
        try {
            identity = await verifyAppleIdToken(body.idToken, deps.config.appleClientIds);
        } catch (err) {
            log.warn('apple verify failed', { err: String(err) });
            return c.json(apiError('unauthenticated', 'invalid Apple sign-in'), ERROR_STATUS.unauthenticated);
        }
        return finishFederatedSignIn(c, deps, 'apple', identity);
    });

    // Email/password. Signup creates an UNTRUSTED 'email' identity — an account
    // with NO free credits until it connects Google/Apple (meditation-pal-116).
    app.post('/email/signup', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<EmailAuthRequest>;
        const email = (body.email ?? '').trim().toLowerCase();
        const password = body.password ?? '';
        if (!EMAIL_RE.test(email)) {
            return c.json(apiError('bad_request', 'a valid email is required'), ERROR_STATUS.bad_request);
        }
        if (password.length < MIN_PASSWORD_LEN) {
            return c.json(
                apiError('bad_request', `password must be at least ${MIN_PASSWORD_LEN} characters`),
                ERROR_STATUS.bad_request
            );
        }
        // Canonical mailbox is the identity key, so j.o.h.n+x@gmail.com and
        // john@gmail.com are one password identity (sign-up once, log in with any
        // variant). Guard against BOTH a duplicate password identity and the
        // mailbox already owning an account via Google/Apple — an unverified
        // signup must never attach to (or shadow) a verified account.
        const canonicalSub = normalizeEmail(email);
        if (
            (await deps.store.getIdentity('email', canonicalSub)) ||
            (await deps.store.findLiveAccountByEmail(email))
        ) {
            return c.json(
                apiError('bad_request', 'an account with this email already exists — try signing in'),
                ERROR_STATUS.bad_request
            );
        }

        const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
        const signupIp = fwd || c.req.header('x-real-ip') || undefined;
        const linkToAccountId = await callerAccountId(c, deps);

        try {
            const result = await connectIdentity(
                deps,
                { provider: 'email', sub: canonicalSub, email, emailVerified: false },
                {
                    secretHash: await hashPassword(password),
                    ...(signupIp ? { signupIp } : {}),
                    ...(linkToAccountId ? { linkToAccountId } : {}),
                }
            );
            return c.json(await issueAuthResponse(deps, result.account, result.isNewAccount));
        } catch (err) {
            log.error('email signup failed', { err: String(err) });
            return c.json(apiError('internal', 'could not create the account'), ERROR_STATUS.internal);
        }
    });

    app.post('/email/login', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<EmailAuthRequest>;
        const email = (body.email ?? '').trim().toLowerCase();
        const password = body.password ?? '';
        // One generic message for both "no such email" and "wrong password" so
        // the endpoint doesn't confirm which emails are registered.
        const reject = () =>
            c.json(apiError('unauthenticated', 'incorrect email or password'), ERROR_STATUS.unauthenticated);

        // Match the canonical mailbox used at signup, so any dot/+tag variant of
        // the same address logs into the one password identity.
        const identity = await deps.store.getIdentity('email', normalizeEmail(email));
        if (!identity?.secretHash || !(await verifyPassword(password, identity.secretHash))) {
            return reject();
        }
        const account = await deps.store.getAccountById(identity.accountId);
        if (!account) return reject();
        return c.json(await issueAuthResponse(deps, account, false));
    });

    // Add (or change) a password on the already-signed-in account, so a
    // Google/Apple user can also sign in with email + password. Bearer-required:
    // only the account owner sets their own password, keyed on the account's own
    // verified email (never a client-supplied address), so it can't attach a
    // password to someone else's mailbox or mint free credits. Under the same
    // /email/* IP rate limit as signup/login.
    app.post('/email/set-password', async (c) => {
        const accountId = await callerAccountId(c, deps);
        if (!accountId) {
            return c.json(apiError('unauthenticated', 'sign in first'), ERROR_STATUS.unauthenticated);
        }
        const account = await deps.store.getAccountById(accountId);
        if (!account || account.deletedAt != null) {
            return c.json(apiError('unauthenticated', 'sign in first'), ERROR_STATUS.unauthenticated);
        }
        const body = (await c.req.json().catch(() => ({}))) as Partial<SetPasswordRequest>;
        const password = body.password ?? '';
        if (password.length < MIN_PASSWORD_LEN) {
            return c.json(
                apiError('bad_request', `password must be at least ${MIN_PASSWORD_LEN} characters`),
                ERROR_STATUS.bad_request
            );
        }
        try {
            await setAccountPassword(deps, account, await hashPassword(password));
            return c.json(await issueAuthResponse(deps, account, false));
        } catch (err) {
            if (err instanceof IdentityConflictError) {
                return c.json(apiError('bad_request', err.message), ERROR_STATUS.bad_request);
            }
            log.error('set-password failed', { err: String(err) });
            return c.json(apiError('internal', 'could not set the password'), ERROR_STATUS.internal);
        }
    });

    // Stable identity for the single local dev account. Reused across sign-ins
    // so the credit ledger and history persist for the duration of a server run.
    const DEV_GOOGLE_SUB = 'dev:local';

    app.post('/dev', async (c) => {
        // Explicit opt-in (ALOUD_ENABLE_DEV_AUTH) rather than "off when
        // ALOUD_ENV=production" — a deploy that forgets to set the env can't
        // ship a credential-free sign-in. Behave as if the route doesn't exist.
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
