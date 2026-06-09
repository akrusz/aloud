/**
 * buildResumeContext — what the model gets when continuing a saved session.
 * Pure over SessionState, so no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
    buildResumeContext,
    RESUME_COMPRESS_OVER,
    RESUME_RECENT_KEEP,
} from '../src/facilitation/resume.js';
import type { SessionState } from '../src/facilitation/session.js';

function session(over: Partial<SessionState> = {}): SessionState {
    return {
        sessionId: 's1',
        startTime: 0,
        endTime: 100,
        exchanges: [],
        tags: [],
        notes: '',
        usage: {
            llmCalls: 0,
            llmTokensIn: 0,
            llmTokensOut: 0,
            llmCacheRead: 0,
            llmCacheCreation: 0,
            sttSeconds: 0,
            ttsChars: 0,
        },
        ...over,
    };
}

function turns(n: number): SessionState['exchanges'] {
    return Array.from({ length: n }, (_v, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `m${i}`,
        timestamp: i,
    }));
}

describe('buildResumeContext', () => {
    it('replays the full transcript when summary-based resume is off', () => {
        const s = session({ exchanges: turns(30), notes: 'a recap' });
        const ctx = buildResumeContext(s, false);
        expect(ctx).toHaveLength(30);
        expect(ctx[0]).toEqual({ role: 'user', content: 'm0' });
    });

    it('compresses a long session to recap + the last RESUME_RECENT_KEEP messages', () => {
        const s = session({ exchanges: turns(30), notes: 'explored the breath' });
        const ctx = buildResumeContext(s, true);
        expect(ctx).toHaveLength(RESUME_RECENT_KEEP + 1); // recap + recent
        expect(ctx[0]!.role).toBe('assistant');
        expect(ctx[0]!.content).toContain('explored the breath');
        // The tail is verbatim and in order.
        expect(ctx[ctx.length - 1]).toEqual({ role: 'assistant', content: 'm29' });
        expect(ctx[1]).toEqual({ role: 'user', content: `m${30 - RESUME_RECENT_KEEP}` });
    });

    it('replays whole when at/below the compression threshold even with a recap', () => {
        const s = session({ exchanges: turns(RESUME_COMPRESS_OVER), notes: 'short one' });
        const ctx = buildResumeContext(s, true);
        expect(ctx).toHaveLength(RESUME_COMPRESS_OVER);
        expect(ctx[0]).toEqual({ role: 'user', content: 'm0' });
    });

    it('replays whole when there is no recap to seed from', () => {
        const s = session({ exchanges: turns(30), notes: '   ' });
        const ctx = buildResumeContext(s, true);
        expect(ctx).toHaveLength(30);
    });
});
