import { describe, expect, it } from 'vitest';
import { isBeginCommand } from '../src/facilitation/begin-command.js';

describe('isBeginCommand', () => {
    it('matches the ways people ask to begin', () => {
        for (const text of [
            'Begin.',
            'begin',
            'Start',
            "Let's begin",
            'Let’s begin',
            'Okay, begin the session',
            'Start the session please',
            'Begin session',
            "I'm ready to begin",
            'Can we start?',
            'Hey aloud, start a new session',
            'start meditating',
            'begin my sit now',
        ]) {
            expect(isBeginCommand(text), text).toBe(true);
        }
    });

    it('ignores what a room says', () => {
        for (const text of [
            'When does the movie start?',
            'I should begin cooking dinner',
            "Don't start",
            'not ready to begin',
            'start the car',
            'begin again from the top of the list please',
            'ready',
            'session',
            "let's go",
            // Two verbs.
            'start, begin',
            '',
            'okay so I think we can maybe just begin the session now',
        ]) {
            expect(isBeginCommand(text), text).toBe(false);
        }
    });

    it('matches and ignores in zh', () => {
        for (const text of ['开始', '开始吧', '开始冥想', '我们开始吧', '请开始 冥想。', '好的开始']) {
            expect(isBeginCommand(text), text).toBe(true);
        }
        for (const text of ['电影什么时候开始', '不要开始', '开始做饭', '重新开始工作吧']) {
            expect(isBeginCommand(text), text).toBe(false);
        }
    });
});
