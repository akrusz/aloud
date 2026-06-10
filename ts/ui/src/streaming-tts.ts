/**
 * Streaming LLM → sentence-chunked TTS bridge.
 *
 * When the provider supports `completeStream`, we can start synthesizing
 * speech for the first sentence as soon as it lands, instead of waiting
 * for the whole response. For 2–3 sentence facilitator replies over a
 * network LLM, this cuts time-to-first-audio by ~1–2 seconds. Mobile
 * users (and anyone on a slow network) feel this most.
 *
 * Falls back to non-streaming `complete()` when the provider doesn't
 * implement streaming.
 */

import type {
    LLMProvider,
    Message,
    CompletionOptions,
    CompletionResult,
    StreamChunk,
} from '../../src/llm/index.js';
import type { LlmUsage } from '../../src/facilitation/index.js';
import { HOLD_PREFIX, startsWithHold, stripHoldPrefix } from '../../src/facilitation/index.js';
import type { TtsEngine, TtsOptions } from '../../src/platform/index.js';

/** Pull the usage split out of a completion result or final stream chunk. */
export function usageFrom(r: CompletionResult | StreamChunk): LlmUsage {
    return {
        tokensIn: r.inputTokens ?? null,
        tokensOut: r.outputTokens ?? null,
        cacheRead: r.cacheReadTokens ?? null,
        cacheCreation: r.cacheCreationTokens ?? null,
    };
}

export interface StreamCompletionOptions extends CompletionOptions {
    /** Called whenever new text has been accumulated (for live transcript). */
    onTextDelta?: (cumulativeText: string) => void;
    /** Forwarded to tts.speak() for each sentence. */
    ttsOptions?: TtsOptions;
    /** Called once with the FIRST TTS failure of this completion. Speak errors
     *  stay non-fatal to the completion (the text still lands; the session
     *  continues text-only), but without this they were swallowed entirely —
     *  a mid-session out-of-credits on the TTS leg never reached the user.
     *  The caller routes it through its billing/auth error UI. */
    onTtsError?: (err: unknown) => void;
    /** Abort the whole completion — stop consuming the LLM stream AND speaking.
     *  Used when a newer turn supersedes this one (the reply is discarded). */
    signal?: AbortSignal;
    /** Hush TTS but keep generating, so the full reply still lands in the
     *  transcript. Used on barge-in: stop talking over the user without losing
     *  the in-progress response. */
    ttsSignal?: AbortSignal;
}

export interface StreamCompletionResult {
    /** Full completion text. */
    text: string;
    /** Promise that resolves when the last TTS chunk finishes playing. */
    ttsDone: Promise<void>;
    /** LLM usage split from this completion (for session usage tracking). */
    usage: LlmUsage;
    /** Provider/proxy finish reason from the final chunk. The cloud proxy uses
     *  it to flag canned billing turns (e.g. 'billing_paused'); null when the
     *  provider doesn't report one. */
    finishReason: string | null;
}

/**
 * Run a streaming completion and feed completed sentences to TTS as
 * they arrive. The returned `text` is the full response; the returned
 * `ttsDone` resolves when all queued speech has finished playing.
 *
 * Sentence-boundary detection uses the same heuristic as the Python
 * code: split on a punctuation char (.!?) preceded by a non-punctuation
 * char and followed by whitespace. This avoids splitting on ellipses
 * ("I see...") or initials ("J.R.R. Tolkien").
 */
