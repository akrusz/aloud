/**
 * Starting a session by saying "begin" on the setup screen (opt-in:
 * AppSettings.voiceStart). With "end the session" recognized without a judge
 * (core end-command.ts), this makes a whole sitting hands-free: begin, speak,
 * end, begin again.
 *
 * Listening before a session exists is a different thing from listening inside
 * one, and this is deliberately narrow about it:
 *
 * - It never raises a permission prompt by itself. Where the microphone is
 *   known to be granted it just listens; where that can't be known, the status
 *   line offers to (one tap, which is also where a prompt belongs).
 * - It is short. The mic closes after VOICE_START_WINDOW_MS, since an app left
 *   open on this screen should not be an open microphone. The status line
 *   says when it is listening and offers to listen again.
 * - It is cheap. Whatever recognizer the session would use is the one that
 *   listens, hosted speech recognition included, but under LOBBY_STT: short
 *   utterances, one transcription each. The word itself is matched locally
 *   (core begin-command.ts), not by the judge.
 * - It waits for a touch only where the page can't make sound without one
 *   (a browser tab nobody has interacted with): a session started there would
 *   be a silent one.
 *
 * The request can name a mode and a length ("begin a twenty minute felt sense
 * session"); the setup screen applies those before it begins. Everything said
 * that isn't the request is dropped where it lands.
 */

import type { SttEngine } from '../../src/platform/index.js';
import { parseBeginRequest, type BeginRequest } from '../../src/facilitation/begin-command.js';
import { appUrl } from './app-base.js';
import { isTauri } from './is-desktop.js';
import { micOpenedThisPage } from './mic-check.js';
import { withTimeout } from './net-timeout.js';

/** How long the mic stays open on the setup screen before it closes itself. */
export const VOICE_START_WINDOW_MS = 120_000;

/**
 * How the recognizer is tuned while it waits for "begin", in place of a
 * session's pacing. A request is a few words said in one breath, so the turn
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
    if (!args.enabled) return 'off';
    if (!args.canBegin) return 'not-ready';
    if (args.mic === 'denied') return 'mic-denied';
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
}

export interface ListenForBeginOptions {
    engine: SttEngine;
    /** False once the setup screen is gone; checked on every tick. */
    alive: () => boolean;
    /** Runs after the mic has been released, so the session can open its own.
     *  Carries what the request named beyond beginning: a mode, a length. */
    onBegin: (request: BeginRequest) => void;
    /** Why listening ended, for the status line. */
    onEnd: (why: VoiceStartEnd) => void;
    windowMs?: number;
    now?: () => number;
}

/**
 * Listen for "begin" until it is heard, the window lapses, or the screen goes
 * away. One utterance at a time, the way a session listens; anything that
 * isn't the request is ignored and listening carries on.
 */
export function listenForBegin(opts: ListenForBeginOptions): VoiceStartHandle {
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.windowMs ?? VOICE_START_WINDOW_MS);
    let ended = false;

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
        else if (now() >= deadline) void end('window');
    }, 500);

    void (async () => {
        while (!ended) {
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
            if (failed) return void end('error');
            const request = heard ? parseBeginRequest(heard) : null;
            if (request) return void end('begin', request);
            // A recognizer that returns at once with nothing (no speech, or a
            // refusal it reports as an ordinary end) must not spin.
            if (!heard) await new Promise((r) => setTimeout(r, 300));
        }
    })();

    return { stop: () => end('stopped') };
}
