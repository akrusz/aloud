/**
 * Which voice answers on the setup screen, and when a clip may be played. The
 * rule under test: a hosted voice is never asked to synthesize a line, and a
 * clip rendered from words the line no longer has is not played.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ui/src/voice-clips.json', () => ({
    default: {
        voices: {
            Ethan: {
                language: 'en',
                gender: 'male',
                fixedPace: true,
                clips: {
                    'mode-noting': { file: 'ethan/en/mode-noting.aaaaaaaa.mp3', text: 'Okay, noting mode.' },
                    'voice-intro-first': { file: 'ethan/en/voice-intro-first.bbbbbbbb.mp3', text: "Hi, I'm Ethan. This is how I sound." },
                },
            },
            Harper: {
                language: 'en',
                gender: 'female',
                fixedPace: true,
                clips: {
                    'mode-noting': { file: 'harper/en/mode-noting.cccccccc.mp3', text: 'Okay, noting mode.' },
                    'timer-off': { file: 'harper/en/timer-off.dddddddd.mp3', text: 'An older wording of this line.' },
                },
            },
            Serena: {
                language: 'zh',
                gender: 'female',
                clips: { 'mode-noting': { file: 'serena/zh/mode-noting.eeeeeeee.mp3', text: '好的，标记模式。' } },
            },
        },
    },
}));
vi.mock('../ui/src/adapters/tts-picker.js', () => ({ createTtsForVoice: vi.fn() }));

import { createTtsForVoice } from '../ui/src/adapters/tts-picker.js';
import {
    clipFor,
    clipPlaybackRate,
    createSetupSpeaker,
    houseVoiceFor,
    houseVoices,
    isLocalVoice,
    linesInTheRoom,
} from '../ui/src/setup-speech.js';
import { looksLikePartOfLine } from '../src/facilitation/echo-guard.js';
import { previewVoice } from '../ui/src/voice-picker.js';

describe('houseVoices', () => {
    it('lists the voices of a language, the female one first', () => {
        expect(houseVoices('en').map((v) => v.name)).toEqual(['Harper', 'Ethan']);
        expect(houseVoices('zh').map((v) => v.name)).toEqual(['Serena']);
        // An unknown language is spoken to in English, like the lines.
        expect(houseVoices('fr').map((v) => v.name)).toEqual(['Harper', 'Ethan']);
    });
});

describe('houseVoiceFor', () => {
    it('is the session voice when that is a house voice', () => {
        expect(houseVoiceFor('aloud:Ethan', 'Harper', 'en')).toBe('Ethan');
    });
    it('is the one picked in the tour when the session voice has no clips', () => {
        expect(houseVoiceFor('aloud:Leda', 'Ethan', 'en')).toBe('Ethan');
    });
    it('is the default before anyone has picked', () => {
        expect(houseVoiceFor('aloud:Leda', null, 'en')).toBe('Harper');
        expect(houseVoiceFor(null, null, 'en')).toBe('Harper');
    });
    it("never crosses languages: an English pick doesn't speak Chinese lines", () => {
        expect(houseVoiceFor('aloud:Ethan', 'Ethan', 'zh')).toBe('Serena');
    });
});

describe('clipFor', () => {
    it('finds a clip whose words are still the line', () => {
        expect(clipFor('Harper', 'mode-noting', 'en')?.url).toMatch(/voice-clips\/harper\/en\/mode-noting\.cccccccc\.mp3$/);
        expect(clipFor('Harper', 'mode-noting', 'en')?.fixedPace).toBe(true);
        expect(clipFor('Serena', 'mode-noting', 'zh')?.fixedPace).toBe(false);
    });
    it('refuses one rendered from other words', () => {
        expect(clipFor('Harper', 'timer-off', 'en')).toBeNull();
    });
    it('has none for a line never rendered, a voice not in the house, or the wrong language', () => {
        expect(clipFor('Harper', 'help', 'en')).toBeNull();
        expect(clipFor('Leda', 'mode-noting', 'en')).toBeNull();
        expect(clipFor('Harper', 'mode-noting', 'zh')).toBeNull();
    });
    it("matches an introduction against the voice's own name", () => {
        expect(clipFor('Ethan', 'voice-intro-first', 'en')).not.toBeNull();
    });
});

describe('who synthesizes', () => {
    it('only a local voice does', () => {
        expect(isLocalVoice('server:en_US-lessac')).toBe(true);
        expect(isLocalVoice('browser:Samantha')).toBe(true);
        expect(isLocalVoice('aloud:Harper')).toBe(false);
    });
    it('none picked yet speaks the house clips, not the browser voice', () => {
        expect(isLocalVoice(null)).toBe(false);
        expect(houseVoiceFor(null, null, 'en')).toBe('Harper');
    });
});

describe('clipPlaybackRate', () => {
    it('follows the speed setting, within reason', () => {
        expect(clipPlaybackRate(160, false)).toBe(1);
        expect(clipPlaybackRate(140, false)).toBeCloseTo(0.875);
        expect(clipPlaybackRate(60, false)).toBe(0.6);
        expect(clipPlaybackRate(400, false)).toBe(1.5);
    });
    it('leaves a fixed-pace voice alone, as a session does', () => {
        expect(clipPlaybackRate(100, true)).toBe(1);
    });
});

describe('a local voice', () => {
    /** An engine whose speak() runs until cancelled. */
    function engine() {
        let finish: (() => void) | null = null;
        const e = {
            cancelled: 0,
            speak: () => new Promise<void>((resolve) => (finish = resolve)),
            cancel: async () => {
                e.cancelled++;
                finish?.();
            },
            listVoices: async () => [],
        };
        return e;
    }
    const speaker = () =>
        createSetupSpeaker({ voiceId: () => 'server:piper', houseVoice: () => null, language: () => 'en', rate: () => 140 });
    const line = (text: string) => [{ id: 'mode-noting' as const, text }];

    it('can stop a line that replaced another', async () => {
        const first = engine();
        const second = engine();
        vi.mocked(createTtsForVoice)
            .mockResolvedValueOnce({ engine: first, voice: null })
            .mockResolvedValueOnce({ engine: second, voice: null });
        const s = speaker();
        void s.say(line('one'));
        await new Promise((r) => setTimeout(r, 0));
        const saying = s.say(line('two'));
        await new Promise((r) => setTimeout(r, 0));
        expect(first.cancelled).toBe(1);
        s.stop();
        await saying;
        expect(second.cancelled).toBe(1);
    });

    it('does not speak a line stopped while its voice was still being found', async () => {
        const late = engine();
        const spoke = vi.spyOn(late, 'speak');
        let found!: () => void;
        vi.mocked(createTtsForVoice).mockReturnValueOnce(
            new Promise((resolve) => (found = () => resolve({ engine: late, voice: null })))
        );
        const s = speaker();
        const saying = s.say(line('one'));
        await new Promise((r) => setTimeout(r, 0));
        s.stop();
        found();
        await saying;
        expect(spoke).not.toHaveBeenCalled();
    });
});