export async function streamCompletionWithChunkedTts(
    provider: LLMProvider,
    tts: TtsEngine,
    messages: Message[],
    options: StreamCompletionOptions = {}
): Promise<StreamCompletionResult> {
    const { onTextDelta, ttsOptions, onTtsError, signal, ttsSignal, ...completionOpts } = options;
    const hushed = (): boolean => !!signal?.aborted || !!ttsSignal?.aborted;
    // Report only the FIRST TTS failure — sentence-chunked speech fails as a
    // burst (every queued chunk hits the same dead/unfunded endpoint), and one
    // apology/toast is enough.
    let ttsErrorReported = false;
    const reportTtsError = (err: unknown): void => {
        if (ttsErrorReported) return;
        ttsErrorReported = true;
        onTtsError?.(err);
    };
    // Forward the supersession signal into the provider fetch
    // (CompletionOptions.signal) so an aborted turn stops generating
    // server-side, not just client-side.
    const providerOpts: CompletionOptions = signal
        ? { ...completionOpts, signal }
        : completionOpts;

    if (!provider.completeStream) {
        // Non-streaming fallback — call complete(), then speak in one go.
        const result = await provider.complete(messages, providerOpts);
        if (onTextDelta) onTextDelta(result.text);
        // Strip a leading [HOLD] token but DO speak the warm acknowledgment
        // after it ("I'll be right here") — the caller enters silence mode once
        // it's spoken. Only the token is silenced, not the reassurance.
        return {
            text: result.text,
            ttsDone: hushed()
                ? Promise.resolve()
                : tts.speak(stripHoldPrefix(result.text), ttsOptions).catch((err: unknown) => {
                      reportTtsError(err);
                      throw err; // callers already treat ttsDone as non-fatal
                  }),
            usage: usageFrom(result),
            finishReason: result.finishReason ?? null,
        };
    }

    let fullText = '';
    let pendingTtsText = ''; // text not yet handed to TTS
    let holdChecked = false; // have we decided about a leading [HOLD] token yet?
    // TTS queue — each entry awaits the previous one so utterances play
    // sequentially and we can return a single "all done" promise.
    let ttsQueue: Promise<void> = Promise.resolve();
    let usage: LlmUsage = {};
    let finishReason: string | null = null;

    function enqueueSpeak(text: string): void {
        if (!text.trim() || hushed()) return;
        ttsQueue = ttsQueue
            .then(() => (hushed() ? undefined : tts.speak(text, ttsOptions)))
            .catch((err: unknown) => {
                // Non-fatal to the queue/session, but surfaced once so the
                // caller can show billing/auth failures (out-of-credits TTS
                // was previously invisible).
                reportTtsError(err);
            });
    }

    /**
     * Once the buffer has enough characters (or the stream is done), strip a
     * leading [HOLD] token from pendingTtsText so it isn't spoken — but keep
     * the warm acknowledgment that follows ("I'll be right here"), which IS
     * meant to be heard before the session goes quiet. The caller parses the
     * signal separately to actually enter silence mode after.
     */
    function checkHoldPrefix(force = false): void {
        if (holdChecked) return;
        // Wait until we have enough non-space chars to tell (or the stream
        // ended) — the token can arrive split across chunks ("[HOL" + "D]").
        if (!force && pendingTtsText.trimStart().length < HOLD_PREFIX.length) return;
        if (startsWithHold(pendingTtsText)) {
            pendingTtsText = stripHoldPrefix(pendingTtsText);
        }
        holdChecked = true;
    }

    for await (const chunk of provider.completeStream(messages, providerOpts)) {
        // Superseded by a newer turn — stop consuming and return what we have.
        if (signal?.aborted) break;
        if (chunk.text) {
            fullText += chunk.text;
            pendingTtsText += chunk.text;
            if (onTextDelta) onTextDelta(fullText);

            checkHoldPrefix();
            // Hold speaking until the prefix decision is made, so a partial
            // "[HOL" is never voiced; the token is stripped first.
            if (!holdChecked) continue;

            const split = splitOffSentences(pendingTtsText);
            for (const sentence of split.complete) {
                enqueueSpeak(sentence);
            }
            pendingTtsText = split.remainder;
        }
        if (chunk.done) {
            usage = usageFrom(chunk);
            finishReason = chunk.finishReason ?? null;
            checkHoldPrefix(true);
            if (pendingTtsText.trim()) {
                enqueueSpeak(pendingTtsText);
                pendingTtsText = '';
            }
        }
    }

    return { text: fullText, ttsDone: ttsQueue, usage, finishReason };
}

/**
 * Split a string into completed sentences + a trailing remainder.
 * "Hello there. How are " → { complete: ["Hello there."], remainder: "How are " }
 */
export function splitOffSentences(text: string): { complete: string[]; remainder: string } {
    // Match a sentence-ending punctuation (.!?) preceded by a non-punctuation
    // char and followed by whitespace. The capture group keeps the
    // punctuation+whitespace attached to the sentence that ends with it.
    const re = /([^.!?][.!?])\s+/g;
    const sentences: string[] = [];
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const end = match.index + match[0].length;
        const sentence = text.slice(lastEnd, end).trim();
        if (sentence) sentences.push(sentence);
        lastEnd = end;
    }
    return {
        complete: sentences,
        remainder: text.slice(lastEnd),
    };
}
