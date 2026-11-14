/**
 * Speech on the setup screen: the line that answers a request made by voice,
 * and the tour's spoken steps (core setup-lines.ts has the words).
 *
 * Nothing here synthesizes on a hosted voice. A hosted session voice is
 * answered with a clip rendered once per house voice
 * (server/scripts/render-voice-clips.ts; voice-clips.json is the list), and a
 * local voice (Piper, `say`, the browser's) says the same words itself, which
 * is free and is already the voice of someone signed out. Where neither can
 * speak, the caption on screen is the answer and this resolves quietly.
 *
 * The caller keeps the microphone from hearing it: lines play with the
 * recognizer stopped (voice-start.ts `onHeard` / `hold`).
 */

import {
    SETUP_LINES,
    setupLanguage,
    setupLineText,
    type SetupLineId,
    type SpokenSetupLine,
} from '../../src/facilitation/index.js';
import { createTtsForVoice } from './adapters/tts-picker.js';
import { assetPath } from './route-base.js';
import manifestJson from './voice-clips.json';

interface ClipEntry {
    /** Path under voice-clips/. Carries a hash of what was rendered, so a
     *  re-rendered line is a new URL. */
    file: string;
    /** Exactly what was synthesized. */
    text: string;
    /** The render script's checks could not pass this one; a person should listen. */
    suspect?: boolean;
}

interface HouseVoiceEntry {
    language: string;
    gender: string;
    /** A styled voice: sessions ignore the speed setting for it, so its clips do too. */
    fixedPace?: boolean;
    clips: Record<string, ClipEntry>;
}

const MANIFEST = manifestJson as { voices: Record<string, HouseVoiceEntry> };

export interface HouseVoice {
    name: string;
    gender: string;
}

/** The house voices that speak `language`, the female one first: she is who
 *  speaks until the tour's voice step has been answered. */
export function houseVoices(language: string): HouseVoice[] {
    const lang = setupLanguage(language);
    return Object.entries(MANIFEST.voices)
        .filter(([, voice]) => voice.language === lang)
        .map(([name, voice]) => ({ name, gender: voice.gender }))
        .sort((a, b) => Number(b.gender === 'female') - Number(a.gender === 'female') || a.name.localeCompare(b.name));
}

/**
 * Which house voice speaks for this session voice: the session voice itself
 * when it is one, else the one picked in the tour, else the default.
 */
export function houseVoiceFor(sessionVoiceId: string | null, picked: string | null, language: string): string | null {
    const offered = houseVoices(language).map((v) => v.name);
    const session = sessionVoiceId?.startsWith('aloud:') ? sessionVoiceId.slice('aloud:'.length) : null;
    if (session && offered.includes(session)) return session;
    if (picked && offered.includes(picked)) return picked;
    return offered[0] ?? null;
}

/**
 * The clip of `id` in `voice`, or null when there is none to play: never
 * rendered, or rendered from words the line no longer has.
 */
export function clipFor(voice: string, id: SetupLineId, language: string): { url: string; fixedPace: boolean } | null {
    const entry = MANIFEST.voices[voice];
    if (!entry || entry.language !== setupLanguage(language)) return null;
    const clip = entry.clips[id];
    if (!clip || clip.text !== setupLineText(id, language, { name: voice })) return null;
    return { url: assetPath(`/voice-clips/${clip.file}`), fixedPace: entry.fixedPace === true };
}

/** A local voice synthesizes on the device; a hosted one (`aloud:`) does not. */
export function isLocalVoice(voiceId: string | null): boolean {
    return !voiceId?.startsWith('aloud:');
}

/** The speed setting (words a minute, 160 neutral) as a playback rate. */
export function clipPlaybackRate(wpm: number, fixedPace: boolean): number {
    if (fixedPace || !Number.isFinite(wpm) || wpm <= 0) return 1;
    return Math.min(1.5, Math.max(0.6, wpm / 160));
}

