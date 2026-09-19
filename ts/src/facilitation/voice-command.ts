/**
 * Spoken commands: "set a timer for ten minutes", "talk slower", "end the
 * session" (v36y phase 2). Voice is the only input, so anything that otherwise
 * needs eyes open and a finger belongs here.
 *
 * Unlike isMuteCommand these are judged by a model (Jev, voice-command-specs.ts),
 * because natural phrasing is the point: "could you slow down a little" and
 * "you're going too fast" should both work. That makes them hosted-only - there
 * is no LLM twin to fall back to, so no judge means the utterance is an ordinary
 * turn. `mute` stays a regex for the opposite reason: it has to work everywhere,
 * instantly.
 *
 * Two rules keep a misfire cheap:
 * - Every command but one is small and reversible, and says what it did.
 * - Ending the session is never an act, only a question ("Would you like to end
 *   the session?") whose answer is judged separately, the way [HOLD] is a bid.
 *   "I want this to be over" must not end a sit.
 */

import type { SessionLanguage } from './language.js';
import {
    judgeTop,
    type JudgeAnswers,
    type UtteranceJudge,
} from './utterance-judge.js';
import { COMMAND_SPECS, VOICE_COMMAND_IDS, type VoiceCommandId } from './voice-command-specs.js';

export { VOICE_COMMAND_IDS, type VoiceCommandId };

/**
 * Commands are short. Past this an utterance is reflection, and skipping the
 * judge keeps its ~150ms off the turns where someone is actually waiting on a
 * reply to something they said.
 */
const MAX_COMMAND_WORDS = 14;
const MAX_COMMAND_CJK_CHARS = 24;

export function mightBeCommand(utterance: string): boolean {
    const text = utterance.trim();
    if (!text) return false;
    const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0;
    if (cjk > 0) return cjk <= MAX_COMMAND_CJK_CHARS;
    return text.split(/\s+/).length <= MAX_COMMAND_WORDS;
}

/**
 * "End without saving" is also, truthfully, "end the session": both asks score
 * ~0.96 on it and the plain one can edge ahead. When a save/discard variant
 * clears the bar it is what they said. Both variants at once is a judge that
 * couldn't tell, so that falls back to the plain ending, which follows the
 * user's own default.
 */
function moreSpecific(top: VoiceCommandId, answers: JudgeAnswers): VoiceCommandId {
    if (top !== 'end_session' && top !== 'end_discard' && top !== 'end_save') return top;
    const cleared = (['end_discard', 'end_save'] as const).filter(
        (id) => (answers[id] ?? 0) >= COMMAND_SPECS.command.asks[id]!.threshold
    );
    return cleared.length === 1 ? cleared[0]! : 'end_session';
}

export interface DetectedCommand {
    command: VoiceCommandId;
    answers: JudgeAnswers;
    latencyMs: number;
}

/**
 * The command in this utterance, or null. Never throws: a judge failure is
 * "not a command", and the utterance goes on to be a turn.
 */
export async function detectVoiceCommand(
    judge: UtteranceJudge,
    utterance: string
): Promise<DetectedCommand | null> {
    if (!mightBeCommand(utterance)) return null;
    const t0 = Date.now();
    try {
        const answers = await judge.judge('command', utterance);
        const top = judgeTop('command', answers);
        if (!top || !(VOICE_COMMAND_IDS as string[]).includes(top)) return null;
        return { command: moreSpecific(top as VoiceCommandId, answers), answers, latencyMs: Date.now() - t0 };
    } catch {
        return null;
    }
}

/**
 * Takes the command check off the critical path. The recognizer knows the words
 * a few seconds before the turn is submitted (it waits out a pause first), so
 * the judge can be asked during that wait and the answer be ready at submit.
 *
 * It only ever makes an answer EARLY. Nothing acts on a prefetched verdict until
 * the final transcript arrives and matches the text that was judged; a final
 * that differs is judged fresh, exactly as without this.
 *
 * Debounced, because browser recognizers emit a partial per word and only the
 * one that stops changing is worth a request.
 */
export class CommandPrefetch {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending: { key: string; result: Promise<DetectedCommand | null> } | null = null;

