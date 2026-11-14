/**
 * What people say on the setup screen, labelled with what the device matchers
 * should make of the cleanly heard words (run.ts measures what Whisper makes
 * of them). Doubles as a read-aloud sheet: the phrasings are meant to be said.
 *
 * `expect`: 'begin' (parseBeginRequest, with `begin` for what it names), the
 * SetupAction list parseSetupCommand should return (order free), or null for
 * something that must change nothing.
 */

import type { BeginRequest } from '../../src/facilitation/begin-command.js';
import type { SetupAction, SetupFocus } from '../../src/facilitation/setup-command.js';
import type { Quality } from '../../src/facilitation/prompts.js';

export interface Phrase {
    text: string;
    lang: 'en' | 'zh';
    expect: 'begin' | SetupAction[] | null;
    /** What a begin should carry; absent is a plain begin. */
    begin?: BeginRequest;
    group: string;
}

const mode = (m: 'exploration' | 'noting' | 'felt_sense'): SetupAction => ({ kind: 'mode', mode: m });
const len = (minutes: number): SetupAction => ({ kind: 'length', minutes });
const noTimer: SetupAction = { kind: 'no-timer' };
const focus = (f: SetupFocus, on = true): SetupAction => ({ kind: 'focus', focus: f, on });
const vibe = (q: Quality, on = true): SetupAction => ({ kind: 'quality', quality: q, on });
const clear = (group: 'focus' | 'quality'): SetupAction => ({ kind: 'clear', group });
const guide = (to: 'up' | 'down' | number): SetupAction => ({ kind: 'guidance', to });
const words = (to: 'up' | 'down' | 'low' | 'medium' | 'high'): SetupAction => ({ kind: 'verbosity', to });
const intention = (text: string): SetupAction => ({ kind: 'intention', text });
const checkins = (on: boolean): SetupAction => ({ kind: 'checkins', on });
const stopListening: SetupAction = { kind: 'stop-listening' };
const help: SetupAction = { kind: 'help' };

const BODY = 'body_sensations';
const EMOTIONS = 'emotions';
const PARTS = 'inner_parts';

type Row = [text: string, expect: Phrase['expect'], begin?: BeginRequest];

function rows(lang: Phrase['lang'], group: string, list: Row[]): Phrase[] {
    return list.map(([text, expect, begin]) => ({ text, lang, expect, group, ...(begin ? { begin } : {}) }));
}

