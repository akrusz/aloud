/**
 * POST /v1/tts, metered text-to-speech. Takes JSON { text, voice?, rate? },
 * synthesizes via the resolved voice's provider (Google, OpenAI, or Azure),
 * debits fractional credits by billed character count, returns MP3 bytes
 * (audio/mpeg). Cost rides in X-Credits-Charged / X-Credits-Remaining so the
 * body stays a clean audio stream the client hands straight to an <audio>
 * element.
 *
 * POST (not GET) keeps the meditation text out of URL query strings, which
 * intermediaries/access logs could capture; the body is never logged
 * (logger.ts privacy invariant).
 */

import { Hono } from 'hono';
import { MAX_TTS_CHARS, type SpeakRequest } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { priceTtsChars } from '../pricing/meter.js';
import { serverIncidents } from '../credits/incidents.js';
import { chargeUpfront, gateUpfront } from './upfront-charge.js';
import { azureBilledChars, synthesizeWithAzure, synthesizeWithGoogle, synthesizeWithOpenAI } from '../providers/tts.js';
import { withLeadSilence } from '../providers/mp3-lead-silence.js';
import {
    CURATED_VOICES,
    PREVIEW_PHRASE,
    resolveVoice,
    type ResolvedVoice,
    type TtsProvider,
} from '../providers/voice-catalog.js';
import { CANNED_MESSAGES, type CannedReason } from '../admin/runtime-config.js';
import { log } from '../logger.js';
import { errorJson, sessionIdOf, tooManyRequests } from '../http.js';

type SynthFn = (text: string, rate: number) => Promise<Uint8Array>;

/** The rate actually synthesized: the caller's request scaled by the curated
 *  voice's pace normalization, so the speed slider means about the same
 *  words-per-minute on every voice (CuratedVoice.paceBias).
 *
 *  EXCEPT a styled voice, which is always rate 1: on MAI-Voice-2 ANY
 *  <prosody> tag silently reverts the mstts express-as style to the standard
 *  voice (either nesting order, even rate 1.05 - measured 2026-08-31, bead
 *  p23f), so a styled voice with a rate is a contradiction - the style IS the
 *  pacing, and its natural pace (~1.5x slower) is the sound these voices were
 *  curated for. The speed slider therefore no-ops on styled voices. */
function effectiveRate(resolved: ResolvedVoice, rate: number): number {
    if (resolved.style) return 1;
    return rate * (resolved.paceBias ?? 1);
}

/** Providers with a key configured here, so a no-voice request's default can
 *  fall through to one that will actually synthesize (defaultVoice's chain). */
function availableProviders(deps: Deps): ReadonlySet<TtsProvider> {
    const s = new Set<TtsProvider>();
    if (deps.config.googleTtsApiKey) s.add('google');
    if (deps.config.openaiTtsApiKey) s.add('openai');
    if (deps.config.azureSpeechKey) s.add('azure');
    return s;
}

/** A bound synth call for a resolved voice, or null when that voice's provider
 *  has no key configured (callers map null to provider_error). One dispatch
 *  for all three routes below: any curated voice works once its provider key
 *  is present. */
function synthFor(deps: Deps, resolved: ResolvedVoice): SynthFn | null {
    if (resolved.provider === 'openai') {
        const key = deps.config.openaiTtsApiKey;
        return key
            ? (text, rate) => synthesizeWithOpenAI(text, resolved.voiceId, effectiveRate(resolved, rate), key)
            : null;
    }
    if (resolved.provider === 'azure') {
        const key = deps.config.azureSpeechKey;
        return key
            ? (text, rate) =>
                  synthesizeWithAzure(
                      text,
                      resolved.voiceId,
                      effectiveRate(resolved, rate),
                      key,
                      deps.config.azureSpeechRegion,
                      resolved.style
                  ).then(withLeadSilence)
            : null;
    }
    const key = deps.config.googleTtsApiKey;
    return key
        ? (text, rate) => synthesizeWithGoogle(text, resolved.voiceId, effectiveRate(resolved, rate), key)
        : null;
}

/** Characters the provider will actually bill for this synthesis. Google and
 *  OpenAI bill the plain text; Azure bills the SSML body we send (markup +
 *  expanded escapes) and counts each CJK character twice, so its count runs
 *  higher than text.length. The meter, the up-front balance gate, and the
 *  usage record all take THIS number - billing text.length would under-charge
 *  every Azure synthesis (roughly 2x on Chinese text). */
