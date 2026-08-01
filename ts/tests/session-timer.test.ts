import { describe, it, expect } from 'vitest';

import {
    buildTimerApproachEvent,
    buildTimerCompletionEvent,
    isSessionTimerEvent,
    isSyntheticEventTurn,
    pickTimerFallback,
    timerApproachLeadSec,
    SESSION_TIMER_EVENT_PREFIX,
    TIMER_APPROACH_FALLBACKS,
    TIMER_COMPLETION_FALLBACKS,
} from '../src/facilitation/session-timer.js';
import {
    buildSmartCheckinEvent,
    parseSmartCheckinReply,
    PASS_PREFIX,
    SMART_CHECKIN_MAX_CHARS,
} from '../src/facilitation/smart-checkin.js';

describe('timerApproachLeadSec', () => {
    it('scales the base lead with the length of the sit', () => {
        expect(timerApproachLeadSec(30 * 60, null)).toBe(180);
        expect(timerApproachLeadSec(15 * 60, null)).toBe(120);
        expect(timerApproachLeadSec(6 * 60, null)).toBe(60);
    });

    it('gives no notice at all for a very short sit', () => {
        expect(timerApproachLeadSec(4 * 60, null)).toBe(0);
        expect(timerApproachLeadSec(60, 90)).toBe(0);
    });

    it('raises the lead past one turn, so it cannot fall inside a silence', () => {
        // 90s turns under a 20 minute timer: a 3 minute base already clears a
        // turn, so it stands.
        expect(timerApproachLeadSec(20 * 60, 90)).toBe(180);
        // 4 minute turns: the base would land mid-silence, so it stretches.
        expect(timerApproachLeadSec(20 * 60, 240)).toBe(312);
    });

    it('never spends more than a third of the sit waiting to warn', () => {
        // Ten minute timer, five minute turns: 1.3x would be 390s of a 600s
        // sit, which would fire before it settled.
        expect(timerApproachLeadSec(10 * 60, 300)).toBe(200);
    });
});

describe('timer event turns', () => {
    it('are recognized as synthetic, and distinct from check-in events', () => {
        const approach = buildTimerApproachEvent(180, 20);
        expect(approach.startsWith(SESSION_TIMER_EVENT_PREFIX)).toBe(true);
        expect(isSessionTimerEvent(approach)).toBe(true);
        expect(isSyntheticEventTurn(approach)).toBe(true);
        expect(isSessionTimerEvent(buildSmartCheckinEvent(300, 1))).toBe(false);
        expect(isSyntheticEventTurn(buildSmartCheckinEvent(300, 1))).toBe(true);
        expect(isSyntheticEventTurn('I keep thinking about the timer')).toBe(false);
    });

    it('offers a pass on approach but never on completion', () => {
        expect(buildTimerApproachEvent(180, 20)).toContain(PASS_PREFIX);
        expect(buildTimerCompletionEvent(20)).not.toContain(PASS_PREFIX);
    });

    it('tells the model not to read the clock out', () => {
        expect(buildTimerApproachEvent(180, 20)).toContain('Do not announce the time');
    });

    it('states the length the meditator actually set', () => {
        expect(buildTimerApproachEvent(180, 45)).toContain('45 minute sit');
        expect(buildTimerCompletionEvent(45)).toContain('45 minutes');
    });

    it('rounds the remaining time into plain speech', () => {
        expect(buildTimerApproachEvent(30, 20)).toContain('about a minute');
        expect(buildTimerApproachEvent(200, 20)).toContain('about 3 minutes');
    });

    it('mentions the stage arc only for staged modes', () => {
        expect(buildTimerApproachEvent(180, 20, { staged: true })).toContain('[NEXT]');
        expect(buildTimerApproachEvent(180, 20)).not.toContain('[NEXT]');
    });
});

describe('timer reply parsing', () => {
    it('allows a closing word longer than a check-in line', () => {
        const first = 'Let the attention loosen now, and let whatever you found here settle on its own.';
        const line =
            `${first} There is nothing left to do with it, and nothing here that needs ` +
            'finishing or tidying away before you go. Come back to the room in your own ' +
            'time, and take the quiet with you for as long as it wants to stay.';
        expect(line.length).toBeGreaterThan(SMART_CHECKIN_MAX_CHARS);
        expect(line.length).toBeLessThan(400);
        // Under the check-in cap it survives only as its first sentence.
        expect(parseSmartCheckinReply(line)).toEqual({
            kind: 'speak',
            text: first,
            waitSec: null,
        });
        // Under the timer's cap the whole closing word is spoken.
        expect(parseSmartCheckinReply(line, 400)).toEqual({
            kind: 'speak',
            text: line,
            waitSec: null,
        });
    });

    it('still passes a pass through under the roomier cap', () => {
        expect(parseSmartCheckinReply(`${PASS_PREFIX}`, 400).kind).toBe('pass');
    });
});

describe('canned fallbacks', () => {
    it('vary by duration and stay in range', () => {
        for (const pool of [TIMER_APPROACH_FALLBACKS, TIMER_COMPLETION_FALLBACKS]) {
            const picks = new Set([1, 2, 3, 4, 5].map((n) => pickTimerFallback(pool, n)));
            expect(picks.size).toBeGreaterThan(1);
            for (const p of picks) expect(pool).toContain(p);
        }
    });

    it('never promise the session is over, since it stays open', () => {
        for (const line of TIMER_COMPLETION_FALLBACKS) {
            expect(line.toLowerCase()).not.toContain('goodbye');
        }
    });
});
