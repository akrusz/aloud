import { describe, it, expect } from 'vitest';

import {
    InMemorySttEngine,
    InMemoryTtsEngine,
    InMemoryKvStorage,
    SessionStore,
    collectFinal,
    isNonSpeechOnly,
    getJson,
    setJson,
    type SttEvent,
} from '../src/platform/index.js';
import { emptyUsage, type SessionState } from '../src/facilitation/session.js';

describe('InMemorySttEngine', () => {
    it('yields scripted events in order and completes', async () => {
        const script: SttEvent[] = [
            { type: 'partial', text: 'I' },
            { type: 'partial', text: 'I notice' },
            { type: 'final', text: 'I notice warmth' },
        ];
        const stt = new InMemorySttEngine({ script });
        const collected: SttEvent[] = [];
        for await (const event of stt.start()) collected.push(event);
        expect(collected).toEqual(script);
    });

    it('stop() cuts the stream early', async () => {
        const stt = new InMemorySttEngine({
            script: [
                { type: 'partial', text: 'one' },
                { type: 'partial', text: 'two' },
                { type: 'final', text: 'three' },
            ],
            delayMs: 10,
        });
        const events: SttEvent[] = [];
        const iter = stt.start()[Symbol.asyncIterator]();
        const first = await iter.next();
        if (!first.done) events.push(first.value);
        await stt.stop();
        for await (const e of { [Symbol.asyncIterator]: () => iter }) events.push(e);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ type: 'partial', text: 'one' });
    });

    it('collectFinal returns the last final transcript', async () => {
        const stt = new InMemorySttEngine({
            script: [
                { type: 'partial', text: 'almost' },
                { type: 'final', text: 'all the way' },
            ],
        });
        expect(await collectFinal(stt)).toBe('all the way');
    });

    it('collectFinal returns null when the stream ends without a final', async () => {
        const stt = new InMemorySttEngine({
            script: [{ type: 'error', error: new Error('mic off') }],
        });
        expect(await collectFinal(stt)).toBe(null);
    });
});

describe('isNonSpeechOnly', () => {
    it('treats empty / whitespace as non-speech', () => {
        expect(isNonSpeechOnly('')).toBe(true);
        expect(isNonSpeechOnly('   ')).toBe(true);
    });

    it('drops utterances that are only Whisper non-speech markers', () => {
        expect(isNonSpeechOnly('[BLANK_AUDIO]')).toBe(true);
        expect(isNonSpeechOnly('[inaudible]')).toBe(true);
        expect(isNonSpeechOnly('(coughing)')).toBe(true);
        expect(isNonSpeechOnly('(wind blowing)')).toBe(true);
        expect(isNonSpeechOnly('*sighs*')).toBe(true);
        expect(isNonSpeechOnly('[cough] (sniff)')).toBe(true);
    });

    it('drops marker-plus-punctuation with no real words', () => {
        expect(isNonSpeechOnly('[BLANK_AUDIO].')).toBe(true);
        expect(isNonSpeechOnly('... (pause) ...')).toBe(true);
    });

    it('keeps real speech, including speech alongside a marker', () => {
        expect(isNonSpeechOnly('I notice warmth')).toBe(false);
        expect(isNonSpeechOnly('um [cough]')).toBe(false);
        expect(isNonSpeechOnly('(laughs) yeah')).toBe(false);
    });

    it('leaves bare hallucinated words alone (matches original behavior)', () => {
        // Whisper's classic silence hallucination — has letters, not filtered.
        expect(isNonSpeechOnly('you')).toBe(false);
        expect(isNonSpeechOnly('Thank you.')).toBe(false);
    });
});

describe('InMemoryTtsEngine', () => {
    it('records spoken text in order', async () => {
        const tts = new InMemoryTtsEngine();
        await tts.speak('hello');
        await tts.speak('there', { voice: 'default', rate: 0.9 });
        expect(tts.spoken.map((s) => s.text)).toEqual(['hello', 'there']);
        expect(tts.spoken[1]!.options).toEqual({ voice: 'default', rate: 0.9 });
    });

    it('cancel() makes a pending speak() resolve early and marks the record cancelled', async () => {
        const tts = new InMemoryTtsEngine({ durationMs: 1000 });
        const speakPromise = tts.speak('a long utterance');
        await tts.cancel();
        await speakPromise; // resolves rather than rejects
        expect(tts.spoken[0]!.cancelled).toBe(true);
    });

    it('lists configured voices', async () => {
        const voices = [
            { id: 'v1', name: 'Voice 1', language: 'en-US' },
            { id: 'v2', name: 'Voice 2', language: 'es-ES' },
        ];
        const tts = new InMemoryTtsEngine({ voices });
        expect(await tts.listVoices()).toEqual(voices);
    });

    it('cancel is a no-op when nothing is speaking', async () => {
        const tts = new InMemoryTtsEngine();
        await expect(tts.cancel()).resolves.toBeUndefined();
    });
});

