/**
 * Server config from environment. Secrets NEVER live in the repo: they come
 * from the process environment (a host-loaded .env, or Fly/Render secrets).
 * See .env.example for the full list.
 *
 * The config is logged at boot with secret values redacted (logger.ts), so
 * operators can confirm what's set without leaking keys.
 */

import type { ProviderId } from './contract.js';
import type { SttBackend } from './providers/stt.js';

export interface ProviderKeys {
    anthropic?: string;
    groq?: string;
    openrouter?: string;
    google?: string;
    /** OpenAI: the metered GPT flagship LLM (and, via fallback, TTS). */
    openai?: string;
}

/** Default OpenAI-compatible Whisper endpoints, by provider label. The backend
 *  is config-selected (resolveSttConfig) so a provider freezing signups or
 *  dropping its audio product is an env change, not a code change. OpenAI is
 *  the recommended default. */
const STT_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
    openai: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        // Not the cheaper -mini: a mis-heard word derails a facilitation turn.
        // gpt-transcribe is the exception - cheaper AND more accurate than the
        // gpt-4o-transcribe it replaced, so it's both the picker's only hosted
        // choice and this fallback (for a client that names no model at all).
        model: 'gpt-transcribe',
    },
    groq: {
        baseUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
        model: 'whisper-large-v3-turbo',
    },
};

/** Models a client may request per-call (POST /cloud/v1/stt?model=...) on top
 *  of the configured backend's default. gpt-4o-transcribe is no longer offered
 *  in the picker, but stays allowlisted (and priced, pricing/providers.ts
 *  STT_USD_PER_SECOND_BY_MODEL) so STT_MODEL can roll back to it without a
 *  deploy.
 *  Other backends accept only their configured model: the model keys billing,
 *  so an arbitrary client value could otherwise name a cheaper rate. */
export function sttModelChoices(backend: SttBackend): readonly string[] {
    if (backend.provider !== 'openai') return [backend.model];
    return [...new Set([backend.model, 'gpt-4o-transcribe', 'gpt-transcribe'])];
}

/**
 * Resolve the STT backend from env. Precedence:
 *   1. STT_API_KEY: explicit/custom backend (STT_BASE_URL + STT_MODEL +
 *      STT_PROVIDER label; defaults to the OpenAI host if base/model omitted).
 *   2. OPENAI_STT_API_KEY || OPENAI_API_KEY: the recommended backend, since the
 *      same key already powers the GPT LLM + OpenAI TTS. Defaults to
 *      gpt-transcribe.
 *   3. GROQ_API_KEY: legacy (cheap, but new paid signups are frozen).
 * Undefined when none is set; /cloud/v1/stt then reports not-configured and the
 * client falls back to browser SpeechRecognition.
 *
 * Because OpenAI reuses the LLM key, a deployment wanting a different STT
 * backend than its LLM must pin it via STT_API_KEY. (Fireworks was dropped once
 * it 401'd every /audio/transcriptions call; pin it via STT_API_KEY if it ever
 * returns.)
 */
export function resolveSttConfig(env: NodeJS.ProcessEnv): SttBackend | undefined {
    if (env['STT_API_KEY']) {
        const provider = env['STT_PROVIDER'] ?? 'custom';
        const fallback = STT_DEFAULTS[provider] ?? STT_DEFAULTS['openai']!;
        return {
            provider,
            apiKey: env['STT_API_KEY'],
            baseUrl: env['STT_BASE_URL'] ?? fallback.baseUrl,
            model: env['STT_MODEL'] ?? fallback.model,
        };
    }
    // OpenAI STT can ride the LLM key or split onto its own (mirrors TTS).
    const openaiSttKey = env['OPENAI_STT_API_KEY'] || env['OPENAI_API_KEY'];
    if (openaiSttKey) {
        return { provider: 'openai', apiKey: openaiSttKey, ...STT_DEFAULTS['openai']! };
    }
    if (env['GROQ_API_KEY']) {
        return { provider: 'groq', apiKey: env['GROQ_API_KEY'], ...STT_DEFAULTS['groq']! };
    }
    return undefined;
}

