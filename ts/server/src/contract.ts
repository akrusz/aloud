/**
 * The wire contract between the aloud client (ts/ui, Capacitor) and aloud cloud.
 * This is the ENTIRE coupling surface between the two; everything else here is
 * server-private. Keep it small and stable.
 *
 * The client half lives in ts/ui/src/adapters/ (cloud-llm.ts, cloud-tts.ts).
 * Mirrored by hand for now (the surface is small enough); a shared
 * @aloud/contract package is the natural home if the workspace ever splits.
 *
 * Tickets: meditation-pal-vd3 (this server), meditation-pal-8sj (credits),
 * meditation-pal-rfb (auth), meditation-pal-2yb (quota).
 */

import type { Message } from '@aloud/core/llm';

/** Providers aloud cloud will forward to. The web tier's ONLY LLM source is this
 *  server; on-device and bring-your-own-key live in the app-store / desktop
 *  builds and never touch this contract. */
export type ProviderId = 'anthropic' | 'groq' | 'openrouter' | 'google' | 'openai';

/** Channel a credit purchase flowed through. Drives the commission lookup; see
 *  pricing/commission.ts and the meditation-pal-8sj addendum. `x402` is the
 *  on-chain USDC channel (meditation-pal-du9): pay-per-pack over x402 on Base,
 *  ~0 commission. */
export type PurchaseChannel = 'web_stripe' | 'iap_apple' | 'iap_google' | 'x402';

// ---- POST /cloud/v1/llm/complete --------------------------------------------------

export interface CompleteRequest {
    provider: ProviderId;
    /** Provider-native model id (e.g. "claude-sonnet-5"). Validated server-side
     *  against an allowlist, so a client can't bill a user for an arbitrary
     *  expensive model. */
    model: string;
    messages: Message[];
    system?: string;
    maxTokens?: number;
    /** When true, the response is an SSE stream of CompleteChunk events
     *  terminated by a final event carrying usage + cost. */
    stream?: boolean;
    /** Opaque client-generated id grouping one meditation session's metered
     *  calls, so the admin cost report attributes them exactly instead of
     *  inferring boundaries by time gaps. A random per-session token: no PII, no
     *  content, aggregate stats only. */
    sessionId?: string;
}

/** Non-streaming response, or the shape carried by the terminal SSE event. */
export interface CompleteResponse {
    text: string;
    finishReason: string | null;
    /** What this turn cost the user, in credits, already debited
     *  (meditation-pal-14s). */
    creditsCharged: number;
    /** Remaining balance after the debit, so the client can update the UI
     *  without a second round-trip. */
    creditsRemaining: number;
}

/** One SSE delta. `text` is the incremental delta only (matches core's
 *  StreamChunk). The final event has `done: true` and carries `result`. */
export interface CompleteChunk {
    text: string;
    done: boolean;
    result?: CompleteResponse;
}

// ---- POST /cloud/v1/stt -----------------------------------------------------------
// Request body is raw 16-bit-equivalent Float32 PCM (mono), with the sample rate
// in the `sample_rate` query param (plus an optional `session_id`, see
// CompleteRequest.sessionId). The server computes duration from the byte length
// (authoritative: the client can't under-report to underpay), wraps it to WAV,
// and forwards to the configured Whisper backend (gpt-4o-transcribe by default).

export interface TranscribeResponse {
    text: string;
    /** Fractional credits this transcription cost (priced by audio seconds). */
    creditsCharged: number;
    creditsRemaining: number;
}

// ---- POST /cloud/v1/tts -----------------------------------------------------------

/** Longest text a single /v1/tts call will synthesize. Both upstreams refuse
 *  well before this matters to a real facilitation turn (Google: 5000 input
 *  bytes, OpenAI: 4096 chars), so the cap turns a client bug into a clean 400
 *  instead of a charge-shaped provider error. */
export const MAX_TTS_CHARS = 4000;

