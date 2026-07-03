import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    buildScoredVoiceList,
    downloadPercent,
    downloadVoiceModel,
    prefixedVoiceId,
    previewErrorMessage,
} from '../ui/src/voice-picker.js';

afterEach(() => vi.unstubAllGlobals());

/** A Response whose body streams the given NDJSON lines as UTF-8 chunks. */
function ndjsonResponse(lines: string[], chunking: 'whole' | 'split' = 'whole'): Response {
    const enc = new TextEncoder();
    const payload = lines.map((l) => l + '\n').join('');
    const chunks =
        chunking === 'whole'
            ? [enc.encode(payload)]
            : // Split mid-line to exercise the buffer-reassembly path.
              [enc.encode(payload.slice(0, 7)), enc.encode(payload.slice(7))];
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
    return new Response(body, { status: 200 });
}

describe('prefixedVoiceId', () => {
    it('prefixes by engine', () => {
        expect(prefixedVoiceId('aloud', 'Leda')).toBe('aloud:Leda');
        expect(prefixedVoiceId('browser', 'Samantha')).toBe('browser:Samantha');
        expect(prefixedVoiceId('macos', 'Ava')).toBe('server:Ava'); // default
        expect(prefixedVoiceId(undefined, 'X')).toBe('server:X');
    });
});

describe('buildScoredVoiceList with hosted voices', () => {
    it('floats curated hosted voices into Recommended with a gender note', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        // No speechSynthesis in this env → browser voices empty; no Flask voices.
        const scored = buildScoredVoiceList(null, false, [
            { name: 'Pulcherrima', gender: 'androgynous' },
            { name: 'Leda', gender: 'female' },
        ]);
        expect(scored).toHaveLength(2);
        const pul = scored.find((v) => v.name === 'Pulcherrima')!;
        expect(pul.engine).toBe('aloud');
        expect(pul.recommended).toBe(true);
        expect(pul.score).toBe(3);
        expect(pul.note).toBe('androgynous');
    });

    it('keeps Chirp3-HD (premium) in Best but drops Neural2 (value) into Very Good', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        const scored = buildScoredVoiceList(null, false, [
            { name: 'Leda', gender: 'female', tier: 'premium' },
            { name: 'Vega', gender: 'female', tier: 'value' },
        ]);
        const leda = scored.find((v) => v.name === 'Leda')!;
        expect(leda.recommended).toBe(true); // Chirp3-HD → Best
        const vega = scored.find((v) => v.name === 'Vega')!;
        expect(vega.recommended).toBeFalsy(); // Neural2 → not Best…
        expect(vega.score).toBe(4); // …it lands in the Very Good tier
        expect(vega.costTier).toBe('value'); // still badged as a paid voice
    });

    it('defaults to no hosted voices (availability-driven) when none are passed', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        const scored = buildScoredVoiceList(null, false);
        expect(scored.filter((v) => v.engine === 'aloud')).toHaveLength(0);
    });

    it('carries the shared model basename through for multi-speaker voices', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        const scored = buildScoredVoiceList(
            [
                {
                    name: 'Libritts p3922 (F)',
                    lang: 'en_US',
                    engine: 'piper',
                    needs_download: true,
                    model: 'en_US-libritts-high',
                },
                {
                    name: 'Libritts p4356 (F)',
                    lang: 'en_US',
                    engine: 'piper',
                    needs_download: true,
                    model: 'en_US-libritts-high',
                },
            ],
            false
        );
        // Both speakers expose the same model, so the UI can group/lock them.
        expect(scored.map((v) => v.model)).toEqual(['en_US-libritts-high', 'en_US-libritts-high']);
    });
});

describe('downloadPercent', () => {
    it('uses per-file total while downloading the main model', () => {
        expect(downloadPercent({ completed: 30, total: 60, file: 'x.onnx' })).toBe(50);
    });
    it('pins to 100 once cumulative bytes exceed the tiny json file total', () => {
        // completed (whole onnx) > total (json content-length) → clamp to 100.
        expect(downloadPercent({ completed: 60_000_000, total: 20_000, file: 'x.onnx.json' })).toBe(
            100
        );
    });
    it('returns 0 when no size is known yet', () => {
        expect(downloadPercent({ completed: 0, total: 0, file: '' })).toBe(0);
    });
});