function billedCharsFor(resolved: ResolvedVoice, text: string, rate: number): number {
    // Same effective rate as synthFor, or the billed SSML disagrees with the
    // SSML actually sent (a pace-biased voice carries a prosody wrapper even
    // at slider-neutral rate 1).
    return resolved.provider === 'azure'
        ? azureBilledChars(text, effectiveRate(resolved, rate), resolved.style)
        : text.length;
}

/** Synthesized canned-apology audio, keyed `${reason}:${provider}:${voiceId}`.
 *  The texts are fixed and server-owned, so each (reason, voice) pair is synthesized once per
 *  process and served free thereafter: no per-user provider cost. Re-warmed
 *  lazily after a restart. */
const CANNED_AUDIO = new Map<string, Uint8Array>();

/** Synthesized voice-preview audio, keyed `${provider}:${voiceId}:${style}:${rate}`.
 *  Same rationale as CANNED_AUDIO: the phrase is fixed (PREVIEW_PHRASE), the
 *  voice must be curated and the rate is quantized (previewRate), so each is
 *  synthesized at most once per process and then served free to anyone: a
 *  handful of short clips per voice per deploy. */
const PREVIEW_AUDIO = new Map<string, Uint8Array>();

/** The cached clip for `key`, synthesized on first use; null (logged) when
 *  synthesis fails. */
async function cachedClip(
    cache: Map<string, Uint8Array>,
    key: string,
    synthesize: () => Promise<Uint8Array>,
    label: string
): Promise<Uint8Array | null> {
    let audio = cache.get(key);
    if (!audio) {
        try {
            audio = await synthesize();
        } catch (err) {
            log.error(`${label} tts synth failed`, { err: String(err) });
            return null;
        }
        cache.set(key, audio);
    }
    return audio;
}

/** The preview's speed step, so the free endpoint can honor the speed slider
 *  (a session at 0.8 should audition at 0.8: Google paces slow speech
 *  differently, it doesn't stretch it) without letting a caller mint unbounded
 *  distinct free syntheses. Takes the client's WPM (>5, ≈160 neutral, the same
 *  convention as the app backend's GET preview) or a multiplier, clamps to the
 *  providers' shared range and snaps to PREVIEW_RATE_STEP: at most 7 clips per
 *  voice. Absent or unparseable means neutral. */
const PREVIEW_RATE_STEP = 0.25;
export function previewRate(raw: string | undefined): number {
    const n = Number(raw);
    if (!raw || !Number.isFinite(n) || n <= 0) return 1;
    const multiplier = n > 5 ? n / 160 : n;
    const clamped = Math.min(2, Math.max(0.5, multiplier));
    return Math.round(clamped / PREVIEW_RATE_STEP) * PREVIEW_RATE_STEP;
}

