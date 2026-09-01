/**
 * Session language: which language the FACILITATION runs in (the meditator's
 * speech, the model's replies, every canned line that reaches their ears).
 * Since 2026-08-31 the UI follows it too - one language control drives both -
 * but that layer lives in `ui/src/i18n.ts` and knows nothing about this module
 * (meditation-pal-c3a0).
 *
 * Three surfaces hang off the setting:
 *   - the system prompt gains a respond-in-Chinese fragment (prompts.ts
 *     buildSystemPrompt) that KEEPS the control tokens ([HOLD]/[NEXT]/[BACK]/
 *     [WAIT:Nm]/[PASS]) verbatim in English, so parseTurnSignals keeps working;
 *   - every canned/non-LLM pool swaps to its zh twin via localizePool below;
 *   - STT engines get the locale (browser SpeechRecognition lang, Whisper
 *     language param, native recognizer locale, hosted STT hint).
 *
 * TRANSLATION REVIEW: the zh strings here are Claude's draft (2026-08-31;
 * second pass 2026-09-01 toward natural spoken register, full-width
 * punctuation) and ship only behind the language setting, which defaults to
 * English. Flagged for native review before promoting the feature - tone
 * matters more than fidelity: these lines are spoken softly into silence.
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
// thing in both languages (pickTimerFallback indexes by position).
//
// THIS MODULE IMPORTS NOTHING, deliberately. The pool owners (prompts.ts,
// session-timer.ts, felt-sense.ts, noting.ts) import their zh twins from here
// and register the en→zh pairing themselves (registerZhPool, at the end of
// each module body). An earlier version imported the en pools here to build
// the map centrally, which closed an import cycle whose TDZ crash depended on
// module load ORDER - fine under vitest, dead on a different entry point.
export const ZH_CHECK_IN_PROMPTS: readonly string[] = [
    '我还在这里陪着你。',
    '你准备好了就说，我在。',
    '慢慢来，不着急。',
    '不用急。',
    '我就在这里。',
    '我在。',
    '还陪着你。',
    '现在感觉怎么样？',
    '不急。',
    '我哪儿也不去。',
    '慢慢来。',
    '你注意到了什么？',
    '还在这里。',
    '就在这里。',
    '在这里陪着你。',
    '时间很充裕。',
];

export const ZH_HOLD_REENTRY_LINES: readonly string[] = [
    '好，我再安静下来。',
    '好的，我在这里。',
    '我先安静地听着，想让我回来就说一声。',
    '慢慢来，不着急。',
    '好。想让我回来的时候，说一声就行。',
];

export const ZH_COMMON_OPENERS: readonly string[] = [
    '此刻你注意到了什么？',
    '我们开始吧。此刻有什么正在发生？',
    '花一点时间安顿下来……你注意到了什么？',
    '当你准备好了，看看此刻能觉察到什么？',
    '慢慢安顿下来。此刻心里有什么？',
    '就从你现在的状态开始。此刻正在发生什么？',
    '什么时候准备好都可以……有什么浮现出来吗？',
    '花点时间让自己落定。现在有什么浮现？',
];

export const ZH_MINIMAL_OPENERS: readonly string[] = [
    '我在。',
    '慢慢来。',
    '你准备好了就开始。',
    '你准备好了，我就在这里。',
];

export const ZH_TIMER_APPROACH_FALLBACKS: readonly string[] = [
    '还剩一点时间。一切保持原样就好。',
    '还有几分钟。什么都不需要做。',
    '快到尾声了。继续和此刻的一切待在一起。',
];

export const ZH_TIMER_COMPLETION_FALLBACKS: readonly string[] = [
    '时间到了。你准备好了再慢慢回来。',
    '你设的时间结束了。慢慢回来，不着急。',
    '这一坐到这里就结束了。不用急。',
];

export const ZH_TIMER_CLOSE_FALLBACKS: readonly string[] = [
    '时间到了。我就陪你到这里。',
    '你设的时间到了。就到这里吧。',
    '这一坐到这里结束。慢慢来。',
];

export const ZH_FELT_SENSE_OPENERS: readonly string[] = [
    '花一点时间安顿下来……当你准备好了，可以在心里问问自己：此刻，是什么隔在我和「感觉还好」之间？',
    '慢慢安顿，不着急。当你准备好了，我们来留意一下，今天什么在心里压着分量。',
    '先让自己到达这里。几个轻松的呼吸……然后也许在心里问问：此刻什么想要我的注意？',
    '什么时候开始都可以。你可以让注意力慢慢落到身体的中间，感受一下那里现在是什么样子。',
    '不急着开始。先让自己落定……看看你今天带着什么来了。',
];

export const ZH_FELT_SENSE_CHECK_INS: readonly string[] = [
    '不着急。身体有它自己的节奏。',
    '我还在，等多久都可以。',
    '需要多久就用多久。',
    '我在。',
    '还陪着你。',
    '要多久都没关系。',
];

export const ZH_NOTING_CHECK_IN_PROMPTS: readonly string[] = [
    '我还在这里陪着你。',
    '继续标记浮现出来的任何东西就好。',
    '我在。',
    '现在浮现的是什么？',
    '还陪着你。',
    '不急。',
];

export const ZH_NOTING_STATIC_OPENERS: readonly string[] = [
    '轮到你的时候，用一两个词说出你觉察到的任何东西。我们开始吧。',
];

export const ZH_FOCUS_OPENERS: Record<string, readonly string[]> = {
    body_sensations: [
        '让自己慢慢回到身体里……你注意到了什么？',
        '花一点时间感受你的身体。那里有什么？',
        '此刻你在身体里注意到了什么？',
    ],
    emotions: [
        '你现在感觉怎么样？',
        '花一点时间到达这里……你心里还好吗？',
        '慢慢安顿下来。此刻心里是什么样的基调？',
    ],
    inner_parts: [
        '先和自己打个招呼……此刻内在有什么？',
        '花一点时间到达这里……你心里还好吗？',
        '慢慢安顿下来。内在有什么浮现出来？',
    ],
    open_awareness: [
        '此刻什么占据着你的注意力？',
        '看看今天有什么在。你注意到了什么？',
    ],
};

export const ZH_QUALITY_OPENERS: Record<string, readonly string[]> = {
    playful: ['嘿，里面在发生什么呢？', '那么……你注意到了什么？'],
    compassionate: ['你好。从你现在所在的地方开始就好。你怎么样？', '不着急。你还好吗？'],
    loving: ['慢慢安顿下来……此刻有什么需要一点温柔和善意吗？'],
    spacious: ['这里有很多空间。你注意到了什么？'],
    effortless: ['什么都不用做。本来就在这里的，是什么？'],
    feeling_good: [
        '此刻有什么感觉是舒服的吗？',
        '花一点时间。有什么感觉不错的，哪怕一点点？',
        '慢慢安顿下来……有什么感觉还不错的吗？',
    ],
};

/** en pool → zh twin, keyed by array identity so callers pass the pool they
 *  already hold and unlisted pools fall through unchanged. Populated by the
 *  pool owners via registerZhPool (see the imports-nothing note above). */
const poolZh = new Map<readonly string[], readonly string[]>();

/** Pair an en pool with its zh twin. Called by the pool's OWNER module at the
 *  end of its body, so registration can never race the pool's initialization. */
export function registerZhPool(en: readonly string[], zh: readonly string[]): void {
    poolZh.set(en, zh);
}

/**
 * The pool to draw from in `language`: the registered zh twin, or the en pool
 * itself. Falling back to English beats silence - a missing translation reads
 * wrong but a missing check-in fails the pacing machinery.
 */
export function localizePool(pool: readonly string[], language: SessionLanguage): readonly string[] {
    if (language === 'en') return pool;
    return poolZh.get(pool) ?? pool;
}
