import { describe, it, expect, vi } from 'vitest';

import { createFakeClock } from '../src/clock.js';
import { classifyTrouble } from '../src/facilitation/resume-intent.js';
import { STEPPING_OUT_NOTE, TROUBLE_SYSTEM_PROMPT } from '../src/facilitation/prompts.js';
import { SessionManager, spokenExchanges } from '../src/facilitation/session.js';
import { localCheckFits, TROUBLE_LOCAL_BUDGET_MS, wantsTroubleCheck } from '../src/facilitation/stepping-out.js';
import { UtterancePrefetch } from '../src/facilitation/utterance-prefetch.js';
import { JUDGE_SPECS, type JudgeAnswers, type UtteranceJudge } from '../src/facilitation/utterance-judge.js';
import type { CompletionOptions, CompletionResult, LLMProvider, Message } from '../src/llm/index.js';

class StubProvider implements LLMProvider {
    readonly model = 'stub';
    calls = 0;
    seenSystem: string | undefined;
    constructor(private readonly response: string | Error) {}
    async complete(_messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        this.calls++;
        this.seenSystem = options.system;
        if (this.response instanceof Error) throw this.response;
        return { text: this.response, finishReason: 'stop', tokensUsed: null };
    }
}

const judgeOf = (answers: JudgeAnswers | Error): UtteranceJudge => ({
    async judge() {
        if (answers instanceof Error) throw answers;
        return answers;
    },
});

describe('wantsTroubleCheck', () => {
    it('covers every local model, whatever it is called', () => {
        expect(wantsTroubleCheck('ollama', 'qwen3.5:4b')).toBe(true);
        expect(wantsTroubleCheck('ollama', 'something-new:70b')).toBe(true);
    });

    it('covers the cloud models measured to miss, on any provider that carries them', () => {
        expect(wantsTroubleCheck('aloud', 'moonshotai/kimi-k2')).toBe(true);
        expect(wantsTroubleCheck('openrouter', 'moonshotai/kimi-k2-0905')).toBe(true);
        expect(wantsTroubleCheck('openrouter', 'moonshotai/kimi-k2.6')).toBe(true);
        expect(wantsTroubleCheck('aloud', 'gpt-5-nano')).toBe(true);
    });

    it('leaves the models that step out on their own alone', () => {
        for (const model of ['claude-opus-5-5', 'claude-haiku-5-5', 'gpt-6-sol', 'gpt-6-luna', 'gemini-3.5-flash-lite']) {
            expect(wantsTroubleCheck('aloud', model), model).toBe(false);
        }
        // Unmeasured, so not assumed to share K2's result.
        expect(wantsTroubleCheck('openrouter', 'moonshotai/kimi-k2.5')).toBe(false);
        expect(wantsTroubleCheck('openrouter', 'moonshotai/kimi-k3')).toBe(false);
    });
});

describe('localCheckFits', () => {
    it('never lets an unmeasured check stand in front of a reply', () => {
        expect(localCheckFits(null, 0)).toBe(false);
    });

    it('lets a quick check go first, and a slow one only once most of it has run', () => {
        // qwen3.5:4b on an M-series GPU.
        expect(localCheckFits(280, 0)).toBe(true);
        // The same model with the GPU off: too slow to start at submit...
        expect(localCheckFits(1200, 0)).toBe(false);
        // ...but worth waiting out when the pause already covered most of it.
        expect(localCheckFits(1200, 1200 - TROUBLE_LOCAL_BUDGET_MS)).toBe(true);
        expect(localCheckFits(1200, 1200 - TROUBLE_LOCAL_BUDGET_MS - 1)).toBe(false);
    });
});