export interface Config {
    port: number;
    /** Allowed CORS origins for the browser client (the static ui/dist host). */
    corsOrigins: string[];

    /** Secret used to sign our own session JWTs. Required. */
    sessionSecret: string;
    /** Google OAuth client id(s) accepted as the `aud` of incoming ID tokens. */
    googleClientIds: string[];
    /** Sign in with Apple: the Services ID(s) accepted as the `aud` of incoming
     *  Apple ID tokens. Empty disables Apple sign-in (optional, not required in
     *  strict mode). meditation-pal-s75. */
    appleClientIds: string[];
    /** Desktop (Tauri) Google OAuth client for the loopback PKCE flow. The server
     *  does the code→token exchange so the secret never ships in the desktop
     *  binary; the resulting ID token is verified against googleClientIds like any
     *  other. Empty disables desktop Google sign-in. (meditation-pal-fae) */
    googleDesktopClientId: string;
    googleDesktopClientSecret: string;

    /** Provider API keys, server-held. The point: the client never sees these. */
    providerKeys: ProviderKeys;

    /** Server-side STT backend (OpenAI-compatible Whisper). Undefined when no STT
     *  key is configured; /cloud/v1/stt then reports not-configured and the
     *  client falls back to browser SpeechRecognition. */
    sttConfig?: SttBackend;

    /** Free credits granted to a new verified account. meditation-pal-2yb. */
    freeSignupCredits: number;

    /** Emergency brake: max free credits granted across ALL signups per rolling
     *  hour. A mass-signup attack can't drain more than this; legit bursts stay
     *  well under it. When tripped, new signups get 0 free credits (they can
     *  still buy) and it's logged. Default is generous (~100 signups/hr). */
    freeGrantBudgetPerHour: number;

    /** Soft-launch switch (operator-tunable via admin panel): when true, metered
     *  endpoints (LLM/STT/TTS) refuse with `service_paused`, so signed-up users
     *  keep their granted credits but can't spend yet. `testerEmails` bypass it
     *  so the operator can keep testing. */
    meteredPaused: boolean;

    /** Emails exempt from `meteredPaused` (the operator's own test accounts).
     *  Case-insensitive match on the account email. */
    testerEmails: string[];

    /** Google Cloud Text-to-Speech key (separate from the Gemini LLM key). When
     *  set, /cloud/v1/tts can synthesize Google (Chirp3-HD/Neural2) voices. */
    googleTtsApiKey?: string;

    /** OpenAI key for gpt-4o-mini-tts (separate from any OpenAI STT key). Either
     *  this or googleTtsApiKey enables hosted TTS; each provider's voices appear
     *  only when its key is present. */
    openaiTtsApiKey?: string;

    /** Stripe, optional; billing routes report "not configured" without it. */
    stripeSecretKey?: string;
    stripeWebhookSecret?: string;

    /** x402 (meditation-pal-du9): USDC credit-pack purchases on Base. The buy
     *  route reports "not configured" unless `x402Enabled` is on AND
     *  `x402PayToAddress` is set (a Base address we hold keys to, kept separate
     *  from the personal tip-jar address). CDP facilitator keys are needed only
     *  for mainnet settlement; Base Sepolia uses the keyless testnet
     *  facilitator. */
    x402Enabled?: boolean;
    x402PayToAddress?: string;
    x402Network?: 'base' | 'base-sepolia';
    cdpApiKeyId?: string;
    cdpApiKeySecret?: string;

    /** Bearer token for the /cloud/v1/admin/* endpoints. When unset (and
     *  adminEmails is empty), those endpoints are disabled (404), never open. */
    adminToken?: string;

