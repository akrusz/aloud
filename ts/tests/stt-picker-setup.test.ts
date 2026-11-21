import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The setup screen's listener (VadOpts.setupListening) through the real
 * picker and engine: local Whisper gets the setup vocabulary as `prompt`,
 * aloud cloud gets `setup=1` and no client prompt, and a session sends
 * neither. The local warm-up probe never carries the prompt.
 */

vi.mock('../ui/src/cloud-auth.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../ui/src/cloud-auth.js')>()),
    ensureCloudToken: vi.fn(async () => 'token'),
    clearCloudToken: vi.fn(async () => {}),
}));

import { createSttForChoice, setupHostedChoice } from '../ui/src/adapters/stt-picker.js';
import { WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';
import { setupVocabulary } from '../src/facilitation/index.js';
import type { SttEngineChoice } from '../ui/src/app-settings.js';

type Transcribe = (frames: Float32Array[], label: 'spec' | 'final', rate: number) => Promise<unknown>;

let urls: URL[] = [];

beforeEach(() => {
    urls = [];
    vi.spyOn(WhisperPcmSttEngine, 'isAvailable').mockReturnValue(true);
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
            urls.push(new URL(String(url), 'http://127.0.0.1'));
            return new Response(JSON.stringify({ text: '', ready: true }), { status: 200 });
        })
    );
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Build the engine for `choice`, run one final pass, and return every URL
 *  fetched along the way (the warm-up probe first, for local Whisper). */
