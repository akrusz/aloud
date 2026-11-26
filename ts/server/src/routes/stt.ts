/**
 * POST /cloud/v1/stt, metered speech-to-text. Body is raw mono PCM - Int16
 * with `format=i16` (current clients; half the bytes of the same audio), Float32
 * otherwise (older clients) - sample rate in the `sample_rate` query param.
 * Forwards to the configured Whisper backend (OpenAI by default, Groq/custom
 * via env; config.ts resolveSttConfig), or through OpenRouter for the models
 * in providers/stt.ts OPENROUTER_STT_MODELS; debits fractional credits by the
 * audio seconds the provider bills (pricing sttBilledSeconds), returns the
 * transcript and the model that wrote it.
 *
 * A request for Parakeet may be answered by gpt-transcribe instead, or sent to
 * both (providers/stt-hybrid.ts); the response's `route` says so, and each
 * request a provider bills is metered at its own model's rate.
 *
 * Duration is computed server-side from the byte length, so a client can't
 * under-report seconds to underpay. Stateless: audio in, text out, nothing
 * persisted.
 *
 * An `x-stt-prior` header (percent-encoded) carries the transcript of the same
 * turn up to where this clip's audio begins: incremental transcription sends a
 * turn in pieces, and the configured backend gets that text as its prompt so a
 * piece continues the turn instead of starting cold (sttPrior). A header, not
 * a query param, because it is the meditator's words and URLs get logged. Like
 * the audio, it is forwarded and never logged or kept.
 *
 * `setup=1` marks the setup screen's listening (ui voice-start.ts), before any
 * session exists: the transcription is prompted with the setup vocabulary, and
 * it is free while the clip is short and the account has setup seconds left
 * today. Anyone can send the flag, so those two bounds are all that keeps it
 * from making a session's speech recognition free; past either one the clip
 * is metered exactly as without it.
 */

import { Hono } from 'hono';
import { setupVocabulary } from '@aloud/core/facilitation';
import { sttModelChoices } from '../config.js';
import type { SttRoute, TranscribeResponse } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { priceSttSeconds, type CostBreakdown } from '../pricing/meter.js';
import { sttBilledSeconds, sttPromptIsBilled } from '../pricing/providers.js';
import { serverIncidents } from '../credits/incidents.js';
import { recordUsage } from '../credits/usage.js';
import { chargeUpfrontLegs, gateUpfront } from './upfront-charge.js';
import {
    OPENROUTER_STT_MODELS,
    int16ToFloat32,
    transcribeOpenRouter,
    transcribeWhisper,
    type SttResult,
} from '../providers/stt.js';
import {
    HYBRID_SHORT_MAX_SEC,
    HYBRID_STAND_IN,
    HedgeFailed,
    hybridApplies,
    hybridDeadlineMs,
    legIsBilled,
    transcribeHedged,
    type SttLeg,
} from '../providers/stt-hybrid.js';
import { log } from '../logger.js';
import { errorJson, sessionIdOf, tooManyRequests } from '../http.js';

/** Sample rates a client legitimately records at (mic captures + the common
 *  output rates). Billing divides by this value, so it's an allowlist, not a
 *  range check. */
const ALLOWED_SAMPLE_RATES = new Set([16_000, 24_000, 44_100, 48_000]);

/**
 * The longest clip setup listening gets free. The client cuts an utterance at
 * LOBBY_STT.maxUtteranceMs (10 s) from speech onset, and the payload carries up
 * to 2 s of pre-roll before it, plus a capture frame and the listen loop's
 * 200 ms poll past the cut (ui whisper-pcm-stt.ts PRE_BUFFER_MS, FRAME_SIZE):
 * about 12.5 s at most. The rest is room for one reopened utterance, which
 * re-sends the buffer with whatever was said while the first pass was in
 * flight. A session's longer turns stay metered whatever the flag says.
 */
export const SETUP_MAX_CLIP_SECONDS = 15;

/** deps.setupSttGlobalCap's one key: it counts every account together. */
const ALL_ACCOUNTS = '*';

/** The most of `x-stt-prior` forwarded, in characters, counted from the end
 *  (the words nearest the clip matter most). Bounds what reaches the provider
 *  whatever the client trims to. */
export const MAX_STT_PRIOR_CHARS = 600;

/**
 * The `x-stt-prior` header as a transcription prompt: percent-decoded, control
 * characters blanked, whitespace collapsed, and only the last
 * MAX_STT_PRIOR_CHARS characters kept. Undefined when the header is absent,
 * empty, or not valid percent-encoding: it is advisory and keys nothing, so a
 * bad one is dropped, never a 400.
 */