export interface SetupSpeakerOptions {
    /** The session voice as stored (`aloud:Harper`, `server:...`, `browser:...`). */
    voiceId: () => string | null;
    /** The house voice picked in the tour (AppSettings.houseVoice). */
    houseVoice: () => string | null;
    language: () => string;
    /** The speed setting, in words a minute. */
    rate: () => number;
    /** True while speech is switched off (the tour's mute). */
    muted?: () => boolean;
}

export interface SetupSpeaker {
    /** Say these in order. Resolves when the last has finished, or at once
     *  where nothing here can speak. Never rejects. */
    say(lines: readonly SpokenSetupLine[], as?: { voice?: string }): Promise<void>;
    /** Say one line by its id. */
    sayLine(id: SetupLineId, as?: { voice?: string }): Promise<void>;
    /** Cut off whatever is playing; its say() resolves. */
    stop(): void;
    /** What was last said and when it ended, for the listener's echo check. */
    lastSpoken(): { text: string; endedAt: number } | null;
}

export function createSetupSpeaker(opts: SetupSpeakerOptions): SetupSpeaker {
    let playing: HTMLAudioElement | null = null;
    let cancelLocal: (() => void) | null = null;
    let generation = 0;
    let last: { text: string; endedAt: number } | null = null;

    function playClip(url: string, rate: number): Promise<void> {
        return new Promise((resolve) => {
            // Its own element, not the session's shared one (audio-unlock.ts):
            // a line here must not spend or stand in for the priming a Begin
            // click gives that one. Where the platform wants a gesture this
            // has not had, play() rejects and the caption stands alone.
            const audio = new Audio(url);
            audio.preload = 'auto';
            audio.playbackRate = rate;
            audio.preservesPitch = true;
            const done = (): void => {
                if (playing === audio) playing = null;
                resolve();
            };
            audio.addEventListener('ended', done, { once: true });
            audio.addEventListener('error', done, { once: true });
            // stop() pauses it; a paused clip is a finished one.
            audio.addEventListener('pause', done, { once: true });
            playing = audio;
            audio.play().catch(done);
        });
    }

    async function speakLocally(text: string, voiceId: string | null): Promise<void> {
        try {
            const { engine } = await createTtsForVoice(voiceId, {});
            cancelLocal = () => void engine.cancel().catch(() => undefined);
            await engine.speak(text, { rate: opts.rate() });
        } catch {
            /* no voice to say it with: the caption stands alone */
        } finally {
            cancelLocal = null;
        }
    }

    async function say(lines: readonly SpokenSetupLine[], as: { voice?: string } = {}): Promise<void> {
        const mine = ++generation;
        stopPlayback();
        if (opts.muted?.()) return;
        const language = opts.language();
        const voiceId = opts.voiceId();
        for (const line of lines) {
            if (mine !== generation) return;
            if (!as.voice && isLocalVoice(voiceId)) {
                await speakLocally(line.text, voiceId);
            } else {
                const voice = as.voice ?? houseVoiceFor(voiceId, opts.houseVoice(), language);
                const clip = voice ? clipFor(voice, line.id, language) : null;
                if (!clip) continue;
                await playClip(clip.url, clipPlaybackRate(opts.rate(), clip.fixedPace));
            }
            last = { text: line.text, endedAt: Date.now() };
        }
    }

    function stopPlayback(): void {
        playing?.pause();
        playing = null;
        cancelLocal?.();
    }

    return {
        say,
        sayLine: (id, as = {}) => {
            const language = opts.language();
            const voice = as.voice ?? houseVoiceFor(opts.voiceId(), opts.houseVoice(), language) ?? '';
            return say([{ id, text: setupLineText(id, language, { name: voice }) }], as);
        },
        stop: () => {
            generation++;
            stopPlayback();
        },
        lastSpoken: () => last,
    };
}

/** Every line id, for a check that the manifest and the lines agree. */
export const SETUP_LINE_COUNT = Object.keys(SETUP_LINES).length;
