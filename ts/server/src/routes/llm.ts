/**
 * POST /v1/llm/complete — the metered proxy. The hot path and the only route
 * that sees meditation content (forwarded, never stored — see logger.ts).
 *
 * Per turn:
 *   1. rate-guard the account (meditation-pal-2yb)
 *   2. validate provider+model against the allowlist (no billing arbitrary models)
 *   3. place a pre-auth hold (meditation-pal-8sj)
 *   4. forward to the provider, reusing core's usage parsing
 *   5. settle the hold to the ACTUAL metered cost, releasing the remainder
 *
 * Supports streaming (SSE) and non-streaming. Either way the response carries
 * creditsCharged + creditsRemaining so the client's cost meter (meditation-pal-14s)
 * updates without a second round-trip.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
    ERROR_STATUS,
    apiError,
    type CompleteChunk,
    type CompleteRequest,
    type CompleteResponse,
} from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { isMeteredBlocked, FREE_LIMIT_MESSAGE, BILLING_PAUSED_FINISH } from '../admin/runtime-config.js';
import { isModelAllowed } from '../pricing/providers.js';
import { SESSION_HOLD_CREDITS, MAX_OUTPUT_TOKENS, priceLlmTurn, type CostBreakdown } from '../pricing/meter.js';
import { usageOf } from '../providers/forward.js';
import { InsufficientCreditsError } from '../credits/ledger.js';
import { recordUsage } from '../credits/usage.js';
import { activeRetreatCoverage } from '../credits/retreat.js';
import type { LlmUsage } from '@aloud/core/facilitation';
import type { ProviderId } from '../contract.js';
import { log } from '../logger.js';

/** Best-effort cost-attribution write for one settled LLM turn (usage.ts). */
function recordLlmUsage(
    deps: Deps,
    accountId: string,
    provider: ProviderId,
    model: string,
    usage: LlmUsage,
    cost: CostBreakdown,
    passId: string | null,
    sessionId: string | null
): Promise<void> {
    return recordUsage(deps.store, {
        accountId,
        kind: 'llm',
        provider,
        model,
        sessionId,
        tokensIn: usage.tokensIn ?? 0,
        tokensOut: usage.tokensOut ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheCreation: usage.cacheCreation ?? 0,
        cacheCreation1h: usage.cacheCreation1h ?? 0,
        seconds: 0,
        chars: 0,
        providerCostUsd: cost.providerCostUsd,
        // Always the metered (would-be) credits, even when a pass covers the
        // turn — so per-retreat spend and the daily-cap sum both stay honest.
        credits: cost.credits,
        passId,
    });
}

const VALID_PROVIDERS = new Set(['anthropic', 'groq', 'openrouter', 'google']);