describe('downloadVoiceModel', () => {
    it('reports progress and resolves on done', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            ndjsonResponse([
                JSON.stringify({ status: 'downloading', total: 100, completed: 50, file: 'a.onnx' }),
                JSON.stringify({ status: 'downloading', total: 100, completed: 100, file: 'a.onnx' }),
                JSON.stringify({ status: 'done' }),
            ])
        );
        vi.stubGlobal('fetch', fetchMock);

        const progress: number[] = [];
        await downloadVoiceModel('en_US-lessac-medium', 'piper', (p) => progress.push(p.completed));

        expect(progress).toEqual([50, 100]);
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            voice: 'en_US-lessac-medium',
            engine: 'piper',
        });
    });

    it('reassembles progress lines split across stream chunks', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            ndjsonResponse(
                [
                    JSON.stringify({ status: 'downloading', total: 8, completed: 8, file: 'a' }),
                    JSON.stringify({ status: 'done' }),
                ],
                'split'
            )
        );
        vi.stubGlobal('fetch', fetchMock);
        const seen: number[] = [];
        await downloadVoiceModel('v', 'piper', (p) => seen.push(p.completed));
        expect(seen).toEqual([8]);
    });

    it('rejects on an error line', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(ndjsonResponse([JSON.stringify({ status: 'error', error: 'boom' })]));
        vi.stubGlobal('fetch', fetchMock);
        await expect(downloadVoiceModel('v', 'piper')).rejects.toThrow('boom');
    });

    it('rejects on a non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
        await expect(downloadVoiceModel('v', 'piper')).rejects.toThrow('500');
    });
});

describe('Best tier is reserved for hosted + Chrome cloud (not macOS/Piper)', () => {
    it('does not promote server-recommended macOS Premium / Piper into Best', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        const scored = buildScoredVoiceList(
            [
                { name: 'Ava (Premium)', lang: 'en-US', engine: 'macos', recommended: true },
                { name: 'Libritts p3922 (F)', lang: 'en-US', engine: 'piper', recommended: true },
            ],
            false
        );
        const ava = scored.find((v) => v.name === 'Ava (Premium)')!;
        expect(ava.score).toBe(4); // Very Good tier…
        expect(ava.recommended).toBeFalsy(); // …but NOT Best
        const piper = scored.find((v) => v.name.startsWith('Libritts'))!;
        expect(piper.score).toBe(3); // Good tier (below Very Good)
        expect(piper.recommended).toBeFalsy();
    });

    it('keeps ElevenLabs in the Quality tier (score 2) without a quality keyword', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        const scored = buildScoredVoiceList(
            [{ name: 'Rachel', lang: 'en-US', engine: 'elevenlabs' }],
            false
        );
        expect(scored.find((v) => v.name === 'Rachel')!.score).toBe(2);
    });

    it('tags Apple browser voices as macOS (display only) and floats Chrome cloud into Best', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        vi.stubGlobal('speechSynthesis', {
            getVoices: () => [
                {
                    name: 'Samantha',
                    lang: 'en-US',
                    localService: true,
                    voiceURI: 'com.apple.voice.compact.en-US.Samantha',
                },
                {
                    name: 'Google US English',
                    lang: 'en-US',
                    localService: false,
                    voiceURI: 'Google US English',
                },
            ],
        });
        const scored = buildScoredVoiceList(null, true);
        const sam = scored.find((v) => v.name === 'Samantha')!;
        expect(sam.engine).toBe('browser'); // playback still routes to speechSynthesis
        expect(sam.displayEngine).toBe('macos'); // …but the badge reads macOS
        expect(sam.recommended).toBeFalsy(); // local → not Best
        const goog = scored.find((v) => v.name === 'Google US English')!;
        expect(goog.recommended).toBe(true); // Chrome cloud → Best
        expect(goog.displayEngine).toBeUndefined();
    });
});

describe('previewErrorMessage', () => {
    it('gives a browser-voice-specific hint for a speechSynthesis failure', () => {
        // The Microsoft "Online (Natural)" case: BrowserTtsEngine rejects with
        // "speechSynthesis synthesis-failed" when a remote voice won't render.
        const msg = previewErrorMessage(new Error('speechSynthesis synthesis-failed'));
        expect(msg).toMatch(/Online/i);
        expect(msg).toMatch(/another voice|aloud cloud/i);
    });

    it('maps hosted credit/auth failures to their own lines', () => {
        expect(previewErrorMessage(new Error('TTS endpoint 402'))).toMatch(/credit/i);
        expect(previewErrorMessage(new Error('TTS endpoint 401'))).toMatch(/sign in/i);
    });

    it('falls back to a generic line for an unknown failure', () => {
        const msg = previewErrorMessage(new Error('something odd'));
        expect(msg).toMatch(/Couldn't play/i);
    });
});
