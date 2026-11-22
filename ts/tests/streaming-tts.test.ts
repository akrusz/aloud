import { afterEach, describe, it, expect, vi } from 'vitest';

import {
    MAX_WHOLE_REPLY_CHARS,
    WHOLE_REPLY_WAIT_MS,
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

/** Records each utterance's options and prefetches too, and plays each out
 *  at once, reporting every mark as CloudTtsEngine does. `failWhen` makes the
 *  matching ones fail as a synthesis error does, before any audio;
 *  `failPlayWhen` as a blocked play() does, after the synthesis. */
class RecordingTtsWithOptions extends RecordingTts {
    readonly reportsMarks: boolean = true;
    options: (TtsOptions | undefined)[] = [];
    prefetched: string[] = [];
    failWhen: ((text: string, opts?: TtsOptions) => boolean) | null = null;
    failPlayWhen: ((text: string, opts?: TtsOptions) => boolean) | null = null;
    override async speak(text: string, opts?: TtsOptions): Promise<void> {
        this.spoken.push(text);
        this.options.push(opts);
        if (this.failWhen?.(text, opts)) throw new Error('TTS endpoint 502');
        opts?.onSynthesized?.();
        if (this.failPlayWhen?.(text, opts)) throw Object.assign(new Error('play() blocked'), { name: 'NotAllowedError' });
        opts?.onStart?.();
        opts?.marks?.forEach((_, i) => opts.onMark?.(i));
    }
    prefetch(text: string): void {
        this.prefetched.push(text);
    }
}

describe('splitOffSentences', () => {
    it('splits on .!? followed by whitespace', () => {
        expect(splitOffSentences('Hello there, my good friend. How are you feeling today? Good!')).toEqual({
            complete: ['Hello there, my good friend.', 'How are you feeling today?'],
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
        const result = splitOffSentences('I see... and then what?');
        // Either grouping is fine ("I see..." alone or the whole line); the
        // property is that "..." never breaks into separate sentences.
        expect(result.complete.length).toBeLessThanOrEqual(1);
        if (result.complete[0]) expect(result.complete[0]).toContain('I see');
    });

    it('carries a short sentence into the next one instead of voicing it alone (1c9h)', () => {
        expect(splitOffSentences('Nice. Just like that, stay with it. And ')).toEqual({
            complete: ['Nice. Just like that, stay with it.'],
            remainder: 'And ',
        });
    });

    it('leaves a trailing short sentence in the remainder', () => {
        expect(splitOffSentences('Let the breath find its own rhythm. Good. ')).toEqual({
            complete: ['Let the breath find its own rhythm.'],
            remainder: 'Good. ',
        });
    });

    it('handles an empty string', () => {
        expect(splitOffSentences('')).toEqual({ complete: [], remainder: '' });
    });
});

describe('streamCompletionWithChunkedTts', () => {
    // The trouble check's hook (views/session.ts): the reply generates while
    // the verdict is out, and is heard only if the gate opens.
    describe('speakGate', () => {
        const chunks = ['Stay with that for a moment longer. ', 'What do you notice now?'];

        it('holds every sentence until the gate opens, then speaks them in order', async () => {
            const tts = new RecordingTts();
            let open!: (go: boolean) => void;
            let asked = 0;
            const result = await streamCompletionWithChunkedTts(
                new FakeStreamingProvider(chunks),
                tts,
                [{ role: 'user', content: 'hi' }],
                {
                    speakGate: () => {
                        asked++;
                        return new Promise<boolean>((resolve) => (open = resolve));
                    },
                }
            );
            // The whole reply has been generated; none of it has been heard.
            expect(result.text).toBe(chunks.join(''));
            await Promise.resolve();
            expect(tts.spoken).toEqual([]);
            open(true);
            await result.ttsDone;
            expect(tts.spoken).toEqual(['Stay with that for a moment longer.', 'What do you notice now?']);
            expect(asked).toBe(1);
        });

        it('keeps the completion silent when the gate stays shut', async () => {
            const tts = new RecordingTts();
            const result = await streamCompletionWithChunkedTts(
                new FakeStreamingProvider(chunks),
                tts,
                [{ role: 'user', content: 'hi' }],
                { speakGate: async () => false }
            );
            await result.ttsDone;
            expect(result.text).toBe(chunks.join(''));
            expect(tts.spoken).toEqual([]);
        });

        it('opens when the gate itself fails', async () => {
            const tts = new RecordingTts();
            const result = await streamCompletionWithChunkedTts(
                new FakeStreamingProvider(chunks),
                tts,
                [{ role: 'user', content: 'hi' }],
                { speakGate: () => Promise.reject(new Error('check broke')) }
            );
            await result.ttsDone;
            expect(tts.spoken).toHaveLength(2);
        });

        it('gates the non-streaming fallback too', async () => {
            const tts = new RecordingTts();
            const result = await streamCompletionWithChunkedTts(
                new FakeNonStreamingProvider('Hello there. How are you?'),
                tts,
                [{ role: 'user', content: 'hi' }],
                { speakGate: async () => false }
            );
            await result.ttsDone;
            expect(tts.spoken).toEqual([]);
        });
    });

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
            'Hello there, my',
            ' good friend.',
            ' How are you',
            ' feeling today?',
            ' Good',
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'hi' },
        ]);
        await result.ttsDone;
        expect(result.text).toBe('Hello there, my good friend. How are you feeling today? Good');
        expect(tts.spoken).toEqual(['Hello there, my good friend.', 'How are you feeling today?', 'Good']);
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

    it('strips a [NEXT] stage token even when split across chunks', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider([
            '[NE',
            'XT] Which of these',
            ' wants your attention?',
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'the job thing, mostly' },
        ]);
        await result.ttsDone;
        // Full text (token intact) returned so the caller advances the arc…
        expect(result.text).toBe('[NEXT] Which of these wants your attention?');
        // …but the token itself is never voiced.
        expect(tts.spoken).toEqual(['Which of these wants your attention?']);
    });

    it('strips stacked control tokens ([NEXT] [HOLD]) before speaking', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider([
            '[NEXT] [H',
            'OLD] Take all the time',
            ' you need.',
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'sticky… yes, that fits' },
        ]);
        await result.ttsDone;
        expect(result.text).toBe('[NEXT] [HOLD] Take all the time you need.');
        expect(tts.spoken).toEqual(['Take all the time you need.']);
    });

    it('strips a [WAIT:Nm] timing token before speaking', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider([
            '[WAIT:1m] Take a moment to notice',
            " what's here inside.",
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'ok' },
        ]);
        await result.ttsDone;
        // Full text (token intact) returned so the caller sets the interval…
        expect(result.text).toBe("[WAIT:1m] Take a moment to notice what's here inside.");
        // …but the token is never voiced.
        expect(tts.spoken).toEqual(["Take a moment to notice what's here inside."]);
    });

    it('strips a [WAIT:Nm] token split across chunks, stacked with [HOLD]', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider([
            '[WAI',
            'T:12',
            'm] [HOLD] Let it',
            ' unfold.',
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: "I'll sit with this a while" },
        ]);
        await result.ttsDone;
        expect(result.text).toBe('[WAIT:12m] [HOLD] Let it unfold.');
        expect(tts.spoken).toEqual(['Let it unfold.']);
    });

    it('scrubs a non-leading [WAIT:Nm] from speech (never honored, never spoken)', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider(['We can wait [WAIT:5m] style here.']);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'hm' },
        ]);
        await result.ttsDone;
        expect(result.text).toBe('We can wait [WAIT:5m] style here.');
        expect(tts.spoken).toEqual(['We can wait style here.']);
    });

    it('strips stage tokens on the non-streaming fallback too', async () => {
        const tts = new RecordingTts();
        const result = await streamCompletionWithChunkedTts(
            new FakeNonStreamingProvider('[BACK] Maybe it can set things down again.'),
            tts,
            [{ role: 'user', content: 'too much at once' }]
        );
        await result.ttsDone;
        expect(result.text).toBe('[BACK] Maybe it can set things down again.');
        expect(tts.spoken).toEqual(['Maybe it can set things down again.']);
    });

    it('non-leading tokens are not honored, but are scrubbed from speech', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider(['We can go [NEXT] later.']);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'hm' },
        ]);
        await result.ttsDone;
        // The raw text keeps the token — signal parsing stays leading-only —
        // and unknown brackets are untouched (scrubControlTokens tests).
        expect(result.text).toBe('We can go [NEXT] later.');
        expect(tts.spoken).toEqual(['We can go later.']);
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

    it('reports onSpeakStart per sentence when the engine signals playback start', async () => {
        // Engine that reports onStart as playback begins (CloudTtsEngine /
        // BrowserTtsEngine behavior) with playback outlasting the report.
        class StartReportingTts extends RecordingTts {
            override async speak(text: string, options?: TtsOptions): Promise<void> {
                this.spoken.push(text);
                options?.onStart?.();
                await new Promise((r) => setTimeout(r, 0));
            }
        }
        const tts = new StartReportingTts();
        const startedSentences: string[] = [];
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(['Hello there, my good friend.', ' How are you feeling today?']),
            tts,
            [{ role: 'user', content: 'hi' }],
            { onSpeakStart: (t) => startedSentences.push(t) }
        );
        await result.ttsDone;
        expect(startedSentences).toEqual(['Hello there, my good friend.', 'How are you feeling today?']);
    });

    it('falls back to reporting onSpeakStart when speak resolves, exactly once', async () => {
        // RecordingTts never calls options.onStart — the bridge must still
        // report each chunk (late, at playback end) so the reveal lands.
        const tts = new RecordingTts();
        const startedSentences: string[] = [];
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(['The first sentence goes here. The second sentence goes here.']),
            tts,
            [{ role: 'user', content: 'hi' }],
            { onSpeakStart: (t) => startedSentences.push(t) }
        );
        await result.ttsDone;
        expect(startedSentences).toEqual(['The first sentence goes here.', 'The second sentence goes here.']);
    });

    it('reports onSpeakStart with the clean text on the non-streaming fallback', async () => {
        const startedSentences: string[] = [];
        const result = await streamCompletionWithChunkedTts(
            new FakeNonStreamingProvider('[HOLD] Resting together.'),
            new RecordingTts(),
            [{ role: 'user', content: 'hi' }],
            { onSpeakStart: (t) => startedSentences.push(t) }
        );
        await result.ttsDone;
        expect(startedSentences).toEqual(['Resting together.']);
    });

    it('prefetches each sentence at enqueue time, before earlier playback finishes', async () => {
        // Slow playback + a prefetch hook: every sentence's synthesis must be
        // kicked off while sentence one is still "playing", not serially.
        const events: string[] = [];
        class PrefetchingTts extends RecordingTts {
            prefetch(text: string): void {
                events.push(`prefetch:${text}`);
            }
            override async speak(text: string, _options?: TtsOptions): Promise<void> {
                await new Promise((r) => setTimeout(r, 5));
                events.push(`spoke:${text}`);
            }
        }
        const tts = new PrefetchingTts();
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(['This is the very first one. ', 'This is the very second one. ', 'This is the very third one.']),
            tts,
            [{ role: 'user', content: 'hi' }]
        );
        await result.ttsDone;
        expect(events.filter((e) => e.startsWith('prefetch:'))).toEqual([
            'prefetch:This is the very first one.',
            'prefetch:This is the very second one.',
            'prefetch:This is the very third one.',
        ]);
        // All prefetches land before the first sentence finishes playing.
        expect(events.indexOf('spoke:This is the very first one.')).toBeGreaterThan(
            events.indexOf('prefetch:This is the very third one.')
        );
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

describe('role-leak guard in the streaming path', () => {
    it('never speaks a fabricated turn, and stops consuming the stream', async () => {
        const tts = new RecordingTts();
        // Chunked so the leak lands mid-stream, after a sentence already went
        // to TTS - the case the pending-buffer index math has to get right.
        const provider = new FakeStreamingProvider([
            "What's the skeptical part",
            ' saying as it comes back?',
            ' user I have this suspicion',
            " that I don't want to notice anything.",
            " assistant So there's a wanting to skip ahead.",
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'the skeptical part came back' },
        ]);
        await result.ttsDone;

        expect(tts.spoken).toEqual(["What's the skeptical part saying as it comes back?"]);
        expect(tts.spoken.join(' ')).not.toMatch(/suspicion|skip ahead/);
        // Stream stopped at the leak rather than draining every chunk.
        expect(result.text).not.toContain('skip ahead');
    });

    it('leaves a clean reply alone', async () => {
        const tts = new RecordingTts();
        const provider = new FakeStreamingProvider([
            'What does that',
            ' feel like in your nervous system?',
            ' Take your time.',
        ]);
        const result = await streamCompletionWithChunkedTts(provider, tts, [
            { role: 'user', content: 'tense' },
        ]);
        await result.ttsDone;
        expect(result.text).toBe('What does that feel like in your nervous system? Take your time.');
        expect(tts.spoken).toEqual([
            'What does that feel like in your nervous system?',
            'Take your time.',
        ]);
    });
});

