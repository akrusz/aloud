/**
 * The transcript check for long setup lines (render-voice-clips.ts): the
 * desktop shell's own Whisper (src-tauri examples/whisper_batch) hears each
 * take, and a word said again (a stumble, "words, words", or the whole line
 * twice) fails it. One take in seven of the felt-sense line stumbled
 * (2026-11-16); the pause and length checks miss that.
 *
 * Optional: without a whisper_batch build and the app's base.en model the
 * check is skipped. English only.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Whisper {
    binary: string;
    model: string;
}

/** cargo build --manifest-path ts/src-tauri/Cargo.toml --example whisper_batch */
export function findWhisper(): Whisper | null {
    const examples = resolve(import.meta.dirname, '..', '..', '..', 'src-tauri', 'target');
    const binary = ['release', 'debug'].map((p) => join(examples, p, 'examples', 'whisper_batch')).find((p) => existsSync(p));
    const model = join(homedir(), 'Library', 'Application Support', 'app.aloud.meditation', 'models', 'ggml-base.en.bin');
    return binary && existsSync(model) ? { binary, model } : null;
}

/** What Whisper hears in an MP3 take, or null when it can't say. */
export function transcribe(whisper: Whisper, ffmpeg: string, mp3: Uint8Array): string | null {
    const dir = mkdtempSync(join(tmpdir(), 'aloud-clip-'));
    try {
        const wav = join(dir, 'take.wav');
        execFileSync(ffmpeg, ['-v', 'error', '-f', 'mp3', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { input: mp3 });
        const out = execFileSync(whisper.binary, ['--model', whisper.model, '--lang', 'en'], { input: `${wav}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
        const row = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { text?: unknown };
        return typeof row.text === 'string' ? row.text : null;
    } catch {
        return null;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const words = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}'’ ]+/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);

/** Words heard that the line doesn't have and that repeat a word beside
 *  them: the same word, its start ("in into") or its stem ("feeler
 *  feeling"). Other differences are Whisper's ("a loud" for "aloud") and
 *  don't count. */
export function repeatedWords(line: string, heard: string): string[] {
    const want = words(line);
    const got = words(heard);
    const d = Array.from({ length: want.length + 1 }, (_, i) =>
        Array.from({ length: got.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= want.length; i++) {
        for (let j = 1; j <= got.length; j++) {
            const same = want[i - 1] === got[j - 1] ? 0 : 1;
            d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + same);
        }
    }
    const repeats: string[] = [];
    for (let i = want.length, j = got.length; i > 0 || j > 0; ) {
        const same = i > 0 && j > 0 && want[i - 1] === got[j - 1] ? 0 : 1;
        if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + same) {
            i--;
            j--;
        } else if (j > 0 && d[i]![j] === d[i]![j - 1]! + 1) {
            const w = got[--j]!;
            const near = want.slice(Math.max(0, i - 3), i + 3);
            const repeated = near.some(
                (n) => n === w || (w.length >= 2 && n.startsWith(w)) || (w.length >= 3 && n.startsWith(w.slice(0, 3)))
            );
            if (repeated) repeats.unshift(w);
        } else i--;
    }
    return repeats;
}
