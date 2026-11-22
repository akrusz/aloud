/**
 * The model's reasoning kept from the speaker (core reasoning.ts): the tag
 * shapes (meditation-pal-wgtb), the untagged-reasoning detector
 * (meditation-pal-dqti), and what a stream may speak so far.
 */

import { describe, expect, it } from 'vitest';

import { isReasoningAloud, speakableSoFar, stripReasoning } from '../src/facilitation/reasoning.js';
import { parseSmartCheckinReply } from '../src/facilitation/smart-checkin.js';
import { stripThinkTags } from '../src/facilitation/strip-think-tags.js';

// Kimi K2 on the destabilizing soak scenario, 2026-11-14 (ts/soak-runs/
// 0-stepping-out-2026-11-14-before and -after): the reasoning, then a bare
// closing tag, then the reply.
const KIMI_BEFORE =
    'The user is describing dissociation - feeling disconnected from their body, hands feeling far away, "sinking behind glass," and now fear is arising. This is a significant shift from the earlier drifting.\n\nI should:\n- Stay with them in this experience\n- Acknowledge the fear without amplifying it\n\nLet me go with something that invites them to stay with it without forcing anything.</think>What\'s that scared feeling like?';
const KIMI_AFTER =
    "The user is describing a sensation of dissociation or depersonalization—feeling distant from their body, hands barely felt, not sure if they're still in their body. This is a \"strange sensation\" that could be ordinary in meditation, but I need to check if it's welcome or frightening.\n\nAccording to the instructions: \"When you can't tell whether something strange is welcome, ask how it is for them.\"\n\nI should ask how this is for them.\n\nResponse length is brief. Guidance level is somewhat following.</think>How is that for you—does it feel okay, or is it unsettling?";
// An opener stored in a real desktop session, 2026-07-18.
const CLAUDE_OPENER =
    'The user wants a brief, natural opening for a meditation session. Key constraints:\n- Just a sentence or two\n- Welcome the meditator and invite them to begin\n\nSince this is an opening, I should:\n- Welcome them in a natural way';

const firstSentence = (s: string): string => /^[\s\S]*?[.!?](?=\s)/.exec(s)?.[0] ?? s;

describe('stripReasoning', () => {
    it('drops a closed block, and everything up to a lone closing tag', () => {
        expect(stripReasoning(KIMI_BEFORE).trim()).toBe("What's that scared feeling like?");
        expect(stripReasoning(KIMI_AFTER).trim()).toBe('How is that for you—does it feel okay, or is it unsettling?');
        expect(stripReasoning('<scratchpad>plan</scratchpad>Rest here.').trim()).toBe('Rest here.');
        expect(stripReasoning('All reasoning.</reasoning>').trim()).toBe('');
    });

    it('keeps an opening tag that never closed, for the scrub to drop alone', () => {
        expect(stripReasoning('<think>Notice the breath.')).toBe('<think>Notice the breath.');
    });

    it('is what the auxiliary parsers strip too', () => {
        expect(stripThinkTags('Okay, the user said yes.</think>YES')).toBe('YES');
    });
});

