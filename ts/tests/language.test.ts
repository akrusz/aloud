import { describe, it, expect } from 'vitest';

import {
    sessionLanguageOf,
    localizePool,
    ZH_LANGUAGE_FRAGMENT,
} from '../src/facilitation/language.js';
import {
    PromptBuilder,
    CHECK_IN_PROMPTS,
    HOLD_REENTRY_LINES,
    COMMON_OPENERS,
    MINIMAL_OPENERS,
    FOCUS_OPENERS,
    QUALITY_OPENERS,
} from '../src/facilitation/prompts.js';
import {
    TIMER_APPROACH_FALLBACKS,
    TIMER_COMPLETION_FALLBACKS,
    TIMER_CLOSE_FALLBACKS,
} from '../src/facilitation/session-timer.js';
import { FELT_SENSE_OPENERS, FELT_SENSE_CHECK_INS, FELT_SENSE_MODE } from '../src/facilitation/felt-sense.js';
import { NOTING_CHECK_IN_PROMPTS, NOTING_STATIC_OPENERS } from '../src/facilitation/noting.js';
import { parseTurnSignals } from '../src/facilitation/modes.js';
import { parseSmartCheckinReply } from '../src/facilitation/smart-checkin.js';

const CJK = /[㐀-鿿]/;

describe('sessionLanguageOf', () => {
    it('maps any zh flavor to zh-CN and everything else to en', () => {
        for (const code of ['zh', 'zh-CN', 'zh-Hans-CN', 'ZH']) {
            expect(sessionLanguageOf(code), code).toBe('zh-CN');
        }
        for (const code of ['en', 'es', 'ja', '', undefined, null]) {
            expect(sessionLanguageOf(code), String(code)).toBe('en');
        }
    });
});

describe('localizePool', () => {
    // Every canned pool that reaches the meditator's ears. A twin must keep its
    // original's length: pool position means the same thing in both languages
    // (pickTimerFallback indexes by minutes, tests key on counts).
    const REGISTERED: ReadonlyArray<[string, readonly string[]]> = [
        ['CHECK_IN_PROMPTS', CHECK_IN_PROMPTS],
        ['HOLD_REENTRY_LINES', HOLD_REENTRY_LINES],
        ['COMMON_OPENERS', COMMON_OPENERS],
        ['MINIMAL_OPENERS', MINIMAL_OPENERS],
        ['TIMER_APPROACH_FALLBACKS', TIMER_APPROACH_FALLBACKS],
        ['TIMER_COMPLETION_FALLBACKS', TIMER_COMPLETION_FALLBACKS],
        ['TIMER_CLOSE_FALLBACKS', TIMER_CLOSE_FALLBACKS],
        ['FELT_SENSE_OPENERS', FELT_SENSE_OPENERS],
        ['FELT_SENSE_CHECK_INS', FELT_SENSE_CHECK_INS],
        ['NOTING_CHECK_IN_PROMPTS', NOTING_CHECK_IN_PROMPTS],
        ['NOTING_STATIC_OPENERS', NOTING_STATIC_OPENERS],
        ...Object.entries(FOCUS_OPENERS).map(([k, v]): [string, readonly string[]] => [`FOCUS_OPENERS.${k}`, v]),
        ...Object.entries(QUALITY_OPENERS).map(([k, v]): [string, readonly string[]] => [`QUALITY_OPENERS.${k}`, v]),
    ];

    it('returns a same-length, actually-Chinese twin for every registered pool', () => {
        for (const [name, pool] of REGISTERED) {
            const zh = localizePool(pool, 'zh-CN');
            expect(zh, name).not.toBe(pool);
            expect(zh.length, name).toBe(pool.length);
            for (const line of zh) expect(CJK.test(line), `${name}: ${line}`).toBe(true);
        }
    });

    it('is the identity for en, and falls back to en for an unregistered pool', () => {
        expect(localizePool(CHECK_IN_PROMPTS, 'en')).toBe(CHECK_IN_PROMPTS);
        const custom = ['one', 'two'];
        expect(localizePool(custom, 'zh-CN')).toBe(custom);
    });
});

describe('PromptBuilder language', () => {
    it('appends the zh fragment for zh-CN and leaves the en prompt untouched', () => {
        const en = new PromptBuilder().buildSystemPrompt();
        const enExplicit = new PromptBuilder({ config: { language: 'en' } }).buildSystemPrompt();
        const zh = new PromptBuilder({ config: { language: 'zh-CN' } }).buildSystemPrompt();
        expect(enExplicit).toBe(en); // cache-prefix invariant
        expect(en).not.toContain(ZH_LANGUAGE_FRAGMENT);
        expect(zh).toContain(ZH_LANGUAGE_FRAGMENT);
        // The tokens stay literal inside the fragment: a translated [HOLD]
        // would break parseTurnSignals.
        expect(zh).toContain('[HOLD]');
    });

    it('draws every canned line from the zh pools in a zh session', () => {
        const zh = new PromptBuilder({
            config: { language: 'zh-CN', focuses: ['emotions'], qualities: ['playful'] },
        });
        for (let i = 0; i < 10; i++) {
            expect(CJK.test(zh.getSessionOpener())).toBe(true);
            expect(CJK.test(zh.getCheckInPrompt())).toBe(true);
            expect(CJK.test(zh.getHoldReentryLine())).toBe(true);
        }
        // Mode pools localize too (felt sense static openers + check-ins).
        const felt = new PromptBuilder({ config: { language: 'zh-CN' }, mode: FELT_SENSE_MODE });
        for (let i = 0; i < 10; i++) {
            expect(CJK.test(felt.getSessionOpener())).toBe(true);
            expect(CJK.test(felt.getCheckInPrompt())).toBe(true);
        }
    });

    it('at minimal guidance the zh minimal pool serves', () => {
        const zh = new PromptBuilder({ config: { language: 'zh-CN', directiveness: 0 } });
        expect(CJK.test(zh.getSessionOpener())).toBe(true);
    });
});

describe('control tokens on zh replies', () => {
    it('parses and strips a leading token run before Chinese text', () => {
        const hold = parseTurnSignals('[HOLD] 好的,我会安静下来。');
        expect(hold.hold).toBe(true);
        expect(hold.cleanText).toBe('好的,我会安静下来。');

        const wait = parseTurnSignals('[WAIT:10m] 让它慢慢展开。');
        expect(wait.waitSec).toBe(600);
        expect(wait.cleanText).toBe('让它慢慢展开。');

        const next = parseTurnSignals('[NEXT] [HOLD] 慢慢来。');
        expect(next.stage).toBe('advance');
        expect(next.hold).toBe(true);
        expect(next.cleanText).toBe('慢慢来。');
    });

    it('scrubs a misplaced mid-text token from a zh line', () => {
        const { cleanText } = parseTurnSignals('好的。 [HOLD] 需要我安静一会儿吗?');
        expect(cleanText).not.toContain('[HOLD]');
        expect(cleanText).toContain('需要我安静一会儿吗');
    });

    it('smart check-in [PASS] and [WAIT] survive a zh session', () => {
        expect(parseSmartCheckinReply('[PASS]')).toEqual({ kind: 'pass', waitSec: null });
        const spoken = parseSmartCheckinReply('[WAIT:5m] 我在这里。');
        expect(spoken).toEqual({ kind: 'speak', text: '我在这里。', waitSec: 300 });
    });
});