    constructor(
        private readonly judge: UtteranceJudge,
        /** A partial must sit unchanged this long before it's worth judging. */
        private readonly settleMs = 350
    ) {}

    /** Case, edge whitespace and trailing punctuation differ between a partial
     *  and its final without the words differing. */
    private static keyOf(text: string): string {
        return text.trim().toLowerCase().replace(/[\s.,!?。，！？…]+$/u, '');
    }

    /** A partial transcript arrived. */
    note(partial: string): void {
        const key = CommandPrefetch.keyOf(partial);
        if (this.pending?.key === key) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (!key || !mightBeCommand(partial)) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.pending = { key, result: detectVoiceCommand(this.judge, partial) };
        }, this.settleMs);
    }

    /**
     * The final transcript arrived: the verdict already asked for, if it was for
     * these words (possibly still in flight - awaiting it is still a head start),
     * else null and the caller judges it fresh. Always resets.
     */
    take(finalText: string): Promise<DetectedCommand | null> | null {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const hit = this.pending?.key === CommandPrefetch.keyOf(finalText) ? this.pending.result : null;
        this.pending = null;
        return hit;
    }
}

/**
 * The reply to "Would you like to end the session?".
 * - `yes`   - end it.
 * - `no`    - they declined; acknowledge and carry on.
 * - `other` - they ignored the question (or the judge failed): an ordinary
 *             turn. The button still works.
 */
export async function classifyEndConfirm(
    judge: UtteranceJudge,
    utterance: string
): Promise<'yes' | 'no' | 'other'> {
    try {
        const top = judgeTop('end-confirm', await judge.judge('end-confirm', utterance));
        return top === 'confirms' ? 'yes' : top === 'declines' ? 'no' : 'other';
    } catch {
        return 'other';
    }
}

// ---- timer durations --------------------------------------------------------
// Jev says THAT a timer was asked for, not for how long; this pulls the number
// out of the same utterance.

const EN_UNITS: Record<string, number> = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "twenty five" / "forty-five" / "12" / "an" as a number, else null. */
function enNumber(words: string[]): number | null {
    if (words.length === 1 && /^\d+(\.\d+)?$/.test(words[0]!)) return Number(words[0]);
    let total = 0;
    let seen = false;
    for (const w of words) {
        if (w in EN_TENS) total += EN_TENS[w]!;
        else if (w in EN_UNITS) total += EN_UNITS[w]!;
        else return null;
        seen = true;
    }
    return seen ? total : null;
}

const ZH_DIGITS: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 0-99 in Chinese numerals ("二十五", "十", "两") or ASCII digits. */
function zhNumber(s: string): number | null {
    if (/^\d+$/.test(s)) return Number(s);
    if (!/^[零一二两三四五六七八九十]+$/.test(s)) return null;
    const at = s.indexOf('十');
    if (at < 0) return s.length === 1 ? (ZH_DIGITS[s] ?? null) : null;
    const tens = at === 0 ? 1 : ZH_DIGITS[s[at - 1]!];
    const ones = at === s.length - 1 ? 0 : ZH_DIGITS[s[at + 1]!];
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
}

export interface TimerRequest {
    minutes: number;
    /** "five more minutes": add to what's left rather than start over. */
    relative: boolean;
}

