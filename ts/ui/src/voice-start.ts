/**
 * The microphone on the setup screen (AppSettings.setupVoice): say "begin" to
 * start a session, or change the setup first ("noting", "twenty minutes",
 * "add playful"; core setup-command.ts). With "end the session" recognized
 * without a judge (core end-command.ts), a whole sitting is hands-free: set
 * up, begin, speak, end, begin again.
 *
 * Listening before a session exists is a different thing from listening inside
 * one, and this is deliberately narrow about it:
 *
 * - It never raises a permission prompt by itself. Where the microphone is
 *   known to be granted it just listens; where that can't be known, the status
 *   line offers to (one tap, which is also where a prompt belongs).
 * - It closes by itself (`setupListeningLimits`). On a phone that is by the
 *   clock: VOICE_START_WINDOW_MS after the last request it understood, and
 *   VOICE_START_MAX_OPEN_MS after it opened, whatever was said. On a desktop
 *   there is no clock, since a quiet room costs nothing on any recognizer
 *   (speech is found on the device, and only speech is sent). Everywhere it
 *   closes on a run of things heard that were not requests: a room that is
 *   talking, and not to the app. Hosted recognition pays for each of those,
 *   so its run is shorter and counts faster once the room has gone
 *   VOICE_START_WINDOW_MS with nothing asked. The mic beside Begin shows
 *   which, and a tap opens it again.
 * - It is cheap. Whatever recognizer the session would use is the one that
 *   listens, hosted speech recognition included, but under LOBBY_STT: short
 *   utterances, one transcription each. "Begin" is matched locally and
 *   strictly (core begin-command.ts), never by the judge.
 * - It does not hear the app. A recognized request is answered out loud
 *   (setup-speech.ts) with the recognizer stopped, and it starts again a
 *   moment after the line ends.
 * - It waits for a touch only where the page can't make sound without one
 *   (a browser tab nobody has interacted with): a session started there would
 *   be a silent one.
 *
 * A request to begin can name a mode and a length ("begin a twenty minute felt
 * sense session"); the setup screen applies those before it begins. Everything
 * said that is neither a request to begin nor one to change the setup is
 * dropped where it lands.
 */

import type { SttEngine } from '../../src/platform/index.js';
import { parseBeginRequest, type BeginRequest } from '../../src/facilitation/begin-command.js';
import { appUrl } from './app-base.js';
import { isTauri } from './is-desktop.js';
import { micOpenedThisPage } from './mic-check.js';
import { withTimeout } from './net-timeout.js';

/** How long the mic stays open on the setup screen with nothing asked of it. */
export const VOICE_START_WINDOW_MS = 120_000;

/** Each request understood buys another window, up to this long since the mic
 *  opened. Nothing a television says keeps a microphone open past it. */
export const VOICE_START_MAX_OPEN_MS = 600_000;

/**
 * How many things in a row a free, on-device recognizer may hear that are not
 * requests before the mic closes. Silence costs nothing there; a television
 * does (Whisper transcribing all evening, and each line the parser can't place
 * going to the judge where there is one, against the same daily allowance a
 * session's voice commands use). An utterance is at most ten seconds
 * (LOBBY_STT), so this is five minutes or so of unbroken talk.
 */
export const VOICE_START_LOCAL_UNHEARD = 30;

/**
 * The same count for hosted recognition and a phone's own. Lower, since each
 * thing heard there is a clip sent off the device.
 */
export const VOICE_START_SENT_UNHEARD = 20;

/**
 * What one thing heard that was not a request counts for on hosted
 * recognition at a desktop, once VOICE_START_WINDOW_MS has gone by with
 * nothing asked: by then a talking room is not talking to the app, and four
 * more clips close the mic. There is no clock there, so a quiet room stays
 * open however long.
 */
export const VOICE_START_LATE_UNHEARD_COST = 5;

/** How the mic on the setup screen closes by itself, for a recognizer. */
export interface SetupListeningLimits {
    windowMs: number;
    maxOpenMs: number;
    /** Things heard in a row that were not requests; Infinity for no limit. */
    unheardLimit: number;
    /** This long after the last request understood (or the mic opening), one
     *  of those counts for `lateUnheardCost`. */
    lateAfterMs: number;
    lateUnheardCost: number;
}

