import { describe, expect, it, vi } from 'vitest';
import type { CompletionOptions, LLMProvider, Message } from '../src/llm/index.js';
import { OllamaProvider } from '../src/llm/index.js';
import {
    LOCAL_SETUP_CHANGES,
    LOCAL_SETUP_FORMAT,
    readSetupLocally,
    resolveLocalSetupChanges,
} from '../src/facilitation/setup-local.js';
import { createLocalSetupReader } from '../ui/src/setup-local-reader.js';

const resolve = (changes: unknown, text = 'Could you change that, please?') => resolveLocalSetupChanges(changes, text);

describe('resolveLocalSetupChanges', () => {
    it('turns the list into the same actions the parser makes', () => {
        expect(resolve(['mode:noting'])).toEqual([{ kind: 'mode', mode: 'noting' }]);
        expect(resolve(['add:spacious', 'remove:playful'])).toEqual([
            { kind: 'quality', quality: 'spacious', on: true },
            { kind: 'quality', quality: 'playful', on: false },
        ]);
        expect(resolve(['only', 'add:body'])).toEqual([
            { kind: 'clear', group: 'focus' },
            { kind: 'focus', focus: 'body_sensations', on: true },
        ]);
        expect(resolve(['checkins:off'])).toEqual([{ kind: 'checkins', on: false }]);
        expect(resolve(['clock:hide'])).toEqual([{ kind: 'clock', show: false }]);
        expect(resolve(['intention:set'])).toEqual([{ kind: 'intention-ask' }]);
        expect(resolve(['voices:open'])).toEqual([{ kind: 'voice-picker' }]);
        expect(resolve(['mic:off'])).toEqual([{ kind: 'stop-listening' }]);
    });

    it('is nothing beside a none or a begin, whatever else is listed', () => {
        expect(resolve(['none'])).toBeNull();
        expect(resolve(['begin'])).toBeNull();
        expect(resolve(['begin', 'mode:noting'])).toBeNull();
        expect(resolve([])).toBeNull();
    });

    it('trusts nothing it did not offer', () => {
        expect(resolve(['add:sleepy'])).toBeNull();
        expect(resolve(['mode:noting', 42])).toBeNull();
        expect(resolve('mode:noting')).toBeNull();
        expect(resolve(undefined)).toBeNull();
        // A list that long is a model filling in the form, not a request.
        expect(resolve(LOCAL_SETUP_CHANGES.slice(2, 9))).toBeNull();
    });

    it('takes a length only with minutes in the words', () => {
        expect(resolve(['timer:set'], "Let's do about fifteen minutes.")).toEqual([{ kind: 'length', minutes: 15 }]);
        expect(resolve(['timer:set'], 'Set a timer, would you?')).toBeNull();
        expect(resolve(['timer:none'], 'Let it run as long as it runs.')).toEqual([{ kind: 'no-timer' }]);
    });

    it('cancels what it could not tell apart', () => {
        expect(resolve(['guidance:more', 'guidance:less'])).toBeNull();
        expect(resolve(['clock:hide', 'clock:show'])).toBeNull();
        expect(resolve(['add:playful', 'remove:playful'])).toBeNull();
        expect(resolve(['mode:noting', 'mode:exploration'])).toBeNull();
    });

    it('keeps guidance and response length apart by the word that names one', () => {
        expect(resolve(['guidance:more', 'responses:longer'], 'Lead me a bit more.')).toEqual([{ kind: 'guidance', to: 'up' }]);
        expect(resolve(['guidance:less', 'responses:shorter'], 'Keep your replies brief.')).toEqual([{ kind: 'verbosity', to: 'down' }]);
    });
});

/** A provider that answers with `text` and remembers what it was asked. */
function fakeProvider(text: string | Error) {
    const calls: Array<{ messages: Message[]; options: CompletionOptions }> = [];
    const provider = {
        model: 'fake',
        async complete(messages: Message[], options: CompletionOptions = {}) {
            calls.push({ messages, options });
            if (text instanceof Error) throw text;
            return { text, finishReason: 'stop' };
        },
    } as unknown as LLMProvider;
    return { provider, calls };
}

