import { describe, it, expect } from 'vitest';

import {
    buildSmartCheckinEvent,
    checkinSuggestionFor,
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

    // A pass is not a check-in "with no reply": the model is told what it did,
    // and that a second pass is for silence the meditator asked for.
    it('after a pass, says so and raises the bar for passing again', () => {
        const text = buildSmartCheckinEvent(780, 1, { passedSecAgo: 600 });
        expect(text).toContain('quiet for about 13 minutes');
        expect(text).toContain('You stayed quiet at the last check-in, about 10 minutes ago');
        expect(text).toContain('so nothing has been said since your last reply');
        expect(text).toContain('Stay quiet again only if they asked for silence or for space.');
        expect(text).not.toContain('already');
        expect(buildSmartCheckinEvent(300, 1)).not.toContain('stayed quiet');
        expect(buildSmartCheckinEvent(300, 1, { passedSecAgo: null })).not.toContain('stayed quiet');
    });

    it('a pass after an unanswered spoken check-in is stated, with no bar raised', () => {
        const text = buildSmartCheckinEvent(600, 2, { passedSecAgo: 300 });
        expect(text).toContain('1 time already with no reply. You stayed quiet at the last check-in, about 5 minutes ago.');
        expect(text).not.toContain('Stay quiet again only');
    });

    it('mentions [WAIT:Nm] only when the wait hint is on', () => {
        expect(buildSmartCheckinEvent(300, 1)).not.toContain('[WAIT:');
        expect(buildSmartCheckinEvent(300, 1, { withWaitHint: true })).toContain('[WAIT:Nm]');
    });

    it('maps the guidance slider onto the tiers', () => {
        expect(checkinSuggestionFor(0)).toBe('none');
        expect(checkinSuggestionFor(3)).toBe('offered');
        expect(checkinSuggestionFor(7)).toBe('offered');
        expect(checkinSuggestionFor(10)).toBe('expected');
    });

    it('scales how much the line may steer with the suggestion tier', () => {
        const none = buildSmartCheckinEvent(300, 1);
        expect(none).toContain('one short sentence');
        expect(none).not.toContain('suggestion');
        const offered = buildSmartCheckinEvent(300, 1, { suggestion: 'offered' });
        expect(offered).toContain('one short sentence');
        expect(offered).toContain('a suggestion');
        const expected = buildSmartCheckinEvent(300, 1, { suggestion: 'expected' });
        expect(expected).not.toContain('one short sentence');
        expect(expected).toContain('a suggestion');
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
            waitSec: null,
        });
    });

    it('passes on [PASS]', () => {
        expect(parseSmartCheckinReply('[PASS]')).toEqual({ kind: 'pass', waitSec: null });
    });

    it('passes on [PASS] with trailing chatter', () => {
        expect(parseSmartCheckinReply('[PASS] Silence serves them.')).toEqual({ kind: 'pass', waitSec: null });
    });

    it('passes on a bare unbracketed "pass" (small model flubbing the format)', () => {
        expect(parseSmartCheckinReply('PASS')).toEqual({ kind: 'pass', waitSec: null });
        expect(parseSmartCheckinReply('pass.')).toEqual({ kind: 'pass', waitSec: null });
        expect(parseSmartCheckinReply('"pass"')).toEqual({ kind: 'pass', waitSec: null });
    });

    it('does not treat a sentence containing "pass" as a pass', () => {
        expect(parseSmartCheckinReply('Let that pass through you.')).toEqual({
            kind: 'speak',
            text: 'Let that pass through you.',
            waitSec: null,
        });
    });

    it('scrubs a misplaced mid-text token from the spoken line', () => {
        expect(parseSmartCheckinReply('Still here. [HOLD] No rush.')).toEqual({
            kind: 'speak',
            text: 'Still here. No rush.',
            waitSec: null,
        });
    });

    it('treats [HOLD] as a pass (no unconfirmed silence mode)', () => {
        expect(parseSmartCheckinReply('[HOLD] Staying quiet.')).toEqual({ kind: 'pass', waitSec: null });
    });

    it('is case-insensitive on tokens', () => {
        expect(parseSmartCheckinReply('[pass]')).toEqual({ kind: 'pass', waitSec: null });
    });

    it('strips stray leading control tokens and speaks the rest', () => {
        expect(parseSmartCheckinReply('[NEXT] What do you notice?')).toEqual({
            kind: 'speak',
            text: 'What do you notice?',
            waitSec: null,
        });
    });

    it('strips a <think> block first', () => {
        expect(parseSmartCheckinReply('<think>should I speak?</think>[PASS]')).toEqual({
            kind: 'pass',
            waitSec: null,
        });
        expect(parseSmartCheckinReply('<think>hmm</think>Still here.')).toEqual({
            kind: 'speak',
            text: 'Still here.',
            waitSec: null,
        });
    });

    it('captures [WAIT:Nm] on a pass', () => {
        expect(parseSmartCheckinReply('[PASS][WAIT:15m]')).toEqual({
            kind: 'pass',
            waitSec: 900,
        });
        expect(parseSmartCheckinReply('[WAIT:15m] [PASS]')).toEqual({
            kind: 'pass',
            waitSec: 900,
        });
    });

    it('captures [WAIT:Nm] on a spoken line', () => {
        expect(parseSmartCheckinReply('[WAIT:5m] Take your time.')).toEqual({
            kind: 'speak',
            text: 'Take your time.',
            waitSec: 300,
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
            waitSec: null,
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
        expect(reply).toEqual({ kind: 'speak', text: 'Still with you.', waitSec: null });
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