export const PHRASES: Phrase[] = [
    ...rows('en', 'mode', [
        ['noting', [mode('noting')]],
        ['noting mode', [mode('noting')]],
        ['switch to noting', [mode('noting')]],
        ["let's do noting", [mode('noting')]],
        ['exploration', [mode('exploration')]],
        ['exploration mode, please', [mode('exploration')]],
        ['go back to exploration', [mode('exploration')]],
        ['felt sense', [mode('felt_sense')]],
        ['switch to felt sense', [mode('felt_sense')]],
        ["let's do a felt sense session", [mode('felt_sense')]],
        ['switch to focusing', [mode('felt_sense')]],
    ]),
    ...rows('en', 'length', [
        ['twenty minutes', [len(20)]],
        ['ten minutes', [len(10)]],
        ['five minutes', [len(5)]],
        ['twelve minutes', [len(12)]],
        ['forty minutes', [len(40)]],
        ['forty-five minutes', [len(45)]],
        ['set the timer for fifteen minutes', [len(15)]],
        ['make it thirty minutes', [len(30)]],
        ['a twenty minute session', [len(20)]],
        ['an hour', [len(60)]],
        ['one hour', [len(60)]],
        ['half an hour', [len(30)]],
        ['an hour and a half', [len(90)]],
        ['two hours', [len(120)]],
        ['no timer', [noTimer]],
        ['turn off the timer', [noTimer]],
        ['open-ended', [noTimer]],
        ["let's make it open-ended", [noTimer]],
        ['no time limit', [noTimer]],
    ]),
    ...rows('en', 'focus', [
        ['body', [focus(BODY)]],
        ['focus on the body', [focus(BODY)]],
        ['body and sensations', [focus(BODY)]],
        ['emotions', [focus(EMOTIONS)]],
        ['add emotions', [focus(EMOTIONS)]],
        ['parts', [focus(PARTS)]],
        ['add parts work', [focus(PARTS)]],
        ['inner parts', [focus(PARTS)]],
        ['remove the body focus', [focus(BODY, false)]],
        ['drop emotions', [focus(EMOTIONS, false)]],
        ['uncheck parts', [focus(PARTS, false)]],
        ['only body', [clear('focus'), focus(BODY)]],
        ['change the focus to parts', [clear('focus'), focus(PARTS)]],
        ['set the focus to body and emotions', [clear('focus'), focus(BODY), focus(EMOTIONS)]],
        ['body and emotions', [focus(BODY), focus(EMOTIONS)]],
        ['focus on emotions and parts', [focus(EMOTIONS), focus(PARTS)]],
        ['clear the focus', [clear('focus')]],
        ['no focus', [clear('focus')]],
    ]),
    ...rows('en', 'vibe', [
        ['playful', [vibe('playful')]],
        ['add playful', [vibe('playful')]],
        ['make it more playful', [vibe('playful')]],
        ['more lighthearted', [vibe('playful')]],
        ['less playful', [vibe('playful', false)]],
        ['no playful', [vibe('playful', false)]],
        ['remove playful and loving', [vibe('playful', false), vibe('loving', false)]],
        ['compassionate', [vibe('compassionate')]],
        ['add compassion', [vibe('compassionate')]],
        ['loving', [vibe('loving')]],
        ['loving kindness', [vibe('loving')]],
        ['spacious', [vibe('spacious')]],
        ['a spacious vibe', [vibe('spacious')]],
        ['effortless', [vibe('effortless')]],
        ['feeling good', [vibe('feeling_good')]],
        ['turn off effortless', [vibe('effortless', false)]],
        ['without feeling good', [vibe('feeling_good', false)]],
        ['drop the spacious vibe', [vibe('spacious', false)]],
        ['playful and spacious', [vibe('playful'), vibe('spacious')]],
        ['loving and compassionate', [vibe('loving'), vibe('compassionate')]],
        ['change the vibe to spacious', [clear('quality'), vibe('spacious')]],
        ['set the vibe to playful and loving', [clear('quality'), vibe('playful'), vibe('loving')]],
        ['only compassionate', [clear('quality'), vibe('compassionate')]],
        ['clear the vibes', [clear('quality')]],
        ['no vibes', [clear('quality')]],
    ]),
    ...rows('en', 'guidance', [
        ['more guidance', [guide('up')]],
        ['less guidance', [guide('down')]],
        ['a little less guidance', [guide('down')]],
        ['guide me more', [guide('up')]],
        ['turn up the guidance', [guide('up')]],
        ['more directive', [guide('up')]],
        ['lead more', [guide('up')]],
        ['follow me more', [guide('down')]],
        ['following', [guide(0)]],
        ['somewhat following', [guide(1)]],
        ['balanced', [guide(2)]],
        ['set guidance to balanced', [guide(2)]],
        ['somewhat directing', [guide(3)]],
        ['directing', [guide(4)]],
    ]),
    ...rows('en', 'responses', [
        ['shorter responses', [words('down')]],
        ['longer responses', [words('up')]],
        ['shorter replies, please', [words('down')]],
        ['brief responses', [words('low')]],
        ['medium length responses', [words('medium')]],
        ['long responses', [words('high')]],
        ['talk less', [words('down')]],
        ['talk more', [words('up')]],
        ['say less', [words('down')]],
        ['fewer words', [words('down')]],
        ['keep your responses short', [words('low')]],
    ]),
    ...rows('en', 'intention', [
        ['my intention is to rest', [intention('to rest')]],
        ['my intention is to be kind to myself', [intention('to be kind to myself')]],
        ["the intention is just to notice what's here", [intention("just to notice what's here")]],
        ['my intention for today is to soften', [intention('to soften')]],
        ['set my intention to letting go', [intention('letting go')]],
        ['something to sit with is the job decision', [intention('the job decision')]],
        ['I want to sit with this restless feeling', [intention('this restless feeling')]],
        ['clear my intention', [intention('')]],
        ['no intention', [intention('')]],
    ]),
    ...rows('en', 'checkins', [
        ['check-ins off', [checkins(false)]],
        ['no check-ins', [checkins(false)]],
        ["don't check in", [checkins(false)]],
        ['check-ins on', [checkins(true)]],
        ['turn on check-ins', [checkins(true)]],
        ["check in on me if I'm quiet", [checkins(true)]],
    ]),
    ...rows('en', 'stop-listening', [
        ['stop listening', [stopListening]],
        ['mute', [stopListening]],
        ['turn off the mic', [stopListening]],
        ['you can stop listening now', [stopListening]],
    ]),
    ...rows('en', 'help', [
        ['help', [help]],
        ['what can I say', [help]],
        ['what are my options', [help]],
    ]),
    ...rows('en', 'begin', [
        ['begin', 'begin'],
        ['start', 'begin'],
        ["let's begin", 'begin'],
        ['start the session', 'begin'],
        ["okay, I'm ready to begin", 'begin'],
        ['can we start now', 'begin'],
        ['start meditating', 'begin'],
        ['start a noting session', 'begin', { mode: 'noting' }],
        ['begin a twenty minute felt sense session', 'begin', { mode: 'felt_sense', minutes: 20 }],
        ['begin ten minutes of exploration', 'begin', { mode: 'exploration', minutes: 10 }],
        ["let's start a half hour session", 'begin', { minutes: 30 }],
    ]),
    ...rows('en', 'combined', [
        ['felt sense and twenty minutes', [mode('felt_sense'), len(20)]],
        ['noting for ten minutes', [mode('noting'), len(10)]],
        ['forty-five minutes of noting', [len(45), mode('noting')]],
        ['switch to noting and no timer', [mode('noting'), noTimer]],
        ['exploration with emotions and parts', [mode('exploration'), focus(EMOTIONS), focus(PARTS)]],
        ['exploration, playful and body, thirty minutes', [mode('exploration'), vibe('playful'), focus(BODY), len(30)]],
        ['twenty minutes with more guidance', [len(20), guide('up')]],
        ['add playful and shorter responses', [vibe('playful'), words('down')]],
        ['body focus and a compassionate vibe', [focus(BODY), vibe('compassionate')]],
        ['less guidance and longer responses', [guide('down'), words('up')]],
        ['playful, loving and feeling good', [vibe('playful'), vibe('loving'), vibe('feeling_good')]],
        ['spacious and effortless, no check-ins', [vibe('spacious'), vibe('effortless'), checkins(false)]],
    ]),

    ...rows('zh', 'mode', [
        ['探索', [mode('exploration')]],
        ['标记模式', [mode('noting')]],
        ['体会模式', [mode('felt_sense')]],
        ['切换到体会', [mode('felt_sense')]],
    ]),
    ...rows('zh', 'length', [
        ['二十分钟', [len(20)]],
        ['十分钟', [len(10)]],
        ['半小时', [len(30)]],
        ['一个小时', [len(60)]],
        ['设定四十五分钟', [len(45)]],
        ['不要计时器', [noTimer]],
    ]),
    ...rows('zh', 'focus', [
        ['身体', [focus(BODY)]],
        ['加上情绪', [focus(EMOTIONS)]],
        ['去掉内在部分', [focus(PARTS, false)]],
        ['只要身体', [clear('focus'), focus(BODY)]],
    ]),
    ...rows('zh', 'vibe', [
        ['轻松', [vibe('playful')]],
        ['慈悲', [vibe('compassionate')]],
        ['加上慈爱', [vibe('loving')]],
        ['开阔', [vibe('spacious')]],
        ['不费力', [vibe('effortless')]],
        ['感觉不错', [vibe('feeling_good')]],
        ['不要轻松', [vibe('playful', false)]],
        ['去掉所有氛围', [clear('quality')]],
    ]),
    ...rows('zh', 'guidance', [
        ['多一点引导', [guide('up')]],
        ['少一点引导', [guide('down')]],
        ['跟随', [guide(0)]],
        ['均衡', [guide(2)]],
        ['主导', [guide(4)]],
    ]),
    ...rows('zh', 'responses', [
        ['说少一点', [words('down')]],
        ['多说一点', [words('up')]],
        ['回应简短一点', [words('low')]],
    ]),
    ...rows('zh', 'intention', [
        ['我的意图是放松', [intention('放松')]],
        ['清除意图', [intention('')]],
    ]),
    ...rows('zh', 'checkins', [
        ['不要问候我', [checkins(false)]],
        ['问候我', [checkins(true)]],
    ]),
    ...rows('zh', 'stop-listening', [
        ['停止聆听', [stopListening]],
        ['静音', [stopListening]],
    ]),
    ...rows('zh', 'help', [
        ['帮助', [help]],
        ['我可以说什么', [help]],
    ]),
    ...rows('zh', 'begin', [
        ['开始', 'begin'],
        ['开始吧', 'begin'],
        ['我们开始一个标记练习', 'begin', { mode: 'noting' }],
        ['开始二十分钟的体会冥想', 'begin', { mode: 'felt_sense', minutes: 20 }],
    ]),
    ...rows('zh', 'combined', [
        ['体会和二十分钟', [mode('felt_sense'), len(20)]],
        ['标记，十分钟', [mode('noting'), len(10)]],
        ['轻松和开阔', [vibe('playful'), vibe('spacious')]],
        ['多一点引导，回应简短一点', [guide('up'), words('low')]],
    ]),
];