describe('heard(): what a hush left unspoken', () => {
    const reply = ['The first sentence goes here. ', 'The second sentence goes here. ', 'And the third one here.'];

    /** Reports onStart, then plays until cancel() or `release()`. */
    class HeldTts extends RecordingTts {
        private end: (() => void) | null = null;
        override speak(text: string, options?: TtsOptions): Promise<void> {
            this.spoken.push(text);
            options?.onStart?.();
            return new Promise((resolve) => (this.end = resolve));
        }
        override async cancel(): Promise<void> {
            this.end?.();
        }
    }

    it('is the whole reply, not cut, once it has played out', async () => {
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider(reply), new RecordingTts(), [
            { role: 'user', content: 'hi' },
        ]);
        await result.ttsDone;
        expect(result.heard()).toEqual({
            text: 'The first sentence goes here. The second sentence goes here. And the third one here.',
            cut: false,
        });
    });

    it('keeps the sentence a barge-in landed in and cuts the ones after it', async () => {
        const tts = new HeldTts();
        const ac = new AbortController();
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(reply),
            tts,
            [{ role: 'user', content: 'hi' }],
            { ttsSignal: ac.signal }
        );
        await new Promise((r) => setTimeout(r, 0));
        expect(result.heard().cut).toBe(false); // still playing
        void tts.cancel();
        ac.abort();
        // Known at once: a turn that takes over reads it before its own words
        // go into the log.
        expect(result.heard()).toEqual({ text: 'The first sentence goes here.', cut: true });
        await result.ttsDone;
        expect(tts.spoken).toEqual(['The first sentence goes here.']);
        expect(result.heard()).toEqual({ text: 'The first sentence goes here.', cut: true });
    });

    it('is empty and cut when the hush came before any audio', async () => {
        const ac = new AbortController();
        ac.abort();
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(reply),
            new RecordingTts(),
            [{ role: 'user', content: 'hi' }],
            { ttsSignal: ac.signal }
        );
        await result.ttsDone;
        expect(result.heard()).toEqual({ text: '', cut: true });
    });

    it('is not cut by a TTS failure: the reply stays, text-only', async () => {
        class FailingTts extends RecordingTts {
            override async speak(): Promise<void> {
                throw new Error('synthesis failed');
            }
        }
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(reply),
            new FailingTts(),
            [{ role: 'user', content: 'hi' }],
            { onTtsError: () => {} }
        );
        await result.ttsDone;
        expect(result.heard().cut).toBe(false);
    });
});

