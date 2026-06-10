import { describe, it, expect } from 'vitest';

import { SessionManager } from '../src/facilitation/session.js';
import { createFakeClock } from '../src/clock.js';

function makeManager(opts?: ConstructorParameters<typeof SessionManager>[0]) {
    const fake = createFakeClock(1_000_000);
    const manager = new SessionManager({ clock: fake.clock, ...opts });
    return { manager, fake };
}

describe('SessionManager — lifecycle', () => {
    it('starts inactive', () => {
        const { manager } = makeManager();
        expect(manager.state).toBe(null);
        expect(manager.isActive).toBe(false);
    });

    it('starts a session and is active until ended', () => {
        const { manager } = makeManager();
        const state = manager.startSession();
        expect(state.sessionId).toBeTruthy();
        expect(manager.isActive).toBe(true);

        manager.endSession();
        expect(manager.isActive).toBe(false);
        expect(manager.state?.endTime).not.toBe(null);
    });

    it('default session IDs do not collide within the same second', () => {
        const { manager } = makeManager();
        const first = manager.startSession().sessionId;
        manager.endSession();
        const second = manager.startSession().sessionId;
        // Same fake-clock second; the random suffix keeps them distinct.
        expect(second).not.toBe(first);
        expect(first).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{4}$/);
    });

    it('accepts a caller-provided session ID', () => {
        const { manager } = makeManager();
        const state = manager.startSession('my-session');
        expect(state.sessionId).toBe('my-session');
    });

    it('reports duration based on the injected clock', () => {
        const { manager, fake } = makeManager();
        manager.startSession();
        fake.tick(42);
        expect(manager.duration).toBe(42);
    });
});

describe('SessionManager — exchanges', () => {
    it('records user and assistant messages with timestamps', () => {
        const { manager, fake } = makeManager();
        manager.startSession();
        fake.tick(1);
        manager.addUserMessage('hello');
        fake.tick(2);
        manager.addAssistantMessage('welcome');

        const exchanges = manager.state?.exchanges ?? [];
        expect(exchanges).toHaveLength(2);
        expect(exchanges[0]).toMatchObject({ role: 'user', content: 'hello' });
        expect(exchanges[1]).toMatchObject({ role: 'assistant', content: 'welcome' });
        expect(exchanges[1]!.timestamp - exchanges[0]!.timestamp).toBe(2);
    });

    it('throws when adding messages without a session', () => {
        const { manager } = makeManager();
        expect(() => manager.addUserMessage('x')).toThrow();
    });

    it('returns the last user message', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addUserMessage('first');
        manager.addAssistantMessage('reply');
        manager.addUserMessage('second');
        manager.addAssistantMessage('reply 2');
        expect(manager.getLastUserMessage()).toBe('second');
    });

    it('loads saved exchanges for continuation', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.loadExchanges([
            { role: 'user', content: 'previously...', timestamp: 999 },
            { role: 'assistant', content: '...responded', timestamp: 1000 },
        ]);
        expect(manager.state?.exchanges).toHaveLength(2);
    });
});

describe('SessionManager — context strategies', () => {
    it('returns full history when strategy is "full"', () => {
        const { manager } = makeManager({ contextStrategy: 'full' });
        manager.startSession();
        for (let i = 0; i < 5; i++) {
            manager.addUserMessage(`msg ${i}`);
        }
        expect(manager.getContextMessages()).toHaveLength(5);
    });

    it('truncates to window size when strategy is "rolling"', () => {
        const { manager } = makeManager({
            contextStrategy: 'rolling',
            windowSize: 3,
        });
        manager.startSession();
        for (let i = 0; i < 5; i++) {
            manager.addUserMessage(`msg ${i}`);
        }
        const messages = manager.getContextMessages();
        expect(messages).toHaveLength(3);
        expect(messages.map((m) => m.content)).toEqual(['msg 2', 'msg 3', 'msg 4']);
    });

    it('rolling window trims forward to a user-message boundary', () => {
        const { manager } = makeManager({
            contextStrategy: 'rolling',
            windowSize: 3,
        });
        manager.startSession();
        manager.addUserMessage('u0');
        manager.addAssistantMessage('a0');
        manager.addUserMessage('u1');
        manager.addAssistantMessage('a1');
        // Naive slice(-3) would be [a0, u1, a1] — opening with an assistant
        // turn, which breaks providers requiring user-first alternation.
        const messages = manager.getContextMessages();
        expect(messages.map((m) => m.content)).toEqual(['u1', 'a1']);
        expect(messages[0]?.role).toBe('user');
    });

    it('rolling window with no user message in range returns the slice as-is', () => {
        const { manager } = makeManager({
            contextStrategy: 'rolling',
            windowSize: 2,
        });
        manager.startSession();
        manager.addUserMessage('u0');
        manager.addAssistantMessage('a0');
        manager.addAssistantMessage('a1');
        const messages = manager.getContextMessages();
        expect(messages.map((m) => m.content)).toEqual(['a0', 'a1']);
    });

    it('returns role/content shapes only — no internal fields', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addUserMessage('hi', 'You');
        const [msg] = manager.getContextMessages();
        expect(Object.keys(msg ?? {}).sort()).toEqual(['content', 'role']);
    });
});

