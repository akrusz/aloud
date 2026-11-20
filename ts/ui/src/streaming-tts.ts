/**
 * Streaming LLM → sentence-chunked TTS bridge. When the provider supports
 * `completeStream`, synthesis starts on the first sentence rather than the whole
 * response - worth ~1-2s of time-to-first-audio on a 2-3 sentence reply over a
 * network LLM, most of all on mobile or a slow connection. Falls back to
 * non-streaming complete() otherwise.
 *
 * A voice whose every request bills a fixed overhead (a styled Azure voice's
 * express-as tags, CloudVoice.wholeReply) is instead given the whole reply as
 * one utterance, or two when the stream runs long (WHOLE_REPLY_WAIT_MS), with
 * marks at its chunks so a barge-in still keeps only the chunks heard.
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
     * stripped. Not called for failed chunks, or for ones a hush kept from
     * being heard, so keep a fallback render.
     */
    onSpeakStart?: (text: string) => void;
    /** Forwarded to tts.speak() for each sentence. */
    ttsOptions?: TtsOptions;
    /** Called once with the FIRST TTS failure of this completion. Speak errors
     *  stay non-fatal (the text still arrives, the session continues text-only); this
     *  is how a mid-session out-of-credits on the TTS leg reaches the user. The
     *  caller routes it through its billing/auth error UI. */
    onTtsError?: (err: unknown) => void;
    /** Abort the whole completion - stop consuming the stream AND speaking. For
     *  when a newer turn supersedes this one and the reply is discarded. */
    signal?: AbortSignal;
    /** Hush TTS but keep generating, so the reply's signals and usage still
     *  arrive. Barge-in: stop talking over the user. What was said before it
     *  is `heard()`. */
    ttsSignal?: AbortSignal;
    /**
     * Speak the reply as one utterance where it can (the hosted voice's
     * CloudVoice.wholeReply), not one per chunk: the chunks gather until the
     * stream ends, or until WHOLE_REPLY_WAIT_MS after the first is complete,
     * when what is there goes and the rest follows as one more at the end.
     * Each utterance carries its chunk starts as TtsOptions.marks, and heard()
     * keeps the chunks the engine reports reached. If one fails, its chunks
     * and the rest of the reply are spoken one by one.
     */
    wholeReply?: boolean;
    /**
     * Asked once, when the first words are ready to be spoken: resolve true to
     * let the reply be heard, false to keep the whole completion silent (the
     * caller is throwing it away). Generation and synthesis prefetch carry on
     * underneath, so a gate that opens costs only the time it took to answer.
     */
    speakGate?: () => Promise<boolean>;
}

export interface StreamCompletionResult {
    text: string;
    /** Promise that resolves when the last TTS chunk finishes playing. */
    ttsDone: Promise<void>;
    /**
     * What the meditator heard, once speech was hushed (either signal): the
     * chunks whose audio started, the one cut mid-sentence included. `cut` is
     * true when a hush left at least one chunk unspoken; false on a reply that
     * is still playing, played out, or lost chunks only to a TTS failure.
     */
    heard: () => { text: string; cut: boolean };
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
    const {
        onTextDelta,
        onSpeakStart,
        ttsOptions,
        onTtsError,
        signal,
        ttsSignal,
        speakGate,
        wholeReply,
        ...completionOpts
    } = options;
    const hushed = (): boolean => !!signal?.aborted || !!ttsSignal?.aborted;
    const startedChunks: string[] = [];
    let chunkCount = 0;
    // The stream was dropped with text still to come.
    let brokenOff = false;
    const heard = (): { text: string; cut: boolean } => ({
        text: startedChunks.join(' '),
        cut: hushed() && (brokenOff || startedChunks.length < chunkCount),
    });
    // A chunk that resolves hushed without having started was cancelled before
    // any of it was audible: not heard, so not reported.
    const startedUnlessHushed = (reportStart: () => void) => (): void => {
        if (!hushed()) reportStart();
    };
    // A gate that throws opens: a broken check must not swallow a reply.
    let gate: Promise<boolean> | null = null;
    const maySpeak = (): Promise<boolean> =>
        (gate ??= speakGate ? speakGate().catch(() => true) : Promise.resolve(true));
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

    // Each entry awaits the previous one, so utterances play sequentially behind
    // a single "all done" promise.
    let ttsQueue: Promise<void> = Promise.resolve();
    // Settles once the queue does and nothing more was added to it meanwhile.
    const drained = async (): Promise<void> => {
        for (let q = ttsQueue; ; q = ttsQueue) {
            await q;
            if (q === ttsQueue) return;
        }
    };

    /** Speak one chunk, reporting it heard once its audio starts (or once it
     *  played, for an engine that can't tell). */
    function playChunk(text: string, opts: TtsOptions | undefined): Promise<void> {
        let started = false;
        const reportStart = (): void => {
            if (started) return;
            started = true;
            startedChunks.push(text);
            onSpeakStart?.(text);
        };
        return tts.speak(text, { ...opts, onStart: reportStart }).then(startedUnlessHushed(reportStart));
    }

