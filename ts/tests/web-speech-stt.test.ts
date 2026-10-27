/**
 * Web Speech transcript assembly. Both Chromes emit several interim results:
 * desktop's are separate chunks, Android's are growing prefixes of one utterance
 * (meditation-pal-oxmt). Dropping desktop's earlier interims strands the live
 * bubble on the last word or two - keep that case covered.
 * Node has no window, so the engine picks up a fake recognizer off the global.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

    it("keeps every one of desktop Chrome's interim chunks", async () => {
        const text = await transcriptFor([
            { text: 'yeah I\'m just settling in', final: false },
            { text: 'feeling a little', final: false },
            { text: 'tightness', final: false },
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

describe('WebSpeechSttEngine userSpeechActive', () => {
    it('is true from the first transcript until the turn submits', async () => {
        vi.useFakeTimers();
        try {
            const { WebSpeechSttEngine } = await import('../ui/src/adapters/web-speech-stt.js');
            const engine = new WebSpeechSttEngine({ submitDelayMs: 1000 });
            const iterator = engine.start()[Symbol.asyncIterator]();
            const next = iterator.next();
            await Promise.resolve();
            expect(engine.userSpeechActive).toBe(false);
            FakeRecognition.last?.emit([{ text: 'I notice', final: false }]);
            expect(engine.userSpeechActive).toBe(true);
            await next; // the partial
            const final = iterator.next();
            await vi.advanceTimersByTimeAsync(1000);
            expect(((await final).value as { type: string }).type).toBe('final');
            expect(engine.userSpeechActive).toBe(false);
            await iterator.return?.(undefined);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('WebSpeechSttEngine network errors', () => {
    /** Run one turn that errors `network`, after `heard` results beforehand. */
    async function networkErrorAfter(heard: boolean): Promise<unknown> {
        const { WebSpeechSttEngine } = await import('../ui/src/adapters/web-speech-stt.js');
        const engine = new WebSpeechSttEngine();
        if (heard) {
            const first = engine.start()[Symbol.asyncIterator]();
            const ev = first.next();
            await Promise.resolve();
            FakeRecognition.last?.emit([{ text: 'warm hands', final: true }]);
            await ev;
            await first.return?.(undefined);
        }
        const iterator = engine.start()[Symbol.asyncIterator]();
        const next = iterator.next();
        await Promise.resolve();
        FakeRecognition.last?.onerror?.({ error: 'network' });
        const event = (await next).value as { type: string; error?: unknown };
        await iterator.return?.(undefined);
        expect(event.type).toBe('error');
        return event.error;
    }

    it('reports a recognizer that never worked as plain network (blocked endpoint)', async () => {
        expect(await networkErrorAfter(false)).toBe('network');
    });

    it('reports one that had been hearing fine as a lost connection', async () => {
        expect(await networkErrorAfter(true)).toBe('network-lost');
    });
});

