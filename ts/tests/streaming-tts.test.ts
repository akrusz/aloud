import { describe, it, expect } from 'vitest';

import {
    streamCompletionWithChunkedTts,
    splitOffSentences,
} from '../ui/src/streaming-tts.js';
import {
    type LLMProvider,
    type CompletionOptions,
    type CompletionResult,
    type Message,
    type StreamChunk,
} from '../src/llm/index.js';
import { type TtsEngine, type TtsOptions, type TtsVoice } from '../src/platform/index.js';

class FakeStreamingProvider implements LLMProvider {
    readonly model = 'fake';
    constructor(private readonly chunks: readonly string[]) {}

    async complete(): Promise<CompletionResult> {
        return {
            text: this.chunks.join(''),
            finishReason: 'stop',
            tokensUsed: null,
        };
    }

    async *completeStream(
        _messages: Message[],
        _options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        for (const c of this.chunks) {
            yield { text: c, done: false };
        }
        yield {
            text: '',
            done: true,
            finishReason: 'stop',
            tokensUsed: 33,
            inputTokens: 25,
            outputTokens: 8,
            cacheReadTokens: 20,
        };
    }
}

class FakeNonStreamingProvider implements LLMProvider {
    readonly model = 'fake';
    constructor(private readonly text: string) {}
    async complete(): Promise<CompletionResult> {
        return {
            text: this.text,
            finishReason: 'stop',
            tokensUsed: 15,
            inputTokens: 10,
            outputTokens: 5,
        };
    }
    // No completeStream — exercises the fallback path.
}

class RecordingTts implements TtsEngine {
    spoken: string[] = [];
    async speak(text: string, _options?: TtsOptions): Promise<void> {
        this.spoken.push(text);
    }
    async cancel(): Promise<void> {}
    async listVoices(): Promise<TtsVoice[]> {
        return [];
    }
}

describe('splitOffSentences', () => {
    it('splits on .!? followed by whitespace', () => {
        expect(splitOffSentences('Hello there. How are you? Good!')).toEqual({
            complete: ['Hello there.', 'How are you?'],
            remainder: 'Good!',
        });
    });

    it('returns no completed sentences when none have ended', () => {
        expect(splitOffSentences('Hello there')).toEqual({
            complete: [],
            remainder: 'Hello there',
        });
    });

    it('keeps ellipses attached to the surrounding sentence', () => {
        // The Python regex uses `[^.!?][.!?]` to avoid splitting on
        // ellipses; we mirror it. "I see..." should NOT split into "I see."
        const result = splitOffSentences('I see... and then what?');
        // Could split as "I see..." or "I see... and then what?" — the
        // crucial property is that we don't break "..." into separate
        // sentences. The `.` after `..` qualifies as a non-punct→punct
        // boundary, so we accept either grouping but never a 3-way split.
        expect(result.complete.length).toBeLessThanOrEqual(1);
        if (result.complete[0]) expect(result.complete[0]).toContain('I see');
    });

    it('handles an empty string', () => {
        expect(splitOffSentences('')).toEqual({ complete: [], remainder: '' });
    });
});