describe('isReasoningAloud', () => {
    it('catches the reasoning replies seen, from their first sentence', () => {
        for (const r of [KIMI_BEFORE, KIMI_AFTER, CLAUDE_OPENER]) {
            expect(isReasoningAloud(r)).toBe(true);
            expect(isReasoningAloud(firstSentence(r))).toBe(true);
        }
    });

    it('catches the usual reasoning openings, after a lead-in or a sentence', () => {
        for (const s of [
            'Okay, the user is asking for quiet.',
            'Alright, so the meditator says their hands feel far away.',
            'Hmm. The user just said they feel calmer.',
            'I hear you. The user seems frightened now.',
            'The meditator has described a tight chest twice.',
            'My response should be short and warm.',
            'I need to: acknowledge the fear, then ground them.',
            '用户描述了一种身体变远的感觉。',
            '好的，用户说他们感到害怕。',
            '我的回应应该简短。',
        ]) {
            expect(isReasoningAloud(s), s).toBe(true);
        }
    });

    it('leaves speech addressed to the meditator alone, someone else and the app included', () => {
        for (const s of [
            "What's that scared feeling like?",
            'Is there a person you trust who could be with you? Your sister, maybe - they could come over.',
            'The app waits until the user stops speaking, so take your time.',
            'The user testing tomorrow is on your mind. Let it be there.',
            'The user said your design was too complex. Where do you feel that?',
            '用户说你的设计太复杂，这句话现在在身体哪里？',
            'Even the most experienced meditator has days like this.',
            'Perhaps I should stay quiet for a while. Would that help?',
            'I want to acknowledge how hard that was.',
            "Let me know if you'd like some quiet.",
            'I need to pause here for a moment, and so can you.',
            '你担心用户觉得不好用，这份担心现在在身体哪里？',
            '冥想者感到困倦是很常见的。',
            '我应该安静一会儿吗？',
        ]) {
            expect(isReasoningAloud(s), s).toBe(false);
        }
    });

    it('reads traditional characters as the simplified ones, catching and leaving the same', () => {
        for (const s of [
            '用戶描述了一種身體變遠的感覺。',
            '好的，用戶說他們感到害怕。',
            '首先，用戶剛才提到胸口很緊。',
            '用戶似乎希望安靜一會兒。',
            '我的回應應該簡短。',
            '我的回覆需要溫和一點。',
            '我應該：先安撫，再引導。',
        ]) {
            expect(isReasoningAloud(s), s).toBe(true);
        }
        for (const s of [
            '用戶說你的設計太複雜，這句話現在在身體哪裡？',
            '用戶說妳的設計太複雜，這句話現在在身體哪裡？',
            '你擔心用戶覺得不好用，這份擔心現在在身體哪裡？',
            '冥想者感到睏倦是很常見的。',
            '我應該安靜一會兒嗎？',
            '慢慢來，感覺一下呼吸。',
            '現在有什麼浮現出來嗎？',
        ]) {
            expect(isReasoningAloud(s), s).toBe(false);
        }
    });
});

describe('speakableSoFar (a reply still streaming)', () => {
    it('cuts at an opening tag still waiting for its close, and drops the block once it closes', () => {
        expect(speakableSoFar('Rest here. <think>The user seems tense')).toEqual({ text: 'Rest here. ', loneCloses: 0 });
        expect(speakableSoFar('Rest here. <think>The user seems tense.</think> And breathe.').text).toBe('Rest here.   And breathe.');
    });

    it('lets the words of a block that never closed out once the stream is over', () => {
        expect(speakableSoFar('<think>Notice the breath.', true).text).toBe('<think>Notice the breath.');
    });

    it('counts the closing tags that had no opening one, and starts after the last', () => {
        expect(speakableSoFar('Stop facilitating. ')).toEqual({ text: 'Stop facilitating. ', loneCloses: 0 });
        expect(speakableSoFar('Stop facilitating.</think> Okay, that sounds scary.')).toEqual({
            text: '  Okay, that sounds scary.',
            loneCloses: 1,
        });
    });
});

describe('smart check-ins', () => {
    it('falls back on a reasoning reply rather than salvaging its first sentence', () => {
        expect(parseSmartCheckinReply(CLAUDE_OPENER)).toEqual({ kind: 'fallback' });
        expect(parseSmartCheckinReply('The user has been quiet for ten minutes. I should offer a brief word.')).toEqual({
            kind: 'fallback',
        });
    });

    it('reads a pass or a line after a lone closing tag', () => {
        expect(parseSmartCheckinReply('They asked for silence.</think>[PASS]')).toEqual({ kind: 'pass', waitSec: null });
        expect(parseSmartCheckinReply('A gentle word.</think>[WAIT:10m] Still here with you.')).toEqual({
            kind: 'speak',
            text: 'Still here with you.',
            waitSec: 600,
        });
        expect(parseSmartCheckinReply('Nothing to say.</think>')).toEqual({ kind: 'fallback' });
    });
});