describe('InMemoryKvStorage', () => {
    it('round-trips strings', async () => {
        const kv = new InMemoryKvStorage();
        await kv.set('a', '1');
        expect(await kv.get('a')).toBe('1');
        expect(await kv.get('missing')).toBe(null);
    });

    it('delete and clear work as expected', async () => {
        const kv = new InMemoryKvStorage();
        await kv.set('a', '1');
        await kv.set('b', '2');
        await kv.delete('a');
        expect(await kv.get('a')).toBe(null);
        expect(await kv.keys()).toEqual(['b']);
        await kv.clear();
        expect(await kv.keys()).toEqual([]);
    });

    it('getJson / setJson serialize through', async () => {
        const kv = new InMemoryKvStorage();
        await setJson(kv, 'cfg', { directiveness: 5, focuses: ['emotions'] });
        const parsed = await getJson<{ directiveness: number; focuses: string[] }>(kv, 'cfg');
        expect(parsed).toEqual({ directiveness: 5, focuses: ['emotions'] });
    });

    it('getJson returns the default for missing or unparseable keys', async () => {
        const kv = new InMemoryKvStorage();
        expect(await getJson(kv, 'missing', { ok: true })).toEqual({ ok: true });
        await kv.set('bad', '{not-json');
        expect(await getJson(kv, 'bad', 'fallback')).toBe('fallback');
    });
});

function makeSession(id: string, exchanges = 0): SessionState {
    return {
        sessionId: id,
        startTime: 1_000_000,
        endTime: null,
        exchanges: Array.from({ length: exchanges }).map((_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant' as const,
            content: `msg ${i}`,
            timestamp: 1_000_000 + i,
        })),
        tags: [],
        notes: '',
        usage: emptyUsage(),
    };
}

describe('SessionStore', () => {
    it('save then load round-trips state', async () => {
        const store = new SessionStore(new InMemoryKvStorage());
        const s = makeSession('abc', 4);
        await store.save(s);
        expect(await store.load('abc')).toEqual(s);
    });

    it('list returns saved session IDs', async () => {
        const store = new SessionStore(new InMemoryKvStorage());
        await store.save(makeSession('one'));
        await store.save(makeSession('two'));
        await store.save(makeSession('one')); // resave shouldn't double-index
        expect(await store.list()).toEqual(['one', 'two']);
    });

    it('delete removes the entry and the index pointer', async () => {
        const store = new SessionStore(new InMemoryKvStorage());
        await store.save(makeSession('one'));
        await store.save(makeSession('two'));
        await store.delete('one');
        expect(await store.list()).toEqual(['two']);
        expect(await store.load('one')).toBe(null);
    });

    it('load returns null for unknown ids', async () => {
        const store = new SessionStore(new InMemoryKvStorage());
        expect(await store.load('missing')).toBe(null);
    });

    it('load backfills a zeroed usage tally on legacy records', async () => {
        const kv = new InMemoryKvStorage();
        // Saved before usage tracking existed — no `usage` field.
        const legacy = {
            sessionId: 'old',
            startTime: 1_000_000,
            endTime: 1_000_500,
            exchanges: [],
            tags: [],
            notes: '',
        };
        await setJson(kv, 'session:old', legacy);
        const store = new SessionStore(kv);
        const loaded = await store.load('old');
        expect(loaded?.usage).toEqual(emptyUsage());
    });

    it('honors a custom key prefix', async () => {
        const kv = new InMemoryKvStorage();
        const store = new SessionStore(kv, { prefix: 'glow:' });
        await store.save(makeSession('xyz'));
        const keys = await kv.keys();
        expect(keys).toContain('glow:xyz');
    });
});
