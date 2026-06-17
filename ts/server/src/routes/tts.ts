/**
 * POST /v1/tts — metered text-to-speech. Takes JSON { text, voice?, rate? },
 * synthesizes via Google Cloud TTS, debits fractional credits by character
 * count, and returns the MP3 bytes (audio/mpeg). Cost rides in the
 * X-Credits-Charged / X-Credits-Remaining headers so the body stays a clean
 * audio stream the client hands straight to an <audio> element.
 *
 * POST (not GET) keeps the meditation text out of URL query strings, which
 * intermediaries/access logs could capture — the body never gets logged
 * (logger.ts privacy invariant).
 */

import { Hono } from 'hono';
import { ERROR_STATUS, apiError, type SpeakRequest } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { priceTtsChars } from '../pricing/meter.js';
import { recordUsage } from '../credits/usage.js';
import { activeRetreatCoverage } from '../credits/retreat.js';
import { synthesizeWithGoogle, synthesizeWithOpenAI } from '../providers/tts.js';
import {
    CURATED_VOICES,
    PREVIEW_PHRASE,
    resolveVoice,
    type ResolvedVoice,
} from '../providers/voice-catalog.js';
import { CANNED_MESSAGES, type CannedReason } from '../admin/runtime-config.js';
import { log } from '../logger.js';

/** A bound synth call for a resolved voice, or null when that voice's provider
 *  has no key configured (the caller maps null to a provider_error). Centralizes
 *  the provider→(key, synth fn) dispatch so the three routes below stay uniform:
 *  any curated voice "just works" once its provider key is present. */
type SynthFn = (text: string, rate: number) => Promise<Uint8Array>;
function synthFor(deps: Deps, resolved: ResolvedVoice): SynthFn | null {
    if (resolved.provider === 'openai') {
        const key = deps.config.openaiTtsApiKey;
        return key ? (text, rate) => synthesizeWithOpenAI(text, resolved.voiceId, rate, key) : null;
    }
    const key = deps.config.googleTtsApiKey;
    return key ? (text, rate) => synthesizeWithGoogle(text, resolved.voiceId, rate, key) : null;
}

/** Synthesized canned-apology audio, keyed `${reason}:${voiceId}`. The texts are
 *  fixed and server-owned, so each (reason, voice) pair is synthesized once for
 *  the whole process lifetime and then served free — no per-user provider cost.
 *  Re-synthesized lazily after a restart; negligible. */
const CANNED_AUDIO = new Map<string, Uint8Array>();

/** Synthesized voice-preview audio, keyed by Google voice id. Same rationale as
 *  CANNED_AUDIO: the phrase is fixed (PREVIEW_PHRASE) and the voice must be one
 *  we curate, so each curated voice is synthesized at most once per process
 *  lifetime and then served free to anyone — a handful of short clips per
 *  deploy, re-warmed lazily after a restart. */
const PREVIEW_AUDIO = new Map<string, Uint8Array>();

export function ttsRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    // Voice the fixed out-of-credits / paused apology. UNMETERED and with NO
    // balance gate by design: the whole point is to speak gracefully to an
    // account that has run out (the metered POST / below would 402). Safe to
    // give away because the text is one of a few server-controlled constants —
    // a caller can't turn this into free synthesis of arbitrary input.
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
        const resolved = resolveVoice(body.voice);
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
    // PREVIEW_PHRASE and the voice must be one we curate, so a caller can't turn
    // this into free synthesis of arbitrary input. Each curated voice is
    // synthesized at most once per process (cached in PREVIEW_AUDIO) and then
    // served from memory, so signed-out visitors can audition voices for the
    // cost of a few short clips per deploy. Real, metered synthesis stays on the
    // authed POST / below. GET so the result is plainly cacheable downstream.
    app.get('/preview', async (c) => {
        const curated = CURATED_VOICES.find((v) => v.name === (c.req.query('voice') ?? ''));
        if (!curated) {
            return c.json(apiError('bad_request', 'unknown preview voice'), ERROR_STATUS.bad_request);
        }
        const resolved: ResolvedVoice = { provider: curated.provider, voiceId: curated.providerVoiceId };
        const synth = synthFor(deps, resolved);
        if (!synth) {
            return c.json(apiError('provider_error', 'TTS is not configured on this server'), ERROR_STATUS.provider_error);
        }

        const cacheKey = `${resolved.provider}:${resolved.voiceId}`;
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
        // Fixed phrase per voice — safe to cache hard in the browser/CDN.
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

        // Resolve a curated short name ("Leda", "Lyra") or raw Google id to its
        // (provider, voiceId) once, and reuse it for synthesis, pricing (the
        // rate is provider/tier-specific), and telemetry — so the charge matches
        // the voice actually synthesized. A null synth means the resolved
        // provider has no key configured on this server.
        const resolved = resolveVoice(body.voice);
        const synth = synthFor(deps, resolved);
        if (!synth) {
            return c.json(apiError('provider_error', 'TTS is not configured on this server'), ERROR_STATUS.provider_error);
        }

        // A retreat pass (meditation-pal-414) covers this synthesis: speak with no
        // balance gate and no debit. Otherwise the ESTIMATED cost (known exactly
        // up front — it's character-priced) must fit the balance, or a near-zero
        // balance would buy an unbounded provider call with the debit clamped
        // after the fact.
        const cost = priceTtsChars(text.length, { provider: resolved.provider, voiceId: resolved.voiceId });
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
        // (the up-front gate already refused requests the balance can't cover).
        // Under a pass nothing is debited, but we record the metered credits so
        // per-retreat spend and the daily-cap sum stay honest.
        const debit = pass ? 0 : Math.min(cost.credits, balance);
        if (debit > 0) await deps.ledger.debit(account.id, debit, `tts:${resolved.provider}:${text.length}c`);
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
            chars: text.length,
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
