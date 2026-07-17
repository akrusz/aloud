import { describe, it, expect } from 'vitest';

import {
    buildSmartCheckinEvent,
    isSmartCheckinEvent,
    parseSmartCheckinReply,
    runSmartCheckin,
    PASS_PREFIX,
    SMART_CHECKIN_EVENT_PREFIX,
    SMART_CHECKIN_MAX_CHARS,
    SMART_CHECKIN_MAX_TOKENS,
} from '../src/facilitation/smart-checkin.js';
import type { LLMProvider, CompletionResult, Message, CompletionOptions } from '../src/llm/index.js';

class StubProvider implements LLMProvider {
    readonly model = 'stub';
    seenSystem: string | undefined = undefined;
    seenMessages: Message[] = [];
    seenMaxTokens: number | undefined = undefined;
    constructor(private readonly response: string | Error) {}
    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        this.seenMessages = messages;
        this.seenSystem = options.system;
        this.seenMaxTokens = options.maxTokens;
        if (this.response instanceof Error) throw this.response;
        return {
            text: this.response,
            finishReason: 'stop',
            tokensUsed: null,
            inputTokens: 120,
            outputTokens: 8,
            cacheReadTokens: 100,
        };
    }
}

describe('buildSmartCheckinEvent', () => {
    it('starts with the stable prefix and names the duration', () => {
        const text = buildSmartCheckinEvent(300, 1);
        expect(text.startsWith(SMART_CHECKIN_EVENT_PREFIX)).toBe(true);
        expect(text).toContain('about 5 minutes');
        expect(text).toContain(PASS_PREFIX);
    });

    it('says "about a minute" for short silences', () => {
        expect(buildSmartCheckinEvent(60, 1)).toContain('about a minute');
    });

    it('mentions prior unanswered check-ins from the second one on', () => {
        expect(buildSmartCheckinEvent(300, 1)).not.toContain('already');
        expect(buildSmartCheckinEvent(600, 2)).toContain('1 time already');
        expect(buildSmartCheckinEvent(900, 3)).toContain('2 times already');
    });

    it('round-trips through isSmartCheckinEvent', () => {
        expect(isSmartCheckinEvent(buildSmartCheckinEvent(300, 1))).toBe(true);
        expect(isSmartCheckinEvent('I feel some tightness')).toBe(false);
    });
});

describe('parseSmartCheckinReply', () => {
    it('speaks a short line as-is', () => {
        expect(parseSmartCheckinReply('Take your time with that heaviness.')).toEqual({
            kind: 'speak',
            text: 'Take your time with that heaviness.',
        });
    });

    it('passes on [PASS]', () => {
        expect(parseSmartCheckinReply('[PASS]')).toEqual({ kind: 'pass' });
    });

    it('passes on [PASS] with trailing chatter', () => {
        expect(parseSmartCheckinReply('[PASS] Silence serves them.')).toEqual({ kind: 'pass' });
    });

    it('treats [HOLD] as a pass (no unconfirmed silence mode)', () => {
        expect(parseSmartCheckinReply('[HOLD] Staying quiet.')).toEqual({ kind: 'pass' });
    });

    it('is case-insensitive on tokens', () => {
        expect(parseSmartCheckinReply('[pass]')).toEqual({ kind: 'pass' });
    });

    it('strips stray leading control tokens and speaks the rest', () => {
        expect(parseSmartCheckinReply('[NEXT] What do you notice?')).toEqual({
            kind: 'speak',
            text: 'What do you notice?',
        });
    });

    it('strips a <think> block first', () => {
        expect(parseSmartCheckinReply('<think>should I speak?</think>[PASS]')).toEqual({
            kind: 'pass',
        });
        expect(parseSmartCheckinReply('<think>hmm</think>Still here.')).toEqual({
            kind: 'speak',
            text: 'Still here.',
        });
    });

    it('falls back on an empty reply', () => {
        expect(parseSmartCheckinReply('')).toEqual({ kind: 'fallback' });
        expect(parseSmartCheckinReply('   ')).toEqual({ kind: 'fallback' });
    });

    it('salvages the first sentence of a rambling reply', () => {
        const ramble = `I'm right here with you. ${'Also, '.repeat(60)}and more.`;
        expect(ramble.length).toBeGreaterThan(SMART_CHECKIN_MAX_CHARS);
        expect(parseSmartCheckinReply(ramble)).toEqual({
            kind: 'speak',
            text: "I'm right here with you.",
        });
    });

    it('falls back when even the first sentence is too long', () => {
        const run = `${'word '.repeat(80)}word.`;
        expect(parseSmartCheckinReply(run)).toEqual({ kind: 'fallback' });
    });
});

describe('runSmartCheckin', () => {
    const messages: Message[] = [
        { role: 'user', content: 'settling in' },
        { role: 'assistant', content: 'What do you notice?' },
        { role: 'user', content: buildSmartCheckinEvent(300, 1) },
    ];

    it('returns the parsed reply and the usage split', async () => {
        const provider = new StubProvider('Still with you.');
        const { reply, usage } = await runSmartCheckin(provider, messages, { system: 'sys' });
        expect(reply).toEqual({ kind: 'speak', text: 'Still with you.' });
        expect(usage).toMatchObject({ tokensIn: 120, tokensOut: 8, cacheRead: 100 });
        expect(provider.seenSystem).toBe('sys');
        expect(provider.seenMaxTokens).toBe(SMART_CHECKIN_MAX_TOKENS);
        expect(provider.seenMessages).toHaveLength(3);
    });

    it('propagates provider errors (caller falls back)', async () => {
        const provider = new StubProvider(new Error('boom'));
        await expect(runSmartCheckin(provider, messages)).rejects.toThrow('boom');
    });
});
