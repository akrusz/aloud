import { describe, it, expect } from 'vitest';

import {
    InMemoryKvStorage,
    SessionStore,
    isNonSpeechOnly,
    getJson,
    setJson,
} from '../src/platform/index.js';
import { emptyUsage, type SessionState } from '../src/facilitation/session.js';

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

    it('leaves bare hallucinated words alone', () => {
        // Whisper's classic silence hallucination — has letters, not filtered.
        expect(isNonSpeechOnly('you')).toBe(false);
        expect(isNonSpeechOnly('Thank you.')).toBe(false);
    });
});

describe('getJson', () => {
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
            notes: '',
        };
        await setJson(kv, 'session:old', legacy);
        const store = new SessionStore(kv);
        const loaded = await store.load('old');
        expect(loaded?.usage).toEqual(emptyUsage());
    });
});
