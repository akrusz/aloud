/**
 * Web Speech transcript assembly. Desktop Chrome replaces the interim result at
 * the tail; Android appends each one and keeps the old (meditation-pal-oxmt).
 * Node has no window, so the engine picks up a fake recognizer off the global.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

interface FakeResult {
    isFinal: boolean;
    0: { transcript: string; confidence: number };
}

class FakeRecognition {
    static last: FakeRecognition | null = null;
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((event: { resultIndex: number; results: unknown }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;

    constructor() {
        FakeRecognition.last = this;
    }
    start(): void {
        this.started = true;
    }
    stop(): void {
        this.onend?.();
    }
    abort(): void {
        this.onend?.();
    }

    /** Deliver a result list, `final:` marking which segments have settled. */
    emit(segments: Array<{ text: string; final: boolean }>): void {
        const results: Record<number, FakeResult> & { length: number } = { length: segments.length };
        segments.forEach((seg, i) => {
            results[i] = { isFinal: seg.final, 0: { transcript: seg.text, confidence: 1 } };
        });
        this.onresult?.({ resultIndex: 0, results });
    }
}

const originalWindow = (globalThis as Record<string, unknown>)['window'];
const originalDocument = (globalThis as Record<string, unknown>)['document'];

beforeEach(() => {
    (globalThis as Record<string, unknown>)['window'] = { SpeechRecognition: FakeRecognition };
    (globalThis as Record<string, unknown>)['document'] = { documentElement: { lang: 'en-US' } };
    FakeRecognition.last = null;
});

afterEach(() => {
    (globalThis as Record<string, unknown>)['window'] = originalWindow;
    (globalThis as Record<string, unknown>)['document'] = originalDocument;
});

/** Start the engine, deliver one result list, and return the event it emitted. */
async function transcriptFor(segments: Array<{ text: string; final: boolean }>): Promise<string> {
    const { WebSpeechSttEngine } = await import('../ui/src/adapters/web-speech-stt.js');
    const engine = new WebSpeechSttEngine();
    const iterator = engine.start()[Symbol.asyncIterator]();
    const next = iterator.next();
    // start() runs to its first await synchronously, so the recognizer exists.
    await Promise.resolve();
    FakeRecognition.last?.emit(segments);
    const event = await next;
    await iterator.return?.(undefined);
    const value = event.value as { type: string; text?: string };
    return value.text ?? '';
}

describe('WebSpeechSttEngine transcript assembly', () => {
    it('keeps only the last of Android Chrome\'s accumulated interim results', async () => {
        const text = await transcriptFor([
            { text: 'yeah', final: false },
            { text: "yeah I'm just", final: false },
            { text: "yeah I'm just settling in", final: false },
            { text: "yeah I'm just settling in feeling a little tightness", final: false },
        ]);
        expect(text).toBe("Yeah I'm just settling in feeling a little tightness");
    });

    it('appends the live interim to the finals that came before it', async () => {
        const text = await transcriptFor([
            { text: 'I notice some tightness.', final: true },
            { text: 'it feels like', final: false },
        ]);
        expect(text).toBe('I notice some tightness. It feels like');
    });

    it('joins multiple final segments', async () => {
        const text = await transcriptFor([
            { text: 'I notice some tightness.', final: true },
            { text: 'it feels like a knot.', final: true },
        ]);
        expect(text).toBe('I notice some tightness. It feels like a knot.');
    });
});