export interface SpeakRequest {
    text: string;
    /** Provider voice id (e.g. a Google Cloud TTS voice name). Defaults
     *  server-side when omitted. */
    voice?: string;
    /** Speaking rate multiplier (1.0 = normal). */
    rate?: number;
    /** Opaque per-session grouping id (see CompleteRequest.sessionId). No PII or
     *  content. */
    sessionId?: string;
}

/** Audio is returned as the raw response body (audio/mpeg); cost rides in
 *  headers (X-Credits-Charged / X-Credits-Remaining) so the body stays a clean
 *  audio stream the client can hand straight to an <audio> element. */

/** GET /cloud/v1/voices, public. The curated hosted voices the server can speak
 *  (empty when TTS isn't configured). The client stores `name` and sends it back
 *  as the /cloud/v1/tts `voice`. */
export interface CloudVoice {
    name: string;
    gender: 'female' | 'male' | 'androgynous';
    /** Cost tier for the picker's indicator: 'premium' (priciest offered,
     *  Chirp3-HD) vs 'value' (a cheaper Google tier at ~half the cost). */
    tier: 'premium' | 'value';
    /** Estimated credits/hr at a typical talk profile, from the same pricing the
     *  meter bills with, so the picker can show a concrete "~N cr/hr". */
    creditsPerHourTypical: number;
    /** Speaks languages beyond English natively (CuratedVoice.multilingual);
     *  the picker dims voices without it in a non-English session. */
    multilingual?: boolean;
}

// ---- Auth & account ---------------------------------------------------------

/** POST /cloud/v1/auth/google: exchange a Google ID token for an aloud session. */
export interface GoogleAuthRequest {
    /** The ID token (JWT) from Google Sign-In on the client. */
    idToken: string;
}

/** POST /cloud/v1/auth/google/desktop: finish the desktop (Tauri) loopback PKCE
 *  flow. The app sends the code it caught on the loopback; the server holds the
 *  client secret and does the exchange, so no secret ships in the desktop
 *  binary. (meditation-pal-fae) */
export interface GoogleDesktopAuthRequest {
    /** Authorization code from the loopback redirect. */
    code: string;
    /** PKCE verifier paired with the challenge sent to the auth endpoint. */
    codeVerifier: string;
    /** The exact loopback redirect_uri used in the auth request (must match at
     *  the token endpoint). */
    redirectUri: string;
}

/** POST /cloud/v1/auth/apple: exchange a Sign in with Apple ID token. */
export interface AppleAuthRequest {
    /** The identity token (JWT) from Sign in with Apple on the client. */
    idToken: string;
}

/** POST /cloud/v1/auth/email/{signup,login}: local email/password sign-in. Email
 *  accounts get NO free credits until they connect Google/Apple
 *  (meditation-pal-116). */
export interface EmailAuthRequest {
    email: string;
    password: string;
    /** Signup only: the "email me occasional updates" checkbox. Opt-in, defaults
     *  false; ignored on login. */
    emailUpdates?: boolean;
}

/** POST /auth/email/set-password: add or change the password on the
 *  already-signed-in account (bearer required). The email is the account's own,
 *  so only the password travels. */
export interface SetPasswordRequest {
    password: string;
}

export interface AuthResponse {
    /** Bearer token for subsequent requests (our own short-lived JWT). */
    token: string;
    account: AccountView;
    /** True only on the request that created the account, so the client can show
     *  a "here are your free credits" welcome. */
    isNewAccount: boolean;
}