describe('SessionManager — usage tracking', () => {
    it('starts with a zeroed usage tally', () => {
        const { manager } = makeManager();
        manager.startSession();
        expect(manager.state?.usage).toEqual({
            llmCalls: 0,
            llmTokensIn: 0,
            llmTokensOut: 0,
            llmCacheRead: 0,
            llmCacheCreation: 0,
            sttSeconds: 0,
            ttsChars: 0,
        });
    });

    it('records per-exchange tokens and folds them into the tally', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addAssistantMessage('hi there', undefined, {
            tokensIn: 100,
            tokensOut: 20,
            cacheRead: 80,
            cacheCreation: 0,
        });

        const ex = manager.state!.exchanges[0]!;
        expect(ex).toMatchObject({ tokensIn: 100, tokensOut: 20, cacheRead: 80 });
        // cacheCreation was 0 → omitted from the exchange (matches Python).
        expect('cacheCreation' in ex).toBe(false);

        expect(manager.state?.usage).toMatchObject({
            llmCalls: 1,
            llmTokensIn: 100,
            llmTokensOut: 20,
            llmCacheRead: 80,
            llmCacheCreation: 0,
        });
    });

    it('keeps input and output separate, never summed', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addAssistantMessage('a', undefined, { tokensIn: 500, tokensOut: 30 });
        const u = manager.state!.usage;
        expect(u.llmTokensIn).toBe(500);
        expect(u.llmTokensOut).toBe(30);
    });

    it('does not record usage for static/fallback messages', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addAssistantMessage('static check-in line');
        const ex = manager.state!.exchanges[0]!;
        expect(ex.tokensIn).toBeUndefined();
        expect(ex.tokensOut).toBeUndefined();
        expect(manager.state?.usage.llmCalls).toBe(0);
    });

    it('counts off-transcript LLM calls without adding an exchange', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addAssistantMessage('reply', undefined, { tokensIn: 10, tokensOut: 5 });
        // e.g. a summary completion after the session
        manager.recordLlmUsage({ tokensIn: 200, tokensOut: 8 });

        expect(manager.state?.exchanges).toHaveLength(1);
        expect(manager.state?.usage).toMatchObject({
            llmCalls: 2,
            llmTokensIn: 210,
            llmTokensOut: 13,
        });
    });

    it('accumulates STT seconds and TTS chars', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.recordStt(3.5);
        manager.recordStt(1.25);
        manager.recordTts(42);
        manager.recordTts(8);
        expect(manager.state?.usage.sttSeconds).toBeCloseTo(4.75, 5);
        expect(manager.state?.usage.ttsChars).toBe(50);
    });

    it('ignores zero/empty STT and TTS records', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.recordStt(0);
        manager.recordTts(0);
        expect(manager.state?.usage.sttSeconds).toBe(0);
        expect(manager.state?.usage.ttsChars).toBe(0);
    });

    it('no-ops recording when no session is active', () => {
        const { manager } = makeManager();
        expect(() => {
            manager.recordLlmUsage({ tokensIn: 1, tokensOut: 1 });
            manager.recordStt(1);
            manager.recordTts(1);
        }).not.toThrow();
    });
});

describe('SessionManager — tags and notes', () => {
    it('adds unique tags only', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addTag('insight');
        manager.addTag('insight');
        manager.addTag('warm');
        expect(manager.state?.tags).toEqual(['insight', 'warm']);
    });

    it('sets notes', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.setNotes('felt very settled');
        expect(manager.state?.notes).toBe('felt very settled');
    });
});