export function llmRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.post('/complete', requireAuth(deps), async (c) => {
        const account = c.get('account');

        if (!deps.rateGuard.allow(account.id)) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }

        const body = (await c.req.json().catch(() => ({}))) as Partial<CompleteRequest>;
        if (!body.provider || !VALID_PROVIDERS.has(body.provider) || !body.model || !Array.isArray(body.messages)) {
            return c.json(apiError('bad_request', 'provider, model, messages required'), ERROR_STATUS.bad_request);
        }
        if (!isModelAllowed(body.provider, body.model)) {
            return c.json(
                apiError('model_not_allowed', `model not available on aloud cloud: ${body.provider}/${body.model}`),
                ERROR_STATUS.model_not_allowed
            );
        }

        // Soft-launch pause: a non-tester account can't spend on conversation
        // yet. Rather than erroring (which would break a session mid-flow), the
        // facilitator returns a graceful canned turn — TTS speaks it, the
        // transcript keeps it, and the session saves cleanly. No hold, no charge.
        // (Testers bypass; see isMeteredBlocked.) STT/TTS stay open so the
        // message can be heard. A live in-session reload is a follow-up bead.
        if (isMeteredBlocked(deps, account.email)) {
            const paused: CompleteResponse = {
                text: FREE_LIMIT_MESSAGE,
                // Sentinel (not 'stop') so the client keeps this turn out of the
                // saved transcript and resumes from the last real one.
                finishReason: BILLING_PAUSED_FINISH,
                creditsCharged: 0,
                creditsRemaining: await deps.ledger.balance(account.id),
            };
            if (body.stream) {
                return streamSSE(c, async (sse) => {
                    await sse.writeSSE({
                        data: JSON.stringify({ text: FREE_LIMIT_MESSAGE, done: false } satisfies CompleteChunk),
                    });
                    await sse.writeSSE({
                        data: JSON.stringify({ text: '', done: true, result: paused } satisfies CompleteChunk),
                    });
                });
            }
            return c.json(paused);
        }

        // A retreat pass (meditation-pal-414) covers this turn: forward with no
        // hold and no charge, but still record usage (tagged with the pass). When
        // there's no pass, holdId stays null and we take the normal metered path.
        const pass = await activeRetreatCoverage(deps.store, account.id, Date.now() / 1000);

        // Hold up to the per-turn cap, bounded by what the user actually has.
        let holdId: string | null = null;
        if (!pass) {
            const balance = await deps.ledger.balance(account.id);
            if (balance <= 0) {
                return c.json(apiError('insufficient_credits', 'out of credits'), ERROR_STATUS.insufficient_credits);
            }
            const holdAmount = Math.min(SESSION_HOLD_CREDITS, balance);
            try {
                holdId = await deps.ledger.placeHold(account.id, holdAmount, `turn:${body.provider}:${body.model}`);
            } catch (err) {
                if (err instanceof InsufficientCreditsError) {
                    return c.json(apiError('insufficient_credits', 'out of credits'), ERROR_STATUS.insufficient_credits);
                }
                throw err;
            }
        }

        const fwd = {
            provider: body.provider,
            model: body.model,
            // Clamp output length server-side — the client can't request a
            // turn pricier than the pre-auth hold was sized for (meditation-pal-aa8).
            maxTokens: Math.min(body.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
            ...(body.system ? { system: body.system } : {}),
        };
        const reason = `llm:${body.provider}:${body.model}`;
        // Opaque per-session grouping id, when the client sends one (usage.ts).
        const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;

        // ---- streaming branch ----
        if (body.stream) {
            return streamSSE(c, async (sse) => {
                let settled = false;
                try {
                    let final: CompleteResponse | undefined;
                    for await (const chunk of deps.forwarder.stream(body.messages!, fwd)) {
                        if (!chunk.done) {
                            await sse.writeSSE({ data: JSON.stringify({ text: chunk.text, done: false } satisfies CompleteChunk) });
                            continue;
                        }
                        const usage = usageOf(chunk);
                        const cost = priceLlmTurn(body.provider!, body.model!, usage);
                        if (holdId) await deps.ledger.settleHold(account.id, holdId, cost.credits, reason);
                        settled = true;
                        await recordLlmUsage(deps, account.id, body.provider!, body.model!, usage, cost, pass?.id ?? null, sessionId);
                        final = {
                            text: chunk.text,
                            finishReason: chunk.finishReason ?? null,
                            // A pass-covered turn is free; the balance is untouched.
                            creditsCharged: pass ? 0 : cost.credits,
                            creditsRemaining: await deps.ledger.balance(account.id),
                        };
                    }
                    const terminal: CompleteChunk = { text: '', done: true, ...(final ? { result: final } : {}) };
                    await sse.writeSSE({ data: JSON.stringify(terminal) });
                } catch (err) {
                    log.error('stream forward failed', { err: String(err), provider: body.provider });
                    if (!settled && holdId) await deps.ledger.releaseHold(account.id, holdId);
                    await sse.writeSSE({ event: 'error', data: JSON.stringify(apiError('provider_error', 'upstream provider error')) });
                }
            });
        }

        // ---- non-streaming branch ----
        try {
            const result = await deps.forwarder.complete(body.messages, fwd);
            const usage = usageOf(result);
            const cost = priceLlmTurn(body.provider, body.model, usage);
            if (holdId) await deps.ledger.settleHold(account.id, holdId, cost.credits, reason);
            await recordLlmUsage(deps, account.id, body.provider, body.model, usage, cost, pass?.id ?? null, sessionId);
            const response: CompleteResponse = {
                text: result.text,
                finishReason: result.finishReason,
                // A pass-covered turn is free; the balance is untouched.
                creditsCharged: pass ? 0 : cost.credits,
                creditsRemaining: await deps.ledger.balance(account.id),
            };
            return c.json(response);
        } catch (err) {
            log.error('forward failed', { err: String(err), provider: body.provider });
            if (holdId) await deps.ledger.releaseHold(account.id, holdId);
            return c.json(apiError('provider_error', 'upstream provider error'), ERROR_STATUS.provider_error);
        }
    });

    return app;
}