describe('readSetupLocally', () => {
    it('asks once, with the closed list as the format, and reads the answer', async () => {
        const { provider, calls } = fakeProvider('{"changes":["add:spacious"]}');
        expect(await readSetupLocally(provider, 'Could we make it more spacious?')).toEqual([
            { kind: 'quality', quality: 'spacious', on: true },
        ]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.options.format).toBe(LOCAL_SETUP_FORMAT);
        expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'Could we make it more spacious?' }]);
    });

    it('sends neither a begin nor a lone word', async () => {
        const { provider, calls } = fakeProvider('{"changes":["mode:noting"]}');
        expect(await readSetupLocally(provider, "Let's begin a noting session")).toBeNull();
        expect(await readSetupLocally(provider, 'Nothing.')).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('has understood nothing when the model is down or writes something else', async () => {
        expect(await readSetupLocally(fakeProvider(new Error('down')).provider, 'Make it spacious please')).toBeNull();
        expect(await readSetupLocally(fakeProvider('Sure! Spacious it is.').provider, 'Make it spacious please')).toBeNull();
    });
});

describe('the Ollama provider', () => {
    it('passes a format through, at temperature zero, with the context window it always asks for', async () => {
        const bodies: Array<Record<string, any>> = [];
        const fetchImpl = (async (_url: string, init: { body: string }) => {
            bodies.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ message: { content: '{}' }, done: true }), { status: 200 });
        }) as unknown as typeof fetch;
        const provider = new OllamaProvider({ model: 'm', contextLength: 8192, fetchImpl });
        await provider.complete([{ role: 'user', content: 'x' }], { format: LOCAL_SETUP_FORMAT, maxTokens: 60 });
        await provider.complete([{ role: 'user', content: 'x' }]);
        expect(bodies[0]!['format']).toEqual(LOCAL_SETUP_FORMAT);
        expect(bodies[0]!['options']).toEqual({ num_predict: 60, num_ctx: 8192, temperature: 0 });
        expect(bodies[1]!['format']).toBeUndefined();
        expect(bodies[1]!['options']['num_ctx']).toBe(8192);
        expect(bodies[1]!['options']['temperature']).toBeUndefined();
    });
});

describe('createLocalSetupReader', () => {
    const SPACIOUS = [{ kind: 'quality', quality: 'spacious', on: true }] as const;
    function world(over: { provider?: string; usable?: boolean; takes?: number[] } = {}) {
        let clock = 0;
        const takes = [...(over.takes ?? [])];
        const made: string[] = [];
        const read = vi.fn(async () => {
            const ms = takes.shift() ?? 100;
            await new Promise((r) => setTimeout(r, ms));
            clock += ms;
            return [...SPACIOUS];
        });
        const reader = createLocalSetupReader({
            provider: () => over.provider ?? 'ollama',
            model: () => 'qwen3.5:4b',
            usable: () => over.usable ?? true,
            makeProvider: (model) => {
                made.push(model);
                return {} as LLMProvider;
            },
            read,
            waitMs: 1000,
            now: () => clock,
        });
        return { reader, read, made };
    }

    it('asks only for a session set to a usable local model', async () => {
        const cloud = world({ provider: 'aloud' });
        expect(await cloud.reader('Make it more spacious please')).toBeNull();
        const down = world({ usable: false });
        expect(await down.reader('Make it more spacious please')).toBeNull();
        expect(cloud.read).not.toHaveBeenCalled();
        expect(down.read).not.toHaveBeenCalled();
    });

    it('reads with one provider per model, and never a begin', async () => {
        const w = world();
        expect(await w.reader('Make it more spacious please')).toEqual(SPACIOUS);
        expect(await w.reader('A bit more spacious again')).toEqual(SPACIOUS);
        expect(await w.reader("Let's begin now")).toBeNull();
        expect(w.made).toEqual(['qwen3.5:4b']);
        expect(w.read).toHaveBeenCalledTimes(2);
    });

    it('stops waiting on a slow read, and sends nothing more while it runs', async () => {
        vi.useFakeTimers();
        try {
            const w = world({ takes: [5000] });
            const first = w.reader('Make it more spacious please');
            await vi.advanceTimersByTimeAsync(1000);
            expect(await first).toBeNull();
            expect(await w.reader('A bit more spacious again')).toBeNull();
            expect(w.read).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(4000);
            const after = w.reader('A bit more spacious again');
            await vi.advanceTimersByTimeAsync(100);
            expect(await after).toEqual(SPACIOUS);
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves a model alone where reads are slow, not counting the one that loaded it', async () => {
        vi.useFakeTimers();
        try {
            const w = world({ takes: [9000, 3000, 3000, 100] });
            for (let i = 0; i < 3; i++) {
                const asked = w.reader('Make it more spacious please');
                await vi.advanceTimersByTimeAsync(9000);
                expect(await asked).toBeNull();
            }
            expect(w.read).toHaveBeenCalledTimes(3);
            expect(await w.reader('Make it more spacious please')).toBeNull();
            expect(w.read).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });
});
