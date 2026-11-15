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
 * - It closes by itself (`setupListeningLimits`). Where listening is paid for
 *   (hosted speech recognition), or the recognizer is a phone's, that is by
 *   the clock: VOICE_START_WINDOW_MS after the last request it understood,
 *   and VOICE_START_MAX_OPEN_MS after it opened, whatever was said. Local
 *   Whisper and the browser's recognizer cost nothing to leave open in a quiet
 *   room, so there it stays open and closes only on a run of things heard that
 *   were not requests: a room that is talking, and not to the app. The mic beside Begin shows which, and a
 *   tap opens it again.
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

/** How the mic on the setup screen closes by itself, for a recognizer. */
export interface SetupListeningLimits {
    windowMs: number;
    maxOpenMs: number;
    /** Things heard in a row that were not requests; Infinity for no limit. */
    unheardLimit: number;
}

/**
 * `free`: listening costs nothing and the machine is a desktop: local Whisper,
 * or the browser's own recognizer (a browser is a desktop browser here; phones
 * use the app). The rest keep the clock: hosted recognition is paid for by the
 * second, and a phone's recognizer is not built to be left running.
 */
export function setupListeningLimits(free: boolean): SetupListeningLimits {
    return free
        ? { windowMs: Infinity, maxOpenMs: Infinity, unheardLimit: VOICE_START_LOCAL_UNHEARD }
        : { windowMs: VOICE_START_WINDOW_MS, maxOpenMs: VOICE_START_MAX_OPEN_MS, unheardLimit: Infinity };
}

/** After the app has finished speaking, before the recognizer listens again:
 *  room for the last syllable to leave the speaker (a Bluetooth one runs a
 *  couple of hundred milliseconds behind the page) and the room. */
export const SPEECH_TAIL_MS = 450;

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
    /** Stop listening and close the mic. Safe to call twice. */
    stop(): Promise<void>;
    /**
     * Stop the recognizer while `during` runs (the app is speaking a line
     * nobody asked for, like a step of the tour), and listen again a moment
     * after it settles. The mic can't hear what plays inside.
     */
    hold<T>(during: () => Promise<T>): Promise<T>;
    /** Start the window over, as a request understood does. */
    keepOpen(): void;
}

export interface ListenOnSetupOptions {
    engine: SttEngine;
    /** False once the setup screen is gone; checked on every tick. */
    alive: () => boolean;
    /** Runs after the mic has been released, so the session can open its own.
     *  Carries what the request named beyond beginning: a mode, a length. */
    onBegin: (request: BeginRequest) => void;
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
    windowMs?: number;
    maxOpenMs?: number;
    /** Close after this many things heard in a row that were not requests. */
    unheardLimit?: number;
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
    let unheard = 0;
    let ended = false;
    // Settles when nothing is holding the recognizer stopped.
    let held: Promise<void> | null = null;
    let holds = 0;

    const keepOpen = (): void => {
        deadline = Math.min(now() + windowMs, ceiling);
        unheard = 0;
    };

    const end = async (why: VoiceStartEnd, request?: BeginRequest): Promise<void> => {
        if (ended) return;
        ended = true;
        clearInterval(watchdog);
        // Release the mic before anything else happens: on "begin" the session
        // is about to open its own.
        await opts.engine.stop().catch(() => undefined);
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
        await opts.engine.stop().catch(() => undefined);
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
                        await opts.engine.stop().catch(() => undefined);
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
            if (request) return void end('begin', request);
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
            if (heard && ++unheard >= unheardLimit) return void end('window');
            // A recognizer that returns at once with nothing (no speech, or a
            // refusal it reports as an ordinary end) must not spin.
            if (!heard) await pause(300);
        }
    })();

    return { stop: () => end('stopped'), hold, keepOpen };
}
