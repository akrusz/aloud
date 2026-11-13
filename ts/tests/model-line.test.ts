import { describe, it, expect } from 'vitest';
import { compareVersions, modelLine } from '../src/llm/model-line.js';
import { followShortlist, lineSuccessor, type ModelOption } from '../ui/src/model-picker.js';

describe('modelLine', () => {
    it.each([
        ['anthropic/claude-opus-4-8', 'anthropic/claude-opus', [4, 8]],
        ['anthropic/claude-opus-5', 'anthropic/claude-opus', [5, 0]],
        ['anthropic/claude-fable-5-2', 'anthropic/claude-fable', [5, 2]],
        // A date stamp is not a version, wherever the version sits.
        ['anthropic/claude-haiku-4-5-20251001', 'anthropic/claude-haiku', [4, 5]],
        ['anthropic/claude-3-opus-20240229', 'anthropic/claude-opus', [3, 0]],
        ['openai/gpt-5.6-sol', 'openai/gpt-sol', [5, 6]],
        ['openai/gpt-6-sol', 'openai/gpt-sol', [6, 0]],
        ['openai/gpt-5.5', 'openai/gpt', [5, 5]],
        ['google/gemini-3.5-flash-lite', 'google/gemini-flash-lite', [3, 5]],
    ])('%s is %s %j', (id, line, version) => {
        expect(modelLine(id)).toEqual({ line, version });
    });

    it('finds no line in an id whose version is not a part of its own', () => {
        expect(modelLine('openrouter/moonshotai/kimi-k2')).toBeNull();
        expect(modelLine('sonnet')).toBeNull();
    });

    it('orders a two-digit minor after a one-digit one', () => {
        const v = (id: string) => modelLine(id)!.version;
        expect(compareVersions(v('claude-opus-5-10'), v('claude-opus-5-9'))).toBeGreaterThan(0);
        expect(compareVersions(v('claude-opus-5'), v('claude-opus-5-5'))).toBeLessThan(0);
    });
});

describe('lineSuccessor', () => {
    const option = (value: string, extra: Partial<ModelOption> = {}): ModelOption => ({ value, label: value, ...extra });
    const shortlist = [
        option('anthropic/claude-opus-5-5'),
        option('anthropic/claude-fable-5-2'),
        option('anthropic/claude-sonnet-5-5'),
        option('openai/gpt-6-sol'),
    ];

    it("moves a pick to its own line's newer version, not to the list's first model", () => {
        expect(lineSuccessor('anthropic/claude-fable-5-1', shortlist)).toBe(shortlist[1]);
        expect(lineSuccessor('anthropic/claude-opus-4-8', shortlist)).toBe(shortlist[0]);
        expect(lineSuccessor('openai/gpt-5.6-sol', shortlist)).toBe(shortlist[3]);
    });

    it('takes the newest when the shortlist carries two of a line', () => {
        const two = [option('anthropic/claude-haiku-5'), option('anthropic/claude-haiku-5-5')];
        expect(lineSuccessor('anthropic/claude-haiku-4-5-20251001', two)).toBe(two[1]);
    });

    it('has nothing for a line the shortlist does not carry, a different tier, or another provider', () => {
        expect(lineSuccessor('openai/gpt-5.6-terra', shortlist)).toBeNull();
        expect(lineSuccessor('openrouter/moonshotai/kimi-k2', shortlist)).toBeNull();
        expect(lineSuccessor('openrouter/anthropic/claude-opus-4-8', shortlist)).toBeNull();
    });

    it('never moves a pick down to an older version', () => {
        expect(lineSuccessor('anthropic/claude-opus-6', shortlist)).toBeNull();
        expect(lineSuccessor('anthropic/claude-opus-5-5', shortlist)).toBeNull();
    });

    it("leaves older picks where they are when the line's newest declines them", () => {
        const declining = [option('anthropic/claude-opus-5-5', { noAutoUpgrade: true }), ...shortlist.slice(1)];
        expect(lineSuccessor('anthropic/claude-opus-4-5', declining)).toBe('stay');
        // Other lines are unaffected.
        expect(lineSuccessor('anthropic/claude-fable-5-1', declining)).toBe(shortlist[1]);
    });
});

describe('followShortlist', () => {
    const option = (value: string, extra: Partial<ModelOption> = {}): ModelOption => ({ value, label: value, ...extra });
    const catalog = (opus55: Partial<ModelOption> = {}): ModelOption[] => [
        option('anthropic/claude-opus-5-5', { isDefault: true, ...opus55 }),
        option('anthropic/claude-fable-5-2'),
        option('anthropic/claude-fable-5-1', { expanded: true }),
        option('anthropic/claude-opus-4-5', { expanded: true }),
        option('openrouter/moonshotai/kimi-k2', { expanded: true }),
    ];
    const follow = (pick: string, models = catalog(), keepOffShortlist = false, deliberate: string[] = []): string =>
        followShortlist(pick, models, {
            offShortlist: (m) => m.expanded === true,
            keepOffShortlist,
            deliberate: new Set(deliberate),
        });

    it('leaves a shortlisted pick, and no pick, alone', () => {
        expect(follow('anthropic/claude-fable-5-2')).toBe('anthropic/claude-fable-5-2');
        expect(follow('')).toBe('');
    });

    it('moves a pick whose model was demoted to its newer version', () => {
        expect(follow('anthropic/claude-fable-5-1')).toBe('anthropic/claude-fable-5-2');
    });

    it('moves a pick whose model was delisted to its newer version', () => {
        expect(follow('anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-5-5');
    });

    it('hands a demoted or delisted pick with no newer version to the default', () => {
        expect(follow('openrouter/moonshotai/kimi-k2')).toBe('');
        expect(follow('openai/gpt-5.5')).toBe('');
    });

    it('keeps a demoted pick that was made off the shortlist, or under the keep setting', () => {
        expect(follow('anthropic/claude-fable-5-1', catalog(), false, ['anthropic/claude-fable-5-1'])).toBe(
            'anthropic/claude-fable-5-1'
        );
        expect(follow('anthropic/claude-fable-5-1', catalog(), true)).toBe('anthropic/claude-fable-5-1');
    });

    it('still moves a delisted pick under the keep setting: there is nothing to keep', () => {
        expect(follow('anthropic/claude-opus-4-8', catalog(), true, ['anthropic/claude-opus-4-8'])).toBe(
            'anthropic/claude-opus-5-5'
        );
    });

    it('with noAutoUpgrade on the newer version, a demoted pick stays and a delisted one takes the default', () => {
        const declining = catalog({ noAutoUpgrade: true });
        expect(follow('anthropic/claude-opus-4-5', declining)).toBe('anthropic/claude-opus-4-5');
        expect(follow('anthropic/claude-opus-4-8', declining)).toBe('');
    });
});
