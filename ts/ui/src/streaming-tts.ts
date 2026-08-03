/**
 * Streaming LLM → sentence-chunked TTS bridge. When the provider supports
 * `completeStream`, synthesis starts on the first sentence rather than the whole
 * response - worth ~1-2s of time-to-first-audio on a 2-3 sentence reply over a
 * network LLM, most of all on mobile or a slow connection. Falls back to
 * non-streaming complete() otherwise.
 */

import type {
    LLMProvider,
    Message,
    CompletionOptions,
    CompletionResult,
    StreamChunk,
} from '../../src/llm/index.js';
import type { LlmUsage } from '../../src/facilitation/index.js';
import {
    HOLD_PREFIX,
    NEXT_PREFIX,
    BACK_PREFIX,
    WAIT_PREFIX,
    findRoleLeak,
    matchWaitToken,
    parseTurnSignals,
    scrubControlTokens,
} from '../../src/facilitation/index.js';
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
    /**
     * Fires per TTS chunk when its audio starts (engine-reported where
     * supported, otherwise at chunk end), with the chunk's text - lets the UI
     * reveal the transcript in step with the voice instead of dumping the reply
     * ahead of the audio. Chunks arrive in spoken order, control tokens already
     * stripped. Not called for hushed or failed chunks, so keep a fallback render.
     */
    onSpeakStart?: (text: string) => void;
    /** Forwarded to tts.speak() for each sentence. */
    ttsOptions?: TtsOptions;
    /** Called once with the FIRST TTS failure of this completion. Speak errors
     *  stay non-fatal (the text lands, the session continues text-only), but
     *  without this they were swallowed entirely and a mid-session
     *  out-of-credits on the TTS leg never reached the user. The caller routes
     *  it through its billing/auth error UI. */
    onTtsError?: (err: unknown) => void;
    /** Abort the whole completion - stop consuming the stream AND speaking. For
     *  when a newer turn supersedes this one and the reply is discarded. */
    signal?: AbortSignal;
    /** Hush TTS but keep generating, so the full reply still lands in the
     *  transcript. Barge-in: stop talking over the user without losing the
     *  in-progress response. */
    ttsSignal?: AbortSignal;
}

export interface StreamCompletionResult {
    /** Full completion text. */
    text: string;
    /** Promise that resolves when the last TTS chunk finishes playing. */
    ttsDone: Promise<void>;
    /** LLM usage split from this completion (for session usage tracking). */
    usage: LlmUsage;
    /** Provider/proxy finish reason from the final chunk. The cloud proxy flags
     *  canned billing turns with it (e.g. 'billing_paused'); null when the
     *  provider doesn't report one. */
    finishReason: string | null;
}

/**
 * Run a streaming completion, feeding completed sentences to TTS as they
 * arrive. `text` is the full response; `ttsDone` resolves when all queued
 * speech has played. See splitOffSentences for the boundary heuristic.
 */