export function sttPrior(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return undefined;
    }
    const cleaned = decoded.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
    // By code point, so the cut can't split a surrogate pair.
    const tail = Array.from(cleaned).slice(-MAX_STT_PRIOR_CHARS).join('').trimStart();
    return tail || undefined;
}

/** One model's share of a request: what it bills and where. */
interface SttLegCost {
    model: string;
    provider: string;
    billedSeconds: number;
    cost: CostBreakdown;
}

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

        // Optional per-call model pick (the client picker's hosted options).
        // Allowlisted: the configured backend's models, or one of the models
        // served through OpenRouter. The model keys billing, so an arbitrary
        // value could otherwise name a cheaper rate - or make us forward
        // garbage upstream.
        const requestedModel = c.req.query('model');
        const viaOpenRouter = requestedModel !== undefined && Object.hasOwn(OPENROUTER_STT_MODELS, requestedModel);
        if (requestedModel && !viaOpenRouter && !sttModelChoices(stt).includes(requestedModel)) {
            return errorJson(c, 'bad_request', 'unknown stt model');
        }
        const openRouterKey = deps.config.providerKeys.openrouter;
        if (viaOpenRouter && !openRouterKey) {
            return errorJson(c, 'provider_error', 'this STT model is not configured on this server');
        }
        const model = requestedModel || stt.model;
        const provider = viaOpenRouter ? 'openrouter' : stt.provider;

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

        const sessionId = sessionIdOf(c.req.query('session_id'));
        const incident = serverIncidents(deps.store, { accountId: account.id, provider, model, sessionId });

        // A Parakeet request runs with gpt-transcribe behind it wherever the
        // backend offers that (providers/stt-hybrid.ts): a short clip goes
        // there instead, a longer one there as well on a failure or a stall.
        const hybrid = hybridApplies(model, stt);
        const reroute = hybrid && seconds <= HYBRID_SHORT_MAX_SEC;
        const hedged = hybrid && !reroute;
        const legOf = (legModel: string): SttLegCost => {
            const billed = sttBilledSeconds(seconds, legModel);
            return {
                model: legModel,
                provider: Object.hasOwn(OPENROUTER_STT_MODELS, legModel) ? 'openrouter' : stt.provider,
                billedSeconds: billed,
                cost: priceSttSeconds(billed, legModel),
            };
        };
        const planned = legOf(reroute ? HYBRID_STAND_IN : model);
        const billedSeconds = planned.billedSeconds;
        // The hold covers the dearest outcome, a hedge both providers bill, so
        // a request moved to the dearer model can't outrun its reservation.
        const standInCost = hedged ? legOf(HYBRID_STAND_IN).cost : null;
        const cost: CostBreakdown = standInCost
            ? {
                  providerCostUsd: planned.cost.providerCostUsd + standInCost.providerCostUsd,
                  credits: planned.cost.credits + standInCost.credits,
              }
            : planned.cost;

        // Both allowances are checked before either is spent, so a clip the
        // global one refuses doesn't eat into the account's.
        const setup = c.req.query('setup') === '1';
        const free =
            setup &&
            seconds <= SETUP_MAX_CLIP_SECONDS &&
            deps.setupSttDailyCap.fits(account.id, billedSeconds) &&
            deps.setupSttGlobalCap.fits(ALL_ACCOUNTS, billedSeconds);
        if (free) {
            deps.setupSttDailyCap.allow(account.id, billedSeconds);
            deps.setupSttGlobalCap.allow(ALL_ACCOUNTS, billedSeconds);
        }

        const gate = free ? null : await gateUpfront(deps, account.id, cost);
        if (gate && !gate.fits) {
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
        // Setup listening is prompted with the vocabulary built here from core,
        // and nothing from the request. Otherwise the one prompt a request can
        // carry is x-stt-prior: the caller's own transcript of this turn so
        // far, bounded and cleaned (sttPrior). Nothing checks that it is a
        // transcript, so it is accepted only because it is the caller's text
        // steering the caller's own result, on a clip billed by its audio
        // length; it keys no billing and is never logged. A free-form
        // `?prompt=` is still ignored. The OpenRouter models take no prompt
        // (OPENROUTER_STT_MODELS), so there the header goes nowhere, and
        // neither does gpt-transcribe standing in for Parakeet.
        // A model that bills the prompt (sttPromptIsBilled) gets no prior: the
        // meter counts audio only. If STT_MODEL rolls back to one, clients
        // still send pieces, they just go unprompted. The setup vocabulary
        // still reaches such a model, and is unmetered text there too.
        const prompt = setup
            ? (setupVocabulary(language ?? 'en').prompt ?? undefined)
            : sttPromptIsBilled(model)
              ? undefined
              : sttPrior(c.req.header('x-stt-prior'));

        const send = (legModel: string, signal?: AbortSignal): Promise<SttResult> => {
            const fetchImpl: typeof fetch | undefined = signal
                ? (input, init) => globalThis.fetch(input, { ...init, signal })
                : undefined;
            return Object.hasOwn(OPENROUTER_STT_MODELS, legModel)
                ? transcribeOpenRouter(samples, sampleRate, openRouterKey!, legModel, { language }, fetchImpl)
                : transcribeWhisper(
                      samples,
                      sampleRate,
                      { ...stt, model: legModel },
                      legModel === model ? { language, prompt } : { language },
                      fetchImpl
                  );
        };
        const deadlineMs = hybridDeadlineMs(seconds);
        // What a fallback or hedge did, for its rate on production: timings,
        // models and an upstream error's first line, never the audio or text.
        const hybridIncident = (route: 'fallback' | 'hedge', legs: readonly SttLeg[]): void => {
            const answered = legs.find((l) => l.end === 'answered');
            const head = [
                `${seconds.toFixed(1)}s:`,
                ...(route === 'hedge' ? [`deadline=${deadlineMs}ms`] : []),
                answered ? `served=${answered.model} at=${answered.ms}ms` : 'served=none',
            ].join(' ');
            const failures = legs
                .filter((l) => l.end === 'failed')
                .map((l) => `${l.model} failed at ${l.ms}ms: ${String(l.error)}`);
            incident(route === 'hedge' ? 'stt_hedge' : 'stt_fallback', [head, ...failures].join('; '));
        };

        let text: string;
        let served = planned;
        let billed = [planned];
        let route: SttRoute | undefined = reroute ? 'reroute' : undefined;
        try {
            let result: SttResult;
            if (hedged) {
                const h = await transcribeHedged(
                    { model, send: (signal) => send(model, signal) },
                    { model: HYBRID_STAND_IN, send: (signal) => send(HYBRID_STAND_IN, signal) },
                    deadlineMs
                );
                result = h.result;
                served = legOf(h.answered.model);
                billed = h.legs.filter(legIsBilled).map((l) => legOf(l.model));
                if (h.route) {
                    route = h.route;
                    hybridIncident(h.route, h.legs);
                }
            } else {
                result = await send(planned.model);
            }
            text = result.text;
            // The charge is our own count; the provider's is the tripwire for
            // a billing rule that has moved under it. Exact-second billers
            // report a float, so a hair of rounding isn't a moved rule.
            if (result.reportedSeconds !== undefined && Math.abs(result.reportedSeconds - served.billedSeconds) > 0.01) {
                log.warn('stt billed seconds differ from provider usage', {
                    model: served.model,
                    billedSeconds: served.billedSeconds,
                    reportedSeconds: result.reportedSeconds,
                });
            }
        } catch (err) {
            gate?.release();
            if (err instanceof HedgeFailed) hybridIncident(err.route, err.legs);
            log.error('stt forward failed', { err: String(err) });
            incident('stt_error', `${seconds.toFixed(1)}s: ${String(err)}`);
            return errorJson(c, 'provider_error', 'STT upstream error');
        }

        const usageOf = (leg: SttLegCost) => ({
            accountId: account.id,
            sessionId,
            kind: 'stt' as const,
            provider: leg.provider,
            model: leg.model,
            seconds: leg.billedSeconds,
            purpose: setup ? ('setup' as const) : null,
        });
        const answer = { text, model: served.model, ...(route ? { route } : {}) };
        if (!gate) {
            for (const leg of billed) {
                await recordUsage(deps.store, { ...usageOf(leg), providerCostUsd: leg.cost.providerCostUsd, credits: 0 });
            }
            return c.json({
                ...answer,
                creditsCharged: 0,
                creditsRemaining: await deps.ledger.balance(account.id),
            } satisfies TranscribeResponse);
        }
        const charged = await chargeUpfrontLegs(
            deps,
            gate,
            billed.map((leg) => ({ cost: leg.cost, usage: usageOf(leg) })),
            `stt:${billed.map((leg) => `${leg.provider}:${leg.billedSeconds.toFixed(1)}s`).join('+')}`
        );
        return c.json({ ...answer, ...charged } satisfies TranscribeResponse);
    });

    return app;
}