    /** Emails (lowercased) whose signed-in sessions get admin access, so the
     *  operator can sign in with Google on a phone instead of carrying the static
     *  token. The stored credential is then a 7-day session JWT, not the root
     *  token; remove the email to revoke. Verified emails only (enforced at the
     *  route), so an unverified email-signup squatting on an admin address can't
     *  pass. */
    adminEmails: string[];

    /** When true, refuse to start unless every prod-critical secret is set.
     *  Off in dev so the server boots with an in-memory store and stubs. */
    strict: boolean;

    /** Explicit opt-in for POST /cloud/v1/auth/dev (the local sign-in shortcut
     *  that mints a session without Google). Enabled ONLY when
     *  ALOUD_ENABLE_DEV_AUTH is truthy: opt-in rather than "off in production",
     *  so a deploy that forgets ALOUD_ENV can't ship a credential-free sign-in
     *  by default. Set in .env for local dev. */
    enableDevAuth: boolean;

    /** Path to the durable SQLite credit-ledger file (e.g. a mounted volume:
     *  /data/aloud.db). When set, buildDeps uses SqliteCreditsStore so balances
     *  survive restarts; unset falls back to the in-memory store. REQUIRED in
     *  production (strict): an in-memory ledger would silently drop real
     *  balances on every deploy/restart. */
    dbPath?: string;

    /** Optional directory of the built UI (`ui/dist`). When set, this process
     *  serves the static UI alongside the API (the self-host story). Unset in
     *  the canonical deploy, where the UI is on a static host (e.g. GitHub
     *  Pages) and this box is API-only. */
    uiDir?: string;
}