/** The duration in a set-timer utterance, or null when it names none. */
export function parseTimerRequest(utterance: string): TimerRequest | null {
    const zh = utterance.replace(/[\s。，！？、．.…,!?~]+/gu, '');
    if (/[㐀-鿿]/.test(zh)) {
        const relative = /[再多加]|延长/.test(zh);
        if (/半个?小时/.test(zh) && !/[\d一二两三四五六七八九十]个?半小时/.test(zh)) return { minutes: 30, relative };
        const hour = /([\d零一二两三四五六七八九十]+)个?(半)?小时/.exec(zh);
        if (hour) {
            const n = zhNumber(hour[1]!);
            if (n !== null) return { minutes: n * 60 + (hour[2] ? 30 : 0), relative };
        }
        const min = /([\d零一二两三四五六七八九十]+)分钟?/.exec(zh);
        const n = min ? zhNumber(min[1]!) : null;
        return n !== null && n > 0 ? { minutes: n, relative } : null;
    }

    const text = utterance.toLowerCase().replace(/-/g, ' ');
    const relative = /\b(more|another|extra|additional|longer|add|extend)\b/.test(text);
    if (/\bhalf (an |a )?hour\b/.test(text) && !/\band a half hours?\b/.test(text)) return { minutes: 30, relative };
    const words = text
        .replace(/[^a-z0-9. ]+/g, ' ')
        // Keep a decimal point, drop a full stop ("minutes.").
        .replace(/\.(?!\d)/g, ' ')
        .split(/\s+/)
        // "five MORE minutes": the number has to sit next to its unit below.
        .filter((w) => w && !/^(more|extra|additional)$/.test(w));
    // Last duration wins: "wait a minute, set a timer for twelve minutes".
    for (let i = words.length - 1; i >= 0; i--) {
        const unit = /^(minutes?|mins?|hours?|hrs?)$/.exec(words[i]!);
        if (!unit) continue;
        const perUnit = unit[1]!.startsWith('h') ? 60 : 1;
        // "an hour and a half": the half trails the unit.
        const half = perUnit === 60 && words.slice(i + 1, i + 4).join(' ') === 'and a half' ? 30 : 0;
        // Longest run of number words ending right before the unit.
        for (let start = Math.max(0, i - 3); start < i; start++) {
            const n = enNumber(words.slice(start, i));
            if (n !== null && n > 0) return { minutes: n * perUnit + half, relative };
        }
    }
    return null;
}

// ---- speaking rate ----------------------------------------------------------

/** Matches the voice picker's slider (voice-picker.ts). */
export const TTS_RATE_MIN = 60;
export const TTS_RATE_MAX = 240;
/** Two slider stops: one is hard to hear, and "slower" asked twice is tedious. */
export const TTS_RATE_STEP = 20;

/** The rate after one "slower"/"faster", or null when already at the end. */
export function steppedRate(current: number, direction: 'slower' | 'faster'): number | null {
    const next = Math.min(
        TTS_RATE_MAX,
        Math.max(TTS_RATE_MIN, current + (direction === 'faster' ? TTS_RATE_STEP : -TTS_RATE_STEP))
    );
    return next === current ? null : next;
}

// ---- reply timing -----------------------------------------------------------
// "Respond more quickly" / "wait longer before responding" move the
// pause-before-submit pair (AppSettings.silenceBaseMs/MaxMs) one rung. The
// Settings presets (Quick / Relaxed / Spacious) are rungs 1, 2 and 4, so a voice
// change usually lands on a named stop there rather than "Custom".

export interface PauseWindow {
    baseMs: number;
    maxMs: number;
}

export const PAUSE_LADDER: readonly PauseWindow[] = [
    { baseMs: 1500, maxMs: 2500 },
    { baseMs: 2000, maxMs: 3500 },
    { baseMs: 3000, maxMs: 5000 },
    { baseMs: 4000, maxMs: 6500 },
    { baseMs: 5000, maxMs: 8000 },
    { baseMs: 6500, maxMs: 10000 },
];

/** The next rung from wherever `currentBaseMs` sits (it may be a custom value
 *  between rungs), or null at the end of the ladder. */
export function steppedPause(currentBaseMs: number, direction: 'sooner' | 'longer'): PauseWindow | null {
    if (direction === 'sooner') {
        return [...PAUSE_LADDER].reverse().find((w) => w.baseMs < currentBaseMs) ?? null;
    }
    return PAUSE_LADDER.find((w) => w.baseMs > currentBaseMs) ?? null;
}

// ---- what the app says back -------------------------------------------------
// Canned, like HOLD_REENTRY_LINES: the app knows what it just did and the model
// doesn't. Short enough to land and get out of the way. Functions rather than
// registerZhPool pools because most of them carry a number.

const zhOr = (language: SessionLanguage, en: string, zh: string): string => (language === 'zh-CN' ? zh : en);

const minutesEn = (n: number): string => (n === 1 ? '1 minute' : `${n} minutes`);

