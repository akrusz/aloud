import { describe, it, expect } from 'vitest';
import type { StreamChunk } from '@aloud/core/llm';
import { Forwarder } from '../src/providers/forward.js';
import { withholdThinking, withoutThinking } from '../src/providers/withheld-thinking.js';

const THINKING =
    "The user moved their leg and feels better, but now they're wondering about their breath. Keep it brief.";

async function* chunks(parts: string[]): AsyncIterable<StreamChunk> {
    for (const text of parts) yield { text, done: false };
    yield { text: '', done: true, finishReason: 'stop', outputTokens: 40 };
}

async function collect(parts: string[]): Promise<StreamChunk[]> {
    const out: StreamChunk[] = [];
    for await (const c of withholdThinking(chunks(parts))) out.push(c);
    return out;
}

const textOf = (out: StreamChunk[]): string => out.map((c) => c.text).join('');

describe('withholdThinking', () => {
    it('passes an ordinary reply on as it arrives', async () => {
        const out = await collect(['What', "'s here", ' now?']);
        expect(out.map((c) => c.text)).toEqual(['What', "'s here", ' now?', '']);
        expect(out.at(-1)).toMatchObject({ done: true, finishReason: 'stop', outputTokens: 40 });
        expect(out.at(-1)!.diagnostics).toBeUndefined();
    });

    it('lets go of a reply that only starts like the opening', async () => {
        expect(textOf(await collect(['The', 're is', ' no rush.']))).toBe('There is no rush.');
        expect(textOf(await collect(['The']))).toBe('The');
    });

    it('holds thinking back and sends the reply behind its closing tag', async () => {
        const out = await collect([' The us', `er${THINKING.slice(8)}</thi`, 'nk>[WAIT:5m] What happens', ' if you let it be?']);
        expect(textOf(out)).toBe('[WAIT:5m] What happens if you let it be?');
        expect(out[0]!.text).toBe('[WAIT:5m] What happens');
        expect(out.at(-1)!.diagnostics!.reasoningChars).toBe(` ${THINKING}</think>`.length);
    });

    it('sends a blank turn when the thinking never closes', async () => {
        const out = await collect([THINKING, '  What does that feel like?']);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ text: '', done: true, outputTokens: 40 });
        expect(out[0]!.diagnostics!.reasoningChars).toBeGreaterThan(THINKING.length);
    });
});

describe('withoutThinking', () => {
    it('keeps the reply behind the tag, and nothing when there is no tag', () => {
        const base = { finishReason: 'stop', tokensUsed: null };
        expect(withoutThinking({ ...base, text: `${THINKING}</think>Where is it now?` }).text).toBe('Where is it now?');
        expect(withoutThinking({ ...base, text: THINKING }).text).toBe('');
        const plain = { ...base, text: 'Where is it now?' };
        expect(withoutThinking(plain)).toBe(plain);
    });
});

describe('Forwarder', () => {
    const answer = (content: string): typeof fetch =>
        (async () =>
            new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })) as typeof fetch;

    it('holds thinking back for the Kimi slot and for no other model', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = answer(`${THINKING}</think>Where is it now?`);
        try {
            const fwd = new Forwarder({ openrouter: 'or-test' });
            const kimi = await fwd.complete([{ role: 'user', content: 'hi' }], { provider: 'openrouter', model: 'moonshotai/kimi-k2' });
            expect(kimi.text).toBe('Where is it now?');
            const other = await fwd.complete([{ role: 'user', content: 'hi' }], { provider: 'openrouter', model: 'somebody/else' });
            expect(other.text).toContain(THINKING);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});