describe('wholeReply: a reply as one utterance (CloudVoice.wholeReply)', () => {
    const user: Message[] = [{ role: 'user', content: 'hi' }];
    const A = 'Notice where the breath is easiest to feel.';
    const B = 'Stay with that spot for a little while.';
    const C = 'What do you find there?';
    const whole = `${A} ${B} ${C}`;

    /** A stream with waits (ms) between its pieces. */
    class TimedStreamingProvider implements LLMProvider {
        readonly model = 'fake';
        constructor(private readonly steps: readonly (string | number)[]) {}
        async complete(): Promise<CompletionResult> {
            return { text: '', finishReason: 'stop', tokensUsed: null };
        }
        async *completeStream(): AsyncIterable<StreamChunk> {
            for (const step of this.steps) {
                if (typeof step === 'number') await new Promise((r) => setTimeout(r, step));
                else yield { text: step, done: false };
            }
            yield { text: '', done: true, finishReason: 'stop' };
        }
    }

    /** Records each utterance with its options; plays until cancel() or
     *  finish(), reaching the first `reach` marks, as CloudTtsEngine reports
     *  them: inside cancel(), and all of them on playing out. */
    class MarkingTts extends RecordingTts {
        readonly reportsMarks = true;
        options: (TtsOptions | undefined)[] = [];
        reach = 0;
        private playing: { opts: TtsOptions | undefined; end: () => void } | null = null;
        override speak(text: string, opts?: TtsOptions): Promise<void> {
            this.spoken.push(text);
            this.options.push(opts);
            opts?.onStart?.();
            return new Promise((resolve) => (this.playing = { opts, end: resolve }));
        }
        finish(): void {
            const p = this.playing;
            this.playing = null;
            p?.opts?.marks?.forEach((_, i) => p.opts!.onMark?.(i));
            p?.end();
        }
        override async cancel(): Promise<void> {
            const p = this.playing;
            this.playing = null;
            for (let i = 0; i < this.reach && i < (p?.opts?.marks?.length ?? 0); i++) p!.opts!.onMark?.(i);
            p?.end();
        }
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    it('speaks a reply that ends inside the wait as one utterance, its chunk starts marked', async () => {
        const tts = new RecordingTtsWithOptions();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {
            wholeReply: true,
            ttsOptions: { rate: 140 },
        });
        await result.ttsDone;
        expect(tts.spoken).toEqual([whole]);
        expect(tts.options[0]).toMatchObject({ rate: 140, marks: [A.length + 1, A.length + B.length + 2] });
        expect(whole.slice(tts.options[0]!.marks![1]!)).toBe(C);
        expect(result.heard()).toEqual({ text: whole, cut: false });
    });

    /** Each utterance plays `ms`. */
    class PlayingTts extends RecordingTtsWithOptions {
        constructor(private readonly ms: number) {
            super();
        }
        override async speak(text: string, opts?: TtsOptions): Promise<void> {
            await super.speak(text, opts);
            await new Promise((r) => setTimeout(r, this.ms));
        }
    }

    it('sends what it has when the stream runs past the wait, and the rest as one more at its end', async () => {
        vi.useFakeTimers();
        const tts = new PlayingTts(3000);
        const done = streamCompletionWithChunkedTts(
            new TimedStreamingProvider([`${A} `, 'Stay', WHOLE_REPLY_WAIT_MS + 300, ` with that spot for a little while. ${C}`]),
            tts,
            user,
            { wholeReply: true }
        );
        await vi.advanceTimersByTimeAsync(WHOLE_REPLY_WAIT_MS - 10);
        expect(tts.spoken).toEqual([]);
        await vi.advanceTimersByTimeAsync(20);
        expect(tts.spoken).toEqual([A]);
        expect(tts.options[0]!.marks).toBeUndefined();
        await vi.advanceTimersByTimeAsync(400);
        const result = await done;
        await vi.advanceTimersByTimeAsync(7000);
        await result.ttsDone;
        expect(tts.spoken).toEqual([A, `${B} ${C}`]);
        expect(tts.options[1]!.marks).toEqual([B.length + 1]);
    });

    it('sends a chunk at once when the stream is slower than the audio, rather than at the stream end', async () => {
        vi.useFakeTimers();
        // A plays 200ms from the wait; B lands long after, C later still.
        const tts = new PlayingTts(200);
        const done = streamCompletionWithChunkedTts(
            new TimedStreamingProvider([`${A} `, 'S', 1500, 'tay with that spot for a little while. ', 'W', 3000, 'hat do you find there?']),
            tts,
            user,
            { wholeReply: true }
        );
        await vi.advanceTimersByTimeAsync(1600);
        // B went the moment it was complete, with the stream still running.
        expect(tts.spoken).toEqual([A, B]);
        await vi.advanceTimersByTimeAsync(4000);
        await (await done).ttsDone;
        expect(tts.spoken).toEqual([A, B, C]);
    });

    it('sends the next part early when the stream outlasts the part playing', async () => {
        vi.useFakeTimers();
        // Each utterance plays 300ms.
        class SlowTts extends RecordingTtsWithOptions {
            override async speak(text: string, opts?: TtsOptions): Promise<void> {
                await super.speak(text, opts);
                await new Promise((r) => setTimeout(r, 300));
            }
        }
        const tts = new SlowTts();
        const done = streamCompletionWithChunkedTts(
            new TimedStreamingProvider([`${A} `, 'S', 700, 'tay with that spot for a little while. ', 'W', 2000, 'hat do you find there?']),
            tts,
            user,
            { wholeReply: true }
        );
        // A goes at the wait; B is in by the time A has played (800ms).
        await vi.advanceTimersByTimeAsync(WHOLE_REPLY_WAIT_MS + 400);
        expect(tts.spoken).toEqual([A, B]);
        await vi.advanceTimersByTimeAsync(3000);
        await (await done).ttsDone;
        expect(tts.spoken).toEqual([A, B, C]);
    });

    it('keeps only the chunks whose audio was reached when a barge-in cuts it', async () => {
        const tts = new MarkingTts();
        const ac = new AbortController();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {
            wholeReply: true,
            ttsSignal: ac.signal,
        });
        await vi.waitFor(() => expect(tts.spoken).toEqual([whole]));
        expect(result.heard()).toEqual({ text: A, cut: false });
        // Cut in B: the engine reports B's mark inside cancel(), before the
        // turn that takes the floor reads heard().
        tts.reach = 1;
        void tts.cancel();
        ac.abort();
        expect(result.heard()).toEqual({ text: `${A} ${B}`, cut: true });
        await result.ttsDone;
        expect(result.heard()).toEqual({ text: `${A} ${B}`, cut: true });
    });

    it('counts the whole reply heard once it plays out, and none of it before its audio starts', async () => {
        const tts = new MarkingTts();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {
            wholeReply: true,
        });
        await vi.waitFor(() => expect(tts.spoken).toHaveLength(1));
        tts.finish();
        await result.ttsDone;
        expect(result.heard()).toEqual({ text: whole, cut: false });

        const ac = new AbortController();
        const quiet = new MarkingTts();
        const early = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), quiet, user, {
            wholeReply: true,
            ttsSignal: ac.signal,
            speakGate: () => new Promise(() => {}),
        });
        ac.abort();
        expect(quiet.spoken).toEqual([]);
        expect(early.heard()).toEqual({ text: '', cut: true });
    });

    it('reveals the whole text when the utterance starts', async () => {
        const revealed: string[] = [];
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), new MarkingTts(), user, {
            wholeReply: true,
            onSpeakStart: (t) => revealed.push(t),
        });
        await vi.waitFor(() => expect(revealed).toEqual([whole]));
        expect(result.text).toBe(whole);
    });

    it('drops what it gathered when hushed during the wait', async () => {
        vi.useFakeTimers();
        const tts = new RecordingTtsWithOptions();
        const ac = new AbortController();
        const done = streamCompletionWithChunkedTts(new TimedStreamingProvider([`${A} `, 'S', 2000, `tay a while. ${C}`]), tts, user, {
            wholeReply: true,
            ttsSignal: ac.signal,
        });
        await vi.advanceTimersByTimeAsync(100);
        ac.abort();
        await vi.advanceTimersByTimeAsync(3000);
        const result = await done;
        await result.ttsDone;
        expect(tts.spoken).toEqual([]);
        expect(result.heard()).toEqual({ text: '', cut: true });
    });

    it('asks the gate at the first chunk, while the rest of the reply is awaited', async () => {
        vi.useFakeTimers();
        let asked = 0;
        const done = streamCompletionWithChunkedTts(
            new TimedStreamingProvider([`${A} `, 'S', 300, `tay a while. ${C}`]),
            new RecordingTtsWithOptions(),
            user,
            {
                wholeReply: true,
                speakGate: async () => {
                    asked++;
                    return true;
                },
            }
        );
        await vi.advanceTimersByTimeAsync(10);
        expect(asked).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        await (await done).ttsDone;
        expect(asked).toBe(1);
    });

    it("says a failed utterance a chunk at a time, inside the first try's retry time, without an error", async () => {
        const tts = new RecordingTtsWithOptions();
        tts.failWhen = (_text, opts) => !!opts?.marks;
        const errors: unknown[] = [];
        const before = Date.now();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {
            wholeReply: true,
            onTtsError: (e) => errors.push(e),
        });
        await result.ttsDone;
        expect(tts.spoken).toEqual([whole, A, B, C]);
        for (const opts of tts.options.slice(1)) {
            expect(opts!.retryFrom).toBeGreaterThanOrEqual(before);
            expect(opts!.marks).toBeUndefined();
        }
        expect(tts.prefetched).toEqual([whole, A, B, C]);
        expect(errors).toEqual([]);
        expect(result.heard()).toEqual({ text: whole, cut: false });
    });

    it('keeps the rest of the reply a chunk at a time after a failure, and reports one error if those fail too', async () => {
        vi.useFakeTimers();
        const tts = new RecordingTtsWithOptions();
        tts.failWhen = () => true;
        const errors: unknown[] = [];
        const done = streamCompletionWithChunkedTts(
            new TimedStreamingProvider([`${A} `, 'S', 700, `tay with that spot for a little while. ${C}`]),
            tts,
            user,
            { wholeReply: true, onTtsError: (e) => errors.push(e) }
        );
        await vi.advanceTimersByTimeAsync(2000);
        const result = await done;
        await result.ttsDone;
        // A alone (the wait ran out) fails and is said again on its own; B
        // and C, still to come then, go one at a time.
        expect(tts.spoken).toEqual([A, A, B, C]);
        expect(errors).toHaveLength(1);
        expect(result.heard().cut).toBe(false);
    });

    it('splits a reply too long for one request at a chunk', async () => {
        const long = Array.from({ length: 40 }, (_, i) => `This is the sentence numbered ${i + 1} of a long reply.`);
        // Each utterance plays until the reply has been generated.
        let generated!: () => void;
        const allIn = new Promise<void>((r) => (generated = r));
        class HeldTts extends RecordingTtsWithOptions {
            override async speak(text: string, opts?: TtsOptions): Promise<void> {
                await super.speak(text, opts);
                await allIn;
            }
        }
        const tts = new HeldTts();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider(long.map((s) => `${s} `)), tts, user, {
            wholeReply: true,
        });
        generated();
        await result.ttsDone;
        expect(tts.spoken.length).toBe(Math.ceil(long.join(' ').length / MAX_WHOLE_REPLY_CHARS));
        for (const t of tts.spoken) expect(t.length).toBeLessThanOrEqual(MAX_WHOLE_REPLY_CHARS);
        expect(tts.spoken.join(' ')).toBe(long.join(' '));
    });

    it('marks the chunks of a non-streaming reply too', async () => {
        const tts = new RecordingTtsWithOptions();
        const result = await streamCompletionWithChunkedTts(new FakeNonStreamingProvider(`[HOLD] ${whole}`), tts, user, {
            wholeReply: true,
        });
        await result.ttsDone;
        expect(tts.spoken).toEqual([whole]);
        expect(tts.options[0]!.marks).toEqual([A.length + 1, A.length + B.length + 2]);
    });

    it('says the chunks a clip stopped without a hush never reached, one at a time, and counts only what was reached', async () => {
        // Stopped once B had started (an outside pause, a voice switch,
        // another engine taking the element): the engine reports B's mark,
        // then resolves.
        class StoppedTts extends RecordingTtsWithOptions {
            override async speak(text: string, opts?: TtsOptions): Promise<void> {
                if (!opts?.marks) return super.speak(text, opts);
                this.spoken.push(text);
                this.options.push(opts);
                opts.onSynthesized?.();
                opts.onStart?.();
                opts.onMark?.(0);
            }
        }
        const tts = new StoppedTts();
        const revealed: string[] = [];
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {
            wholeReply: true,
            onSpeakStart: (t) => revealed.push(t),
        });
        await result.ttsDone;
        // The rest of B is lost, as the rest of a sentence was before; C plays.
        expect(tts.spoken).toEqual([whole, C]);
        expect(revealed).toEqual([whole, C]);
        expect(result.heard()).toEqual({ text: whole, cut: false });
    });

    it('a clip stopped before its audio began says every chunk one at a time', async () => {
        class TakenTts extends RecordingTtsWithOptions {
            override async speak(text: string, opts?: TtsOptions): Promise<void> {
                if (!opts?.marks) return super.speak(text, opts);
                this.spoken.push(text);
            }
        }
        const tts = new TakenTts();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {
            wholeReply: true,
        });
        await result.ttsDone;
        expect(tts.spoken).toEqual([whole, A, B, C]);
    });

    it('speaks a chunk at a time on an engine that cannot say how far a clip got', async () => {
        class Blind extends RecordingTtsWithOptions {
            override readonly reportsMarks = false;
        }
        const tts = new Blind();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {
            wholeReply: true,
        });
        await result.ttsDone;
        expect(tts.spoken).toEqual([A, B, C]);
    });

    it('keeps the order when a chunk arrives after a failed utterance while another waits gathered', async () => {
        vi.useFakeTimers();
        // The reviewer's case: A goes alone at the wait and fails 150ms
        // later; B is gathered behind it; C comes after the failure.
        class FailFirst extends RecordingTtsWithOptions {
            private calls = 0;
            override async speak(text: string, opts?: TtsOptions): Promise<void> {
                if (this.calls++ === 0) {
                    this.spoken.push(text);
                    await new Promise((r) => setTimeout(r, 150));
                    throw new Error('TTS endpoint 502');
                }
                await super.speak(text, opts);
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        const tts = new FailFirst();
        const done = streamCompletionWithChunkedTts(
            new TimedStreamingProvider([`${A} `, 600, `${B} `, 300, `${C} `, 300]),
            tts,
            user,
            { wholeReply: true }
        );
        await vi.advanceTimersByTimeAsync(3000);
        const result = await done;
        await result.ttsDone;
        expect(tts.spoken).toEqual([A, A, B, C]);
        expect(result.heard()).toEqual({ text: whole, cut: false });
    });

    it('speaks nothing for a turn whose stream threw while chunks were gathered', async () => {
        vi.useFakeTimers();
        class Throwing implements LLMProvider {
            readonly model = 'fake';
            async complete(): Promise<CompletionResult> {
                return { text: '', finishReason: 'stop', tokensUsed: null };
            }
            async *completeStream(): AsyncIterable<StreamChunk> {
                yield { text: `${A} `, done: false };
                await new Promise((r) => setTimeout(r, 100));
                throw new Error('stream dropped');
            }
        }
        const tts = new RecordingTtsWithOptions();
        const done = streamCompletionWithChunkedTts(new Throwing(), tts, user, { wholeReply: true });
        const failed = expect(done).rejects.toThrow('stream dropped');
        await vi.advanceTimersByTimeAsync(WHOLE_REPLY_WAIT_MS * 3);
        await failed;
        expect(tts.spoken).toEqual([]);
    });

    it('reports a clip whose play() failed after synthesis, and does not say its chunks again', async () => {
        const tts = new RecordingTtsWithOptions();
        tts.failPlayWhen = () => true;
        const errors: unknown[] = [];
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {
            wholeReply: true,
            onTtsError: (e) => errors.push(e),
        });
        await result.ttsDone;
        expect(tts.spoken).toEqual([whole]);
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).name).toBe('NotAllowedError');
    });

    it("leaves a voice without the flag a chunk per utterance, as an older server's voices are", async () => {
        const tts = new RecordingTtsWithOptions();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([`${A} `, `${B} `, C]), tts, user, {});
        await result.ttsDone;
        expect(tts.spoken).toEqual([A, B, C]);
        expect(tts.options.every((o) => o?.marks === undefined)).toBe(true);
    });
});

