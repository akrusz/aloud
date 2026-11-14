import { describe, it, expect, vi } from 'vitest';

import { WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';

/**
 * The setup screen's listener rides two query params on the transcription
 * POST: `prompt` (local Whisper's initial prompt) and `setup=1` (the hosted
 * route builds its own prompt). Every pass carries them; a session sends
 * neither.
 */

type TranscribeResult = { ok: true; text: string } | { ok: false; error: unknown };
type Transcribe = (frames: Float32Array[], label: 'spec' | 'final', rate: number) => Promise<TranscribeResult>;

/** The URLs one speculative and one final pass POST to. */
async function passUrls(options: ConstructorParameters<typeof WhisperPcmSttEngine>[0]): Promise<URL[]> {
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
        urls.push(new URL(String(url), 'http://127.0.0.1'));
        return new Response(JSON.stringify({ text: 'felt sense' }), { status: 200 });
    });
    const engine = new WhisperPcmSttEngine({ ...options, fetchImpl });
    const frame = new Float32Array(16_000).map((_, i) => Math.sin(i / 10) * 0.2);
    const transcribe = (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
    for (const label of ['spec', 'final'] as const) {
        expect(await transcribe([frame], label, 16_000)).toMatchObject({ ok: true });
    }
    return urls;
}

describe('WhisperPcmSttEngine setup-listening params', () => {
    it('sends the initial prompt, encoded, on every pass', async () => {
        const prompt = 'Exploration, noting, felt sense. Vibes: playful & spacious?';
        const urls = await passUrls({ initialPrompt: prompt, language: 'en' });
        expect(urls).toHaveLength(2);
        for (const url of urls) {
            expect(url.searchParams.get('prompt')).toBe(prompt);
            expect(url.searchParams.get('lang')).toBe('en');
            expect(url.searchParams.has('setup')).toBe(false);
        }
    });

    it('sends a Chinese prompt intact', async () => {
        const prompt = '探索，标记，体会。';
        const [url] = await passUrls({ initialPrompt: prompt });
        expect(url!.searchParams.get('prompt')).toBe(prompt);
    });

    it('sends setup=1 on every pass', async () => {
        const urls = await passUrls({ setupListening: true });
        expect(urls).toHaveLength(2);
        for (const url of urls) {
            expect(url.searchParams.get('setup')).toBe('1');
            expect(url.searchParams.has('prompt')).toBe(false);
        }
    });

    it('sends neither by default', async () => {
        for (const url of await passUrls({})) {
            expect(url.searchParams.has('prompt')).toBe(false);
            expect(url.searchParams.has('setup')).toBe(false);
        }
    });

    it('treats an empty prompt as none', async () => {
        const [url] = await passUrls({ initialPrompt: '', setupListening: false });
        expect(url!.searchParams.has('prompt')).toBe(false);
        expect(url!.searchParams.has('setup')).toBe(false);
    });
});
