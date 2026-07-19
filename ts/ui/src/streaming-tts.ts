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
import {
    HOLD_PREFIX,
    NEXT_PREFIX,
    BACK_PREFIX,
    WAIT_PREFIX,
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
     * Called once per TTS chunk when its audio starts playing (engine-reported
     * where supported, otherwise when the chunk finishes), with the chunk's
     * text. Lets the UI reveal the transcript in step with the voice instead
     * of dumping the full reply ahead of the audio. Chunks arrive in spoken
     * order; control tokens are already stripped. Not called for hushed or
     * failed chunks — keep a fallback render for those.
     */
    onSpeakStart?: (text: string) => void;
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
    const { onTextDelta, onSpeakStart, ttsOptions, onTtsError, signal, ttsSignal, ...completionOpts } =
        options;
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
        // Strip leading control tokens ([HOLD], and [NEXT]/[BACK] in staged
        // modes) but DO speak the text after them ("I'll be right here") —
        // only the tokens are silenced, never the words. The caller parses
        // the signals separately from the returned full text.
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
    let prefixChecked = false; // have we decided about leading control tokens yet?
    // TTS queue — each entry awaits the previous one so utterances play
    // sequentially and we can return a single "all done" promise.
    let ttsQueue: Promise<void> = Promise.resolve();
    let usage: LlmUsage = {};
    let finishReason: string | null = null;

    function enqueueSpeak(text: string): void {
        // Safety net for misplaced control tokens: the leading run is handled
        // by checkControlPrefix, but a small model can drop a token mid-reply
        // and it would be read aloud. Never honored (signals stay leading-
        // only) — just never spoken.
        text = scrubControlTokens(text);
        if (!text.trim() || hushed()) return;
        // Kick synthesis off NOW, concurrent with earlier sentences' playback,
        // so this chunk's audio is (usually) already fetched when its turn to
        // play comes — instead of paying the synthesis round-trip as a gap of
        // silence between sentences. Engines without prefetch() just fetch
        // inside speak() as before.
        tts.prefetch?.(text, ttsOptions);
        // Report when this chunk audibly starts. Engines that can't observe
        // playback start never fire onStart; report at resolve (playback end)
        // instead so the reveal still lands, just late.
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
                // caller can show billing/auth failures (out-of-credits TTS
                // was previously invisible).
                reportTtsError(err);
            });
    }

    // The control tokens a reply can open with: [HOLD] always, [NEXT]/[BACK]
    // in staged modes, and [WAIT:Nm] with smart check-in timing. They can
    // stack ("[NEXT] [HOLD] …"), and a token can arrive split across chunks
    // ("[NE" + "XT]", "[WAIT:1" + "m]").
    const CONTROL_PREFIXES = [HOLD_PREFIX, NEXT_PREFIX, BACK_PREFIX];

    /** True when `lead` (uppercased) could still grow into a [WAIT:Nm] token:
     *  a prefix of "[WAIT:", or an unclosed "[WAIT:…" whose body still looks
     *  like the token grammar (digits/spaces/unit letters). Bounded so a
     *  malformed non-token can't hold TTS until stream end. */
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
     * Once the buffer proves the leading run of control tokens is over (or
     * the stream is done), strip the tokens from pendingTtsText so they're
     * never spoken — but keep the words that follow ("I'll be right here"),
     * which ARE meant to be heard. The caller parses the signals separately
     * (parseTurnSignals on the full text) to act on them.
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
            // Variable-length [WAIT:Nm] — same grammar the turn parser uses.
            const wait = matchWaitToken(lead);
            if (wait) {
                pendingTtsText = lead.slice(wait.length).trimStart();
                continue;
            }
            // A token may still be arriving split across chunks — hold the
            // decision until more text lands or the stream ends.
            if (!force && isPartialControlPrefix(upper)) return;
            break;
        }
        prefixChecked = true;
    }

    for await (const chunk of provider.completeStream(messages, providerOpts)) {
        // Superseded by a newer turn — stop consuming and return what we have.
        if (signal?.aborted) break;
        if (chunk.text) {
            fullText += chunk.text;
            pendingTtsText += chunk.text;
            if (onTextDelta) onTextDelta(fullText);

            checkControlPrefix();
            // Hold speaking until the prefix decision is made, so a partial
            // "[HOL" or "[NE" is never voiced; the tokens are stripped first.
            if (!prefixChecked) continue;

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
