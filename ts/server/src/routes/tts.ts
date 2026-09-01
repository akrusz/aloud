/**
 * POST /v1/tts, metered text-to-speech. Takes JSON { text, voice?, rate? },
 * synthesizes via the resolved voice's provider (Google, OpenAI, or Azure),
 * debits fractional credits by billed character count, returns MP3 bytes
 * (audio/mpeg). Cost
 * rides in X-Credits-Charged / X-Credits-Remaining so the body stays a clean
 * audio stream the client hands straight to an <audio> element.
 *
 * POST (not GET) keeps the meditation text out of URL query strings, which
 * intermediaries/access logs could capture; the body is never logged
 * (logger.ts privacy invariant).
 */

import { Hono } from 'hono';
import { ERROR_STATUS, MAX_TTS_CHARS, apiError, type SpeakRequest } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { priceTtsChars } from '../pricing/meter.js';
import { recordUsage } from '../credits/usage.js';
import { activeRetreatCoverage } from '../credits/retreat.js';
import { azureBilledChars, synthesizeWithAzure, synthesizeWithGoogle, synthesizeWithOpenAI } from '../providers/tts.js';
import {
    CURATED_VOICES,
    PREVIEW_PHRASE,
    resolveVoice,
    type ResolvedVoice,
    type TtsProvider,
} from '../providers/voice-catalog.js';
import { CANNED_MESSAGES, type CannedReason } from '../admin/runtime-config.js';
import { log } from '../logger.js';

/** A bound synth call for a resolved voice, or null when that voice's provider
 *  has no key configured (callers map null to provider_error). Centralizing the
 *  provider→(key, synth fn) dispatch keeps the three routes below uniform: any
 *  curated voice works once its provider key is present. */
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
                  )
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

/** Synthesized canned-apology audio, keyed `${reason}:${provider}:${voiceId}`. The texts are
 *  fixed and server-owned, so each (reason, voice) pair is synthesized once per
 *  process and served free thereafter: no per-user provider cost. Re-warmed
 *  lazily after a restart. */
const CANNED_AUDIO = new Map<string, Uint8Array>();

/** Synthesized voice-preview audio, keyed `${provider}:${voiceId}`. Same rationale as
 *  CANNED_AUDIO: the phrase is fixed (PREVIEW_PHRASE) and the voice must be
 *  curated, so each is synthesized at most once per process and then served
 *  free to anyone: a handful of short clips per deploy. */
const PREVIEW_AUDIO = new Map<string, Uint8Array>();

