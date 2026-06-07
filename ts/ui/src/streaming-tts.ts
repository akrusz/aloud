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
    const { onTextDelta, ttsOptions, ...completionOpts } = options;

    if (!provider.completeStream) {
        // Non-streaming fallback — call complete(), then speak in one go.
        const result = await provider.complete(messages, completionOpts);
        if (onTextDelta) onTextDelta(result.text);
        // Mirror the streaming path's [HOLD] handling: a reply that opens with
        // [HOLD] is asking for silence, so speaking the acknowledgement aloud
        // defeats the point — suppress TTS entirely. The caller still receives
        // the full text and parses the signal to render the transcript.
        const isHold = result.text.trimStart().toUpperCase().startsWith(HOLD_PREFIX);
        return {
            text: result.text,
            ttsDone: isHold ? Promise.resolve() : tts.speak(result.text, ttsOptions),
            usage: usageFrom(result),
            finishReason: result.finishReason ?? null,
        };
    }

    let fullText = '';
    let pendingTtsText = ''; // text not yet handed to TTS
    let holdChecked = false; // have we decided whether [HOLD] is present?
    let inHoldMode = false;  // true → suppress TTS entirely (the LLM is asking
                             //         for silence, speaking it aloud defeats the point)
    // TTS queue — each entry awaits the previous one so utterances play
    // sequentially and we can return a single "all done" promise.
    let ttsQueue: Promise<void> = Promise.resolve();
    let usage: LlmUsage = {};
    let finishReason: string | null = null;

    function enqueueSpeak(text: string): void {
        if (!text.trim() || inHoldMode) return;
        ttsQueue = ttsQueue.then(() => tts.speak(text, ttsOptions)).catch(() => {
            /* non-fatal */
        });
    }

    /**
     * Once the buffer has enough characters (or the stream is done),
     * decide whether the response opened with [HOLD]. If so, strip the
     * prefix from pendingTtsText and don't speak the brief
     * acknowledgement that follows — entering silence mode out loud
     * defeats the point. Caller still gets the full text + signal so it
     * can render the acknowledgement to the transcript.
     */
    function checkHoldPrefix(force = false): void {
        if (holdChecked) return;
        if (!force && pendingTtsText.length < HOLD_PREFIX.length) return;
        const leading = pendingTtsText.trimStart();
        if (leading.toUpperCase().startsWith(HOLD_PREFIX)) {
            inHoldMode = true;
            // Drop the [HOLD] prefix from the buffer; if the LLM emits an
            // acknowledgement after it, we still won't speak (inHoldMode).
            pendingTtsText = '';
        }
        holdChecked = true;
    }

    for await (const chunk of provider.completeStream(messages, completionOpts)) {
        if (chunk.text) {
            fullText += chunk.text;
            pendingTtsText += chunk.text;
            if (onTextDelta) onTextDelta(fullText);

            checkHoldPrefix();
            if (inHoldMode) continue;

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
            if (!inHoldMode && pendingTtsText.trim()) {
                enqueueSpeak(pendingTtsText);
                pendingTtsText = '';
            }
        }
    }

    return { text: fullText, ttsDone: ttsQueue, usage, finishReason };
}

const HOLD_PREFIX = '[HOLD]';

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
