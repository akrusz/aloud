/**
 * POST /v1/stt, metered speech-to-text. Body is raw mono PCM - Int16 with
 * `format=i16` (current clients; half the bytes of the same audio), Float32
 * otherwise (older clients) - sample rate in the `sample_rate` query param. Forwards to the configured Whisper
 * backend (OpenAI by default, Groq/custom via env; config.ts resolveSttConfig),
 * debits fractional credits by audio duration, returns the transcript.
 *
 * Duration is computed server-side from the byte length, so a client can't
 * under-report seconds to underpay. Stateless: audio in, text out, nothing
 * persisted.
 */

import { Hono } from 'hono';
import { sttModelChoices } from '../config.js';
import { ERROR_STATUS, apiError, type TranscribeResponse } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { priceSttSeconds } from '../pricing/meter.js';
import { recordUsage } from '../credits/usage.js';
import { recordIncident } from '../credits/incidents.js';
import { activeRetreatCoverage } from '../credits/retreat.js';
import { int16ToFloat32, transcribeWhisper } from '../providers/stt.js';
import { log } from '../logger.js';

/** Sample rates a client legitimately records at (mic captures + the common
 *  output rates). Billing divides by this value, so it's an allowlist, not a
 *  range check. */
const ALLOWED_SAMPLE_RATES = new Set([16_000, 24_000, 44_100, 48_000]);

export function sttRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.post('/', requireAuth(deps), async (c) => {
        const account = c.get('account');

        const stt = deps.config.sttConfig;
        if (!stt) {
            return c.json(apiError('provider_error', 'STT is not configured on this server'), ERROR_STATUS.provider_error);
        }
        if (!deps.rateGuard.allow(account.id)) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }

        // Billing divides by the sample rate, so it must be a real capture rate:
        // an attacker-supplied huge value would shrink the billed seconds of an
        // arbitrarily long clip toward zero.
        const sampleRate = Number(c.req.query('sample_rate') ?? 16_000);
        if (!ALLOWED_SAMPLE_RATES.has(sampleRate)) {
            return c.json(apiError('bad_request', 'invalid sample_rate'), ERROR_STATUS.bad_request);
        }

        // Optional per-call model pick (the client picker's two hosted options).
        // Allowlisted against the configured backend: the model keys billing, so
        // an arbitrary value could otherwise name a cheaper rate — or make us
        // forward garbage upstream.
        const requestedModel = c.req.query('model');
        if (requestedModel && !sttModelChoices(stt).includes(requestedModel)) {
            return c.json(apiError('bad_request', 'unknown stt model'), ERROR_STATUS.bad_request);
        }
        const model = requestedModel || stt.model;

        // Wire format: i16 (current clients), f32 default for old ones. It
        // keys the alignment check and billed duration, so unknown = 400.
        const format = c.req.query('format') ?? 'f32';
        if (format !== 'f32' && format !== 'i16') {
            return c.json(apiError('bad_request', 'unknown pcm format'), ERROR_STATUS.bad_request);
        }
        const raw = await c.req.arrayBuffer();
        const bytesPerSample = format === 'i16' ? 2 : 4;
        if (raw.byteLength === 0 || raw.byteLength % bytesPerSample !== 0) {
            return c.json(apiError('bad_request', 'body must be non-empty PCM'), ERROR_STATUS.bad_request);
        }
        const samples = format === 'i16' ? int16ToFloat32(new Int16Array(raw)) : new Float32Array(raw);
        const seconds = samples.length / sampleRate;

        // A retreat pass (meditation-pal-414) covers this leg: transcribe with
        // no balance gate and no debit. Otherwise the cost (known exactly up
        // front, it's duration-priced) must fit the balance, or a near-zero
        // balance would buy an unbounded provider call with the debit clamped
        // after the fact.
        const cost = priceSttSeconds(seconds, model);
        const pass = await activeRetreatCoverage(deps.store, account.id, Date.now() / 1000);
        const balance = pass ? 0 : await deps.ledger.balance(account.id);
        if (!pass && balance < cost.credits) {
            void recordIncident(deps.store, {
                accountId: account.id,
                kind: 'insufficient_credits',
                source: 'server',
                provider: stt.provider,
                model,
                sessionId: c.req.query('session_id') || null,
                detail: `stt: ${seconds.toFixed(1)}s needs ${cost.credits.toFixed(2)} > balance ${balance.toFixed(2)}`,
            });
            return c.json(apiError('insufficient_credits', 'out of credits'), ERROR_STATUS.insufficient_credits);
        }

        // Optional language hint (the session language). Advisory only - it
        // keys no billing - so an unparseable value is dropped, not a 400. The
        // client sends the app's 2-letter code; providers want ISO-639-1, so a
        // regional tag ('zh-CN') is trimmed to its base.
        const langRaw = c.req.query('lang') ?? '';
        const langMatch = /^([a-z]{2,3})(-|$)/i.exec(langRaw);
        const language = langMatch ? langMatch[1]!.toLowerCase() : undefined;

        let text: string;
        try {
            text = await transcribeWhisper(samples, sampleRate, { ...stt, model }, language);
        } catch (err) {
            log.error('stt forward failed', { err: String(err) });
            void recordIncident(deps.store, {
                accountId: account.id,
                kind: 'stt_error',
                source: 'server',
                provider: stt.provider,
                model,
                sessionId: c.req.query('session_id') || null,
                detail: `${seconds.toFixed(1)}s: ${String(err)}`,
            });
            return c.json(apiError('provider_error', 'STT upstream error'), ERROR_STATUS.provider_error);
        }

        // Debit clamped to balance so a concurrent-spend race can't overdraw
        // (the up-front gate already refused what the balance can't cover).
        // Under a pass nothing is debited, but record the metered credits so
        // per-retreat spend and the daily-cap sum stay honest.
        const debit = pass ? 0 : Math.min(cost.credits, balance);
        if (debit > 0) await deps.ledger.debit(account.id, debit, `stt:${stt.provider}:${seconds.toFixed(1)}s`);
        const sessionId = c.req.query('session_id') || null;
        await recordUsage(deps.store, {
            accountId: account.id,
            sessionId,
            kind: 'stt',
            provider: stt.provider,
            model,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            seconds,
            chars: 0,
            providerCostUsd: cost.providerCostUsd,
            credits: pass ? cost.credits : debit,
            passId: pass?.id ?? null,
        });

        const response: TranscribeResponse = {
            text,
            creditsCharged: pass ? 0 : cost.credits,
            creditsRemaining: await deps.ledger.balance(account.id),
        };
        return c.json(response);
    });

    return app;
}
