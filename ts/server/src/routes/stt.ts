/**
 * POST /v1/stt, metered speech-to-text. Body is raw mono PCM - Int16 with
 * `format=i16` (current clients; half the bytes of the same audio), Float32
 * otherwise (older clients) - sample rate in the `sample_rate` query param.
 * Forwards to the configured Whisper backend (OpenAI by default, Groq/custom
 * via env; config.ts resolveSttConfig), debits fractional credits by audio
 * duration, returns the transcript.
 *
 * Duration is computed server-side from the byte length, so a client can't
 * under-report seconds to underpay. Stateless: audio in, text out, nothing
 * persisted.
 */

import { Hono } from 'hono';
import { sttModelChoices } from '../config.js';
import type { TranscribeResponse } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { priceSttSeconds } from '../pricing/meter.js';
import { serverIncidents } from '../credits/incidents.js';
import { chargeUpfront, gateUpfront } from './upfront-charge.js';
import { int16ToFloat32, transcribeWhisper } from '../providers/stt.js';
import { log } from '../logger.js';
import { errorJson, tooManyRequests } from '../http.js';

/** Sample rates a client legitimately records at (mic captures + the common
 *  output rates). Billing divides by this value, so it's an allowlist, not a
 *  range check. */
const ALLOWED_SAMPLE_RATES = new Set([16_000, 24_000, 44_100, 48_000]);

export function sttRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.post('/', requireAuth(deps), async (c) => {
        const account = c.get('account');

        const stt = deps.config.sttConfig;
        if (!stt) return errorJson(c, 'provider_error', 'STT is not configured on this server');
        if (!deps.rateGuard.allow(account.id)) return tooManyRequests(c);

        // Billing divides by the sample rate, so it must be a real capture rate:
        // an attacker-supplied huge value would shrink the billed seconds of an
        // arbitrarily long clip toward zero.
        const sampleRate = Number(c.req.query('sample_rate') ?? 16_000);
        if (!ALLOWED_SAMPLE_RATES.has(sampleRate)) return errorJson(c, 'bad_request', 'invalid sample_rate');

        // Optional per-call model pick (the client picker's two hosted options).
        // Allowlisted against the configured backend: the model keys billing, so
        // an arbitrary value could otherwise name a cheaper rate — or make us
        // forward garbage upstream.
        const requestedModel = c.req.query('model');
        if (requestedModel && !sttModelChoices(stt).includes(requestedModel)) {
            return errorJson(c, 'bad_request', 'unknown stt model');
        }
        const model = requestedModel || stt.model;

        // Wire format: i16 (current clients), f32 default for old ones. It
        // keys the alignment check and billed duration, so unknown = 400.
        const format = c.req.query('format') ?? 'f32';
        if (format !== 'f32' && format !== 'i16') return errorJson(c, 'bad_request', 'unknown pcm format');
        const raw = await c.req.arrayBuffer();
        const bytesPerSample = format === 'i16' ? 2 : 4;
        if (raw.byteLength === 0 || raw.byteLength % bytesPerSample !== 0) {
            return errorJson(c, 'bad_request', 'body must be non-empty PCM');
        }
        const samples = format === 'i16' ? int16ToFloat32(new Int16Array(raw)) : new Float32Array(raw);
        const seconds = samples.length / sampleRate;

        const sessionId = c.req.query('session_id') || null;
        const incident = serverIncidents(deps.store, { accountId: account.id, provider: stt.provider, model, sessionId });

        const cost = priceSttSeconds(seconds, model);
        const gate = await gateUpfront(deps, account.id, cost);
        if (!gate.fits) {
            incident(
                'insufficient_credits',
                `stt: ${seconds.toFixed(1)}s needs ${cost.credits.toFixed(2)} > balance ${gate.balance.toFixed(2)}`
            );
            return errorJson(c, 'insufficient_credits', 'out of credits');
        }

        // Optional language hint (the session language). Advisory only - it
        // keys no billing - so an unparseable value is dropped, not a 400. The
        // client sends the app's 2-letter code; providers want ISO-639-1, so a
        // regional tag ('zh-CN') is trimmed to its base.
        const langMatch = /^([a-z]{2,3})(-|$)/i.exec(c.req.query('lang') ?? '');
        const language = langMatch ? langMatch[1]!.toLowerCase() : undefined;

        let text: string;
        try {
            text = await transcribeWhisper(samples, sampleRate, { ...stt, model }, language);
        } catch (err) {
            log.error('stt forward failed', { err: String(err) });
            incident('stt_error', `${seconds.toFixed(1)}s: ${String(err)}`);
            return errorJson(c, 'provider_error', 'STT upstream error');
        }

        const charged = await chargeUpfront(deps, gate, cost, `stt:${stt.provider}:${seconds.toFixed(1)}s`, {
            accountId: account.id,
            sessionId,
            kind: 'stt',
            provider: stt.provider,
            model,
            seconds,
        });
        return c.json({ text, ...charged } satisfies TranscribeResponse);
    });

    return app;
}