describe('streamCompletionWithChunkedTts', () => {
    it('falls back to single-shot speak when provider lacks completeStream', async () => {
        const tts = new RecordingTts();
        const result = await streamCompletionWithChunkedTts(
            new FakeNonStreamingProvider('Hello there. How are you?'),
            tts,
            [{ role: 'user', content: 'hi' }]
        );
        await result.ttsDone;
        expect(result.text).toBe('Hello there. How are you?');
        expect(tts.spoken).toEqual(['Hello there. How are you?']);
    });

    it('chunks streaming output into sentence-sized TTS calls', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider([
            'Hello',
            ' there.',
            ' How are',
            ' you?',
            ' Good',
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'hi' },
        ]);
        await result.ttsDone;
        expect(result.text).toBe('Hello there. How are you? Good');
        expect(tts.spoken).toEqual(['Hello there.', 'How are you?', 'Good']);
    });

    it('strips the [HOLD] token but still speaks the acknowledgment', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider([
            '[HOLD',
            "] I'll be",
            ' right here.',
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'quiet please' },
        ]);
        await result.ttsDone;
        // Full text (token intact) returned so the caller parses the signal…
        expect(result.text).toBe("[HOLD] I'll be right here.");
        // …but the spoken text drops the token and keeps the warm
        // acknowledgment — the meditator hears they were heard, then silence.
        expect(tts.spoken).toEqual(["I'll be right here."]);
    });

    it('strips the [HOLD] token but still speaks via the non-streaming fallback', async () => {
        const tts = new RecordingTts();
        const result = await streamCompletionWithChunkedTts(
            new FakeNonStreamingProvider("[HOLD] I'll be right here."),
            tts,
            [{ role: 'user', content: 'quiet please' }]
        );
        await result.ttsDone;
        // Full text still returned so the caller can parse the signal…
        expect(result.text).toBe("[HOLD] I'll be right here.");
        // …and the acknowledgment is spoken with the token stripped.
        expect(tts.spoken).toEqual(["I'll be right here."]);
    });

    it('ttsSignal hushes speech but still returns the full reply text', async () => {
        const tts = new RecordingTts();
        const ac = new AbortController();
        ac.abort(); // barge-in already fired before this turn even speaks
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(['Hello there.', ' How are you?']),
            tts,
            [{ role: 'user', content: 'hi' }],
            { ttsSignal: ac.signal }
        );
        await result.ttsDone;
        // Full text lands in the transcript…
        expect(result.text).toBe('Hello there. How are you?');
        // …but nothing is spoken — the user is talking over it.
        expect(tts.spoken).toEqual([]);
    });

    it('signal aborts generation mid-stream and stops speaking', async () => {
        const tts = new RecordingTts();
        const ac = new AbortController();
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(['One.', ' Two.', ' Three.']),
            tts,
            [{ role: 'user', content: 'hi' }],
            {
                signal: ac.signal,
                // A newer turn supersedes this one once "Two" arrives.
                onTextDelta: (t) => {
                    if (t.includes('Two')) ac.abort();
                },
            }
        );
        await result.ttsDone;
        // Stopped consuming the stream after the chunk that tripped the abort —
        // "Three." is never pulled.
        expect(result.text).toBe('One. Two.');
        expect(tts.spoken).toEqual([]);
    });

    it('surfaces the usage split from the final stream chunk', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider(['Hello', ' there.']);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'hi' },
        ]);
        await result.ttsDone;
        expect(result.usage).toEqual({
            tokensIn: 25,
            tokensOut: 8,
            cacheRead: 20,
            cacheCreation: null,
        });
    });

    it('surfaces the usage split from the non-streaming fallback', async () => {
        const tts = new RecordingTts();
        const result = await streamCompletionWithChunkedTts(
            new FakeNonStreamingProvider('Hi.'),
            tts,
            [{ role: 'user', content: 'hi' }]
        );
        await result.ttsDone;
        expect(result.usage).toMatchObject({ tokensIn: 10, tokensOut: 5 });
    });

    it('surfaces the finishReason from the final stream chunk', async () => {
        // The cloud proxy stamps a sentinel finishReason on a canned billing
        // turn; the session view keys off it to keep the turn out of history.
        class PausedProvider implements LLMProvider {
            readonly model = 'fake';
            async complete(): Promise<CompletionResult> {
                return { text: 'paused', finishReason: 'billing_paused', tokensUsed: null };
            }
            async *completeStream(): AsyncIterable<StreamChunk> {
                yield { text: 'Come back soon.', done: false };
                yield { text: '', done: true, finishReason: 'billing_paused' };
            }
        }
        const result = await streamCompletionWithChunkedTts(new PausedProvider(), new RecordingTts(), [
            { role: 'user', content: 'hi' },
        ]);
        await result.ttsDone;
        expect(result.finishReason).toBe('billing_paused');
    });

    it('surfaces the finishReason from the non-streaming fallback', async () => {
        const result = await streamCompletionWithChunkedTts(
            new FakeNonStreamingProvider('Hi.'),
            new RecordingTts(),
            [{ role: 'user', content: 'hi' }]
        );
        await result.ttsDone;
        expect(result.finishReason).toBe('stop');
    });

    it('forwards onTextDelta with the cumulative text after each chunk', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider(['Hello', ' there.']);
        const deltas: string[] = [];
        await streamCompletionWithChunkedTts(
            provider,
            tts,
            [{ role: 'user', content: 'hi' }],
            { onTextDelta: (t) => deltas.push(t) }
        );
        expect(deltas).toEqual(['Hello', 'Hello there.']);
    });
});
