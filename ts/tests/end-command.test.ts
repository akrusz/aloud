import { describe, expect, it } from 'vitest';
import { endConfirmReply, isEndCommand } from '../src/facilitation/end-command.js';

describe('isEndCommand', () => {
    it('matches the ways people ask to end the sit', () => {
        for (const text of [
            'End the session.',
            'end session',
            'Stop the session',
            'Okay, end the session please.',
            'Can we end the session?',
            "I'd like to end the session now",
            'I would like to stop the meditation',
            "Let's end the session here",
            'Hey aloud, end my session',
            'finish the sit',
            'Please end this meditation. Thanks.',
            'I want to end the session',
            // A recognizer's curly apostrophe.
            'Let’s end the session',
        ]) {
            expect(isEndCommand(text), text).toBe(true);
        }
    });

    it('leaves sentences about ending alone', () => {
        for (const text of [
            // No object: as likely meant for the facilitator's sentence.
            'stop',
            'end',
            'Stop, please.',
            // Negated, or about something else ending.
            "I don't want to end the session",
            'I never want this session to end',
            'Part of me wants this session to end',
            'I want this feeling to end',
            'the session should end soon I think',
            'When will the session end?',
            'It feels like the end of something',
            'End the war in my head',
            // Something else in the same breath.
            'end the session after this breath',
            'end the session but save it first',
            // Two verbs: a correction mid-thought, not a request.
            'stop, I mean end the session',
            // Too long to be only a request.
            'okay so I would like to please just end the session now thanks',
            '',
            'session',
        ]) {
            expect(isEndCommand(text), text).toBe(false);
        }
    });

    it('matches the zh request, with or without spaces and punctuation', () => {
        for (const text of ['结束冥想', '结束这次冥想。', '请结束冥想吧', '我想结束这次冥想', '结束 打坐', '我们结束今天的练习吧', '可以结束冥想了']) {
            expect(isEndCommand(text), text).toBe(true);
        }
    });

    it('leaves zh sentences about ending alone', () => {
        for (const text of ['结束', '我不想结束冥想', '这种感觉什么时候结束', '冥想结束以后我要去吃饭', '结束这段关系']) {
            expect(isEndCommand(text), text).toBe(false);
        }
    });
});

describe('endConfirmReply', () => {
    it('hears a plain yes', () => {
        for (const text of [
            'Yes.',
            'yeah',
            'Yes please',
            'Okay.',
            'Sure, thanks',
            'Yes, end it',
            'yes end the session',
            'Please',
            'End it.',
            'Do it',
            'go ahead',
            'I would',
            "That's right",
            'Yes, right now',
        ]) {
            expect(endConfirmReply(text), text).toBe('yes');
        }
    });

    it('hears a plain no, and a no anywhere wins', () => {
        for (const text of [
            'No.',
            'no thanks',
            'Not yet',
            'Nope',
            'Never mind',
            'cancel',
            "Let's keep going",
            'Keep going',
            'Continue',
            'please continue',
            "Please don't",
            'Not right now',
            'Wait',
            "No, I'd like to stay",
            'yes... no, not yet',
            'okay no',
        ]) {
            expect(endConfirmReply(text), text).toBe('no');
        }
    });

    it('lets anything else through as a turn', () => {
        for (const text of [
            // A yes-word, then something this does not know.
            'Yes, I think my leg is asleep',
            'okay so there is a tightness in my chest',
            'No part of me wants to move',
            // Ambiguous on its own.
            'go on',
            'a little longer',
            'I do',
            'hmm',
            '',
            // Too long to be an answer.
            'yes yes yes please do end it now',
        ]) {
            expect(endConfirmReply(text), text).toBeNull();
        }
    });

    it('answers in zh', () => {
        for (const text of ['好', '好的。', '是的', '嗯', '可以', '结束吧', '好的，结束吧']) {
            expect(endConfirmReply(text), text).toBe('yes');
        }
        for (const text of ['不', '不要', '先不要', '还没', '等一下', '继续', '再坐一会儿', '不用了']) {
            expect(endConfirmReply(text), text).toBe('no');
        }
        for (const text of ['我的腿麻了', '好像有点紧', '不知道']) {
            expect(endConfirmReply(text), text).toBeNull();
        }
    });
});