export async function streamCompletionWithChunkedTts(
    provider: LLMProvider,
    tts: TtsEngine,
    messages: Message[],
    options: StreamCompletionOptions = {}
): Promise<StreamCompletionResult> {
    const { onTextDelta, onSpeakStart, ttsOptions, onTtsError, signal, ttsSignal, ...completionOpts } =
        options;
    const hushed = (): boolean => !!signal?.aborted || !!ttsSignal?.aborted;
    // First TTS failure only: sentence-chunked speech fails as a burst (every
    // queued chunk hits the same dead/unfunded endpoint), and one toast is enough.
    let ttsErrorReported = false;
    const reportTtsError = (err: unknown): void => {
        if (ttsErrorReported) return;
        ttsErrorReported = true;
        onTtsError?.(err);
    };
    // Forward the supersession signal into the provider fetch so an aborted turn
    // stops generating server-side, not just client-side.
    const providerOpts: CompletionOptions = signal
        ? { ...completionOpts, signal }
        : completionOpts;

    if (!provider.completeStream) {
        // Non-streaming fallback - complete(), then speak in one go.
        const result = await provider.complete(messages, providerOpts);
        if (onTextDelta) onTextDelta(result.text);
        // Strip leading control tokens but DO speak what follows them ("I'll be
        // right here") - only the tokens are silenced, never the words. The
        // caller parses the signals separately from the full text.
        const spoken = parseTurnSignals(result.text).cleanText;
        let started = false;
        const reportStart = (): void => {
            if (started) return;
            started = true;
            onSpeakStart?.(spoken);
        };
        return {
            text: result.text,
            ttsDone: hushed()
                ? Promise.resolve()
                : tts
                      .speak(spoken, { ...ttsOptions, onStart: reportStart })
                      .then(reportStart)
                      .catch((err: unknown) => {
                          reportTtsError(err);
                          throw err; // callers already treat ttsDone as non-fatal
                      }),
            usage: usageFrom(result),
            finishReason: result.finishReason ?? null,
        };
    }

    let fullText = '';
    let pendingTtsText = ''; // text not yet handed to TTS
    let prefixChecked = false; // leading control tokens decided?
    // Each entry awaits the previous one, so utterances play sequentially behind
    // a single "all done" promise.
    let ttsQueue: Promise<void> = Promise.resolve();
    let usage: LlmUsage = {};
    let finishReason: string | null = null;

    function enqueueSpeak(text: string): void {
        // Safety net for misplaced control tokens: checkControlPrefix handles
        // the leading run, but a small model can drop one mid-reply and it would
        // be read aloud. Never honored (signals stay leading-only), just never
        // spoken.
        text = scrubControlTokens(text);
        if (!text.trim() || hushed()) return;
        // Start synthesis NOW, concurrent with earlier sentences' playback, so
        // this chunk's audio is usually fetched by the time it plays instead of
        // costing a round-trip of silence between sentences. Engines without
        // prefetch() just fetch inside speak().
        tts.prefetch?.(text, ttsOptions);
        // Report audible start. Engines that can't observe it never fire
        // onStart, so report at resolve (playback end) - the reveal still lands,
        // just late.
        let started = false;
        const reportStart = (): void => {
            if (started) return;
            started = true;
            onSpeakStart?.(text);
        };
        ttsQueue = ttsQueue
            .then(() => {
                if (hushed()) return;
                return tts.speak(text, { ...ttsOptions, onStart: reportStart }).then(reportStart);
            })
            .catch((err: unknown) => {
                // Non-fatal to the queue/session, but surfaced once so the
                // caller can show billing/auth failures.
                reportTtsError(err);
            });
    }

    // The control tokens a reply can open with: [HOLD] always, [NEXT]/[BACK]
    // in staged modes, and [WAIT:Nm] with smart check-in timing. They can
    // stack ("[NEXT] [HOLD] …"), and a token can arrive split across chunks
    // ("[NE" + "XT]", "[WAIT:1" + "m]").
    const CONTROL_PREFIXES = [HOLD_PREFIX, NEXT_PREFIX, BACK_PREFIX];

    /** True when `lead` (uppercased) could still grow into a [WAIT:Nm] token: a
     *  prefix of "[WAIT:", or an unclosed one whose body still matches the token
     *  grammar. Bounded so a malformed non-token can't hold TTS to stream end. */
    function isPartialWaitToken(lead: string): boolean {
        if (lead.length <= WAIT_PREFIX.length) return WAIT_PREFIX.startsWith(lead);
        if (!lead.startsWith(WAIT_PREFIX)) return false;
        const body = lead.slice(WAIT_PREFIX.length);
        return body.length < 16 && /^[\d\sA-Z]*$/.test(body);
    }

    /** True when `lead` (uppercased) could still grow into a control token
     *  once more chunks arrive ("[", "[NE", "[HOL", "[WAIT:1"). */
    function isPartialControlPrefix(lead: string): boolean {
        return (
            CONTROL_PREFIXES.some((t) => t.length > lead.length && t.startsWith(lead)) ||
            isPartialWaitToken(lead)
        );
    }

    /**
     * Once the buffer proves the leading run of control tokens is over (or the
     * stream ends), strip them from pendingTtsText so they're never spoken -
     * keeping the words that follow, which ARE meant to be heard. The caller
     * acts on the signals via parseTurnSignals on the full text.
     */
    function checkControlPrefix(force = false): void {
        if (prefixChecked) return;
        for (;;) {
            const lead = pendingTtsText.trimStart();
            const upper = lead.toUpperCase();
            const token = CONTROL_PREFIXES.find((t) => upper.startsWith(t));
            if (token) {
                pendingTtsText = lead.slice(token.length).trimStart();
                continue;
            }
            // Variable-length [WAIT:Nm] - same grammar the turn parser uses.
            const wait = matchWaitToken(lead);
            if (wait) {
                pendingTtsText = lead.slice(wait.length).trimStart();
                continue;
            }
            // A token may still be arriving split across chunks - hold until
            // more text lands or the stream ends.
            if (!force && isPartialControlPrefix(upper)) return;
            break;
        }
        prefixChecked = true;
    }

    for await (const chunk of provider.completeStream(messages, providerOpts)) {
        // Superseded by a newer turn - stop consuming and return what we have.
        if (signal?.aborted) break;
        if (chunk.text) {
            fullText += chunk.text;
            pendingTtsText += chunk.text;
            if (onTextDelta) onTextDelta(fullText);

            checkControlPrefix();
            // Hold speech until the prefix decision lands, so a partial "[HOL"
            // or "[NE" is never voiced.
            if (!prefixChecked) continue;

            // Checked against fullText, not the pending buffer: the leak's
            // anchor is the sentence end before it, which a sentence split has
            // usually already handed to TTS.
            const leak = findRoleLeak(fullText);
            if (leak >= 0) {
                const keep = leak - (fullText.length - pendingTtsText.length);
                enqueueSpeak(pendingTtsText.slice(0, Math.max(0, keep)));
                pendingTtsText = '';
                break; // stop consuming; the caller re-parses fullText anyway
            }

            const split = splitOffSentences(pendingTtsText);
            for (const sentence of split.complete) {
                enqueueSpeak(sentence);
            }
            pendingTtsText = split.remainder;
        }
        if (chunk.done) {
            usage = usageFrom(chunk);
            finishReason = chunk.finishReason ?? null;
            checkControlPrefix(true);
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
    // Sentence-ending .!? preceded by a non-punctuation char and followed by
    // whitespace - so ellipses ("I see...") and initials ("J.R.R. Tolkien")
    // don't split. The capture keeps the punctuation with its sentence.
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