export function ttsRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    // Voice the fixed out-of-credits / paused apology. UNMETERED with NO balance
    // gate by design: the point is to speak gracefully to an account that has
    // run out (the metered POST / below would 402). Safe to give away because
    // the text is one of a few server-owned constants, so a caller can't turn
    // this into free synthesis of arbitrary input.
    app.post('/canned', requireAuth(deps), async (c) => {
        const account = c.get('account');
        if (!deps.rateGuard.allow(account.id)) return tooManyRequests(c);

        const body = (await c.req.json().catch(() => ({}))) as { reason?: string; voice?: string };
        const reason = body.reason as CannedReason;
        const message = CANNED_MESSAGES[reason];
        if (!message) return errorJson(c, 'bad_request', 'unknown canned reason');
        const resolved = resolveVoice(body.voice, availableProviders(deps));
        const synth = synthFor(deps, resolved);
        if (!synth) return errorJson(c, 'provider_error', 'TTS is not configured on this server');
        const cacheKey = `${reason}:${resolved.provider}:${resolved.voiceId}`;
        const audio = await cachedClip(CANNED_AUDIO, cacheKey, () => synth(message, 1), 'canned');
        if (!audio) return errorJson(c, 'provider_error', 'TTS upstream error');
        c.header('content-type', 'audio/mpeg');
        return c.body(audio.buffer as ArrayBuffer);
    });

    // Public, UNAUTHENTICATED, UNMETERED preview of a curated voice. No sign-in
    // and no balance gate by design: the spoken text is the server-owned
    // PREVIEW_PHRASE and the voice must be curated, so a caller can't turn this
    // into free synthesis of arbitrary input, and `rate` is snapped to a few
    // steps (previewRate). Cached in PREVIEW_AUDIO, so signed-out visitors
    // audition voices for a few short clips per deploy. Real metered synthesis
    // stays on the authed POST / below. GET so the result is cacheable
    // downstream.
    app.get('/preview', async (c) => {
        const curated = CURATED_VOICES.find((v) => v.name === (c.req.query('voice') ?? ''));
        if (!curated) return errorJson(c, 'bad_request', 'unknown preview voice');
        // resolveVoice(name), not a hand-built ResolvedVoice: a curated voice
        // can carry a style, and a preview without it isn't the voice.
        const resolved = resolveVoice(curated.name);
        const synth = synthFor(deps, resolved);
        if (!synth) return errorJson(c, 'provider_error', 'TTS is not configured on this server');

        const rate = previewRate(c.req.query('rate'));
        const cacheKey = `${resolved.provider}:${resolved.voiceId}:${resolved.style ?? ''}:${rate}`;
        const audio = await cachedClip(PREVIEW_AUDIO, cacheKey, () => synth(PREVIEW_PHRASE, rate), 'preview');
        if (!audio) return errorJson(c, 'provider_error', 'TTS upstream error');
        c.header('content-type', 'audio/mpeg');
        // Short-lived: the phrase is fixed but a voice's server-side treatment
        // (style, pace) can change under the same URL, and a day-long max-age
        // held pre-fix clips in webview caches long past a deploy. PREVIEW_AUDIO
        // absorbs the refetches; the client also versions the URL (cloud-tts
        // PREVIEW_CACHE_REV) to evict entries cached under the old policy.
        c.header('cache-control', 'public, max-age=300');
        return c.body(audio.buffer as ArrayBuffer);
    });

    app.post('/', requireAuth(deps), async (c) => {
        const account = c.get('account');

        if (!deps.rateGuard.allow(account.id)) return tooManyRequests(c);

        const body = (await c.req.json().catch(() => ({}))) as Partial<SpeakRequest>;
        const text = (body.text ?? '').trim();
        if (!text) return errorJson(c, 'bad_request', 'text required');
        // Refuse before pricing/synthesis: a facilitation turn is never this
        // long, so anything over the cap is a client bug, and the balance gate
        // below would happily spend on it.
        if (text.length > MAX_TTS_CHARS) {
            return errorJson(c, 'bad_request', `text too long (${text.length} chars; max ${MAX_TTS_CHARS})`);
        }

        // Resolve once and reuse for synthesis, pricing (the rate is
        // provider/tier-specific), and telemetry, so the charge matches the
        // voice actually synthesized. Null synth = the resolved provider has no
        // key configured here.
        const resolved = resolveVoice(body.voice, availableProviders(deps));
        const synth = synthFor(deps, resolved);
        if (!synth) return errorJson(c, 'provider_error', 'TTS is not configured on this server');

        const rate = body.rate ?? 1;
        const billedChars = billedCharsFor(resolved, text, rate);
        const cost = priceTtsChars(billedChars, { provider: resolved.provider, voiceId: resolved.voiceId });
        const sessionId = sessionIdOf(body.sessionId);
        const incident = serverIncidents(deps.store, {
            accountId: account.id,
            provider: resolved.provider,
            model: resolved.voiceId,
            sessionId,
        });
        const gate = await gateUpfront(deps, account.id, cost);
        if (!gate.fits) {
            incident(
                'insufficient_credits',
                `tts: ${billedChars}c needs ${cost.credits.toFixed(2)} > balance ${gate.balance.toFixed(2)}`
            );
            return errorJson(c, 'insufficient_credits', 'out of credits');
        }

        let audio: Uint8Array;
        try {
            audio = await synth(text, rate);
        } catch (err) {
            log.error('tts forward failed', { err: String(err) });
            incident('tts_error', `${billedChars}c: ${String(err)}`);
            return errorJson(c, 'provider_error', 'TTS upstream error');
        }

        const charged = await chargeUpfront(deps, gate, cost, `tts:${resolved.provider}:${billedChars}c`, {
            accountId: account.id,
            sessionId,
            kind: 'tts',
            provider: resolved.provider,
            model: resolved.voiceId,
            // Billed chars, not text.length, so reconciliation against the
            // provider invoice lines up (they differ on Azure).
            chars: billedChars,
        });

        c.header('content-type', 'audio/mpeg');
        c.header('X-Credits-Charged', String(charged.creditsCharged));
        c.header('X-Credits-Remaining', String(charged.creditsRemaining));
        return c.body(audio.buffer as ArrayBuffer);
    });

    return app;
}
