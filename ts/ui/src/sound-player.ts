/**
 * The one way to play a sound that isn't speech: the signature sound
 * (signature-sound.ts), the noting chime and the noting cue sounds, in a
 * session and in the previews.
 *
 * Everything audible plays through an <audio> element, never through Web Audio
 * (dev-docs/audio-output.md). Each slot has its own element, created on first
 * use and kept, and none of them is the voice's (playbackAudio in
 * audio-unlock.ts): a sound must not cut a line off or be cut off by one. A
 * slot keeps its src until it is asked for a different sound, because a new
 * src loads a new player (AVPlayer, Chromium's media player), which costs time
 * at every play.
 *
 * Level lives in the files: an iPhone ignores an element's volume. A sound cut
 * short fades out where the volume can be set and stops at once where it can't.
 */

import { diag } from './diag.js';
import { assetPath } from './route-base.js';

/**
 * 8 ms of 8-bit mono silence as a WAV, at 48 kHz and not lower. In the Android
 * WebView elements of the same channel count share one output player, opened
 * at the rate of the first sound played on it, and this is a session's first
 * mono sound (the Begin prime). At 8 kHz the voice joined that player and
 * played band-limited to 4 kHz (inferred from a phone's dumpsys audio,
 * 2026-11-19: dev-docs/audio-output.md).
 */
export const SILENT_WAV = `data:audio/wav;base64,UklGRqQBAABXQVZFZm10IBAAAAABAAEAgLsAAIC7AAABAAgAZGF0YYABAACA${'gICA'.repeat(127)}gIA=`;

/**
 * open, close: the signature sound's halves, whose src changes only with the
 * preset. chime: the noting chime, always one file. cue: the named noting cue
 * sounds, whose src changes with the cue.
 */
export type SoundSlot = 'open' | 'close' | 'chime' | 'cue';
const SLOTS: readonly SoundSlot[] = ['open', 'close', 'chime', 'cue'];

/** A cue not started by then is skipped: a late one would land on the turn it
 *  was meant to open. */
const CUE_DEADLINE_MS = 2000;
/** How long a sound cut short takes to fade out. A sound waiting for the same
 *  element starts once it has. */
const FADE_MS = 250;
/** Timers, not animation frames: a hidden page gets no frames. */
const FADE_TICK_MS = 25;
/** How long past its end a sound's `ended` gets before the clock calls it
 *  over. */
const END_GRACE_MS = 300;
/** Where the element doesn't know the duration, the longest any of these
 *  sounds runs, and more. */
const UNKNOWN_DURATION_S = 12;
/** An iPhone takes a volume and puts it back on a later task, so the check
 *  reads it back this much later. */
const VOLUME_CHECK_MS = 100;

export interface SoundOptions {
    /** Prefix for the diag lines (`<label>: start at +Nms ...`); none without
     *  one. */
    label?: string;
    /** A sound that hasn't started by then (ms from the call, loading
     *  included) is skipped, and never plays late. */
    startDeadlineMs?: number;
    /** Held back until this settles: the fade of the sound this one replaces. */
    after?: Promise<unknown>;
}

export interface Sound {
    /** Settles when the sound is over: played out, cut short, skipped, paused
     *  by the system or failed. Never rejects. */
    readonly done: Promise<void>;
    /** Cut it short. Settles once it is quiet. */
    stop(): Promise<void>;
}

interface Slot {
    el: HTMLAudioElement;
    /** The src this module last gave the element. A primed element may be
     *  holding the silent clip instead. */
    src: string | null;
    current: { cut(): void } | null;
    /** Settles when the last fade on this element is done. */
    quiet: Promise<void>;
}

const slots = new Map<SoundSlot, Slot>();
/** Whether an element's volume is fixed (an iPhone); null until checked. */
let volumeFixed: boolean | null = null;
let volumeChecked = false;

function checkVolume(): void {
    if (volumeChecked) return;
    volumeChecked = true;
    try {
        const probe = new Audio();
        probe.volume = 0.5;
        setTimeout(() => {
            volumeFixed = Math.abs(probe.volume - 0.5) > 0.01;
        }, VOLUME_CHECK_MS);
    } catch {
        volumeFixed = true;
    }
}

function slotFor(name: SoundSlot): Slot {
    let slot = slots.get(name);
    if (!slot) {
        const el = new Audio();
        el.preload = 'auto';
        slot = { el, src: null, current: null, quiet: Promise.resolve() };
        slots.set(name, slot);
        checkVolume();
    }
    return slot;
}

function setVolume(el: HTMLAudioElement, volume: number): void {
    try {
        el.volume = volume;
    } catch {
        // ignore
    }
}

