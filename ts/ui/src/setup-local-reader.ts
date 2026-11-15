/**
 * The local model's tier for setup-screen requests (core setup-local.ts), for
 * a setup where no judge may be asked (setup-judge.ts hands over here when
 * voice commands have no route): a session set to Ollama, signed out or not
 * opted in. Nothing leaves the machine.
 *
 * It asks the model the session will use, built the way the session builds it
 * (`sessionOllama`), so the model it loads is the one Begin would have loaded
 * anyway. Held to what a setup screen can afford:
 *
 * - The recognizer is stopped while a request is being read, so a read is
 *   waited on only LOCAL_READ_WAIT_MS. One that runs past it (a model still
 *   loading) goes on in the background and its answer is dropped; the request
 *   has to be said again.
 * - One at a time. Something heard while a read is still running is not sent:
 *   Ollama would only queue it behind.
 * - It gives up on a machine where reading is slow. After SLOW_STRIKES reads
 *   in a row that took longer than the wait with the model already loaded,
 *   this model is not asked again on this page, and the parser is the whole
 *   feature there, as it was before this.
 */

import type { LLMProvider } from '../../src/llm/index.js';
import { OllamaProvider, contextLengthForRam } from '../../src/llm/index.js';
import type { SetupAction } from '../../src/facilitation/index.js';
import { mightBeSetupRequest, readSetupLocally } from '../../src/facilitation/index.js';
import { systemRamGb } from './is-desktop.js';

/** Where the app reaches Ollama: the shell's proxy on desktop, Vite's in dev. */
export const OLLAMA_PROXY_URL = '/ollama';

/**
 * The Ollama provider a session uses. One place, because a request with a
 * different context window makes Ollama load the model again: a setup-screen
 * read built another way would cost the session its warm model.
 */
export function sessionOllama(model?: string): OllamaProvider {
    return new OllamaProvider({
        baseUrl: OLLAMA_PROXY_URL,
        // Down-clamp the context window on low-RAM machines.
        contextLength: contextLengthForRam(systemRamGb()),
        ...(model ? { model } : {}),
    });
}

/**
 * The models allowed to read setup requests: the ones measured to leave room
 * and television talk alone (`npm run setup:local`). None yet. qwen3.5:4b read
 * 62 of 73 natural requests right and then changed a setting on 120 of 243
 * room and television lines (2026-11-14), which is a screen that reconfigures
 * itself from the next room. A model goes here with its numbers beside it.
 */
const READS_SETUP: readonly RegExp[] = [];

export function readsSetupLocally(model: string): boolean {
    return READS_SETUP.some((allowed) => allowed.test(model));
}

/** How long a request waits on the model, with the microphone closed. About
 *  three times what a small model takes on an M-series GPU (0.9s, 2026-11-14). */
export const LOCAL_READ_WAIT_MS = 2500;

/** Reads in a row slower than the wait before a model is left alone. */
const SLOW_STRIKES = 2;

export interface LocalSetupReaderOptions {
    /** The provider and model picked on the setup screen, read at each call. */
    provider: () => string;
    model: () => string;
    /** Ollama is up and this setup would use a model at all. */
    usable: () => boolean;
    /** The rest default to the app's own; tests pass fakes. */
    makeProvider?: (model: string) => LLMProvider;
    read?: (provider: LLMProvider, text: string) => Promise<SetupAction[] | null>;
    waitMs?: number;
    now?: () => number;
}

export function createLocalSetupReader(options: LocalSetupReaderOptions): (text: string) => Promise<SetupAction[] | null> {
    const { makeProvider = sessionOllama, read = readSetupLocally, waitMs = LOCAL_READ_WAIT_MS, now = Date.now } = options;
    let current: { model: string; provider: LLMProvider; reads: number; strikes: number } | null = null;
    let busy = false;

    return async (text) => {
        if (options.provider() !== 'ollama' || !options.usable() || !mightBeSetupRequest(text)) return null;
        const model = options.model();
        if (!model) return null;
        if (current?.model !== model) current = { model, provider: makeProvider(model), reads: 0, strikes: 0 };
        const mine = current;
        if (busy || mine.strikes >= SLOW_STRIKES) return null;

        busy = true;
        const started = now();
        const reading = read(mine.provider, text)
            .catch(() => null)
            .finally(() => {
                busy = false;
                // The first read loads the model, which says nothing about
                // how long a read takes here.
                if (mine.reads++ > 0) mine.strikes = now() - started > waitMs ? mine.strikes + 1 : 0;
            });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const gaveUp = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)));
        try {
            return await Promise.race([reading, gaveUp]);
        } finally {
            clearTimeout(timer);
        }
    };
}
