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
import { synthesizeWithGoogle } from '../providers/tts.js';
import { resolveVoiceId } from '../providers/voice-catalog.js';
import { CANNED_MESSAGES, type CannedReason } from '../admin/runtime-config.js';
import { log } from '../logger.js';

/** Synthesized canned-apology audio, keyed `${reason}:${voiceId}`. The texts are
 *  fixed and server-owned, so each (reason, voice) pair is synthesized once for
 *  the whole process lifetime and then served free — no per-user provider cost.
 *  Re-synthesized lazily after a restart; negligible. */
const CANNED_AUDIO = new Map<string, Uint8Array>();

export function ttsRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    // Voice the fixed out-of-credits / paused apology. UNMETERED and with NO
    // balance gate by design: the whole point is to speak gracefully to an
    // account that has run out (the metered POST / below would 402). Safe to
    // give away because the text is one of a few server-controlled constants —
    // a caller can't turn this into free synthesis of arbitrary input.
    app.post('/canned', requireAuth(deps), async (c) => {
        const account = c.get('account');
        const key = deps.config.googleTtsApiKey;
        if (!key) {
            return c.json(apiError('provider_error', 'TTS is not configured on this server'), ERROR_STATUS.provider_error);
        }
        if (!deps.rateGuard.allow(account.id)) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }

        const body = (await c.req.json().catch(() => ({}))) as { reason?: string; voice?: string };
        const reason = body.reason as CannedReason;
        const message = CANNED_MESSAGES[reason];
        if (!message) {
            return c.json(apiError('bad_request', 'unknown canned reason'), ERROR_STATUS.bad_request);
        }
        const voiceId = resolveVoiceId(body.voice);
        const cacheKey = `${reason}:${voiceId}`;

        let audio = CANNED_AUDIO.get(cacheKey);
        if (!audio) {
            try {
                audio = await synthesizeWithGoogle(message, voiceId, 1, key);
            } catch (err) {
                log.error('canned tts synth failed', { err: String(err) });
                return c.json(apiError('provider_error', 'TTS upstream error'), ERROR_STATUS.provider_error);
            }
            CANNED_AUDIO.set(cacheKey, audio);
        }
        c.header('content-type', 'audio/mpeg');
        return c.body(audio.buffer as ArrayBuffer);
    });

    app.post('/', requireAuth(deps), async (c) => {
        const account = c.get('account');

        const key = deps.config.googleTtsApiKey;
        if (!key) {
            return c.json(apiError('provider_error', 'TTS is not configured on this server'), ERROR_STATUS.provider_error);
        }
        if (!deps.rateGuard.allow(account.id)) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }

        const body = (await c.req.json().catch(() => ({}))) as Partial<SpeakRequest>;
        const text = (body.text ?? '').trim();
        if (!text) {
            return c.json(apiError('bad_request', 'text required'), ERROR_STATUS.bad_request);
        }

        const balance = await deps.ledger.balance(account.id);
        if (balance <= 0) {
            return c.json(apiError('insufficient_credits', 'out of credits'), ERROR_STATUS.insufficient_credits);
        }

        // Resolve a curated short name ("Leda") or raw id to a Google voice once,
        // and reuse it for synthesis, pricing (the rate is tier-specific), and
        // telemetry — so the charge matches the voice actually synthesized.
        const voiceId = resolveVoiceId(body.voice);

        let audio: Uint8Array;
        try {
            audio = await synthesizeWithGoogle(text, voiceId, body.rate ?? 1, key);
        } catch (err) {
            log.error('tts forward failed', { err: String(err) });
            return c.json(apiError('provider_error', 'TTS upstream error'), ERROR_STATUS.provider_error);
        }

        const cost = priceTtsChars(text.length, voiceId);
        const debit = Math.min(cost.credits, balance);
        if (debit > 0) await deps.ledger.debit(account.id, debit, `tts:google:${text.length}c`);
        await recordUsage(deps.store, {
            accountId: account.id,
            kind: 'tts',
            provider: 'google',
            model: voiceId,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            seconds: 0,
            chars: text.length,
            providerCostUsd: cost.providerCostUsd,
            credits: debit,
        });
        const remaining = await deps.ledger.balance(account.id);

        c.header('content-type', 'audio/mpeg');
        c.header('X-Credits-Charged', String(cost.credits));
        c.header('X-Credits-Remaining', String(remaining));
        return c.body(audio.buffer as ArrayBuffer);
    });

    return app;
}
