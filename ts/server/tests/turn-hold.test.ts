/**
 * Per-turn hold sizing (meditation-pal-hd24). A flat SESSION_HOLD_CREDITS hold
 * clamped to the balance parked a sub-10 balance in full for every LLM turn,
 * and the turn's own TTS/STT legs - which gate on spendable balance while the
 * hold is open - 402'd mid-reply. The hold is now sized from the request and
 * always leaves a sidecar reserve spendable.
 */

import { describe, it, expect } from 'vitest';
import {
    estimateTokens,
    holdForTurn,
    holdAgainstBalance,
    SESSION_HOLD_CREDITS,
    TURN_SIDECAR_RESERVE_CREDITS,
    MAX_OUTPUT_TOKENS,
} from '../src/pricing/meter.js';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { Forwarder } from '../src/providers/forward.js';
import type { AuthResponse } from '../src/contract.js';

describe('estimateTokens', () => {
    it('bounds English above the ~4 chars/token it really runs at', () => {
        const text = 'Notice the breath moving in and out of the body, without changing it.';
        expect(estimateTokens(text)).toBeGreaterThan(text.length / 4);
        expect(estimateTokens(text)).toBeLessThanOrEqual(text.length / 3 + 1);
    });
    it('counts each non-ASCII character as a token', () => {
        expect(estimateTokens('觉察呼吸')).toBe(4);
        expect(estimateTokens('')).toBe(0);
    });
});

describe('holdForTurn', () => {
    // A realistic facilitation turn: ~4k-token system prompt + a few exchanges.
    const system = 'x'.repeat(12_000);
    const history = Array.from({ length: 6 }, () => 'y'.repeat(400));

    it('sizes a Fable turn to a few credits, not the 10-credit cap', () => {
        const hold = holdForTurn('anthropic', 'claude-fable-5-1', [system, ...history], MAX_OUTPUT_TOKENS);
        expect(hold).toBeGreaterThan(0.5);
        expect(hold).toBeLessThan(SESSION_HOLD_CREDITS / 2);
    });

    it('sizes a cheap model turn to a fraction of a credit', () => {
        const hold = holdForTurn('google', 'gemini-2.5-flash-lite', [system, ...history], MAX_OUTPUT_TOKENS);
        expect(hold).toBeLessThan(0.1);
    });

    it('caps a pathological prompt at SESSION_HOLD_CREDITS', () => {
        const hold = holdForTurn('anthropic', 'claude-fable-5-1', ['x'.repeat(2_000_000)], MAX_OUTPUT_TOKENS);
        expect(hold).toBe(SESSION_HOLD_CREDITS);
    });

    it('falls back to the cap for a model outside the price table', () => {
        expect(holdForTurn('anthropic', 'claude-nope', ['hi'], 100)).toBe(SESSION_HOLD_CREDITS);
    });
});

describe('holdAgainstBalance', () => {
    it('holds the estimate when the balance comfortably covers it', () => {
        expect(holdAgainstBalance(2, 8.5)).toBe(2);
    });
    it('never takes the whole balance: the sidecar reserve stays spendable', () => {
        // The reporter's shape - about one cloud left on a Fable session.
        expect(holdAgainstBalance(3, 1)).toBeCloseTo(1 - TURN_SIDECAR_RESERVE_CREDITS, 9);
        // Under the reserve it takes half, so tiny balances still turn over.
        expect(holdAgainstBalance(3, 0.2)).toBeCloseTo(0.1, 9);
    });
    it('never goes negative', () => {
        expect(holdAgainstBalance(0, 0.2)).toBe(0);
    });
});

/** A stream whose done chunk arrives after the test has read the balance
 *  mid-turn, standing in for the reply's first TTS sentence. */
function gatedForwarder(midTurn: () => Promise<void>): Forwarder {
    return {
        async *stream() {
            yield { text: 'Breathe', done: false };
            await midTurn();
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

describe('LLM route hold at a small balance', () => {
    it('leaves balance spendable for the TTS leg while the turn is open', async () => {
        const config = loadConfig({
            ALOUD_ENABLE_DEV_AUTH: '1',
            GEMINI_API_KEY: 'gk-test',
            ALOUD_FREE_SIGNUP_CREDITS: '1',
        });
        const deps = buildDeps(config);
        let midTurnBalance = -1;
        let accountId = '';
        deps.forwarder = gatedForwarder(async () => {
            midTurnBalance = await deps.ledger.balance(accountId);
        });
        const app = createApp(deps);
        const auth = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
        const token = ((await auth.json()) as AuthResponse).token;
        accountId = (await deps.store.allAccounts())[0]!.id;

        const res = await app.request('/cloud/v1/llm/complete', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                provider: 'google',
                model: 'gemini-2.5-flash-lite',
                system: 'x'.repeat(12_000),
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
            }),
        });
        expect(res.status).toBe(200);
        await res.text();

        // Before the fix this read 0: the whole 1-credit balance sat in the hold.
        expect(midTurnBalance).toBeGreaterThan(TURN_SIDECAR_RESERVE_CREDITS);
        const entries = await deps.store.listEntries(accountId);
        const held = entries.filter((e) => e.kind === 'hold').reduce((s, e) => s + e.amount, 0);
        const released = entries.filter((e) => e.kind === 'hold_release').reduce((s, e) => s + e.amount, 0);
        expect(held + released).toBeCloseTo(0, 9);
        expect(await deps.ledger.balance(accountId)).toBeLessThan(1);
    });
});
