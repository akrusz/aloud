/**
 * Developer capture of the audio a sit sends for transcription (dev-mode.ts
 * isSttClipsDebug): every pass's PCM with the transcript it got back. The
 * point is a corpus of real, soft, short meditation speech to replay against
 * other STT models (meditation-pal-376v); published benchmarks cover none of it.
 * An incremental pass sends a piece of the turn, so its clip says where the
 * piece starts (`from`) and carries the turn's text through it;
 * scripts/stt-replay.ts loadCapture puts the pieces back together.
 *
 * In a browser the clips are held in memory and saved as one .tar when the
 * session ends. A webview can't download a blob (views/history.ts
 * exportSessions has the same limit), so the desktop app instead writes each
 * clip through the shell as it is transcribed, to
 * <app-data>/stt-clips/<capture>/NNNN-tNNN-<label>.wav with a .json beside it
 * (turn, label, seconds, from, text). A phone posts each clip the same way to
 * scripts/stt-clip-sink.ts on the dev's machine, over USB (`adb reverse`).
 * That works in a debug build only: android/app/src/debug/AndroidManifest.xml
 * is what allows plain http, so a release build drops its clips.
 *
 * Nothing leaves the device (or the cable), and nothing is kept unless the
 * flag is on.
 */

import { appUrl } from './app-base.js';
import { isSttClipsDebug } from './dev-mode.js';
import { isCapacitor, isTauri } from './is-desktop.js';

export const STT_CLIP_SAMPLE_RATE = 16_000;

/** The port scripts/stt-clip-sink.ts listens on and reverses to the phone. */
export const STT_CLIP_SINK_PORT = 8793;

interface Clip {
    /** The utterance this pass belongs to. A turn's audio is its LAST pass
     *  (the final when one ran, else the speculative pass the final reused),
     *  after the pieces before it when that pass was a piece. */
    turn: number;
    label: 'spec' | 'final';
    pcm16: Int16Array;
    /** Seconds of the turn's sent audio before this clip's: 0 for a pass sent
     *  from the turn's start, more for an incremental piece. Its pieces chain
     *  by `from` + `seconds`; a piece whose pass heard no words is sent again
     *  from the same `from`. */
    from: number;
    /** What the turn says through this clip: a piece's reply joined onto the
     *  text before it. */
    text: string;
}

let clips: Clip[] = [];
/** Clips recorded since load, for the file names: both paths number them. */
let seq = 0;
/** The desktop's folder for this page load, named on the first clip. */
let captureDir: string | null = null;

const clipName = (n: number, c: Clip): string =>
    `${String(n).padStart(4, '0')}-t${String(c.turn).padStart(3, '0')}-${c.label}`;

const secondsOf = (c: Clip): number => Number((c.pcm16.length / STT_CLIP_SAMPLE_RATE).toFixed(3));

/** The clip's .json / manifest entry, less the file name. */
const metaOf = (c: Clip) => ({
    turn: c.turn,
    label: c.label,
    seconds: secondsOf(c),
    from: Number(c.from.toFixed(3)),
    text: c.text,
});

/** Keep one transcription pass. A no-op unless the developer flag is on. */
export function recordSttClip(clip: Clip): void {
    if (!isSttClipsDebug() || clip.pcm16.length === 0) return;
    seq++;
    if (isTauri()) void postClip(appUrl('/stt-clips'), seq, clip);
    else if (isCapacitor()) void postClip(`http://localhost:${STT_CLIP_SINK_PORT}/stt-clips`, seq, clip);
    else clips.push(clip);
}

/** Desktop and phone: one clip to disk now, so a crash mid-sit loses nothing. */
async function postClip(base: string, n: number, clip: Clip): Promise<void> {
    captureDir ??= `aloud-stt-clips-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    const put = (kind: 'wav' | 'json', body: BodyInit): Promise<Response> =>
        fetch(`${base}/${captureDir}/${clipName(n, clip)}/${kind}`, { method: 'POST', body });
    try {
        const wav = await put('wav', wavBytes(clip.pcm16) as BodyInit);
        const meta = await put('json', JSON.stringify(metaOf(clip)));
        if (!wav.ok || !meta.ok) console.warn('STT clip save failed', wav.status, meta.status);
    } catch (err) {
        console.warn('STT clip save failed', err);
    }
}

function wavBytes(pcm16: Int16Array): Uint8Array {
    const data = pcm16.length * 2;
    const out = new Uint8Array(44 + data);
    const v = new DataView(out.buffer);
    const tag = (at: number, s: string): void => {
        for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
    };
    tag(0, 'RIFF');
    v.setUint32(4, 36 + data, true);
    tag(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, STT_CLIP_SAMPLE_RATE, true);
    v.setUint32(28, STT_CLIP_SAMPLE_RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    tag(36, 'data');
    v.setUint32(40, data, true);
    for (let i = 0; i < pcm16.length; i++) v.setInt16(44 + i * 2, pcm16[i]!, true);
    return out;
}

/** One ustar entry: header, data, zero padding to the 512-byte block. */
function tarEntry(name: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(512 + Math.ceil(body.length / 512) * 512);
    const put = (at: number, s: string): void => {
        for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
    };
    put(0, name);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, `${body.length.toString(8).padStart(11, '0')}\0`);
    put(136, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`);
    put(148, '        '); // the checksum is summed with its own field as spaces
    put(156, '0');
    put(257, 'ustar\0' + '00');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += out[i]!;
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    out.set(body, 512);
    return out;
}

/** Everything recorded so far as one tar (clips/*.wav + clips.json), and the
 *  buffer cleared. Null when there is nothing to save. */
export function takeSttClipArchive(): Blob | null {
    if (clips.length === 0) return null;
    const taken = clips;
    clips = [];
    const parts: Uint8Array[] = [];
    const manifest = taken.map((c, i) => {
        const file = `clips/${clipName(i + 1, c)}.wav`;
        parts.push(tarEntry(file, wavBytes(c.pcm16)));
        return { file, ...metaOf(c) };
    });
    const json = new TextEncoder().encode(JSON.stringify({ sampleRate: STT_CLIP_SAMPLE_RATE, clips: manifest }, null, 1));
    parts.push(tarEntry('clips.json', json), new Uint8Array(1024));
    return new Blob(parts as BlobPart[], { type: 'application/x-tar' });
}

/** Save what the sit recorded, if anything. */
export function downloadSttClips(): void {
    const blob = takeSttClipArchive();
    if (!blob) return;
    try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aloud-stt-clips-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.tar`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.warn('STT clip export failed', err);
    }
}