    /** Queue one chunk as its own utterance. */
    function speakChunk(text: string): void {
        if (hushed()) return;
        // Start synthesis NOW, concurrent with earlier sentences' playback, so
        // this chunk's audio is usually fetched by the time it plays instead of
        // costing a round-trip of silence between sentences. Engines without
        // prefetch() just fetch inside speak().
        tts.prefetch?.(text, ttsOptions);
        // Engines that can't observe the audible start never fire onStart, so
        // playChunk reports at resolve (playback end) - the reveal still
        // happens, just late.
        ttsQueue = ttsQueue
            .then(async () => {
                if (hushed() || !(await maySpeak()) || hushed()) return;
                return playChunk(text, ttsOptions);
            })
            .catch((err: unknown) => {
                // Non-fatal to the queue/session, but surfaced once so the
                // caller can show billing/auth failures.
                reportTtsError(err);
            });
    }

    // A whole reply (wholeReply): chunks gather here until the stream ends, or
    // WHOLE_REPLY_WAIT_MS after the first one, and go out as one utterance.
    let pending: string[] = [];
    let pendingChars = 0;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    let sentAny = false;
    let streamOver = false;
    // A whole-reply utterance failed: the rest of the reply goes a chunk at a time.
    let chunkByChunk = false;

    function gather(text: string): void {
        if (chunkByChunk) return speakChunk(text);
        if (pending.length && pendingChars + text.length + 1 > MAX_WHOLE_REPLY_CHARS) sendGathered();
        pending.push(text);
        pendingChars += text.length + 1;
        if (!sentAny && !waitTimer) {
            // Ask the gate now, as the per-sentence path does at its first
            // chunk, so the wait for the rest of the reply runs beside it.
            void maySpeak();
            waitTimer = setTimeout(sendGathered, WHOLE_REPLY_WAIT_MS);
        }
    }

    function sendGathered(): void {
        if (waitTimer) {
            clearTimeout(waitTimer);
            waitTimer = null;
        }
        if (!pending.length) return;
        const chunks = pending;
        pending = [];
        pendingChars = 0;
        sentAny = true;
        if (chunkByChunk) chunks.forEach(speakChunk);
        else if (!hushed()) speakTogether(chunks);
    }

    /** Queue `chunks` as one utterance, each after the first a mark, so the
     *  engine can say which ones were heard when it is cut off. */
    function speakTogether(chunks: string[]): void {
        const text = chunks.join(' ');
        const marks: number[] = [];
        for (let i = 1, at = 0; i < chunks.length; i++) marks.push((at += chunks[i - 1]!.length + 1));
        const opts: TtsOptions = marks.length ? { ...ttsOptions, marks } : { ...ttsOptions };
        tts.prefetch?.(text, opts);
        // The chunks heard so far, in order. The bubble gets the whole text at
        // the start (no timed reveal); the log keeps only the chunks heard.
        let started = 0;
        const startUpTo = (n: number): void => {
            if (!started && n > 0) onSpeakStart?.(text);
            while (started < n) startedChunks.push(chunks[started++]!);
        };
        const sentAt = Date.now();
        ttsQueue = ttsQueue.then(async () => {
            if (hushed() || !(await maySpeak()) || hushed()) return;
            try {
                await tts.speak(text, { ...opts, onStart: () => startUpTo(1), onMark: (i) => startUpTo(i + 2) });
            } catch {
                // A synthesis that failed never played. Its chunks are said one
                // at a time instead, inside the time the first try's re-sends
                // had (retryFrom), and so is the rest of the reply.
                chunkByChunk = true;
                const left = chunks.slice(started);
                const retry: TtsOptions = { ...ttsOptions, retryFrom: sentAt };
                for (const chunk of left) if (!hushed()) tts.prefetch?.(chunk, retry);
                for (const chunk of left) {
                    if (hushed()) return;
                    try {
                        await playChunk(chunk, retry);
                    } catch (err) {
                        reportTtsError(err);
                    }
                }
                return;
            }
            // Resolved unhushed: played out, as for a single chunk.
            if (!hushed()) startUpTo(chunks.length);
            // The stream outran by this one's playback: what it has so far
            // goes now rather than at its end.
            if (pending.length && !streamOver) sendGathered();
        }).catch(reportTtsError);
    }

    function enqueueSpeak(text: string): void {
        // Safety net for misplaced control tokens: checkControlPrefix handles
        // the leading run, but a small model can drop one mid-reply and it would
        // be read aloud. Never honored (signals stay leading-only), just never
        // spoken.
        text = scrubControlTokens(text);
        if (!text.trim()) return;
        chunkCount++;
        if (wholeReply) gather(text.trim());
        else speakChunk(text);
    }