/** What a room or a television says. None of it may change anything. */
export const NEGATIVES: Phrase[] = [
    ...rows('en', 'near-miss', [
        ['I love playing with my kids', null],
        ['it started twenty minutes ago', null],
        ['we should begin to think about dinner', null],
        ['when does the movie start', null],
        ['the meeting starts in ten minutes', null],
        ["I'm starting to get hungry", null],
        ['did you start the dishwasher', null],
        ['the game begins at seven', null],
        ['start the car', null],
        ["I'll be there in twenty minutes", null],
        ['give me five minutes', null],
        ['just a minute', null],
        ['in an hour or so', null],
        ['set a timer for the pasta', null],
        ["I'm feeling good today, thanks", null],
        ['be kind to yourself', null],
        ['she gave a very compassionate speech', null],
        ['my emotions are all over the place', null],
        ['focus on the road', null],
        ['the guidance counselor called', null],
        ['I need more space in the closet', null],
        ['this light is too bright', null],
        ['the parts arrived yesterday', null],
        ["we're exploring new options", null],
        ['I noted that down', null],
        ['that was a long day', null],
        ['longer than I thought', null],
        ['more coffee, please', null],
        ['less sugar', null],
        ['turn it up', null],
        ['help me with this box', null],
        ['can you turn that off', null],
    ]),
    ...rows('en', 'room', [
        ['can you pass the salt', null],
        ['turn left at the next light', null],
        ['the body was found near the river', null],
        ['space is the final frontier', null],
        ['let me know when you are ready', null],
        ["no, I don't think so", null],
        ['okay', null],
        ['thank you', null],
        ['yeah', null],
        ['stop it', null],
        ["let's go", null],
        ['and now, the weather', null],
    ]),
    ...rows('zh', 'near-miss', [
        ['我今天感觉不错', null],
        ['电影几点开始', null],
        ['我们开始吃饭吧', null],
        ['十分钟以后再说', null],
        ['你的身体还好吗', null],
        ['谢谢', null],
        ['好的', null],
        ['你在说什么', null],
    ]),
];

