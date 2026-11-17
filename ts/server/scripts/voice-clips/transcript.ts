/**
 * The transcript check for English setup lines (render-voice-clips.ts): the
 * desktop shell's own Whisper (src-tauri examples/whisper_batch) hears each
 * take, and two faults fail it:
 * - a word said again (a stumble, "words, words", or the whole line twice):
 *   one take in seven of the felt-sense line, on a long line only;
 * - the line's first word missing, or more of its words: Harper's softvoice
 *   swallows an opening word on some takes ("Back to Exploration" heard as
 *   "to exploration" in 7 of 12, "Timer set" as "I'm set"), on any line of
 *   at least MIN_HEARD_WORDS.
 * Both forgive what Whisper itself gets wrong: a near spelling, a number in
 * digits, two words run together or one split.
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

/** Below this many words a line is too short for Whisper to judge. */
export const MIN_HEARD_WORDS = 3;

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Lowercase words without punctuation, number words as digits ("forty-five"
 *  and "45" both "45"), "ok" as "okay". */
export function words(s: string): string[] {
    const raw = s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}'’ ]+/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => (w === 'ok' ? 'okay' : w));
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
        const tens = TENS.indexOf(raw[i]!);
        const unit = UNITS.indexOf(raw[i]!);
        if (tens >= 2) {
            const next = UNITS.indexOf(raw[i + 1] ?? '');
            if (next >= 1 && next <= 9) {
                out.push(String(tens * 10 + next));
                i++;
            } else out.push(String(tens * 10));
        } else out.push(unit >= 0 ? String(unit) : raw[i]!);
    }
    return out;
}

function editDistance(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
        prev = row;
    }
    return prev[b.length]!;
}

/** Close enough to be Whisper's spelling of the same word ("parts" heard as
 *  "hearts"), not a different word ("that's" as "it's", "timer" as "i'm"). */
const similar = (a: string, b: string) => a === b || editDistance(a, b) / Math.max(a.length, b.length) <= 0.4;

type Step =
    | { kind: 'heard'; want: number }
    | { kind: 'missed'; want: number }
    | { kind: 'extra'; got: string; at: number };

/** The cheapest alignment of the line's words with what was heard. A word
 *  heard as itself, or as two words run together or split, costs nothing.
 *  Not a run-together pair when one of the two alone is the word: "the
 *  timer" heard as "timer" lost its "the". */
function align(want: string[], got: string[]): Step[] {
    const split = (i: number, j: number) =>
        j + 1 < got.length && !similar(want[i]!, got[j]!) && !similar(want[i]!, got[j + 1]!) && similar(want[i]!, got[j]! + got[j + 1]!);
    const joined = (i: number, j: number) =>
        i + 1 < want.length && !similar(want[i]!, got[j]!) && !similar(want[i + 1]!, got[j]!) && similar(want[i]! + want[i + 1]!, got[j]!);
    const INF = 1e9;
    const d = Array.from({ length: want.length + 1 }, () => Array<number>(got.length + 1).fill(INF));
    d[0]![0] = 0;
    for (let i = 0; i <= want.length; i++) {
        for (let j = 0; j <= got.length; j++) {
            const here = d[i]![j]!;
            if (here === INF) continue;
            const relax = (ni: number, nj: number, cost: number) => {
                if (ni <= want.length && nj <= got.length && here + cost < d[ni]![nj]!) d[ni]![nj] = here + cost;
            };
            if (i < want.length && j < got.length) relax(i + 1, j + 1, similar(want[i]!, got[j]!) ? 0 : 1);
            if (i < want.length && j < got.length && split(i, j)) relax(i + 1, j + 2, 0);
            if (i < want.length && j < got.length && joined(i, j)) relax(i + 2, j + 1, 0);
            relax(i + 1, j, 1);
            relax(i, j + 1, 1);
        }
    }
    const steps: Step[] = [];
    for (let i = want.length, j = got.length; i > 0 || j > 0; ) {
        const at = d[i]![j]!;
        if (i > 0 && j > 0 && at === d[i - 1]![j - 1]! + (similar(want[i - 1]!, got[j - 1]!) ? 0 : 1)) {
            steps.unshift({ kind: similar(want[i - 1]!, got[j - 1]!) ? 'heard' : 'missed', want: i - 1 });
            i--;
            j--;
        } else if (i > 0 && j > 1 && at === d[i - 1]![j - 2]! && split(i - 1, j - 2)) {
            steps.unshift({ kind: 'heard', want: i - 1 });
            i--;
            j -= 2;
        } else if (i > 1 && j > 0 && at === d[i - 2]![j - 1]! && joined(i - 2, j - 1)) {
            steps.unshift({ kind: 'heard', want: i - 2 }, { kind: 'heard', want: i - 1 });
            i -= 2;
            j--;
        } else if (i > 0 && at === d[i - 1]![j]! + 1) {
            steps.unshift({ kind: 'missed', want: i - 1 });
            i--;
        } else {
            steps.unshift({ kind: 'extra', got: got[j - 1]!, at: i });
            j--;
        }
    }
    return steps;
}

/** Words heard that the line doesn't have and that repeat a word beside
 *  them: the same word, its start ("in into") or its stem ("feeler
 *  feeling"). */
export function repeatedWords(line: string, heard: string): string[] {
    const want = words(line);
    return align(want, words(heard))
        .filter((s): s is Extract<Step, { kind: 'extra' }> => s.kind === 'extra')
        .filter(({ got: w, at }) =>
            want
                .slice(Math.max(0, at - 3), at + 3)
                .some((n) => n === w || (w.length >= 2 && n.startsWith(w)) || (w.length >= 3 && n.startsWith(w.slice(0, 3))))
        )
        .map((s) => s.got);
}

/** What a take lost: its first word, or two words and a tenth of the line.
 *  Empty when the line is heard whole, or is too short to judge. */
export function missingWords(line: string, heard: string): string[] {
    const want = words(line);
    if (want.length < MIN_HEARD_WORDS) return [];
    const missed = align(want, words(heard))
        .filter((s) => s.kind === 'missed')
        .map((s) => (s as { want: number }).want)
        .sort((a, b) => a - b);
    const lost = missed[0] === 0 || (missed.length >= 2 && missed.length >= want.length / 10);
    return lost ? missed.map((i) => want[i]!) : [];
}

/** The transcript check's faults for a take of `line` heard as `heard`.
 *  Repeats count on a long line only: a short one has the burst check. */
export function transcriptFaults(line: string, heard: string, long: boolean): string[] {
    const faults: string[] = [];
    const missing = missingWords(line, heard);
    if (missing.length) faults.push(`"${missing.join(' ')}" not heard in "${heard.slice(0, 60)}": probable lost word`);
    const repeated = long ? repeatedWords(line, heard) : [];
    if (repeated.length) faults.push(`heard "${repeated.join(' ')}" said again: probable repeat`);
    return faults;
}
