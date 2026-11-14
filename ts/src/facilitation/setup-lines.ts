/**
 * What the app says on the setup screen: a confirmation for each change made
 * by voice (setup-command.ts) and the spoken half of the tour.
 *
 * Every line is fixed text. A hosted voice never synthesizes one per user:
 * each is rendered once per house voice by server/scripts/render-voice-clips.ts
 * and shipped as a static clip (ui/src/voice-clips.json lists what exists and
 * the text each clip was rendered from, so a line edited here without a
 * re-render is simply not played). A local voice (Piper, `say`, the browser's)
 * speaks the same text itself, which costs nothing.
 *
 * Kept whole and few. Fragments stitched together sound chopped, so a line
 * that varies ("Timer set for twenty minutes.") has a clip per common value
 * and a plain fallback for the rest.
 *
 * Writing them: sentence case, no em-dashes, "session" not "sit". Three words
 * or more where it reads naturally (Azure's softvoice says a one- or two-word
 * input twice about a third of the time), and never opening on "Right"
 * (the same voice clips that onset).
 */

import type { BeginMode } from './begin-command.js';
import type { Quality, Verbosity } from './prompts.js';
import type { SetupAction, SetupFocus } from './setup-command.js';

export type SetupLanguage = 'en' | 'zh';

/** `{name}` is the speaking voice's own name (the two introductions). */
export const SETUP_LINES = {
    'mode-exploration': { en: 'Okay, exploration mode.', zh: '好的，探索模式。' },
    'mode-noting': { en: 'Okay, noting mode.', zh: '好的，标记模式。' },
    'mode-felt-sense': { en: 'Okay, felt sense mode.', zh: '好的，体会模式。' },

    'timer-5': { en: 'Timer set for five minutes.', zh: '计时五分钟。' },
    'timer-10': { en: 'Timer set for ten minutes.', zh: '计时十分钟。' },
    'timer-15': { en: 'Timer set for fifteen minutes.', zh: '计时十五分钟。' },
    'timer-20': { en: 'Timer set for twenty minutes.', zh: '计时二十分钟。' },
    'timer-30': { en: 'Timer set for thirty minutes.', zh: '计时三十分钟。' },
    'timer-45': { en: 'Timer set for forty-five minutes.', zh: '计时四十五分钟。' },
    'timer-60': { en: 'Timer set for an hour.', zh: '计时一小时。' },
    'timer-set': { en: 'Okay, the timer is set.', zh: '计时已设好。' },
    'timer-off': { en: 'The timer is off.', zh: '计时已关闭。' },

    'focus-body-on': { en: 'Body focus is on.', zh: '已加上身体与感受。' },
    'focus-body-off': { en: 'Body focus is off.', zh: '已去掉身体与感受。' },
    'focus-emotions-on': { en: 'Emotions focus is on.', zh: '已加上情绪。' },
    'focus-emotions-off': { en: 'Emotions focus is off.', zh: '已去掉情绪。' },
    'focus-parts-on': { en: 'Parts focus is on.', zh: '已加上内在部分。' },
    'focus-parts-off': { en: 'Parts focus is off.', zh: '已去掉内在部分。' },
    'focus-cleared': { en: 'All focuses are off.', zh: '焦点已全部去掉。' },

    'vibe-playful-on': { en: 'Playful is on.', zh: '已加上轻松有玩心。' },
    'vibe-playful-off': { en: 'Playful is off.', zh: '已去掉轻松有玩心。' },
    'vibe-compassionate-on': { en: 'Compassionate is on.', zh: '已加上慈悲。' },
    'vibe-compassionate-off': { en: 'Compassionate is off.', zh: '已去掉慈悲。' },
    'vibe-loving-on': { en: 'Loving is on.', zh: '已加上慈爱。' },
    'vibe-loving-off': { en: 'Loving is off.', zh: '已去掉慈爱。' },
    'vibe-spacious-on': { en: 'Spacious is on.', zh: '已加上开阔。' },
    'vibe-spacious-off': { en: 'Spacious is off.', zh: '已去掉开阔。' },
    'vibe-effortless-on': { en: 'Effortless is on.', zh: '已加上不费力。' },
    'vibe-effortless-off': { en: 'Effortless is off.', zh: '已去掉不费力。' },
    'vibe-feeling-good-on': { en: 'Feeling good is on.', zh: '已加上感觉不错。' },
    'vibe-feeling-good-off': { en: 'Feeling good is off.', zh: '已去掉感觉不错。' },
    'vibe-cleared': { en: 'All vibes are off.', zh: '氛围已全部去掉。' },

    'guidance-0': { en: 'Guidance set to following.', zh: '引导设为跟随。' },
    'guidance-1': { en: 'Guidance set to somewhat following.', zh: '引导设为略偏跟随。' },
    'guidance-2': { en: 'Guidance set to balanced.', zh: '引导设为均衡。' },
    'guidance-3': { en: 'Guidance set to somewhat directing.', zh: '引导设为略偏主导。' },
    'guidance-4': { en: 'Guidance set to directing.', zh: '引导设为主导。' },

    'responses-low': { en: 'Responses will be brief.', zh: '回应会简短一些。' },
    'responses-medium': { en: 'Responses will be medium length.', zh: '回应长度适中。' },
    'responses-high': { en: 'Responses will be longer.', zh: '回应会更长一些。' },

    'intention-set': { en: 'Your intention is set.', zh: '意图已记下。' },
    'intention-cleared': { en: 'Your intention is cleared.', zh: '意图已清除。' },

    'checkins-on': { en: 'Check-ins are on.', zh: '安静时我会轻声问候。' },
    'checkins-off': { en: 'Check-ins are off.', zh: '安静时我不会打扰。' },

    'mic-off': { en: 'Okay, the mic is off.', zh: '好的，麦克风已关闭。' },
    help: {
        en: 'You can name a mode, a length, a vibe or a focus. Or say begin.',
        zh: '你可以说模式、时长、氛围或焦点，也可以说“开始”。',
    },
    'belongs-exploration': { en: "That's part of exploration.", zh: '这是探索模式的设置。' },
    'belongs-felt-sense': { en: "That's part of felt sense.", zh: '这是体会模式的设置。' },
    'not-in-mode': { en: "This mode doesn't use that.", zh: '这个模式没有这一项。' },
    unavailable: { en: "That can't change right now.", zh: '现在改不了这一项。' },
    'all-set': { en: 'Okay, all set.', zh: '好的，都设好了。' },

    // ---- the tour (ui/src/tour/index-guide.ts) ----
    'tour-hello': {
        en: 'Welcome to aloud. I speak, and I listen. Turn on the microphone and you can answer me out loud.',
        zh: '欢迎来到 aloud。我会说，也会听。打开麦克风，你就可以直接开口回答我。',
    },
    'voice-intro-first': { en: "Hi, I'm {name}. This is how I sound.", zh: '你好，我是 {name}。这是我的声音。' },
    'voice-intro-second': {
        en: "And I'm {name}. Say which of us you'd like, or tap one.",
        zh: '我是 {name}。想听谁的声音？说出名字，或者点一下。',
    },
    'tour-voice-picked': {
        en: 'Good. There are more voices in the voice picker whenever you like.',
        zh: '好的。以后随时可以在声音选择里换别的声音。',
    },
    'tour-exploration': {
        en: 'Exploration is a conversation. You say what you notice, and I ask short questions to help you look closer.',
        zh: '探索是一场对话。你说出此刻注意到的，我用简短的问题陪你看得更细。',
    },
    'tour-noting': {
        en: 'Noting is quieter. You name what you notice in a word or two, and others can take turns with you.',
        zh: '标记更安静。你用一两个词说出注意到的，也可以和其他参与者轮流。',
    },
    'tour-felt-sense': {
        en: 'Felt sense follows six steps for getting to know one thing, slowly, in the body.',
        zh: '体会分六步，在身体里慢慢了解一件事。',
    },
    'tour-focus': {
        en: 'A focus tells me where your attention is going: the body, emotions, or parts of yourself.',
        zh: '焦点告诉我你的注意力放在哪里：身体、情绪，或内在的各个部分。',
    },
    'tour-vibe': {
        en: 'Vibes set my tone. Playful, spacious, loving, any mix you like.',
        zh: '氛围决定我的语气。轻松、开阔、慈爱，可以随意搭配。',
    },
    'tour-voice-control': {
        en: 'You can change all of this out loud. Try saying: twenty minutes.',
        zh: '这些都可以直接说出来改。试着说：二十分钟。',
    },
    'tour-done': {
        en: "That's everything. Say begin when you're ready.",
        zh: '就这些。准备好了，就说“开始”。',
    },
} as const satisfies Record<string, Record<SetupLanguage, string>>;