export function ttsRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    // Voice the fixed out-of-credits / paused apology. UNMETERED with NO balance
    // gate by design: the point is to speak gracefully to an account that has
    // run out (the metered POST / below would 402). Safe to give away because
    // the text is one of a few server-owned constants, so a caller can't turn
    // this into free synthesis of arbitrary input.
    app.post('/canned', requireAuth(deps), async (c) => {
        const account = c.get('account');
        if (!deps.rateGuard.allow(account.id)) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }

        const body = (await c.req.json().catch(() => ({}))) as { reason?: string; voice?: string };
        const reason = body.reason as CannedReason;
        const message = CANNED_MESSAGES[reason];
        if (!message) {
            return c.json(apiError('bad_request', 'unknown canned reason'), ERROR_STATUS.bad_request);
        }
        const resolved = resolveVoice(body.voice, availableProviders(deps));
        const synth = synthFor(deps, resolved);
        if (!synth) {
            return c.json(apiError('provider_error', 'TTS is not configured on this server'), ERROR_STATUS.provider_error);
        }
        const cacheKey = `${reason}:${resolved.provider}:${resolved.voiceId}`;

        let audio = CANNED_AUDIO.get(cacheKey);
        if (!audio) {
            try {
                audio = await synth(message, 1);
            } catch (err) {
                log.error('canned tts synth failed', { err: String(err) });
                return c.json(apiError('provider_error', 'TTS upstream error'), ERROR_STATUS.provider_error);
            }
            CANNED_AUDIO.set(cacheKey, audio);
        }
        c.header('content-type', 'audio/mpeg');
        return c.body(audio.buffer as ArrayBuffer);
    });

    // Public, UNAUTHENTICATED, UNMETERED preview of a curated voice. No sign-in
    // and no balance gate by design: the spoken text is the server-owned
    // PREVIEW_PHRASE and the voice must be curated, so a caller can't turn this
    // into free synthesis of arbitrary input. Cached in PREVIEW_AUDIO, so
    // signed-out visitors audition voices for a few short clips per deploy.
    // Real metered synthesis stays on the authed POST / below. GET so the
    // result is cacheable downstream.
    app.get('/preview', async (c) => {
        const curated = CURATED_VOICES.find((v) => v.name === (c.req.query('voice') ?? ''));
        if (!curated) {
            return c.json(apiError('bad_request', 'unknown preview voice'), ERROR_STATUS.bad_request);
        }
        // resolveVoice(name), not a hand-built ResolvedVoice: a curated voice
        // can carry a style, and a preview without it isn't the voice.
        const resolved = resolveVoice(curated.name);
        const synth = synthFor(deps, resolved);
        if (!synth) {
            return c.json(apiError('provider_error', 'TTS is not configured on this server'), ERROR_STATUS.provider_error);
        }

        const cacheKey = `${resolved.provider}:${resolved.voiceId}:${resolved.style ?? ''}`;
        let audio = PREVIEW_AUDIO.get(cacheKey);
        if (!audio) {
            try {
                audio = await synth(PREVIEW_PHRASE, 1);
            } catch (err) {
                log.error('preview tts synth failed', { err: String(err) });
                return c.json(apiError('provider_error', 'TTS upstream error'), ERROR_STATUS.provider_error);
            }
            PREVIEW_AUDIO.set(cacheKey, audio);
        }
        c.header('content-type', 'audio/mpeg');
        // Fixed phrase per voice: safe to cache hard in the browser/CDN.
        c.header('cache-control', 'public, max-age=86400');
        return c.body(audio.buffer as ArrayBuffer);
    });

    app.post('/', requireAuth(deps), async (c) => {
        const account = c.get('account');

        if (!deps.rateGuard.allow(account.id)) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }

        const body = (await c.req.json().catch(() => ({}))) as Partial<SpeakRequest>;
        const text = (body.text ?? '').trim();
        if (!text) {
            return c.json(apiError('bad_request', 'text required'), ERROR_STATUS.bad_request);
        }
        // Refuse before pricing/synthesis: a facilitation turn is never this
        // long, so anything over the cap is a client bug, and the balance gate
        // below would happily spend on it.
        if (text.length > MAX_TTS_CHARS) {
            return c.json(
                apiError('bad_request', `text too long (${text.length} chars; max ${MAX_TTS_CHARS})`),
                ERROR_STATUS.bad_request
            );
        }

        // Resolve once and reuse for synthesis, pricing (the rate is
        // provider/tier-specific), and telemetry, so the charge matches the
        // voice actually synthesized. Null synth = the resolved provider has no
        // key configured here.
        const resolved = resolveVoice(body.voice, availableProviders(deps));
        const synth = synthFor(deps, resolved);
        if (!synth) {
            return c.json(apiError('provider_error', 'TTS is not configured on this server'), ERROR_STATUS.provider_error);
        }

        // A retreat pass (meditation-pal-414) covers this synthesis: speak with
        // no balance gate and no debit. Otherwise the cost (known exactly up
        // front, it's character-priced) must fit the balance, or a near-zero
        // balance would buy an unbounded provider call with the debit clamped
        // after the fact.
        const billedChars = billedCharsFor(resolved, text, body.rate ?? 1);
        const cost = priceTtsChars(billedChars, { provider: resolved.provider, voiceId: resolved.voiceId });
        const pass = await activeRetreatCoverage(deps.store, account.id, Date.now() / 1000);
        const balance = pass ? 0 : await deps.ledger.balance(account.id);
        if (!pass && balance < cost.credits) {
            return c.json(apiError('insufficient_credits', 'out of credits'), ERROR_STATUS.insufficient_credits);
        }

        let audio: Uint8Array;
        try {
            audio = await synth(text, body.rate ?? 1);
        } catch (err) {
            log.error('tts forward failed', { err: String(err) });
            return c.json(apiError('provider_error', 'TTS upstream error'), ERROR_STATUS.provider_error);
        }

        // Debit clamped to balance so a concurrent-spend race can't overdraw
        // (the up-front gate already refused what the balance can't cover).
        // Under a pass nothing is debited, but record the metered credits so
        // per-retreat spend and the daily-cap sum stay honest.
        const debit = pass ? 0 : Math.min(cost.credits, balance);
        if (debit > 0) await deps.ledger.debit(account.id, debit, `tts:${resolved.provider}:${billedChars}c`);
        const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
        await recordUsage(deps.store, {
            accountId: account.id,
            sessionId,
            kind: 'tts',
            provider: resolved.provider,
            model: resolved.voiceId,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            seconds: 0,
            // Billed chars, not text.length, so reconciliation against the
            // provider invoice lines up (they differ on Azure).
            chars: billedChars,
            providerCostUsd: cost.providerCostUsd,
            credits: pass ? cost.credits : debit,
            passId: pass?.id ?? null,
        });
        const remaining = await deps.ledger.balance(account.id);

        c.header('content-type', 'audio/mpeg');
        c.header('X-Credits-Charged', String(pass ? 0 : cost.credits));
        c.header('X-Credits-Remaining', String(remaining));
        return c.body(audio.buffer as ArrayBuffer);
    });

    return app;
}