/** What is listening on the setup screen, as far as closing by itself goes:
 *  `free` is local Whisper or the browser's recognizer (a browser is a desktop
 *  browser here; phones use the app), `hosted` is hosted recognition at a
 *  desktop, `phone` is any recognizer on a phone. */
export type SetupListener = 'free' | 'hosted' | 'phone';

/**
 * Only a phone keeps the clock: its recognizer is not built to be left
 * running, and an open mic there has costs of its own (call audio on Android).
 * At a desktop a quiet room costs nothing, hosted recognition included, so
 * what closes the mic is the room talking.
 */
export function setupListeningLimits(listener: SetupListener): SetupListeningLimits {
    const never = { windowMs: Infinity, maxOpenMs: Infinity };
    const flat = { lateAfterMs: Infinity, lateUnheardCost: 1 };
    if (listener === 'free') return { ...never, unheardLimit: VOICE_START_LOCAL_UNHEARD, ...flat };
    if (listener === 'hosted') {
        return {
            ...never,
            unheardLimit: VOICE_START_SENT_UNHEARD,
            lateAfterMs: VOICE_START_WINDOW_MS,
            lateUnheardCost: VOICE_START_LATE_UNHEARD_COST,
        };
    }
    return {
        windowMs: VOICE_START_WINDOW_MS,
        maxOpenMs: VOICE_START_MAX_OPEN_MS,
        unheardLimit: VOICE_START_SENT_UNHEARD,
        ...flat,
    };
}

/** After the app has finished speaking, before the recognizer listens again.
 *  A setup clip's file ends 0.15s after its last sound (render-voice-clips.ts,
 *  voice-clips/tail.ts), so the mic hears about 0.4s after the voice stops:
 *  room for a Bluetooth speaker running a couple of hundred milliseconds
 *  behind the page. What still leaks back is met by the capture's echo
 *  cancellation, and a line's last words heard anyway are dropped
 *  (looksLikeSpokenTail). Longer, and a request said at a natural pace after
 *  an answer loses its first word. */
export const SPEECH_TAIL_MS = 250;

/**
 * Whether the recognizer can hear right now (`onHearing`), for the mic beside
 * Begin, which pulses while it can't: words said then are lost.
 * - `opening`: nothing heard yet since the listener began. A capture opened
 *   afresh on macOS sends digital silence for a second or more.
 * - `paused`: stopped for a line and its tail, an answer, or between turns.
 * - `hearing`: a turn is under way and can hear.
 */
export type SetupHearing = 'opening' | 'paused' | 'hearing';

/** The longest one turn shows it is waiting to hear, should the sign never
 *  come (a mic that sends only silence). As session.ts
 *  MIC_OPENING_STATUS_MAX_MS. */
export const HEARING_WAIT_MAX_MS = 5000;

/**
 * How the recognizer is tuned on the setup screen, in place of a session's
 * pacing. A request is a few words said in one breath, so the turn
 * ends on a short pause (a session waits 3s and more, for someone thinking
 * aloud) and nothing runs longer than a request could.
 *
 * This is also what bounds the cost on hosted speech recognition, which bills
 * by the second of audio sent: no speculative passes, so an utterance is one
 * transcription, and a room with a television in it is cut into ten-second
 * pieces that add up to at most the window. Two minutes of hosted audio is
 * about a third of a cent.
 */
export const LOBBY_STT = {
    silenceBaseMs: 700,
    silenceMaxMs: 1500,
    // A bare "begin" is under half a second of speech, and with speculation
    // off there is no preview to vouch for it (whisper-pcm-stt.ts drops a
    // shorter utterance as a cough).
    minSpeechDurationMs: 200,
    speculation: false,
    maxUtteranceMs: 10_000,
    // Tells each recognizer what the setup screen expects to hear (stt-picker.ts),
    // and marks hosted audio as setup listening, which the server leaves
    // unbilled inside a daily allowance (server routes/stt.ts).
    setupListening: true,
} as const;

/**
 * Whether opening the microphone would raise a permission prompt.
 * - `granted`: it won't, so listening may start by itself.
 * - `ask`: it might, or nothing can say. Listening waits for a tap.
 * - `denied`: it can't be opened at all.
 */
export type MicPermission = 'granted' | 'ask' | 'denied';

/** Why listening isn't running right now, or null when it should be. */
export type VoiceStartBlocker = 'off' | 'not-ready' | 'mic-denied' | 'mic-ask' | 'no-touch-yet';