export type SetupLineId = keyof typeof SETUP_LINES;

export const SETUP_LINE_IDS = Object.keys(SETUP_LINES) as SetupLineId[];

export function setupLanguage(language: string): SetupLanguage {
    return language === 'zh' ? 'zh' : 'en';
}

/** A line's text, with the speaking voice's name filled in where it has one. */
export function setupLineText(id: SetupLineId, language: string, vars: { name?: string } = {}): string {
    return SETUP_LINES[id][setupLanguage(language)].replace('{name}', vars.name ?? '');
}

/**
 * What applying one SetupAction came to: the form as it now stands, which is
 * what gets said back. `views/setup.ts` produces these.
 */
export type SetupOutcome =
    | { kind: 'mode'; mode: BeginMode }
    /** The timer as set, after clamping. */
    | { kind: 'length'; minutes: number }
    | { kind: 'no-timer' }
    | { kind: 'focus'; focus: SetupFocus; on: boolean }
    | { kind: 'quality'; quality: Quality; on: boolean }
    | { kind: 'cleared'; group: 'focus' | 'quality' }
    /** The guidance slider's stop after the move, 0 to 4. */
    | { kind: 'guidance'; step: number }
    | { kind: 'verbosity'; value: Verbosity }
    | { kind: 'intention'; set: boolean }
    | { kind: 'checkins'; on: boolean }
    | { kind: 'stop-listening' }
    | { kind: 'help' }
    /** Not applied: the setting lives under another mode's tab (null: under
     *  more than one other, or this mode just has no such thing). */
    | { kind: 'elsewhere'; mode: BeginMode | null }
    /** Not applied: the form won't take it right now (a continuation holds
     *  the mode). */
    | { kind: 'unavailable' };