    if (!provider.completeStream) {
        // Non-streaming fallback - complete(), then speak in one go.
        const result = await provider.complete(messages, providerOpts);
        if (onTextDelta) onTextDelta(result.text);
        // Strip leading control tokens but DO speak what follows them ("I'll be
        // right here") - only the tokens are silenced, never the words. The
        // caller parses the signals separately from the full text.
        const spoken = parseTurnSignals(result.text).cleanText;
        const done = { text: result.text, usage: usageFrom(result), finishReason: result.finishReason ?? null, heard };
        if (wholeReply) {
            // One utterance still, but marked by chunk, so a cut keeps only
            // the chunks heard.
            const { complete, remainder } = splitOffSentences(spoken);
            for (const chunk of [...complete, remainder]) enqueueSpeak(chunk);
            streamOver = true;
            sendGathered();
            return { ...done, ttsDone: drained() };
        }
        if (spoken.trim()) chunkCount = 1;
        let started = false;
        const reportStart = (): void => {
            if (started) return;
            started = true;
            startedChunks.push(spoken);
            onSpeakStart?.(spoken);
        };
        return {
            ...done,
            ttsDone: maySpeak().then((open) =>
                !open || hushed()
                    ? undefined
                    : tts
                          .speak(spoken, { ...ttsOptions, onStart: reportStart })
                          .then(startedUnlessHushed(reportStart))
                          .catch((err: unknown) => {
                              reportTtsError(err);
                              throw err; // callers already treat ttsDone as non-fatal
                          })
            ),
        };
    }

    let fullText = '';
    let pendingTtsText = ''; // text not yet handed to TTS
    let prefixChecked = false; // leading control tokens decided?
    let usage: LlmUsage = {};
    let finishReason: string | null = null;

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
            // more text arrives or the stream ends.
            if (!force && isPartialControlPrefix(upper)) return;
            break;
        }
        prefixChecked = true;
    }

    for await (const chunk of provider.completeStream(messages, providerOpts)) {
        // Superseded by a newer turn - stop consuming and return what we have.
        if (signal?.aborted) {
            brokenOff = true;
            break;
        }
        if (chunk.text) {
            fullText += chunk.text;
            pendingTtsText += chunk.text;
            if (onTextDelta) onTextDelta(fullText);

            checkControlPrefix();
            // Hold speech until the prefix decision is made, so a partial "[HOL"
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
    streamOver = true;
    sendGathered();

    return { text: fullText, ttsDone: drained(), usage, finishReason, heard };
}

/**
 * A whole reply (StreamCompletionOptions.wholeReply) waits this long after its
 * first chunk is complete for the stream to end; past it, what has arrived is
 * spoken and the rest follows as one more utterance. Most replies end well
 * inside it: estimated from the dev's session logs and the soak runs
 * (reply latency against length, 2026-11-19), the stream after the first
 * chunk of a multi-chunk reply ran a median 126ms on aloud cloud's Haiku 5.5
 * (98% inside 500ms), about 25ms on Opus 5.5 (its text arrives in a burst
 * after thinking), 360ms on Opus 4.5 (87%) and 230ms on Sonnet 5.5 (74%).
 * The first words wait at most this much longer than they used to.
 */
export const WHOLE_REPLY_WAIT_MS = 500;

/** Longest text one whole-reply utterance carries; a longer reply is split
 *  at a chunk. No more than the transcript echo guard keeps of what was
 *  handed to the voice (views/session.ts SPOKEN_TAIL_MAX_CHARS), which takes
 *  an utterance's text as it starts: past that, the start of a long one
 *  would be gone from it while it plays. Far over a typical reply (about
 *  140 characters), and under the server's MAX_TTS_CHARS. */
export const MAX_WHOLE_REPLY_CHARS = 600;

/**
 * A completed sentence shorter than this is merged into the next one instead
 * of going to TTS on its own. Azure's Harper (softvoice) voices a one- or
 * two-word input TWICE about a third of the time - "Nice." comes back as two
 * bursts with a 1.5s gap (meditation-pal-1c9h, measured 2026-09-07: 4/10 for
 * "Nice.", 3/10 for "That's good.", 1/10 once merged with a 4-word sentence,
 * 0/10 with an 8-word one). Merging also saves a synth round-trip per
 * acknowledgment. A short sentence that ENDS the reply still speaks alone.
 */
export const MIN_TTS_SENTENCE_CHARS = 24;

/**
 * Split a string into completed sentences + a trailing remainder.
 * "Hello there. How are " → { complete: ["Hello there."], remainder: "How are " }
 * "Nice. Just like that. And " → { complete: ["Nice. Just like that."], remainder: "And " }
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
        // Too short to voice alone: leave lastEnd where it is so the next
        // boundary carries this sentence along (or it stays in the remainder).
        if (sentence.length < MIN_TTS_SENTENCE_CHARS) continue;
        if (sentence) sentences.push(sentence);
        lastEnd = end;
    }
    return {
        complete: sentences,
        remainder: text.slice(lastEnd),
    };
}