async function fetched(choice: SttEngineChoice, opts: Parameters<typeof createSttForChoice>[1]): Promise<URL[]> {
    const engine = await createSttForChoice(choice, opts);
    expect(engine).toBeInstanceOf(WhisperPcmSttEngine);
    const transcribe = (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
    await transcribe([new Float32Array(16_000).fill(0.1)], 'final', 16_000);
    return urls;
}

const isTranscription = (url: URL): boolean => url.searchParams.has('sample_rate');

describe('local Whisper on the setup screen', () => {
    it('prompts with the setup vocabulary', async () => {
        const all = await fetched('whisper', { setupListening: true, language: 'en', whisperModelSize: 'base' });
        const post = all.find(isTranscription)!;
        expect(post.pathname).toBe('/app/v1/stt/whisper');
        expect(post.searchParams.get('prompt')).toBe(setupVocabulary('en').prompt);
        expect(post.searchParams.has('setup')).toBe(false);
    });

    it('sends no prompt in zh, where there is none', async () => {
        const all = await fetched('whisper', { setupListening: true, language: 'zh', whisperModelSize: 'base' });
        const post = all.find(isTranscription)!;
        expect(post.searchParams.get('lang')).toBe('zh');
        expect(post.searchParams.has('prompt')).toBe(false);
    });

    it('falls back to the English vocabulary with no language set', async () => {
        const post = (await fetched('whisper', { setupListening: true })).find(isTranscription)!;
        expect(post.searchParams.get('prompt')).toBe(setupVocabulary('en').prompt);
    });

    it('keeps the prompt off the warm-up probe', async () => {
        const all = await fetched('whisper', { setupListening: true, language: 'en', whisperModelSize: 'base' });
        const warm = all.find((u) => u.pathname.endsWith('/stt/whisper/warm'))!;
        expect(warm).toBeDefined();
        expect(warm.searchParams.has('prompt')).toBe(false);
        expect(warm.searchParams.has('setup')).toBe(false);
    });
});

describe('aloud cloud on the setup screen', () => {
    it('sends setup=1 and no client prompt', async () => {
        const post = (await fetched('aloud-gpt-transcribe', { setupListening: true, language: 'en' })).find(
            isTranscription
        )!;
        expect(post.pathname).toBe('/cloud/v1/stt');
        expect(post.searchParams.get('setup')).toBe('1');
        expect(post.searchParams.has('prompt')).toBe(false);
    });
});

describe('each hosted choice asks for its own model', () => {
    it.each([
        ['aloud-gpt-transcribe', 'gpt-transcribe'],
        ['aloud-parakeet', 'moondream/parakeet-ultra'],
        ['aloud-grok', 'x-ai/grok-stt-2.0'],
    ] as const)('%s sends model=%s', async (choice, model) => {
        const post = (await fetched(choice, { language: 'en' })).find(isTranscription)!;
        expect(post.pathname).toBe('/cloud/v1/stt');
        expect(post.searchParams.get('model')).toBe(model);
    });
});

describe('incremental passes: the hosted models that take a prompt', () => {
    async function incrementalFor(choice: SttEngineChoice, opts: Parameters<typeof createSttForChoice>[1]) {
        const engine = await createSttForChoice(choice, opts);
        expect(engine).toBeInstanceOf(WhisperPcmSttEngine);
        return (engine as unknown as { opts: { incremental: boolean } }).opts.incremental;
    }

    it.each([
        ['whisper', false],
        ['aloud-gpt-transcribe', true],
        ['aloud-parakeet', false],
        ['aloud-grok', false],
    ] as const)('%s in a session: %s', async (choice, on) => {
        expect(await incrementalFor(choice, { language: 'en' })).toBe(on);
    });

    it.each(['whisper', 'aloud-gpt-transcribe'] as const)('%s on the setup screen: off', async (choice) => {
        expect(await incrementalFor(choice, { setupListening: true, language: 'en' })).toBe(false);
    });

    it.each(['whisper', 'aloud-gpt-transcribe'] as const)(
        '%s under the soak harness switch for full passes: off',
        async (choice) => {
            vi.stubGlobal('localStorage', {
                getItem: (k: string) => (k === 'aloud:debugSttFullPasses' ? '1' : null),
            });
            expect(await incrementalFor(choice, { language: 'en' })).toBe(false);
        }
    );
});

describe('a session (no setupListening)', () => {
    it.each(['whisper', 'aloud-gpt-transcribe'] as const)('%s sends neither param', async (choice) => {
        for (const url of await fetched(choice, { language: 'en' })) {
            expect(url.searchParams.has('prompt')).toBe(false);
            expect(url.searchParams.has('setup')).toBe(false);
        }
    });
});

describe('a hosted model named on each request (VadOpts.hostedChoice)', () => {
    it('asks for the tour\'s model and then the default, from one engine and one capture', async () => {
        let touring = true;
        const engine = await createSttForChoice('aloud-parakeet', {
            setupListening: true,
            language: 'en',
            hostedChoice: (built) => setupHostedChoice(built, null, touring, 'en'),
        });
        expect(engine).toBeInstanceOf(WhisperPcmSttEngine);
        const transcribe = (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
        const frame = new Float32Array(16_000).fill(0.1);
        await transcribe([frame], 'final', 16_000);
        touring = false;
        await transcribe([frame], 'final', 16_000);
        const posts = urls.filter(isTranscription);
        expect(posts.map((u) => u.searchParams.get('model'))).toEqual(['gpt-transcribe', 'moondream/parakeet-ultra']);
        // Both as setup listening, with the server's prompt and no client one.
        for (const post of posts) {
            expect(post.searchParams.get('setup')).toBe('1');
            expect(post.searchParams.has('prompt')).toBe(false);
        }
    });

    it('sends no prior: a model that can change inside a turn makes full passes', async () => {
        // GPT in a session would go incremental; asked pass by pass, never.
        const engine = await createSttForChoice('aloud-gpt-transcribe', {
            language: 'en',
            hostedChoice: (built) => built,
        });
        expect((engine as unknown as { opts: { incremental: boolean } }).opts.incremental).toBe(false);
    });

    it('leaves local Whisper alone', async () => {
        const all = await fetched('whisper', {
            setupListening: true,
            language: 'en',
            whisperModelSize: 'base',
            hostedChoice: () => 'aloud-gpt-transcribe',
        });
        const post = all.find(isTranscription)!;
        expect(post.pathname).toBe('/app/v1/stt/whisper');
        expect(post.searchParams.has('model')).toBe(false);
    });
});
