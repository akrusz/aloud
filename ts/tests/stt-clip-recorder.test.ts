import { describe, it, expect, beforeEach, vi } from 'vitest';

const flag = { on: true, desktop: false };
vi.mock('../ui/src/dev-mode.js', () => ({ isSttClipsDebug: () => flag.on }));
vi.mock('../ui/src/is-desktop.js', () => ({ isTauri: () => flag.desktop }));

import { recordSttClip, takeSttClipArchive, STT_CLIP_SAMPLE_RATE } from '../ui/src/stt-clip-recorder.js';

/** Read a ustar archive back the way `tar` does: 512-byte headers, octal sizes. */
function untar(bytes: Uint8Array): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    const str = (at: number, n: number) => new TextDecoder().decode(bytes.subarray(at, at + n)).replace(/\0.*$/, '');
    for (let at = 0; at + 512 <= bytes.length; ) {
        const name = str(at, 100);
        if (!name) break;
        const size = parseInt(str(at + 124, 12), 8);
        // The stored checksum is the header summed with its own field as spaces.
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : bytes[at + i]!;
        expect(parseInt(str(at + 148, 8), 8)).toBe(sum);
        expect(str(at + 257, 5)).toBe('ustar');
        files.set(name, bytes.subarray(at + 512, at + 512 + size));
        at += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}

describe('stt clip recorder', () => {
    beforeEach(() => {
        flag.on = true;
        flag.desktop = false;
        takeSttClipArchive();
    });

    it('archives each pass as a WAV plus a manifest, then starts empty', async () => {
        const pcm = new Int16Array(STT_CLIP_SAMPLE_RATE / 2).fill(1234);
        recordSttClip({ turn: 1, label: 'spec', pcm16: pcm, text: 'there is' });
        recordSttClip({ turn: 1, label: 'final', pcm16: new Int16Array(STT_CLIP_SAMPLE_RATE), text: 'there is a warmth' });

        const blob = takeSttClipArchive()!;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        expect(bytes.length % 512).toBe(0);
        const files = untar(bytes);
        expect([...files.keys()]).toEqual(['clips/0001-t001-spec.wav', 'clips/0002-t001-final.wav', 'clips.json']);

        const wav = files.get('clips/0001-t001-spec.wav')!;
        const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
        expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
        expect(view.getUint32(24, true)).toBe(STT_CLIP_SAMPLE_RATE);
        expect(view.getUint32(40, true)).toBe(pcm.length * 2);
        expect(view.getInt16(44, true)).toBe(1234);

        const manifest = JSON.parse(new TextDecoder().decode(files.get('clips.json')!));
        expect(manifest.clips).toEqual([
            { file: 'clips/0001-t001-spec.wav', turn: 1, label: 'spec', seconds: 0.5, text: 'there is' },
            { file: 'clips/0002-t001-final.wav', turn: 1, label: 'final', seconds: 1, text: 'there is a warmth' },
        ]);
        expect(takeSttClipArchive()).toBeNull();
    });

    it('on desktop writes each clip through the shell as it arrives, buffering nothing', async () => {
        flag.desktop = true;
        const calls: Array<{ url: string; body: unknown }> = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), body: init?.body });
            return new Response('{"status":"ok"}');
        }) as typeof fetch;
        try {
            recordSttClip({ turn: 3, label: 'final', pcm16: new Int16Array(STT_CLIP_SAMPLE_RATE), text: 'still here' });
            await vi.waitFor(() => expect(calls).toHaveLength(2));
        } finally {
            globalThis.fetch = realFetch;
        }
        // One capture folder, a plain-id file name, and the kind as its own segment.
        expect(calls[0]!.url).toMatch(/\/app\/v1\/stt-clips\/aloud-stt-clips-[\d-]+\/\d{4}-t003-final\/wav$/);
        expect(calls[1]!.url).toBe(calls[0]!.url.replace(/wav$/, 'json'));
        expect((calls[0]!.body as Uint8Array).length).toBe(44 + STT_CLIP_SAMPLE_RATE * 2);
        expect(JSON.parse(calls[1]!.body as string)).toEqual({ turn: 3, label: 'final', seconds: 1, text: 'still here' });
        expect(takeSttClipArchive()).toBeNull();
    });

    it('keeps nothing while the developer flag is off', () => {
        flag.on = false;
        recordSttClip({ turn: 1, label: 'final', pcm16: new Int16Array(100), text: 'hi' });
        expect(takeSttClipArchive()).toBeNull();
    });
});