describe('classifyTrouble', () => {
    it('reads the one-word verdict off the trouble prompt', async () => {
        const yes = new StubProvider('YES');
        expect(await classifyTrouble(yes, "I can't tell where I am")).toBe(true);
        expect(yes.seenSystem).toBe(TROUBLE_SYSTEM_PROMPT);
        expect(await classifyTrouble(new StubProvider('NO'), 'warm hands')).toBe(false);
    });

    it('is false when the call fails: a broken check must not cost a turn', async () => {
        expect(await classifyTrouble(new StubProvider(new Error('429')), 'anything')).toBe(false);
    });

    it('takes a yes from either ask on a judge session, each at its own threshold', async () => {
        const llm = new StubProvider('NO');
        const { frightened, danger } = JUDGE_SPECS.trouble.asks;
        const at = (f: number, d: number) => classifyTrouble(llm, 'x', { judge: judgeOf({ frightened: f, danger: d }) });
        expect(await at(frightened!.threshold, 0)).toBe(true);
        expect(await at(0, danger!.threshold)).toBe(true);
        expect(await at(frightened!.threshold - 0.01, danger!.threshold - 0.01)).toBe(false);
        expect(llm.calls).toBe(0);
    });

    it('gives up at once, as a no, when it has been called off', async () => {
        const llm = new StubProvider('YES');
        const abort = new AbortController();
        abort.abort();
        expect(await classifyTrouble(llm, 'x', { signal: abort.signal })).toBe(false);
        expect(llm.calls).toBe(0);
    });

    it('falls back to the LLM when the judge fails', async () => {
        const llm = new StubProvider('YES');
        expect(await classifyTrouble(llm, 'x', { judge: judgeOf(new Error('timeout')) })).toBe(true);
        expect(llm.calls).toBe(1);
    });
});

describe('SessionManager.appendSystemNote', () => {
    const started = (): SessionManager => {
        const manager = new SessionManager({ clock: createFakeClock(1_000_000).clock });
        manager.startSession();
        return manager;
    };

    it('lands right behind the turn it is about, and is sent to the model', () => {
        const manager = started();
        manager.addUserMessage("I feel like I'm disappearing");
        manager.appendSystemNote(STEPPING_OUT_NOTE, 'trouble');
        expect(manager.getContextMessages()).toEqual([
            { role: 'user', content: "I feel like I'm disappearing" },
            { role: 'system', content: STEPPING_OUT_NOTE },
        ]);
    });

    it('is model context, never transcript', () => {
        const manager = started();
        manager.addUserMessage('hello');
        manager.appendSystemNote(STEPPING_OUT_NOTE, 'trouble');
        manager.addAssistantMessage('Open your eyes and look around the room.');
        expect(spokenExchanges(manager.state!.exchanges).map((e) => e.role)).toEqual(['user', 'assistant']);
    });

    it('refuses to follow a reply: a system note has to follow a user turn', () => {
        const manager = started();
        expect(() => manager.appendSystemNote('x', 'trouble')).toThrow();
        manager.addUserMessage('hello');
        manager.addAssistantMessage('hi');
        expect(() => manager.appendSystemNote('x', 'trouble')).toThrow();
    });
});

describe('UtterancePrefetch', () => {
    it('asks once the partial settles, and hands the answer to the matching final', async () => {
        vi.useFakeTimers();
        try {
            const ask = vi.fn(async (text: string) => text.length);
            const pre = new UtterancePrefetch(ask, 350);
            pre.note("I'm scar");
            vi.advanceTimersByTime(100);
            pre.note("I'm scared");
            expect(ask).not.toHaveBeenCalled();
            vi.advanceTimersByTime(350);
            expect(ask.mock.calls.map((c) => c[0])).toEqual(["I'm scared"]);
            // Case and trailing punctuation differ between a partial and its final.
            await expect(pre.take("I'm scared.")).resolves.toBe(10);
            expect(pre.take("I'm scared.")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('gives nothing for a final that differs from what was asked, and calls that ask off', () => {
        vi.useFakeTimers();
        try {
            const signals: AbortSignal[] = [];
            const pre = new UtterancePrefetch(async (_text: string, signal: AbortSignal) => {
                signals.push(signal);
                return true;
            }, 350);
            pre.note('one thing');
            vi.advanceTimersByTime(350);
            expect(pre.take('another thing')).toBeNull();
            expect(signals[0]!.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    // Someone who pauses mid-sentence: each pause starts an ask, and only the
    // last one is wanted.
    it('calls off the ask a later pause replaces', () => {
        vi.useFakeTimers();
        try {
            const signals: AbortSignal[] = [];
            const pre = new UtterancePrefetch(async (_text: string, signal: AbortSignal) => {
                signals.push(signal);
                return true;
            }, 350);
            pre.note("It's getting");
            vi.advanceTimersByTime(350);
            pre.note("It's getting far away and I don't like it");
            vi.advanceTimersByTime(350);
            expect(signals.map((s) => s.aborted)).toEqual([true, false]);
            const taken = pre.takeAsk("It's getting far away and I don't like it");
            expect(taken).not.toBeNull();
            taken!.cancel();
            expect(signals[1]!.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
