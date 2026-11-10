/**
 * Starting a session by saying "begin" on the setup screen (opt-in:
 * AppSettings.voiceStart). With "end the session" recognized without a judge
 * (core end-command.ts), this makes a whole sitting hands-free after the first
 * touch: begin, speak, end, begin again.
 *
 * Listening before a session exists is a different thing from listening inside
 * one, and this is deliberately narrow about it:
 *
 * - It costs nothing and sends nothing new. Only speech recognition that is
 *   free on this device runs here (the browser's, the phone's, local Whisper);
 *   a session set to metered cloud STT gets no listening before Begin, because
 *   a room with a television in it would be billed for the television. The
 *   word itself is matched locally (core begin-command.ts), not by the judge.
 * - It never asks for the microphone. It only runs when permission is already
 *   granted, so opening the app can't raise a prompt.
 * - It is short. The mic closes after VOICE_START_WINDOW_MS, since an app left
 *   open on this screen should not be an open microphone. The status line
 *   says when it is listening and offers to listen again.
 * - It waits for one touch. A browser won't play sound for a page nobody has
 *   interacted with, and a session started that way would be a silent one.
 *
 * Everything said that isn't the request is dropped where it lands.
 */

import type { SttEngine } from '../../src/platform/index.js';
import { isBeginCommand } from '../../src/facilitation/begin-command.js';
import type { SttEngineChoice } from './app-settings.js';

/** How long the mic stays open on the setup screen before it closes itself. */
export const VOICE_START_WINDOW_MS = 120_000;

/** Why listening isn't available right now, or null when it is. */
export type VoiceStartBlocker = 'off' | 'metered-stt' | 'no-permission' | 'not-ready' | 'no-touch-yet';

/** The recognizers that run free on the device. Hosted STT is metered. */
const FREE_STT: readonly SttEngineChoice[] = ['web-speech', 'capacitor', 'whisper'];

export function voiceStartBlocker(args: {
    enabled: boolean;
    sttChoice: SttEngineChoice;
    micGranted: boolean;
    /** The Begin button's own gate: mic present, provider reachable, model loaded. */
    canBegin: boolean;
    /** False only when the browser says nobody has interacted with the page. */
    touched: boolean;
}): VoiceStartBlocker | null {
    if (!args.enabled) return 'off';
    if (!FREE_STT.includes(args.sttChoice)) return 'metered-stt';
    if (!args.micGranted) return 'no-permission';
    if (!args.canBegin) return 'not-ready';
    if (!args.touched) return 'no-touch-yet';
    return null;
}

/** True only when the browser reports the mic as already granted. Unknown
 *  (Safari throws on the descriptor) counts as not granted: this must never
 *  be the thing that raises a permission prompt. */
export async function micAlreadyGranted(): Promise<boolean> {
    try {
        const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
        return status?.state === 'granted';
    } catch {
        return false;
    }
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
    /** Runs after the mic has been released, so the session can open its own. */
    onBegin: () => void;
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

    const end = async (why: VoiceStartEnd): Promise<void> => {
        if (ended) return;
        ended = true;
        clearInterval(watchdog);
        // Release the mic before anything else happens: on "begin" the session
        // is about to open its own.
        await opts.engine.stop().catch(() => undefined);
        opts.onEnd(why);
        if (why === 'begin') opts.onBegin();
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
                        // Act on it now. Leaving the loop closes the turn; some
                        // recognizers take their time ending one by themselves.
                        heard = event.text;
                        break;
                    }
                }
            } catch {
                failed = true;
            }
            if (ended) return;
            if (failed) return void end('error');
            if (heard && isBeginCommand(heard)) return void end('begin');
            // A recognizer that returns at once with nothing (no speech, or a
            // refusal it reports as an ordinary end) must not spin.
            if (!heard) await new Promise((r) => setTimeout(r, 300));
        }
    })();

    return { stop: () => end('stopped') };
}