describe('linesInTheRoom', () => {
    /** An engine whose speak() runs until finished or cancelled. */
    function engine() {
        let done: (() => void) | null = null;
        const e = {
            speak: () => new Promise<void>((resolve) => (done = resolve)),
            cancel: async () => done?.(),
            finish: () => done?.(),
            listVoices: async () => [],
        };
        return e;
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const HARPER = "Hi, I'm Harper. This is how I sound.";
    const ETHAN = "And I'm Ethan. Say which of us you'd like, or tap our name.";

    // A leaked "Harper." whose final lands once Ethan has begun, checked
    // against Ethan's line alone, picked Harper.
    it('holds the line playing and the one just before it', async () => {
        const harper = engine();
        const ethan = engine();
        vi.mocked(createTtsForVoice)
            .mockResolvedValueOnce({ engine: harper, voice: null })
            .mockResolvedValueOnce({ engine: ethan, voice: null });
        const s = createSetupSpeaker({ voiceId: () => 'server:piper', houseVoice: () => null, language: () => 'en', rate: () => 160 });
        const first = s.say([{ id: 'voice-intro-first', text: HARPER }]);
        await tick();
        expect(linesInTheRoom(s, 4000)).toEqual([HARPER]);
        harper.finish();
        await first;
        void s.say([{ id: 'voice-intro-second', text: ETHAN }]);
        await tick();
        const room = linesInTheRoom(s, 4000);
        expect(room).toEqual([ETHAN, HARPER]);
        expect(room.some((line) => looksLikePartOfLine('Harper.', line))).toBe(true);
        expect(room.some((line) => looksLikePartOfLine('Next.', line))).toBe(false);
        // Long enough after it, the line before is out of the room.
        expect(linesInTheRoom(s, 4000, Date.now() + 5000)).toEqual([ETHAN]);
        s.stop();
    });

    it('holds a line cut off by the next one', async () => {
        const harper = engine();
        const ethan = engine();
        vi.mocked(createTtsForVoice)
            .mockResolvedValueOnce({ engine: harper, voice: null })
            .mockResolvedValueOnce({ engine: ethan, voice: null });
        const s = createSetupSpeaker({ voiceId: () => 'server:piper', houseVoice: () => null, language: () => 'en', rate: () => 160 });
        void s.say([{ id: 'voice-intro-first', text: HARPER }]);
        await tick();
        void s.say([{ id: 'voice-intro-second', text: ETHAN }]);
        await tick();
        expect(linesInTheRoom(s, 4000)).toEqual([ETHAN, HARPER]);
        s.stop();
    });

    // "Back." said 12.5s into the focus card's line, which opens on "Back to
    // Exploration", was dropped as the line's own word (desktop app,
    // 2026-11-20). The transcript was read about 13.1s in.
    const FOCUS =
        "Back to Exploration, which is the best place to start. Choosing a focus tells me where you plan to put your attention: the body, emotions, or parts of yourself. Or leave it blank if you aren't sure.";
    const playingFocus = (at: number) => ({
        saying: () => FOCUS,
        lastSpoken: () => null,
        playingAt: () => ({ at, length: 16.39 }),
    });

    it('holds only the stretch of the line playing near where it has got to', () => {
        const late = linesInTheRoom(playingFocus(13.1), 4000);
        expect(late.some((line) => looksLikePartOfLine('Back.', line))).toBe(false);
        expect(late.some((line) => looksLikePartOfLine('parts of yourself', line))).toBe(true);
        const early = linesInTheRoom(playingFocus(2), 4000);
        expect(early.some((line) => looksLikePartOfLine('Back.', line))).toBe(true);
    });

    it('reads where a clip has got to, as heard, and nothing for a local voice', async () => {
        const local = engine();
        vi.mocked(createTtsForVoice).mockResolvedValueOnce({ engine: local, voice: null });
        const s = createSetupSpeaker({ voiceId: () => 'server:piper', houseVoice: () => null, language: () => 'en', rate: () => 160 });
        void s.say([{ id: 'voice-intro-first', text: HARPER }]);
        await tick();
        expect(s.saying()).toBe(HARPER);
        expect(s.playingAt()).toBeNull();
        s.stop();

        class Clip {
            currentTime = 3;
            duration = 6;
            playbackRate = 1;
            preservesPitch = false;
            preload = '';
            addEventListener(): void {}
            play = () => Promise.resolve();
            pause(): void {}
        }
        vi.stubGlobal('Audio', Clip);
        const hosted = createSetupSpeaker({ voiceId: () => 'aloud:Ethan', houseVoice: () => null, language: () => 'en', rate: () => 160 });
        void hosted.sayLine('voice-intro-first');
        await tick();
        expect(hosted.saying()).toBe("Hi, I'm Ethan. This is how I sound.");
        expect(hosted.playingAt()).toEqual({ at: 3, length: 6 });
        hosted.stop();
        vi.unstubAllGlobals();
    });
});

describe("a voice's sample", () => {
    afterEach(() => vi.unstubAllGlobals());

    /** An engine whose speak() runs until cancelled. */
    function engine() {
        let finish: (() => void) | null = null;
        const e = {
            cancelled: 0,
            spoke: 0,
            speak: () => {
                e.spoke++;
                return new Promise<void>((resolve) => (finish = resolve));
            },
            cancel: async () => {
                e.cancelled++;
                finish?.();
            },
            listVoices: async () => [],
        };
        return e;
    }
    /** The browser's speech queue, as far as a cancel goes. */
    function speechQueue() {
        const cancel = vi.fn();
        vi.stubGlobal('speechSynthesis', { cancel });
        return cancel;
    }
    const speaker = () =>
        createSetupSpeaker({ voiceId: () => 'browser:Zoe', houseVoice: () => null, language: () => 'en', rate: () => 160 });
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // "Set the voice to Zoe", then Begin: the sample played over the
    // session's opening sound (Chrome, 2026-11-18). Begin stops the speaker.
    it('is cut off by stop(), which leaves nothing in the speech queue', async () => {
        const queue = speechQueue();
        const zoe = engine();
        vi.mocked(createTtsForVoice).mockResolvedValueOnce({ engine: zoe, voice: null });
        const s = speaker();
        const sampling = s.sample('Zoe', 'browser');
        await tick();
        expect(zoe.spoke).toBe(1);
        queue.mockClear();
        s.stop();
        await sampling;
        expect(zoe.cancelled).toBeGreaterThan(0);
        expect(queue).toHaveBeenCalled();
    });

    it('never plays when stopped while its voice was still being found', async () => {
        speechQueue();
        const zoe = engine();
        let found!: () => void;
        vi.mocked(createTtsForVoice).mockReturnValueOnce(
            new Promise((resolve) => (found = () => resolve({ engine: zoe, voice: null })))
        );
        const s = speaker();
        const sampling = s.sample('Zoe', 'browser');
        await tick();
        s.stop();
        found();
        await sampling;
        expect(zoe.spoke).toBe(0);
    });

    it('is replaced by a line, as one line is by the next', async () => {
        speechQueue();
        const zoe = engine();
        const line = engine();
        vi.mocked(createTtsForVoice)
            .mockResolvedValueOnce({ engine: zoe, voice: null })
            .mockResolvedValueOnce({ engine: line, voice: null });
        const s = speaker();
        const sampling = s.sample('Zoe', 'browser');
        await tick();
        const saying = s.say([{ id: 'mode-noting', text: 'Okay, noting mode.' }]);
        await sampling;
        expect(zoe.cancelled).toBeGreaterThan(0);
        await tick();
        expect(line.spoke).toBe(1);
        s.stop();
        await saying;
    });
});

describe('previewVoice', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('leaves alone the preview that replaced it', async () => {
        vi.stubGlobal('speechSynthesis', { cancel: vi.fn() });
        const finishers: Array<() => void> = [];
        const engines = [0, 1].map(() => {
            const e = {
                cancelled: 0,
                speak: () => new Promise<void>((resolve) => finishers.push(resolve)),
                // Like an engine whose speak() settles a moment after its cancel.
                cancel: async () => {
                    e.cancelled++;
                    const finish = finishers.shift();
                    setTimeout(() => finish?.(), 0);
                },
                listVoices: async () => [],
            };
            return e;
        });
        vi.mocked(createTtsForVoice)
            .mockResolvedValueOnce({ engine: engines[0]!, voice: null })
            .mockResolvedValueOnce({ engine: engines[1]!, voice: null });
        const first = previewVoice('Zoe', 160, 'browser');
        await new Promise((r) => setTimeout(r, 0));
        void previewVoice('Ava', 160, 'browser');
        await first;
        await new Promise((r) => setTimeout(r, 0));
        expect(engines[0]!.cancelled).toBeGreaterThan(0);
        expect(engines[1]!.cancelled).toBe(0);
    });
});

