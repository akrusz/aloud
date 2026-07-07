/**
 * buildResumeContext — what the model gets when continuing a saved session.
 * Pure over SessionState, so no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
    buildResumeContext,
    RESUME_COMPRESS_CHARS,
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

/** n turns, each carrying `chars` characters of content (defaults tiny). */
function turns(n: number, chars = 3): SessionState['exchanges'] {
    return Array.from({ length: n }, (_v, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `m${i}`.padEnd(chars, 'x'),
        timestamp: i,
    }));
}

/** Enough turns of `perTurn` chars to exceed the compression threshold. */
function longTranscript(perTurn = 500): SessionState['exchanges'] {
    const n = Math.ceil((RESUME_COMPRESS_CHARS + perTurn) / perTurn);
    return turns(n, perTurn);
}

describe('buildResumeContext', () => {
    it('replays the full transcript when summary-based resume is off', () => {
        const ex = longTranscript();
        const s = session({ exchanges: ex, notes: 'a recap' });
        const ctx = buildResumeContext(s, false);
        expect(ctx).toHaveLength(ex.length);
        expect(ctx[0]!.content).toBe(ex[0]!.content);
    });

    it('compresses a large transcript to recap + the last RESUME_RECENT_KEEP messages', () => {
        const ex = longTranscript();
        const s = session({ exchanges: ex, notes: 'explored the breath' });
        const ctx = buildResumeContext(s, true);
        expect(ctx).toHaveLength(RESUME_RECENT_KEEP + 1); // recap + recent
        expect(ctx[0]!.role).toBe('assistant');
        expect(ctx[0]!.content).toContain('explored the breath');
        // The tail is verbatim and in order.
        expect(ctx[ctx.length - 1]!.content).toBe(ex[ex.length - 1]!.content);
        expect(ctx[1]!.content).toBe(ex[ex.length - RESUME_RECENT_KEEP]!.content);
    });

    it('replays whole when the transcript is below the character threshold, even with a recap', () => {
        // Many short turns whose combined text stays under the threshold.
        const s = session({ exchanges: turns(20, 3), notes: 'short one' });
        const ctx = buildResumeContext(s, true);
        expect(ctx).toHaveLength(20);
        expect(ctx[0]!.content).toBe('m0x');
    });

    it('replays whole when there is no recap to seed from', () => {
        const s = session({ exchanges: longTranscript(), notes: '   ' });
        const ctx = buildResumeContext(s, true);
        expect(ctx.every((m) => !m.content.startsWith('[Continuing'))).toBe(true);
    });

    it('prepends a hand-off note when a different model resumes (full replay)', () => {
        const ex = turns(6, 3);
        const s = session({ exchanges: ex, notes: 'short', model: 'Claude Fable 5' });
        const ctx = buildResumeContext(s, true, {
            priorModelLabel: 'Claude Fable 5',
            currentModelLabel: 'Opus (Subscription)',
        });
        expect(ctx).toHaveLength(ex.length + 1);
        expect(ctx[0]!.content).toContain('Claude Fable 5');
    });

    it('folds the prior model into the recap note when compressing', () => {
        const s = session({ exchanges: longTranscript(), notes: 'explored the breath' });
        const ctx = buildResumeContext(s, true, {
            priorModelLabel: 'Claude Fable 5',
            currentModelLabel: 'Opus (Subscription)',
        });
        expect(ctx[0]!.content).toContain('facilitated by Claude Fable 5');
        expect(ctx[0]!.content).toContain('explored the breath');
        expect(ctx).toHaveLength(RESUME_RECENT_KEEP + 1);
    });

    it('omits the hand-off note when the same model resumes', () => {
        const ex = turns(6, 3);
        const s = session({ exchanges: ex, notes: 'short', model: 'Sonnet (Subscription)' });
        const ctx = buildResumeContext(s, true, {
            priorModelLabel: 'Sonnet (Subscription)',
            currentModelLabel: 'Sonnet (Subscription)',
        });
        expect(ctx).toHaveLength(ex.length);
    });
});