/**
 * Ordinary talk for the false-trigger set, read under noise and cut into the
 * pieces a listener would hand over. Nothing here is a request on its own,
 * but the words come close.
 */
export const PROSE: Array<{ lang: 'en' | 'zh'; text: string }> = [
    {
        lang: 'en',
        text:
            'Good evening, and welcome to the news at six. Officials say the new bridge will open to traffic next week, ' +
            'about twenty minutes ahead of schedule on the first day, if the weather holds. In the city council meeting, ' +
            'members began to discuss the budget, with several calling for more guidance from the state. Police are asking ' +
            'drivers to be patient and to leave extra time. We will start with the weather after this short break.',
    },
    {
        lang: 'en',
        text:
            "So I told her, look, I'm not going to start that conversation again tonight. She just wanted to know when " +
            "we'd leave, and honestly I don't know. Maybe in an hour, maybe less. The kids were playing in the yard, " +
            "it was getting dark, and I kept thinking we should have started earlier. Anyway, it's fine. Do you want some " +
            'tea? There is still some of the good stuff left.',
    },
    {
        lang: 'en',
        text:
            "Okay, now that the onions are soft, we're going to add the garlic. Keep the heat low, you want it gentle, " +
            "not brown. Let that go for about five minutes, stirring now and then. While that's happening, we can start on " +
            'the sauce. A little butter, a little flour, and then the milk, slowly. Be patient here. It will thicken, I promise.',
    },
    {
        lang: 'en',
        text:
            'And they begin the second half with real energy. A long ball forward, controlled nicely, and he turns. ' +
            'Space opening up on the left. That is a lovely pass, and the keeper has to come out. Oh, it is just wide. ' +
            "They will be disappointed with that one. Twenty minutes gone and still no goals, but this has been a lively start.",
    },
    {
        lang: 'en',
        text:
            "On today's episode we're talking about burnout, and what it actually feels like in the body. My guest has " +
            "spent years studying emotions at work, and she says the first sign is often physical. You notice your " +
            'shoulders, your jaw, the way you breathe. We get into some practical ideas, and some playful ones too. ' +
            "But first, a quick word from our sponsor.",
    },
    {
        lang: 'en',
        text:
            "Hey, it's me. I'm running late, the train stopped for no reason, so start without me. I should be there in " +
            "about half an hour. If you're hungry, just order. Oh, and can you check whether the parts for the bike came? " +
            "They said Tuesday. Okay, love you, bye. Wait, one more thing, don't forget to turn off the oven.",
    },
    {
        lang: 'zh',
        text:
            '晚上好，欢迎收看新闻。今天下午，市里开始讨论明年的预算，几位代表希望得到更多的指导。' +
            '新桥预计下周通车，司机们需要多留二十分钟左右的时间。接下来我们看天气。',
    },
    {
        lang: 'zh',
        text:
            '我跟她说，今天晚上别再开始那个话题了。孩子们在院子里玩，天快黑了，我一直觉得我们应该早点出发。' +
            '算了，没关系。你要不要喝点茶？还有一点好茶叶。',
    },
];