export function voiceStartBlocker(args: {
    enabled: boolean;
    mic: MicPermission;
    /** The Begin button's own gate: mic present, provider reachable, model loaded. */
    canBegin: boolean;
    /** False only when this page can't make sound until someone touches it. */
    touched: boolean;
}): VoiceStartBlocker | null {
    if (!args.canBegin) return 'not-ready';
    if (args.mic === 'denied') return 'mic-denied';
    // Switched off, which is the setting and what a tap on the lit mic sets.
    // After the two above: the mic still shows then, and a tap switches it on.
    if (!args.enabled) return 'off';
    // Before the touch: the tap that answers this one is a touch too.
    if (args.mic === 'ask') return 'mic-ask';
    if (!args.touched) return 'no-touch-yet';
    return null;
}

/**
 * The desktop shell's reading of the OS grant (src-tauri server.rs
 * mic_permission), or null where it has none. On macOS the webview can't be
 * asked: WKWebView answers `prompt` until the page has captured once in this
 * launch, whatever System Settings says.
 */
async function shellMicPermission(): Promise<MicPermission | null> {
    try {
        const response = await withTimeout(fetch(appUrl('/mic-permission')), 2000, 'mic-permission timed out');
        if (!response.ok) return null;
        const { status } = (await response.json()) as { status?: string };
        if (status === 'granted' || status === 'denied') return status;
        return status === 'prompt' ? 'ask' : null;
    } catch {
        return null;
    }
}

/**
 * Never opens the microphone and never prompts: it only reads what is already
 * decided. Anything short of a clear answer is `ask` (Safari throws on the
 * descriptor; an Android WebView has no answer to give).
 */
export async function micPermission(): Promise<MicPermission> {
    // A capture that succeeded since this page loaded is the best evidence
    // there is, and the only kind some browsers offer.
    if (micOpenedThisPage()) return 'granted';
    if (isTauri()) {
        const fromShell = await shellMicPermission();
        if (fromShell) return fromShell;
    }
    try {
        const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
        if (status?.state === 'granted' || status?.state === 'denied') return status.state;
    } catch {
        /* descriptor unsupported */
    }
    return 'ask';
}

/** Has anyone interacted with this page yet? True where the browser can't say. */
export function pageTouched(): boolean {
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    return activation ? activation.hasBeenActive : true;
}

export type VoiceStartEnd =
    /** "Begin" was heard; onBegin is about to run. */
    | 'begin'
    /** The listening window ran out. */
    | 'window'
    /** The setup screen went away, or the caller stopped it. */
    | 'stopped'
    /** The recognizer failed. */
    | 'error';

export interface VoiceStartHandle {
    /** Stop listening and close the mic. Safe to call twice. With
     *  `keepMicUntil` the engine's own mic stream stays open until that
     *  settles (createMicHandover). */
    stop(options?: { keepMicUntil?: Promise<unknown> }): Promise<void>;
    /**
     * Stop the recognizer while `during` runs (the app is speaking a line
     * nobody asked for, like a step of the tour), and listen again a moment
     * after it settles. The mic can't hear what plays inside. A capture
     * opened cold is let settle first (`coldOpening`).
     */
    hold<T>(during: () => Promise<T>): Promise<T>;
    /** Start the window over, as a request understood does. */
    keepOpen(): void;
}