export const COMMAND_LINES = {
    slower: (l: SessionLanguage) => zhOr(l, 'Okay, slower.', '好,慢一点。'),
    faster: (l: SessionLanguage) => zhOr(l, 'Okay, a little faster.', '好,快一点。'),
    slowest: (l: SessionLanguage) => zhOr(l, "That's as slow as I go.", '这已经是最慢的了。'),
    fastest: (l: SessionLanguage) => zhOr(l, "That's as fast as I go.", '这已经是最快的了。'),
    timerSet: (l: SessionLanguage, min: number) => zhOr(l, `Timer set for ${minutesEn(min)}.`, `计时${min}分钟。`),
    // With "end the session when the time is up" on. The setting is theirs and a
    // voice-set timer keeps it; this is so the ending isn't a surprise.
    timerSetEnds: (l: SessionLanguage, min: number) =>
        zhOr(
            l,
            `Timer set for ${minutesEn(min)}. The session will end when it's up.`,
            `计时${min}分钟。时间到后会结束冥想。`
        ),
    timerExtended: (l: SessionLanguage, min: number) => zhOr(l, `${minutesEn(min)} more.`, `再加${min}分钟。`),
    timerNoDuration: (l: SessionLanguage) =>
        zhOr(l, "I didn't catch how long. Try: set a timer for ten minutes.", '我没听清多长时间。可以说:计时十分钟。'),
    timerCancelled: (l: SessionLanguage) => zhOr(l, 'Timer cancelled.', '计时已取消。'),
    noTimer: (l: SessionLanguage) => zhOr(l, "There's no timer running.", '现在没有计时。'),
    timeLeft: (l: SessionLanguage, min: number) =>
        min < 1 ? zhOr(l, 'Less than a minute left.', '还剩不到一分钟。') : zhOr(l, `About ${minutesEn(min)} left.`, `还剩大约${min}分钟。`),
    timeElapsed: (l: SessionLanguage, min: number) =>
        min < 1
            ? zhOr(l, "We've just started.", '我们才刚开始。')
            : zhOr(l, `We've been going about ${minutesEn(min)}.`, `我们已经进行了大约${min}分钟。`),
    respondSooner: (l: SessionLanguage) => zhOr(l, "Okay, I'll come in sooner.", '好,我会回应得快一些。'),
    waitLonger: (l: SessionLanguage) => zhOr(l, "Okay, I'll give you more room.", '好,我会多等一会儿。'),
    soonest: (l: SessionLanguage) => zhOr(l, "That's as quick as I can be.", '这已经是最快的了。'),
    longest: (l: SessionLanguage) => zhOr(l, "That's the longest I can wait.", '这已经是最久的了。'),
    pauseUnsupported: (l: SessionLanguage) =>
        zhOr(l, "I can't change that with this microphone mode.", '这种麦克风模式下无法调整。'),
    nothingToRepeat: (l: SessionLanguage) => zhOr(l, "I haven't said anything yet.", '我还没有说过话。'),
    // Four, not ten: read aloud, the full list is a lecture. The rest are in the
    // session info panel, which this points at.
    help: (l: SessionLanguage) =>
        zhOr(
            l,
            'You can ask me to talk slower or faster, set a timer, repeat myself, or end the session. The full list is under the info button.',
            '你可以让我说慢一点或快一点、设置计时、再说一遍,或者结束冥想。完整的指令在信息按钮里。'
        ),
    muted: (l: SessionLanguage) => zhOr(l, 'Muted.', '已静音。'),
    endDiscardConfirm: (l: SessionLanguage) =>
        zhOr(l, 'End the session without saving it?', '不保存,直接结束这次冥想吗?'),
    endSaveConfirm: (l: SessionLanguage) => zhOr(l, 'End the session and save it?', '保存并结束这次冥想吗?'),
    endConfirm: (l: SessionLanguage) => zhOr(l, 'Would you like to end the session?', '要结束这次冥想吗?'),
    endDeclined: (l: SessionLanguage) => zhOr(l, "Okay, we'll keep going.", '好,我们继续。'),
} as const;