// meditation-pal-wgtb, meditation-pal-dqti: the model's reasoning reaching the
// voice before the reply is complete.
describe("the model's reasoning, kept from the voice mid-stream", () => {
    const user: Message[] = [{ role: 'user', content: 'my hands feel far away' }];
    const REASONING =
        'The user is describing dissociation - feeling disconnected from their body, hands feeling far away. ';
    const PLAN = 'I should stay with them and acknowledge the fear without amplifying it. ';
    const REPLY = "What's that scared feeling like?";

    /** A stream with waits (ms) between its pieces, so a sentence can be
     *  playing when the next one arrives. */
    class Paced implements LLMProvider {
        readonly model = 'fake';
        constructor(private readonly steps: readonly (string | number)[]) {}
        async complete(): Promise<CompletionResult> {
            return { text: '', finishReason: 'stop', tokensUsed: null };
        }
        async *completeStream(): AsyncIterable<StreamChunk> {
            for (const step of this.steps) {
                if (typeof step === 'number') await new Promise((r) => setTimeout(r, step));
                else yield { text: step, done: false };
            }
            yield { text: '', done: true, finishReason: 'stop' };
        }
    }

    /** Plays each utterance for `ms` unless cancel() stops it first, and
     *  records prefetches and cancels. */
    class PlayingTts extends RecordingTts {
        prefetched: string[] = [];
        cancels = 0;
        private stop: (() => void) | null = null;
        constructor(private readonly ms = 30) {
            super();
        }
        override speak(text: string, options?: TtsOptions): Promise<void> {
            this.spoken.push(text);
            options?.onStart?.();
            return new Promise((resolve) => {
                const timer = setTimeout(resolve, this.ms);
                this.stop = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
        }
        prefetch(text: string): void {
            this.prefetched.push(text);
        }
        override async cancel(): Promise<void> {
            this.cancels++;
            this.stop?.();
        }
    }

    it('checks the first sentence before the voice has any of it', async () => {
        const tts = new PlayingTts();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([REASONING, PLAN, 'Something like that.']), tts, user);
        await result.ttsDone;
        expect(tts.spoken).toEqual([]);
        expect(tts.prefetched).toEqual([]);
        expect(tts.cancels).toBe(0);
        // The whole reply still comes back, for the caller's parse to call blank.
        expect(result.text).toBe(`${REASONING}${PLAN}Something like that.`);
        expect(result.heard()).toEqual({ text: '', cut: false });
    });

    it("speaks the reply after a lone closing tag, having kept the reasoning before it silent (Kimi K2's shape)", async () => {
        const tts = new PlayingTts(1);
        const spokenStarts: string[] = [];
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider([REASONING, PLAN, 'Let me go with something simple.</th', 'ink>', REPLY]),
            tts,
            user,
            { onSpeakStart: (s) => spokenStarts.push(s) }
        );
        await result.ttsDone;
        expect(tts.spoken).toEqual([REPLY]);
        expect(spokenStarts).toEqual([REPLY]);
        expect(result.heard()).toEqual({ text: REPLY, cut: false });
    });

    it('withdraws and stops what was said before a lone closing tag, and keeps only the reply as heard', async () => {
        // Reasoning that does not read as such (bonsai-2's "Stop facilitating"):
        // its first sentence is spoken before the tag can be known.
        const tts = new PlayingTts(200);
        const ac = new AbortController();
        const result = await streamCompletionWithChunkedTts(
            new Paced(['Stop facilitating and talk to them plainly now. ', 20, 'Tell them what to do.\n</think>\n\n', 'Okay, that sounds scary. ', REPLY]),
            tts,
            user,
            { ttsSignal: ac.signal }
        );
        expect(tts.cancels).toBe(1);
        expect(tts.spoken[0]).toBe('Stop facilitating and talk to them plainly now.');
        expect(tts.spoken.join(' ')).not.toContain('Tell them what to do');
        // A barge-in now cuts against the reply alone, never the reasoning.
        await new Promise((r) => setTimeout(r, 0));
        expect(result.heard().text).toBe('Okay, that sounds scary.');
        await result.ttsDone;
        expect(tts.spoken.slice(1)).toEqual(['Okay, that sounds scary.', REPLY]);
        expect(result.heard()).toEqual({ text: `Okay, that sounds scary. ${REPLY}`, cut: false });
    });

    it('silences the rest of a reply whose later sentence reads as reasoning, and stops what is playing', async () => {
        const tts = new PlayingTts(200);
        const result = await streamCompletionWithChunkedTts(
            new Paced(['I hear how frightening this feels right now. ', 20, REASONING, PLAN, REPLY]),
            tts,
            user
        );
        await result.ttsDone;
        expect(tts.spoken).toEqual(['I hear how frightening this feels right now.']);
        expect(tts.cancels).toBe(1);
        // Not heard as far as the log goes: the caller treats the reply as blank.
        expect(result.heard()).toEqual({ text: '', cut: false });
    });

    it('holds everything inside an open reasoning block until it closes', async () => {
        const tts = new PlayingTts(1);
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(['<think>They seem tense today. ', 'Keep it short and kind. ', 'Ask about the', ' breath.</think>', 'Rest here with the breath, gently.']),
            tts,
            user
        );
        await result.ttsDone;
        expect(tts.spoken).toEqual(['Rest here with the breath, gently.']);
    });

    it('lets the words of a block that never closed out at the end, as the turn parser keeps them', async () => {
        const tts = new PlayingTts(1);
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(['<think>Breathe in slowly and let the shoulders drop. ', 'Feel the chair', ' holding you.']),
            tts,
            user
        );
        await result.ttsDone;
        expect(tts.spoken).toEqual(['Breathe in slowly and let the shoulders drop.', 'Feel the chair holding you.']);
    });

    it('reads the control tokens at the front of what follows a lone closing tag', async () => {
        const tts = new PlayingTts(1);
        const result = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider(['They asked for quiet.</think>[HO', 'LD] ', "Sure, I'll be right here."]),
            tts,
            user
        );
        await result.ttsDone;
        expect(tts.spoken).toEqual(["Sure, I'll be right here."]);
    });

    it('speaks nothing of a reasoning reply on the non-streaming path (the claude CLI)', async () => {
        const tts = new PlayingTts(1);
        const result = await streamCompletionWithChunkedTts(new FakeNonStreamingProvider(`${REASONING}${PLAN}`), tts, user);
        await result.ttsDone;
        expect(tts.spoken).toEqual([]);
        const rescued = await streamCompletionWithChunkedTts(new FakeNonStreamingProvider(`${REASONING}</think>${REPLY}`), tts, user);
        await rescued.ttsDone;
        expect(tts.spoken).toEqual([REPLY]);
    });

    it('keeps a whole-reply voice silent on reasoning too', async () => {
        const tts = new RecordingTtsWithOptions();
        const result = await streamCompletionWithChunkedTts(new FakeStreamingProvider([REASONING, PLAN, REPLY]), tts, user, {
            wholeReply: true,
        });
        await result.ttsDone;
        expect(tts.spoken).toEqual([]);
        const rescued = await streamCompletionWithChunkedTts(
            new FakeStreamingProvider([REASONING, `${PLAN}</think>`, 'Okay, that sounds scary. ', REPLY]),
            tts,
            user,
            { wholeReply: true }
        );
        await rescued.ttsDone;
        expect(tts.spoken).toEqual([`Okay, that sounds scary. ${REPLY}`]);
    });
});
