/**
 * Streaming-branch hold lifecycle for /cloud/v1/llm/complete: the pre-auth hold
 * must always be closed — settled to the real cost when the provider's done
 * chunk arrives, or released when the stream ends without one (client
 * disconnect, upstream abort). An unclosed hold would silently park
 * SESSION_HOLD_CREDITS of the user's balance forever.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps, type Deps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { Forwarder } from '../src/providers/forward.js';
import type { AuthResponse } from '../src/contract.js';

/** A stream that completes normally: deltas, then a done chunk with usage. */
function completingForwarder(): Forwarder {
    return {
        async *stream() {
            yield { text: 'Breathe', done: false };
            yield {
                text: ' in.',
                done: true,
                finishReason: 'stop',
                inputTokens: 1000,
                outputTokens: 100,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
            };
        },
    } as unknown as Forwarder;
}

/** A stream that dies mid-flight: deltas, then the generator just ends —
 *  no done chunk, so no usage ever arrives (disconnect/abort shape). */
function truncatedForwarder(): Forwarder {
    return {
        async *stream() {
            yield { text: 'Breathe', done: false };
            yield { text: ' in', done: false };
        },
    } as unknown as Forwarder;
}

async function setup(forwarder: Forwarder): Promise<{ deps: Deps; app: ReturnType<typeof createApp>; token: string; accountId: string }> {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        GEMINI_API_KEY: 'gk-test',
        ALOUD_FREE_SIGNUP_CREDITS: '20',
    });
    const deps = buildDeps(config);
    deps.forwarder = forwarder;
    const app = createApp(deps);
    const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    const token = ((await res.json()) as AuthResponse).token;
    const accountId = (await deps.store.allAccounts())[0]!.id;
    return { deps, app, token, accountId };
}

function streamComplete(app: ReturnType<typeof createApp>, token: string) {
    return app.request('/cloud/v1/llm/complete', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            provider: 'google',
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
        }),
    });
}

describe('streaming hold lifecycle', () => {
    it('settles the hold to the actual cost on a completed stream', async () => {
        const { deps, app, token, accountId } = await setup(completingForwarder());
        const res = await streamComplete(app, token);
        expect(res.status).toBe(200);
        await res.text(); // drain the SSE so the handler runs to completion

        const balance = await deps.ledger.balance(accountId);
        // Charged the (tiny, fractional) real cost — not the 10-credit hold.
        expect(balance).toBeLessThan(20);
        expect(balance).toBeGreaterThan(19);
        // No hold left outstanding: every hold has a matching release.
        const entries = await deps.store.listEntries(accountId);
        const held = entries.filter((e) => e.kind === 'hold').reduce((s, e) => s + e.amount, 0);
        const released = entries.filter((e) => e.kind === 'hold_release').reduce((s, e) => s + e.amount, 0);
        expect(held + released).toBeCloseTo(0, 9);
    });

    it('releases the hold when the stream ends without a done chunk', async () => {
        const { deps, app, token, accountId } = await setup(truncatedForwarder());
        const res = await streamComplete(app, token);
        expect(res.status).toBe(200);
        await res.text();

        // No usage ever arrived → nothing billed, hold fully released.
        expect(await deps.ledger.balance(accountId)).toBe(20);
        const entries = await deps.store.listEntries(accountId);
        expect(entries.some((e) => e.kind === 'hold')).toBe(true); // a hold WAS placed
        expect(entries.some((e) => e.kind === 'debit')).toBe(false); // but never charged
    });
});