function describe(err: unknown): string {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Fade the element out and pause it; where the volume is fixed, pause it at
 *  once. Settles when it is quiet. */
function fadeOut(el: HTMLAudioElement): Promise<void> {
    return new Promise((resolve) => {
        let timer: ReturnType<typeof setInterval> | undefined;
        const end = (): void => {
            clearInterval(timer);
            try {
                el.pause();
            } catch {
                // ignore
            }
            setVolume(el, 1);
            resolve();
        };
        if (volumeFixed || el.paused) {
            end();
            return;
        }
        const from = el.volume;
        const t0 = Date.now();
        let asked = from;
        timer = setInterval(() => {
            // A volume put back is one that can't be set (an iPhone cut short
            // before the check answered): stop rather than play on at full level.
            if (Math.abs(el.volume - asked) > 0.01) {
                volumeFixed = true;
                end();
                return;
            }
            const left = 1 - (Date.now() - t0) / FADE_MS;
            if (left <= 0) {
                end();
                return;
            }
            asked = from * left;
            el.volume = asked;
        }, FADE_TICK_MS);
    });
}

/**
 * Play `src` on a slot's element, taking it from whatever sound has it (which
 * is over at once, and restarts from the top if it is the same file).
 */
export function playSound(name: SoundSlot, src: string | Promise<string>, options: SoundOptions = {}): Sound {
    let slot: Slot;
    try {
        slot = slotFor(name);
    } catch {
        return { done: Promise.resolve(), stop: () => Promise.resolve() };
    }
    const { el } = slot;
    const t0 = performance.now();
    const since = (): number => Math.round(performance.now() - t0);
    const log = (line: string): void => {
        if (options.label) diag(`${options.label}: ${line}`);
    };
    let over = false;
    let playCalled = false;
    let started = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const detach: Array<() => void> = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));

    const finish = (): void => {
        if (over) return;
        over = true;
        clearTimeout(deadline);
        clearTimeout(backstop);
        for (const off of detach) off();
        if (slot.current === me) slot.current = null;
        resolveDone();
    };
    const me = { cut: finish };
    const stop = (): Promise<void> => {
        const sounding = slot.current === me && playCalled;
        finish();
        if (!sounding) return Promise.resolve();
        slot.quiet = fadeOut(el);
        return slot.quiet;
    };
    const onStart = (): void => {
        if (over || started) return;
        started = true;
        clearTimeout(deadline);
        const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : UNKNOWN_DURATION_S;
        log(`start at +${since()}ms dur=${duration.toFixed(2)}s`);
        // `ended` can go missing (an interruption on iOS), so the clock ends
        // the wait and the sound with it.
        const left = Math.max(0, duration - (el.currentTime || 0));
        backstop = setTimeout(() => {
            log(`no ended by +${since()}ms, stopped`);
            void stop();
        }, left * 1000 + END_GRACE_MS);
    };

    slot.current?.cut();
    slot.current = me;
    if (options.startDeadlineMs !== undefined) {
        const ms = options.startDeadlineMs;
        deadline = setTimeout(() => {
            log(`not loaded in ${ms}ms, skipped`);
            const loading = slot.current === me && playCalled;
            finish();
            if (loading) {
                try {
                    el.pause();
                } catch {
                    // ignore
                }
            }
        }, ms);
    }

    void (async () => {
        const [url] = await Promise.all([src, slot.quiet, options.after]);
        if (over) return;
        const listen = (type: string, handler: () => void): void => {
            el.addEventListener(type, handler);
            detach.push(() => el.removeEventListener(type, handler));
        };
        // Each check reads the element as the event runs: one queued before
        // this sound took the element (a prime's pause, the emptied of a src
        // change) must not end it.
        listen('ended', () => {
            if (!el.ended) return;
            log(`ended at +${since()}ms`);
            finish();
        });
        listen('pause', () => {
            if (!el.paused || el.ended) return;
            log(`paused at +${since()}ms`);
            finish();
        });
        listen('error', () => {
            if (!el.error) return;
            log(`failed, media error ${el.error.code}`);
            // So the next play of this file loads it again rather than replay
            // the failure.
            slot.src = null;
            finish();
        });
        listen('emptied', () => {
            if (el.networkState === 0 /* NETWORK_EMPTY: its source was taken away */) finish();
        });
        listen('playing', onStart);
        if (slot.src !== url) {
            el.src = url;
            slot.src = url;
        } else {
            try {
                el.currentTime = 0;
            } catch {
                // ignore
            }
        }
        setVolume(el, 1);
        playCalled = true;
        await Promise.resolve(el.play()).then(onStart, (err: unknown) => {
            if (over) return;
            log(`failed, ${describe(err)}`);
            finish();
        });
    })().catch((err: unknown) => {
        if (over) return;
        log(`failed, ${describe(err)}`);
        finish();
    });

    return { done, stop };
}

/** Give an idle slot its next sound ahead of time, so playing it doesn't wait
 *  for a load. */
export function preloadSound(name: SoundSlot, src: Promise<string>): void {
    src.then((url) => {
        const slot = slotFor(name);
        if (slot.current || !slot.el.paused || slot.src === url) return;
        slot.el.src = url;
        slot.src = url;
    }).catch(() => {});
}

/**
 * Let every sound element play later with no gesture behind the call. MUST
 * run synchronously inside a user gesture (primeAudioPlayback, a preview
 * click): Safari lets an element play only once its play() has been called
 * from one, and on iOS that also lifts the cap that holds preload at metadata.
 * An element that is sounding is left alone.
 */
export function primeSounds(): void {
    checkVolume();
    for (const name of SLOTS) {
        try {
            const slot = slotFor(name);
            const { el } = slot;
            if (!el.paused) continue;
            if (slot.src === null) {
                el.src = SILENT_WAV;
                void Promise.resolve(el.play()).catch(() => {});
            } else {
                // Keeps the src it has, so its sound needn't load again.
                el.muted = true;
                void Promise.resolve(el.play()).catch(() => {});
                el.pause();
                el.muted = false;
            }
        } catch {
            // No element to prime: nothing will play.
        }
    }
}

/** The noting chime (render-chime.mjs writes the file). */
export function playChime(): Sound {
    return playSound('chime', assetPath('/audio/chime.wav'), { startDeadlineMs: CUE_DEADLINE_MS });
}

/** A named noting cue, public/audio/<name>.mp3. */
export function playCue(name: string): Sound {
    return playSound('cue', assetPath(`/audio/${encodeURIComponent(name)}.mp3`), {
        startDeadlineMs: CUE_DEADLINE_MS,
    });
}