function list(v: string | undefined): string[] {
    return (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Is an opt-in env flag set? Accepts the common truthy spellings so
 *  `ALOUD_ENABLE_DEV_AUTH=true` doesn't silently read as off. */
function truthy(v: string | undefined): boolean {
    const s = (v ?? '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    // Normalized so `Production` or a stray trailing space still means strict:
    // failing CLOSED on a sloppy value is the safe direction for this flag.
    const strict = (env['ALOUD_ENV'] ?? '').trim().toLowerCase() === 'production';

    const providerKeys: ProviderKeys = {};
    if (env['ANTHROPIC_API_KEY']) providerKeys.anthropic = env['ANTHROPIC_API_KEY'];
    if (env['GROQ_API_KEY']) providerKeys.groq = env['GROQ_API_KEY'];
    if (env['OPENROUTER_API_KEY']) providerKeys.openrouter = env['OPENROUTER_API_KEY'];
    // Gemini direct (AI Studio key): value tier without the OpenRouter fee.
    if (env['GEMINI_API_KEY']) providerKeys.google = env['GEMINI_API_KEY'];
    // OpenAI direct: the metered GPT flagship. The same key also backs OpenAI
    // TTS below (one key with "Model capabilities: Write" covers both).
    if (env['OPENAI_API_KEY']) providerKeys.openai = env['OPENAI_API_KEY'];

    const config: Config = {
        port: Number(env['PORT'] ?? 8787),
        corsOrigins: list(env['ALOUD_CORS_ORIGINS']) || [],
        sessionSecret: env['ALOUD_SESSION_SECRET'] ?? (strict ? '' : 'dev-insecure-secret'),
        googleClientIds: list(env['GOOGLE_CLIENT_IDS']),
        appleClientIds: list(env['APPLE_CLIENT_IDS']),
        googleDesktopClientId: env['GOOGLE_DESKTOP_CLIENT_ID'] ?? '',
        googleDesktopClientSecret: env['GOOGLE_DESKTOP_CLIENT_SECRET'] ?? '',
        providerKeys,
        freeSignupCredits: Number(env['ALOUD_FREE_SIGNUP_CREDITS'] ?? 20),
        freeGrantBudgetPerHour: Number(env['ALOUD_FREE_GRANT_BUDGET_PER_HOUR'] ?? 2000),
        meteredPaused: env['ALOUD_METERED_PAUSED'] === '1',
        testerEmails: list(env['ALOUD_TESTER_EMAILS']).map((e) => e.toLowerCase()),
        adminEmails: list(env['ALOUD_ADMIN_EMAILS']).map((e) => e.toLowerCase()),
        strict,
        enableDevAuth: truthy(env['ALOUD_ENABLE_DEV_AUTH']),
    };
    const sttConfig = resolveSttConfig(env);
    if (sttConfig) config.sttConfig = sttConfig;
    if (env['GOOGLE_TTS_API_KEY']) config.googleTtsApiKey = env['GOOGLE_TTS_API_KEY'];
    // TTS reuses the OpenAI LLM key by default; set OPENAI_TTS_API_KEY only to
    // split them. `||`, not `??`: a present-but-blank OPENAI_TTS_API_KEY= line
    // (the .env template) is the empty STRING, which `??` would NOT fall through.
    // `||` treats blank as absent and uses the LLM key.
    const openaiTtsKey = env['OPENAI_TTS_API_KEY'] || env['OPENAI_API_KEY'];
    if (openaiTtsKey) config.openaiTtsApiKey = openaiTtsKey;
    if (env['STRIPE_SECRET_KEY']) config.stripeSecretKey = env['STRIPE_SECRET_KEY'];
    if (env['STRIPE_WEBHOOK_SECRET']) config.stripeWebhookSecret = env['STRIPE_WEBHOOK_SECRET'];
    if (env['X402_ENABLED'] === '1') config.x402Enabled = true;
    if (env['X402_PAY_TO_ADDRESS']) config.x402PayToAddress = env['X402_PAY_TO_ADDRESS'];
    const x402Net = env['X402_NETWORK'];
    if (x402Net === 'base' || x402Net === 'base-sepolia') config.x402Network = x402Net;
    if (env['CDP_API_KEY_ID']) config.cdpApiKeyId = env['CDP_API_KEY_ID'];
    if (env['CDP_API_KEY_SECRET']) config.cdpApiKeySecret = env['CDP_API_KEY_SECRET'];
    if (env['ALOUD_ADMIN_TOKEN']) config.adminToken = env['ALOUD_ADMIN_TOKEN'];
    if (env['ALOUD_UI_DIR']) config.uiDir = env['ALOUD_UI_DIR'];
    if (env['ALOUD_DB_PATH']) config.dbPath = env['ALOUD_DB_PATH'];

    if (strict) {
        const missing: string[] = [];
        if (!config.sessionSecret) missing.push('ALOUD_SESSION_SECRET');
        if (config.googleClientIds.length === 0) missing.push('GOOGLE_CLIENT_IDS');
        if (!config.dbPath) missing.push('ALOUD_DB_PATH (durable ledger; in-memory would drop balances on restart)');
        // Without an origin allowlist the CORS layer falls open to '*' (fine for
        // zero-config dev, never for a deploy), so fail fast instead.
        if (config.corsOrigins.length === 0)
            missing.push('ALOUD_CORS_ORIGINS (without it CORS falls open to *)');
        if (Object.keys(config.providerKeys).length === 0)
            missing.push(
                'at least one provider key (ANTHROPIC_API_KEY/GROQ_API_KEY/OPENROUTER_API_KEY/GEMINI_API_KEY/OPENAI_API_KEY)'
            );
        if (missing.length > 0) {
            throw new Error(
                `Refusing to start in production: missing required config: ${missing.join(', ')}`
            );
        }
    }

    return config;
}

/** Which providers this server can forward to right now (i.e. have a key). */
export function configuredProviders(config: Config): ProviderId[] {
    const out: ProviderId[] = [];
    if (config.providerKeys.anthropic) out.push('anthropic');
    if (config.providerKeys.groq) out.push('groq');
    if (config.providerKeys.openrouter) out.push('openrouter');
    if (config.providerKeys.google) out.push('google');
    if (config.providerKeys.openai) out.push('openai');
    return out;
}
