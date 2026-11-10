import { describe, expect, it } from 'vitest';
import { isBeginCommand, parseBeginRequest } from '../src/facilitation/begin-command.js';

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

describe('parseBeginRequest', () => {
    it('is a plain begin when nothing else is named', () => {
        expect(parseBeginRequest('Begin.')).toEqual({});
        expect(parseBeginRequest("Okay, let's start the session")).toEqual({});
    });

    it('reads a length', () => {
        expect(parseBeginRequest('Begin a twenty minute session')).toEqual({ minutes: 20 });
        expect(parseBeginRequest('start a 45 minute sit')).toEqual({ minutes: 45 });
        expect(parseBeginRequest('Begin a twenty-minute session.')).toEqual({ minutes: 20 });
        expect(parseBeginRequest('start a session for half an hour')).toEqual({ minutes: 30 });
        expect(parseBeginRequest("let's begin an hour long sit")).toEqual({ minutes: 60 });
        expect(parseBeginRequest('begin for ten minutes please')).toEqual({ minutes: 10 });
    });

    it('reads a mode by its setup-screen name', () => {
        expect(parseBeginRequest('Start noting')).toEqual({ mode: 'noting' });
        expect(parseBeginRequest('Begin a felt sense session')).toEqual({ mode: 'felt_sense' });
        expect(parseBeginRequest('begin a felt-sense sit')).toEqual({ mode: 'felt_sense' });
        expect(parseBeginRequest('start an exploration')).toEqual({ mode: 'exploration' });
    });

    it('reads both', () => {
        expect(parseBeginRequest('Begin a twenty minute felt sense session.')).toEqual({ mode: 'felt_sense', minutes: 20 });
        expect(parseBeginRequest('Start fifteen minutes of noting')).toEqual({ mode: 'noting', minutes: 15 });
    });

    it('refuses what it cannot read rather than guess', () => {
        for (const text of [
            // Half a mode name, two modes.
            'begin a felt session',
            'I sense we should start',
            'start noting and exploration',
            // A length that is about something else.
            'start in twenty minutes',
            'begin five more minutes',
            'start the twenty minute timer on the oven',
        ]) {
            expect(parseBeginRequest(text), text).toBeNull();
        }
    });

    it('reads zh', () => {
        expect(parseBeginRequest('开始')).toEqual({});
        expect(parseBeginRequest('开始二十分钟的冥想')).toEqual({ minutes: 20 });
        expect(parseBeginRequest('开始半小时的体会冥想吧')).toEqual({ mode: 'felt_sense', minutes: 30 });
        expect(parseBeginRequest('请开始标记练习')).toEqual({ mode: 'noting' });
        expect(parseBeginRequest('二十分钟后开始')).toBeNull();
    });
});