/** Which modes carry a setting. Voice, timer and mode itself are everywhere. */
export function setupActionModes(action: SetupAction): readonly BeginMode[] | null {
    switch (action.kind) {
        case 'focus':
        case 'quality':
        case 'clear':
        case 'guidance':
        case 'verbosity':
            return ['exploration'];
        case 'checkins':
            return ['felt_sense'];
        case 'intention':
            return ['exploration', 'felt_sense'];
        default:
            return null;
    }
}

const TIMER_CLIPS: ReadonlySet<number> = new Set([5, 10, 15, 20, 30, 45, 60]);

const FOCUS_SLUG: Record<SetupFocus, 'body' | 'emotions' | 'parts'> = {
    body_sensations: 'body',
    emotions: 'emotions',
    inner_parts: 'parts',
};
const QUALITY_SLUG: Record<Quality, 'playful' | 'compassionate' | 'loving' | 'spacious' | 'effortless' | 'feeling-good'> = {
    playful: 'playful',
    compassionate: 'compassionate',
    loving: 'loving',
    spacious: 'spacious',
    effortless: 'effortless',
    feeling_good: 'feeling-good',
};

/** A line to say: the clip to play, and the words for a voice that
 *  synthesizes (the same as the clip's, or more exact: any number of minutes). */
export interface SpokenSetupLine {
    id: SetupLineId;
    text: string;
}

function minutesText(minutes: number, language: SetupLanguage): string {
    if (language === 'zh') return `计时${minutes}分钟。`;
    return `Timer set for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

function lineFor(outcome: SetupOutcome, language: SetupLanguage): SpokenSetupLine {
    const fixed = (id: SetupLineId): SpokenSetupLine => ({ id, text: SETUP_LINES[id][language] });
    switch (outcome.kind) {
        case 'mode':
            return fixed(outcome.mode === 'felt_sense' ? 'mode-felt-sense' : `mode-${outcome.mode}`);
        case 'length':
            return TIMER_CLIPS.has(outcome.minutes)
                ? fixed(`timer-${outcome.minutes}` as SetupLineId)
                : { id: 'timer-set', text: minutesText(outcome.minutes, language) };
        case 'no-timer':
            return fixed('timer-off');
        case 'focus':
            return fixed(`focus-${FOCUS_SLUG[outcome.focus]}-${outcome.on ? 'on' : 'off'}`);
        case 'quality':
            return fixed(`vibe-${QUALITY_SLUG[outcome.quality]}-${outcome.on ? 'on' : 'off'}`);
        case 'cleared':
            return fixed(outcome.group === 'focus' ? 'focus-cleared' : 'vibe-cleared');
        case 'guidance':
            return fixed(`guidance-${Math.max(0, Math.min(4, Math.round(outcome.step)))}` as SetupLineId);
        case 'verbosity':
            return fixed(`responses-${outcome.value}`);
        case 'intention':
            return fixed(outcome.set ? 'intention-set' : 'intention-cleared');
        case 'checkins':
            return fixed(outcome.on ? 'checkins-on' : 'checkins-off');
        case 'stop-listening':
            return fixed('mic-off');
        case 'help':
            return fixed('help');
        case 'elsewhere':
            return fixed(
                outcome.mode === 'exploration'
                    ? 'belongs-exploration'
                    : outcome.mode === 'felt_sense'
                      ? 'belongs-felt-sense'
                      : 'not-in-mode'
            );
        case 'unavailable':
            return fixed('unavailable');
    }
}

/** Past this many lines a request is answered with one "all set". */
const MAX_SPOKEN_LINES = 3;

/**
 * The lines that say back what a request changed, in order. A clear that only
 * made room for what was then added ("change the vibe to spacious") is not
 * announced, and neither is the same thing twice.
 */
export function setupOutcomeLines(outcomes: readonly SetupOutcome[], language: string): SpokenSetupLine[] {
    const lang = setupLanguage(language);
    const said = outcomes.filter((outcome, i) => {
        if (outcome.kind !== 'cleared') return true;
        return !outcomes.slice(i + 1).some((later) => later.kind === outcome.group && later.on);
    });
    const lines: SpokenSetupLine[] = [];
    for (const outcome of said) {
        const line = lineFor(outcome, lang);
        if (!lines.some((l) => l.id === line.id && l.text === line.text)) lines.push(line);
    }
    if (lines.length > MAX_SPOKEN_LINES) return [{ id: 'all-set', text: SETUP_LINES['all-set'][lang] }];
    return lines;
}