/** GET /cloud/v1/me: current account + balance. */
export interface AccountView {
    id: string;
    email: string;
    /** Whether a trusted provider marked the email verified. */
    emailVerified: boolean;
    creditsRemaining: number;
    /** Sign-in methods linked to this account, so the UI offers "connect
     *  Google/Apple to claim free credits" only when no trusted identity is
     *  linked yet (meditation-pal-116). Mirrors store.ts IdentityProvider. */
    providers: SignInProvider[];
    /** True when an active retreat pass (meditation-pal-414) covers this account:
     *  usage is free for the window. The UI drops the spend prompts and
     *  cloud-cost estimates these users shouldn't see. */
    retreatCovered: boolean;
    /** Opted in to occasional product-update emails. Never shared or sold;
     *  toggled via PATCH /cloud/v1/me. */
    emailUpdates: boolean;
}

/** PATCH /cloud/v1/me: update account preferences. */
export interface UpdateMeRequest {
    emailUpdates?: boolean;
}

/** Sign-in method linked to an account (mirrors store.ts IdentityProvider). */
export type SignInProvider = 'google' | 'apple' | 'email';

// ---- Billing ----------------------------------------------------------------

/** POST /cloud/v1/billing/checkout: start a credit purchase. Returns a URL the
 *  client opens (web: redirect; mobile: external link, per meditation-pal-czr). */
export interface CheckoutRequest {
    /** A preset pack id. Omit when buying a custom amount (see `credits`). */
    packId?: string;
    /** A custom credit quantity at the flat list rate, instead of a preset pack.
     *  Must be a whole number at or above the smallest preset. The server prices
     *  it; a client-sent price is never trusted. */
    credits?: number;
    channel: PurchaseChannel;
    /** ISO 3166-1 alpha-2; selects the commission rate (US vs EU differ). */
    jurisdiction?: string;
    /** App-relative path (must start with '/') to return to after checkout, e.g.
     *  '/app/' for the GitHub-Pages subpath build. The server appends
     *  `?purchase=success|cancel` and prefixes its own validated origin, so
     *  Stripe bounces the user back into the app instead of the marketing root.
     *  Ignored unless it's a clean relative path. */
    returnPath?: string;
    /** When set, this purchase is a GIFT to that email (meditation-pal-bd5): the
     *  payment clears immediately, but the clouds become a pending gift the
     *  recipient accepts on next sign-in (declined/unclaimed → held for the buyer
     *  to re-gift or claim). */
    giftToEmail?: string;
}

/** A pending gift addressed to the signed-in account (GET /cloud/v1/gifts). */
export interface GiftView {
    id: string;
    credits: number;
    /** Buyer's email, for "a gift from …". Omitted if unknown. */
    fromEmail?: string;
    createdAt: number;
}

/** A returned (bounced) gift the signed-in BUYER can re-gift or claim.
 *  GET /cloud/v1/gifts/returned; meditation-pal-bd5. */
export interface ReturnedGiftView {
    id: string;
    credits: number;
    /** Who it was last addressed to, for "your gift to … came back". */
    toEmail: string;
    createdAt: number;
}

/** Body for POST /cloud/v1/gifts/:id/regift: the new recipient. */
export interface RegiftRequest {
    email: string;
}

export interface CheckoutResponse {
    checkoutUrl: string;
}

// ---- Errors -----------------------------------------------------------------

export type ErrorCode =
    | 'unauthenticated'
    | 'email_unverified'
    | 'insufficient_credits'
    | 'quota_exceeded'
    | 'model_not_allowed'
    | 'provider_error'
    | 'bad_request'
    | 'internal';

export interface ApiError {
    error: {
        code: ErrorCode;
        message: string;
    };
}

export function apiError(code: ErrorCode, message: string): ApiError {
    return { error: { code, message } };
}

/** HTTP status per error code: single source of truth so routes stay consistent.
 *  `as const` keeps the values literal so Hono accepts them as
 *  ContentfulStatusCode. */
export const ERROR_STATUS = {
    unauthenticated: 401,
    email_unverified: 403,
    insufficient_credits: 402,
    quota_exceeded: 429,
    model_not_allowed: 400,
    provider_error: 502,
    bad_request: 400,
    internal: 500,
} as const satisfies Record<ErrorCode, number>;
