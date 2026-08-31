/**
 * Session language: which language the FACILITATION runs in (the meditator's
 * speech, the model's replies, every canned line that reaches their ears). UI
 * chrome stays English on purpose - this is a session-language feature, not
 * localization (meditation-pal-c3a0).
 *
 * Three surfaces hang off the setting:
 *   - the system prompt gains a respond-in-Chinese fragment (prompts.ts
 *     buildSystemPrompt) that KEEPS the control tokens ([HOLD]/[NEXT]/[BACK]/
 *     [WAIT:Nm]/[PASS]) verbatim in English, so parseTurnSignals keeps working;
 *   - every canned/non-LLM pool swaps to its zh twin via localizePool below;
 *   - STT engines get the locale (browser SpeechRecognition lang, Whisper
 *     language param, native recognizer locale, hosted STT hint).
 *
 * TRANSLATION REVIEW: the zh strings here are Claude's draft (2026-08-31) and
 * ship only behind the language setting, which defaults to English. Flagged for
 * native review before promoting the feature - tone matters more than fidelity:
 * these lines are spoken softly into silence.
 */

/**
 * The languages the FACILITATION layer distinguishes. STT accepts thirty
 * recognizer languages (ui app-settings.LANGUAGES) and any of them can ride a
 * session's STT; this type is narrower on purpose - it names the languages the
 * prompts and canned pools actually speak. Everything not Chinese behaves as
 * 'en' today (the model just mirrors the transcript's language, as before).
 */
export type SessionLanguage = 'en' | 'zh-CN';

export const DEFAULT_LANGUAGE: SessionLanguage = 'en';

/** Collapse an app language code ('en', 'zh', a BCP-47 tag) to the facilitation
 *  language. Any zh flavor (zh, zh-CN, zh-Hans…) gets the Chinese treatment;
 *  everything else keeps today's English-default behavior. */
export function sessionLanguageOf(code: string | undefined | null): SessionLanguage {
    return code && /^zh\b/i.test(code) ? 'zh-CN' : 'en';
}

/**
 * Appended to the system prompt for a zh session. English instructions steer
 * better than translated ones on every model we ship, so the frame stays
 * English and only the OUTPUT language moves. The token rule is load-bearing:
 * a model that translates [HOLD] breaks the whole silence machinery.
 */
export const ZH_LANGUAGE_FRAGMENT = `Session language: Chinese
The meditator speaks Mandarin Chinese. Respond ONLY in Simplified Chinese - natural, warm, spoken 普通话, never a translation register. Do not mix in English words or pinyin.
The hidden control tokens are the one exception: [HOLD], [NEXT], [BACK], [PASS], and [WAIT:Nm] must stay EXACTLY as written, in English, in square brackets, at the very start of your reply. Never translate, rename, or explain them.`;

// --- zh twins of the canned pools -------------------------------------------
//
// Same order and count as their en originals so a pool position means the same
// thing in both languages. Register each pair in POOL_ZH below.

import {
    CHECK_IN_PROMPTS,
    HOLD_REENTRY_LINES,
    COMMON_OPENERS,
    MINIMAL_OPENERS,
} from './prompts.js';
import {
    TIMER_APPROACH_FALLBACKS,
    TIMER_COMPLETION_FALLBACKS,
    TIMER_CLOSE_FALLBACKS,
} from './session-timer.js';
import { FELT_SENSE_OPENERS, FELT_SENSE_CHECK_INS } from './felt-sense.js';
import { NOTING_CHECK_IN_PROMPTS } from './noting.js';

const ZH_CHECK_IN_PROMPTS: readonly string[] = [
    '我还在这里陪着你。',
    '你准备好了我就在。',
    '慢慢来,不着急。',
    '不用急。',
    '我就在这里。',
    '我在。',
    '还陪着你。',
    '现在感觉怎么样?',
    '不急。',
    '我哪儿也不去。',
    '慢慢来。',
    '你注意到了什么?',
    '还在这里。',
    '就在这里。',
    '在这里陪着你。',
    '时间很充裕。',
];

const ZH_HOLD_REENTRY_LINES: readonly string[] = [
    '好,我再安静下来。',
    '好的,我在这里。',
    '我先安静地听着,想让我回来就说一声。',
    '慢慢来,不着急。',
    '好。想让我回来的时候,说一声就行。',
];

