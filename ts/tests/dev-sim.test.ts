/**
 * Simulated-failure wrappers (Settings → Developer).
 *
 * The property that matters: a simulated fault must be indistinguishable from
 * the real one to everything downstream. The client flattens hosted errors to
 * "<label> endpoint <status>: <body>" strings and every handler re-parses them,
 * so these assertions pin the shapes those matchers expect - a wrapper that
 * threw a tidier error would exercise none of the real handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    simulateLlmFault,
    simulateTtsFault,
    simulateSttFault,
    simulateVoiceCatalog,
    setCloudFault,
    setSttFault,
    setNoVoices,
} from '../ui/src/dev-sim.js';
import { describeCloudError, describeSttError } from '../ui/src/stt-errors.js';
import type { LLMProvider } from '../../ts/src/llm/base.js';
import type { TtsEngine } from '../../ts/src/platform/tts.js';
import type { SttEngine, SttEvent } from '../../ts/src/platform/stt.js';

const realProvider = { model: 'test-model', complete: async () => ({ text: 'hi' }) };
const realTts: TtsEngine = {
    speak: async () => {},
    cancel: async () => {},
    listVoices: async () => [],
};
const realStt: SttEngine = {
    start: async function* (): AsyncIterable<SttEvent> {
        yield { type: 'final', text: 'real' };
    },
    stop: async () => {},
};

beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('no fault set - every wrapper is a pass-through', () => {
    it('returns the real objects untouched', async () => {
        expect(simulateLlmFault(realProvider as LLMProvider)).toBe(realProvider);
        expect(simulateTtsFault(realTts)).toBe(realTts);
        expect(simulateSttFault(realStt)).toBe(realStt);
        const voices = [{ id: 'a' }] as never;
        expect(simulateVoiceCatalog(voices)).toBe(voices);
    });

    it('leaves a null STT engine null rather than inventing one', () => {
        expect(simulateSttFault(null)).toBeNull();
    });
});

describe('cloud faults produce errors the real handlers recognize', () => {
    it('fails complete() with a message describeCloudError maps', async () => {
        setCloudFault('insufficient_credits');
        const provider = simulateLlmFault(realProvider as LLMProvider);
        await expect(provider.complete([])).rejects.toThrow(/endpoint 402/);
        try {
            await provider.complete([]);
        } catch (err) {
            expect(describeCloudError((err as Error).message)).toMatch(/credits/i);
        }
    });

    it('fails completeStream() too, since callers feature-check it', async () => {
        setCloudFault('quota_exceeded');
        const provider = simulateLlmFault(realProvider as LLMProvider);
        // A wrapper that only overrode complete() would let the streaming path
        // run clean and silently test nothing.
        await expect(async () => {
            for await (const _ of provider.completeStream!([])) {
                /* unreachable */
            }
        }).rejects.toThrow(/endpoint 429/);
    });

    it('keeps the provider model visible through the wrapper', () => {
        setCloudFault('unauthenticated');
        expect(simulateLlmFault(realProvider as LLMProvider).model).toBe('test-model');
    });

    it('fails the TTS leg with the same recognizable shape', async () => {
        setCloudFault('email_unverified');
        await expect(simulateTtsFault(realTts).speak('hello')).rejects.toThrow(/endpoint 403/);
    });
});

describe('STT faults reach describeSttError as the real codes', () => {
    async function firstEvent(engine: SttEngine): Promise<SttEvent> {
        for await (const event of engine.start()) return event;
        throw new Error('engine yielded nothing');
    }

    it('yields a bare Web Speech code, not a wrapped Error', async () => {
        setSttFault('service-not-allowed');
        const event = await firstEvent(simulateSttFault(realStt)!);
        expect(event).toEqual({ type: 'error', error: 'service-not-allowed' });
        // The real listen loop passes event.error straight to describeSttError,
        // whose service-not-allowed branch matches on strict equality.
        expect(describeSttError(event.type === 'error' ? event.error : '')).toMatch(/Dictation/);
    });

    it('yields the Whisper 503 as a structured Error, matching the backend', async () => {
        setSttFault('whisper-503');
        const event = await firstEvent(simulateSttFault(realStt)!);
        const described = describeSttError(event.type === 'error' ? event.error : '');
        expect(described).toMatch(/still loading/i);
    });

    it('completes after the error, like a real engine ending its capture', async () => {
        setSttFault('network');
        const events: SttEvent[] = [];
        for await (const event of simulateSttFault(realStt)!.start()) events.push(event);
        expect(events).toHaveLength(1);
    });
});

describe('empty voice catalog', () => {
    it('drops every voice when on', () => {
        setNoVoices(true);
        expect(simulateVoiceCatalog([{ id: 'a' }, { id: 'b' }] as never)).toEqual([]);
    });
});