export interface ListenOnSetupOptions {
    engine: SttEngine;
    /** False once the setup screen is gone; checked on every tick. */
    alive: () => boolean;
    /** Runs once listening has stopped. Carries what the request named beyond
     *  beginning: a mode, a length. */
    onBegin: (request: BeginRequest) => void;
    /** On "begin", the engine's own mic stream stays open until this settles,
     *  so the session opens its capture beside it (mic-check.ts
     *  holdCaptureForSession). Absent, the mic is released before onBegin. */
    keepMicForBegin?: () => Promise<unknown>;
    /**
     * Anything heard that is not a request to begin. Runs with the recognizer
     * stopped, so whatever it says in answer is not heard; listening resumes
     * SPEECH_TAIL_MS after it settles. Resolves true when it was a request
     * (which keeps the window open) and false when it was only the room.
     */
    onHeard?: (text: string) => boolean | Promise<boolean>;
    /**
     * True when what was heard is the app's own last line coming back.
     * Asked before anything else, "begin" included: a line that ends on the
     * word must not be able to start a session.
     */
    isEcho?: (text: string) => boolean;
    /** Why listening ended, for the mic beside Begin. */
    onEnd: (why: VoiceStartEnd) => void;
    /**
     * Settles once a turn just started can hear (WhisperPcmSttEngine
     * whenHearing: the first frame with sound in it). Asked as each turn
     * starts, with the recognizer stopped. Absent, a turn hears as soon as it
     * has started, the best the browser's and the phones' recognizers can say.
     */
    whenHearing?: () => Promise<void>;
    /**
     * A capture opened cold and still coming up, or null
     * (WhisperPcmSttEngine coldOpening). A hold waits for it before it stops
     * the recognizer and starts its line, so it must settle by itself. Absent,
     * as for a recognizer with no capture stream of ours, nothing waits.
     */
    coldOpening?: () => Promise<void> | null;
    /** Each change of SetupHearing, which starts at `opening`. Not called once
     *  listening has ended. */
    onHearing?: (hearing: SetupHearing) => void;
    windowMs?: number;
    maxOpenMs?: number;
    /** Close after this many things heard in a row that were not requests. */
    unheardLimit?: number;
    /** SetupListeningLimits: when, and for how much, one of them counts more. */
    lateAfterMs?: number;
    lateUnheardCost?: number;
    now?: () => number;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Listen on the setup screen until "begin" is heard, the window lapses, or the
 * screen goes away. One utterance at a time, the way a session listens.
 */
export function listenOnSetup(opts: ListenOnSetupOptions): VoiceStartHandle {
    const now = opts.now ?? Date.now;
    const windowMs = opts.windowMs ?? VOICE_START_WINDOW_MS;
    const ceiling = now() + (opts.maxOpenMs ?? VOICE_START_MAX_OPEN_MS);
    let deadline = Math.min(now() + windowMs, ceiling);
    const unheardLimit = opts.unheardLimit ?? Infinity;
    const lateAfterMs = opts.lateAfterMs ?? Infinity;
    const lateUnheardCost = opts.lateUnheardCost ?? 1;
    let unheard = 0;
    // The last request understood, or the mic opening.
    let askedAt = now();
    let ended = false;
    // Settles when nothing is holding the recognizer stopped.
    let held: Promise<void> | null = null;
    let holds = 0;
    // Between turns and under a line the recognizer stops but keeps its mic
    // stream, until listening is over. On macOS, letting an echo-cancelled
    // mic go rebuilds the audio output a second or two later, and a line
    // playing then loses half a second (SttStopOptions.keepMicUntil).
    let letMicGo!: () => void;
    const listeningOver = new Promise<void>((resolve) => (letMicGo = resolve));
    let hearing: SetupHearing = 'opening';
    const setHearing = (next: SetupHearing): void => {
        // Until it has heard once, any wait is still the mic opening.
        if (ended || next === hearing || (next === 'paused' && hearing === 'opening')) return;
        hearing = next;
        opts.onHearing?.(next);
    };
    // Bumped by every start and stop of the recognizer: a turn's sign that it
    // hears counts only while that turn is the one running.
    let turnSeq = 0;
    const stopBetweenTurns = (): Promise<void> => {
        turnSeq++;
        setHearing('paused');
        return opts.engine.stop({ keepMicUntil: listeningOver });
    };

    const keepOpen = (): void => {
        deadline = Math.min(now() + windowMs, ceiling);
        unheard = 0;
        askedAt = now();
    };

    const end = async (why: VoiceStartEnd, request?: BeginRequest, keepMicUntil?: Promise<unknown>): Promise<void> => {
        if (ended) return;
        ended = true;
        clearInterval(watchdog);
        if (keepMicUntil) {
            await stopBetweenTurns().catch(() => undefined);
            void keepMicUntil.then(letMicGo, letMicGo);
        } else {
            // Release the mic before anything else happens.
            await opts.engine.stop().catch(() => undefined);
            letMicGo();
            await listeningOver;
        }
        opts.onEnd(why);
        if (request) opts.onBegin(request);
    };

    const watchdog = setInterval(() => {
        if (!opts.alive()) void end('stopped');
        // Not while the app is mid-sentence: the line finishes, then it closes.
        else if (now() >= deadline && holds === 0) void end('window');
    }, 500);

    const hold = async <T>(during: () => Promise<T>): Promise<T> => {
        let release!: () => void;
        const mine = new Promise<void>((resolve) => (release = resolve));
        const before = held;
        held = (before ?? Promise.resolve()).then(() => mine);
        const chained = held;
        holds++;
        // Started under a capture opened cold, a line begins late and quiet.
        // The turn runs on meanwhile: its frames are how the engine sees the
        // first sound, and a stop now would close the capture as it opens.
        const opening = opts.coldOpening?.();
        if (opening) await opening.catch(() => undefined);
        await stopBetweenTurns().catch(() => undefined);
        try {
            return await during();
        } finally {
            await pause(SPEECH_TAIL_MS);
            holds--;
            release();
            if (held === chained) held = null;
        }
    };

    void (async () => {
        while (!ended) {
            while (held && !ended) await held;
            if (ended) return;
            let heard = '';
            let failed = false;
            const turn = ++turnSeq;
            const canHear = opts.whenHearing?.().catch(() => undefined) ?? Promise.resolve();
            void Promise.race([canHear, pause(HEARING_WAIT_MAX_MS)]).then(() => {
                if (turn === turnSeq) setHearing('hearing');
            });
            try {
                for await (const event of opts.engine.start()) {
                    if (ended) break;
                    if (event.type === 'error') failed = true;
                    if (event.type === 'final') {
                        // Act on it now: some recognizers take their time
                        // ending a turn by themselves. Stop this one before
                        // leaving the loop, while the engine still holds it;
                        // an engine forgets its recognizer once its iterator
                        // is closed, and stop() after that reaches nothing,
                        // leaving a mic open that no one is reading.
                        heard = event.text;
                        await stopBetweenTurns().catch(() => undefined);
                        break;
                    }
                }
            } catch {
                failed = true;
            }
            if (ended) return;
            // Stopped from under it by a hold: that is not the recognizer failing.
            if (holds > 0) continue;
            if (failed) return void end('error');
            if (heard && opts.isEcho?.(heard)) heard = '';
            const request = heard ? parseBeginRequest(heard) : null;
            if (request) return void end('begin', request, opts.keepMicForBegin?.());
            if (heard && opts.onHeard) {
                let understood = false;
                holds++;
                try {
                    understood = await opts.onHeard(heard);
                } catch {
                    /* a handler that fails has understood nothing */
                } finally {
                    holds--;
                }
                if (ended) return;
                if (understood) {
                    keepOpen();
                    await pause(SPEECH_TAIL_MS);
                    continue;
                }
            }
            // The room is talking, and not to the app.
            if (heard) {
                unheard += now() - askedAt >= lateAfterMs ? lateUnheardCost : 1;
                if (unheard >= unheardLimit) return void end('window');
            }
            // A recognizer that returns at once with nothing (no speech, or a
            // refusal it reports as an ordinary end) must not spin.
            if (!heard) await pause(300);
        }
    })();

    return { stop: (options) => end('stopped', undefined, options?.keepMicUntil), hold, keepOpen };
}

/**
 * The mics of listeners stopped for a recognizer change (a mode with its own
 * pick), each held until the listener replacing them can hear. The last
 * echo-cancelled capture closing on macOS rebuilds the audio output a second
 * or two later, under the line the new card is saying; with the new mic open
 * first, the old one going is never the last.
 */
export interface MicHandover {
    /** Stop `handle`, its mic held until the handover settles, along with any
     *  held already and `owed`: what `handle`'s own listener had taken and was
     *  holding until it could hear, which it never will now. */
    stop(handle: VoiceStartHandle, owed?: (() => void) | null): Promise<void>;
    /** Every mic being held, now the caller's to let go. Null when none is. */
    take(): (() => void) | null;
    /** Let every mic being held go. */
    release(): void;
}

export function createMicHandover(): MicHandover {
    let held: (() => void) | null = null;
    const take = (): (() => void) | null => {
        const letGo = held;
        held = null;
        return letGo;
    };
    return {
        stop: (handle, owed) => {
            const before = held;
            let letGo!: () => void;
            const over = new Promise<void>((resolve) => (letGo = resolve));
            held = () => {
                before?.();
                owed?.();
                letGo();
            };
            return handle.stop({ keepMicUntil: over });
        },
        take,
        release: () => take()?.(),
    };
}