const ZH_COMMON_OPENERS: readonly string[] = [
    '此刻你注意到了什么?',
    '我们开始吧。现在有什么在?',
    '花一点时间安顿下来……你注意到了什么?',
    '当你准备好了,你觉察到什么?',
    '慢慢安顿下来。此刻有什么在?',
    '就从你现在的状态开始。此刻正在发生什么?',
    '什么时候准备好都可以……有什么浮现出来?',
    '花点时间落定。此刻有什么在?',
];

const ZH_MINIMAL_OPENERS: readonly string[] = [
    '我在。',
    '慢慢来。',
    '你准备好了就开始。',
    '你准备好了,我就在这里。',
];

const ZH_TIMER_APPROACH_FALLBACKS: readonly string[] = [
    '还剩一点时间。让它停留在原处就好。',
    '还有几分钟。不需要做什么。',
    '快到尾声了。和此刻在的一切待在一起。',
];

const ZH_TIMER_COMPLETION_FALLBACKS: readonly string[] = [
    '时间到了。你准备好了再回来。',
    '你设的时间结束了。慢慢回来,不着急。',
    '这一坐到这里就结束了。不用急。',
];

const ZH_TIMER_CLOSE_FALLBACKS: readonly string[] = [
    '时间到了。我就陪你到这里。',
    '你设的时间到了。就到这里。',
    '这一坐到这里结束。慢慢来。',
];

const ZH_FELT_SENSE_OPENERS: readonly string[] = [
    '花一点时间安顿下来……当你准备好了,可以在心里问问自己:此刻,是什么隔在我和"感觉还好"之间?',
    '慢慢安顿,不着急。当你准备好了,我们来留意一下,今天什么在心里压着分量。',
    '先让自己到达这里。几个轻松的呼吸……然后也许在心里问问:此刻什么想要我的注意?',
    '什么时候开始都可以。你可以让注意力慢慢落到身体的中间,感受一下里面是什么样子。',
    '不急着开始。先落定……看看你今天带着什么进来了。',
];

const ZH_FELT_SENSE_CHECK_INS: readonly string[] = [
    '不着急。身体有它自己的节奏。',
    '我还在,等什么浮现都可以。',
    '需要多久就用多久。',
    '我在。',
    '还陪着你。',
    '要多久都没关系。',
];

const ZH_NOTING_CHECK_IN_PROMPTS: readonly string[] = [
    '我还在这里陪着你。',
    '继续标记浮现的任何东西就好。',
    '我在。',
    '现在浮现的是什么?',
    '还陪着你。',
    '不急。',
];

/** en pool → zh twin, keyed by array identity so callers pass the pool they
 *  already hold and unlisted pools fall through unchanged. */
const POOL_ZH: ReadonlyMap<readonly string[], readonly string[]> = new Map([
    [CHECK_IN_PROMPTS, ZH_CHECK_IN_PROMPTS],
    [HOLD_REENTRY_LINES, ZH_HOLD_REENTRY_LINES],
    [COMMON_OPENERS, ZH_COMMON_OPENERS],
    [MINIMAL_OPENERS, ZH_MINIMAL_OPENERS],
    [TIMER_APPROACH_FALLBACKS, ZH_TIMER_APPROACH_FALLBACKS],
    [TIMER_COMPLETION_FALLBACKS, ZH_TIMER_COMPLETION_FALLBACKS],
    [TIMER_CLOSE_FALLBACKS, ZH_TIMER_CLOSE_FALLBACKS],
    [FELT_SENSE_OPENERS, ZH_FELT_SENSE_OPENERS],
    [FELT_SENSE_CHECK_INS, ZH_FELT_SENSE_CHECK_INS],
    [NOTING_CHECK_IN_PROMPTS, ZH_NOTING_CHECK_IN_PROMPTS],
]);

/**
 * The pool to draw from in `language`: the registered zh twin, or the en pool
 * itself. Falling back to English beats silence - a missing translation reads
 * wrong but a missing check-in fails the pacing machinery.
 */
export function localizePool(pool: readonly string[], language: SessionLanguage): readonly string[] {
    if (language === 'en') return pool;
    return POOL_ZH.get(pool) ?? pool;
}
