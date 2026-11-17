/**
 * What local Whisper hears of setup-screen requests (epic k3ng), measured on
 * synthetic speech: macOS `say` voices, three rooms (clean, quieter under room
 * noise, far microphone), each transcribed with and without the setup prompt
 * (setupVocabulary), then scored against parseSetupCommand / parseBeginRequest
 * as they are at run time. Plus a false-trigger set: noise alone and ordinary
 * prose under noise, cut the way the lobby listener cuts an utterance.
 *
 *   cd ts && npx tsx scripts/setup-voice/run.ts --audio <scratch dir>   (synthesize + transcribe what is new, then score)
 *   cd ts && npx tsx scripts/setup-voice/run.ts --summary-only          (score the saved transcripts again, nothing else)
 *   options: --full (every voice in every room), --size base (Settings model size), --model-dir <dir> (repeatable),
 *            --results <dir> (somewhere other than results/)
 *
 * Scope by default: every phrase in the clean and noisy rooms with three
 * voices per language; every third phrase also far-mic (one of those voices)
 * and in one of the other voices, clean and noisy. One Whisper process at a
 * time, on background priority (taskpolicy -b, nice 19): about 1.5 s a clip,
 * since whisper.cpp encodes a full 30 s window whatever the clip's length.
 *
 * Synthetic voices through one recognizer: good for systematic mishearings and
 * the prompt's effect, not a measure of accuracy in a real room.
 *
 * Transcription goes through the cargo example src-tauri/examples/whisper_batch.rs,
 * which mirrors the shell's /app/v1/stt/whisper parameters. Nothing here calls
 * a hosted API. Transcripts cache by a hash of what went into the audio plus
 * the model, language and prompt (results/cache.json), so a rerun only
 * synthesizes and transcribes what changed.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, setPriority, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEGATIVES, PHRASES, PROSE, type Phrase } from './phrases.js';
import type { SetupAction } from '../../src/facilitation/setup-command.js';
import type { BeginRequest } from '../../src/facilitation/begin-command.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_ROOT = resolve(HERE, '../..');
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const WHISPER_BIN = join(TS_ROOT, 'src-tauri/target/debug/examples/whisper_batch');
const SR = 16_000;
/** Bump when the audio pipeline changes; every transcript is redone. */
const AUDIO_VERSION = 1;

// Names exactly as `say -v '?'` lists them. CORE voices read every phrase;
// EXTRA ones take turns on every third.
const CORE: Record<'en' | 'zh', string[]> = {
    en: ['Samantha (English (US))', 'Daniel (English (UK))', 'Rishi (English (India))'],
    zh: ['Tingting (Chinese (China mainland))', 'Eddy (Chinese (China mainland))'],
};
const EXTRA: Record<'en' | 'zh', string[]> = {
    en: ['Ava (Premium)', 'Moira (English (Ireland))', 'Reed (English (US))', 'Karen', 'Eddy (English (UK))', 'Tessa (English (South Africa))'],
    zh: ['Meijia (Chinese (Taiwan))', 'Reed (Chinese (China mainland))'],
};

type Condition = 'clean' | 'noisy' | 'far';
const CONDITIONS: Condition[] = ['clean', 'noisy', 'far'];
/** Speech level (active, dBFS) and SNR per condition. */
const ROOM: Record<Exclude<Condition, 'clean'>, { levelDb: number; snrDb: number; brown: number }> = {
    noisy: { levelDb: -30, snrDb: 12, brown: 0.4 },
    far: { levelDb: -36, snrDb: 6, brown: 0.6 },
};
/** The far microphone: thin, echoing. */
const FAR_FILTER = 'highpass=f=120,lowpass=f=3000,aecho=0.8:0.6:29|67|121|188:0.45|0.3|0.2|0.12';
/** The listener's onset pre-buffer and end-of-turn pause, around the words. */
const LEAD_S = 0.5;
const TRAIL_S = 1.0;

// ---- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
};
const SUMMARY_ONLY = flag('--summary-only');
const FULL = flag('--full');
/** Where transcripts, the cache and the summary live; misheard.ts sits beside run.ts unless this moves. */
const RESULTS = resolve(option('--results') ?? join(HERE, 'results'));
const MISHEARD_TS = option('--results') ? join(RESULTS, 'misheard.ts') : join(HERE, 'misheard.ts');
const SIZE = option('--size') ?? 'base';
const AUDIO = resolve(option('--audio') ?? join(tmpdir(), 'aloud-setup-voice-audio'));
const MODEL_DIRS = [
    ...argv.flatMap((a, i) => (a === '--model-dir' && argv[i + 1] ? [argv[i + 1]!] : [])),
    join(homedir(), 'Library/Application Support/app.aloud.meditation/models'),
];

// ---- small utilities --------------------------------------------------------

const sha = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);

function run(cmd: string, args: string[], input?: string): Promise<string> {
    return new Promise((ok, fail) => {
        const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('error', fail);
        child.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
    });
}

/** Kept off the performance cores: a batch of these runs for an hour. */
const throttled = (cmd: string, args: string[], input?: string): Promise<string> =>
    run('taskpolicy', ['-b', 'nice', '-n', '19', cmd, ...args], input);

function readWav(path: string): Float32Array {
    const b = readFileSync(path);
    let at = 12;
    while (at + 8 <= b.length) {
        const id = b.toString('ascii', at, at + 4);
        const size = b.readUInt32LE(at + 4);
        if (id === 'data') {
            const end = Math.min(b.length, at + 8 + size);
            const out = new Float32Array((end - at - 8) >> 1);
            for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(at + 8 + i * 2) / 32768;
            return out;
        }
        at += 8 + size + (size & 1);
    }
    throw new Error(`no data chunk in ${path}`);
}

function writeWav(path: string, samples: Float32Array): void {
    const b = Buffer.alloc(44 + samples.length * 2);
    b.write('RIFF', 0, 'ascii');
    b.writeUInt32LE(36 + samples.length * 2, 4);
    b.write('WAVEfmt ', 8, 'ascii');
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(SR, 24);
    b.writeUInt32LE(SR * 2, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36, 'ascii');
    b.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]!));
        b.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, b);
}

function rng(seed: string): () => number {
    let a = parseInt(sha(seed).slice(0, 8), 16) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rms = (x: Float32Array): number => {
    let s = 0;
    for (const v of x) s += v * v;
    return Math.sqrt(s / Math.max(1, x.length));
};
const dbToAmp = (db: number): number => Math.pow(10, db / 20);

/** RMS over the 20 ms frames within 35 dB of the loudest: the speech, not its pauses. */
function activeLevel(x: Float32Array): number {
    const frame = SR / 50;
    const frames: number[] = [];
    for (let i = 0; i + frame <= x.length; i += frame) frames.push(rms(x.subarray(i, i + frame)));
    const peak = Math.max(...frames, 1e-9);
    const loud = frames.filter((f) => f >= peak * dbToAmp(-35));
    return Math.sqrt(loud.reduce((s, f) => s + f * f, 0) / Math.max(1, loud.length));
}

function normalized(x: Float32Array): Float32Array {
    const r = rms(x) || 1;
    return x.map((v) => v / r);
}

function noise(kind: 'white' | 'pink' | 'brown', n: number, seed: string): Float32Array {
    const rand = rng(seed);
    const out = new Float32Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
        const w = rand() * 2 - 1;
        if (kind === 'white') out[i] = w;
        else if (kind === 'brown') {
            last = (last + 0.02 * w) / 1.02;
            out[i] = last;
        } else {
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.969 * b2 + w * 0.153852;
            b3 = 0.8665 * b3 + w * 0.3104856;
            b4 = 0.55 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.016898;
            out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
            b6 = w * 0.115926;
        }
    }
    return normalized(out);
}

/** Pink and brown, mixed and scaled to an RMS. */
function roomNoise(n: number, brownShare: number, rmsTarget: number, seed: string): Float32Array {
    const p = noise('pink', n, `${seed}:pink`);
    const b = noise('brown', n, `${seed}:brown`);
    const mix = p.map((v, i) => v * (1 - brownShare) + b[i]! * brownShare);
    const r = rms(mix) || 1;
    return mix.map((v) => (v / r) * rmsTarget);
}

function pad(x: Float32Array): Float32Array {
    const out = new Float32Array(Math.round((LEAD_S + TRAIL_S) * SR) + x.length);
    out.set(x, Math.round(LEAD_S * SR));
    return out;
}

/** Speech at a level, under room noise at an SNR. */
function inRoom(speech: Float32Array, room: (typeof ROOM)['noisy'], seed: string): Float32Array {
    const gain = dbToAmp(room.levelDb) / (activeLevel(speech) || 1);
    const n = roomNoise(speech.length, room.brown, dbToAmp(room.levelDb - room.snrDb), seed);
    return speech.map((v, i) => v * gain + n[i]!);
}

// ---- audio ------------------------------------------------------------------

interface Clip {
    /** Hash of everything that went into the audio. */
    key: string;
    wav: string;
    set: 'command' | 'negative' | 'noise' | 'prose';
    lang: 'en' | 'zh';
    voice: string;
    condition: string;
    /** core: every phrase; sample: every third; noise: the false-trigger set. */
    tier: 'core' | 'sample' | 'noise';
    phrase?: Phrase;
    /** What the noise or prose piece is. */
    label?: string;
    /** Writes the wav if it isn't there. */
    make: () => Promise<void>;
}

/** One writer per file: the rooms of one utterance share its say rendering. */
const inflight = new Map<string, Promise<void>>();
function once(path: string, work: () => Promise<void>): Promise<void> {
    if (existsSync(path)) return Promise.resolve();
    let p = inflight.get(path);
    if (!p) {
        p = work();
        inflight.set(path, p);
    }
    return p;
}

function speak(voice: string, text: string, out: string): Promise<void> {
    return once(out, () => speakNow(voice, text, out));
}

async function speakNow(voice: string, text: string, out: string): Promise<void> {
    mkdirSync(dirname(out), { recursive: true });
    const aiff = `${out}.aiff`;
    await throttled('say', ['-v', voice, '-o', aiff, text]);
    await throttled(FFMPEG, ['-loglevel', 'error', '-y', '-i', aiff, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', out]);
    rmSync(aiff, { force: true });
}

function farFx(src: string, out: string): Promise<void> {
    return once(out, () => farFxNow(src, out));
}

async function farFxNow(src: string, out: string): Promise<void> {
    mkdirSync(dirname(out), { recursive: true });
    await throttled(FFMPEG, ['-loglevel', 'error', '-y', '-i', src, '-af', FAR_FILTER, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', out]);
}

/** The three rooms for one utterance; `speech` is the base say rendering. */
function roomClips(base: { key: string; voice: string; text: string }): Array<{ condition: Condition; key: string; wav: string; make: () => Promise<void> }> {
    const raw = join(AUDIO, 'say', `${base.key}.wav`);
    const clean = join(AUDIO, 'clean', `${base.key}.wav`);
    const fx = join(AUDIO, 'farfx', `${base.key}.wav`);
    const makeClean = (): Promise<void> =>
        once(clean, async () => {
            await speak(base.voice, base.text, raw);
            writeWav(clean, pad(readWav(raw)));
        });
    return CONDITIONS.map((condition) => {
        const key = sha(`${base.key}|${condition}`);
        const wav = join(AUDIO, condition, `${base.key}.wav`);
        const make = async (): Promise<void> => {
            if (existsSync(wav)) return;
            await makeClean();
            if (condition === 'noisy') writeWav(wav, inRoom(readWav(clean), ROOM.noisy, key));
            else if (condition === 'far') {
                await farFx(clean, fx);
                writeWav(wav, inRoom(readWav(fx), ROOM.far, key));
            }
        };
        return { condition, key, wav, make };
    });
}

/** Who reads each phrase, in which rooms (see the header for the scope). */
function readings(index: number, core: string[], extra: string[]): Array<[voice: string, condition: Condition, tier: Clip['tier']]> {
    if (FULL) return [...core, ...extra].flatMap((v) => CONDITIONS.map((c) => [v, c, 'core'] as [string, Condition, Clip['tier']]));
    const out: Array<[string, Condition, Clip['tier']]> = core.flatMap((v) => [[v, 'clean', 'core'], [v, 'noisy', 'core']] as Array<[string, Condition, Clip['tier']]>);
    if (index % 3 === 0) {
        const turn = index / 3;
        if (core.length) out.push([core[turn % core.length]!, 'far', 'sample']);
        if (extra.length) {
            const v = extra[turn % extra.length]!;
            out.push([v, 'clean', 'sample'], [v, 'noisy', 'sample']);
        }
    }
    return out;
}

function phraseClips(list: Phrase[], set: 'command' | 'negative', voices: Record<'en' | 'zh', { core: string[]; extra: string[] }>): Clip[] {
    return list.flatMap((phrase, index) => {
        const { core, extra } = voices[phrase.lang];
        return readings(index, core, extra).map(([voice, condition, tier]) => {
            const baseKey = sha(JSON.stringify({ v: AUDIO_VERSION, voice, text: phrase.text }));
            const r = roomClips({ key: baseKey, voice, text: phrase.text }).find((c) => c.condition === condition)!;
            return { key: r.key, wav: r.wav, set, lang: phrase.lang, voice, condition, tier, phrase, make: r.make };
        });
    });
}

/** Ten seconds each: what a room makes with nobody talking. */
const NOISES: Array<{ label: string; make: (n: number, seed: string) => Float32Array }> = [
    { label: 'digital silence', make: (n) => new Float32Array(n) },
    { label: 'dither -70', make: (n, s) => noise('white', n, s).map((v) => v * dbToAmp(-70)) },
    { label: 'white -50', make: (n, s) => noise('white', n, s).map((v) => v * dbToAmp(-50)) },
    { label: 'white -40', make: (n, s) => noise('white', n, s).map((v) => v * dbToAmp(-40)) },
    { label: 'pink -50', make: (n, s) => noise('pink', n, s).map((v) => v * dbToAmp(-50)) },
    { label: 'pink -40', make: (n, s) => noise('pink', n, s).map((v) => v * dbToAmp(-40)) },
    { label: 'pink -30', make: (n, s) => noise('pink', n, s).map((v) => v * dbToAmp(-30)) },
    { label: 'brown -45', make: (n, s) => noise('brown', n, s).map((v) => v * dbToAmp(-45)) },
    { label: 'brown -35', make: (n, s) => noise('brown', n, s).map((v) => v * dbToAmp(-35)) },
    { label: 'brown -25', make: (n, s) => noise('brown', n, s).map((v) => v * dbToAmp(-25)) },
    { label: 'room -45', make: (n, s) => roomNoise(n, 0.5, dbToAmp(-45), s) },
    { label: 'room -35', make: (n, s) => roomNoise(n, 0.5, dbToAmp(-35), s) },
    {
        label: 'hum 60 Hz + pink -45',
        make: (n, s) => {
            const p = noise('pink', n, s);
            return p.map((v, i) => {
                const t = i / SR;
                const hum = Math.sin(2 * Math.PI * 60 * t) + 0.5 * Math.sin(2 * Math.PI * 120 * t) + 0.3 * Math.sin(2 * Math.PI * 180 * t);
                return (v + hum * 0.8) * dbToAmp(-45);
            });
        },
    },
    {
        label: 'rustle bursts -35',
        make: (n, s) => {
            const p = noise('pink', n, s);
            const rand = rng(`${s}:env`);
            const env = new Float32Array(n);
            let level = 0;
            let target = 0;
            for (let i = 0; i < n; i++) {
                if (i % (SR / 10) === 0) target = rand() < 0.3 ? 1 : 0.05;
                level += (target - level) * 0.0015;
                env[i] = level;
            }
            return p.map((v, i) => v * env[i]! * dbToAmp(-35));
        },
    },
    {
        label: 'taps and clicks',
        make: (n, s) => {
            const rand = rng(s);
            const out = noise('pink', n, `${s}:floor`).map((v) => v * dbToAmp(-55));
            for (let i = 0; i < n; i++) {
                if (rand() < 3 / SR) {
                    const amp = dbToAmp(-20 - rand() * 15);
                    for (let j = 0; j < 400 && i + j < n; j++) out[i + j] = out[i + j]! + (rand() * 2 - 1) * amp * Math.exp(-j / 60);
                }
            }
            return out;
        },
    },
    {
        label: 'fan (lowpassed brown) -30',
        make: (n, s) => {
            const b = noise('brown', n, s);
            let y = 0;
            return normalized(b.map((v) => (y += (v - y) * 0.2))).map((v) => v * dbToAmp(-30));
        },
    },
];

function noiseClips(lang: 'en' | 'zh'): Clip[] {
    return NOISES.map((spec) => {
        const key = sha(JSON.stringify({ v: AUDIO_VERSION, noise: spec.label }));
        const wav = join(AUDIO, 'noise', `${key}.wav`);
        return {
            key,
            wav,
            set: 'noise' as const,
            lang,
            voice: '-',
            condition: 'noise',
            tier: 'noise' as const,
            label: spec.label,
            make: async () => {
                if (!existsSync(wav)) writeWav(wav, spec.make(SR * 10, key));
            },
        };
    });
}

/** Each paragraph read by two voices, one per room, cut into 3-10 s pieces. */
function proseClips(voices: Record<'en' | 'zh', { core: string[]; extra: string[] }>): Clip[] {
    const clips: Clip[] = [];
    PROSE.forEach((para, p) => {
        const pick = [...voices[para.lang].core, ...voices[para.lang].extra];
        if (pick.length === 0) return;
        const readers: Array<[string, Exclude<Condition, 'clean'>]> = [
            [pick[(p * 2) % pick.length]!, 'noisy'],
            [pick[(p * 2 + 1) % pick.length]!, 'far'],
        ];
        for (const [voice, condition] of readers) {
            const baseKey = sha(JSON.stringify({ v: AUDIO_VERSION, voice, prose: para.text }));
            const raw = join(AUDIO, 'say', `${baseKey}.wav`);
            const mixed = join(AUDIO, 'prose', `${baseKey}-${condition}.wav`);
            // Cut points depend only on the length, which is known once the
            // paragraph is spoken; the clip list is built after that.
            clips.push({
                key: `prose-pending:${baseKey}:${condition}`,
                wav: mixed,
                set: 'prose',
                lang: para.lang,
                voice,
                condition,
                tier: 'noise',
                label: `para ${p + 1}`,
                make: async () => {
                    await speak(voice, para.text, raw);
                    if (existsSync(mixed)) return;
                    let speech = readWav(raw);
                    if (condition === 'far') {
                        const fx = join(AUDIO, 'farfx', `${baseKey}.wav`);
                        await farFx(raw, fx);
                        speech = readWav(fx);
                    }
                    writeWav(mixed, inRoom(speech, { ...ROOM[condition], snrDb: condition === 'noisy' ? 10 : 6 }, baseKey));
                },
            });
        }
    });
    return clips;
}

/** Turn a mixed paragraph into its pieces (after it has been made). */
function cutProse(clip: Clip): Clip[] {
    const audio = readWav(clip.wav);
    const rand = rng(clip.key);
    const pieces: Clip[] = [];
    let at = 0;
    while (at < audio.length - SR) {
        let len = Math.round((3 + rand() * 7) * SR);
        if (audio.length - (at + len) < SR) len = audio.length - at;
        const key = sha(`${clip.key}|${at}|${len}`);
        const wav = join(AUDIO, 'prose-pieces', `${key}.wav`);
        const slice = audio.slice(at, at + len);
        const start = (at / SR).toFixed(1);
        pieces.push({
            ...clip,
            key,
            wav,
            label: `${clip.label} ${start}-${((at + len) / SR).toFixed(1)}s`,
            make: async () => {
                if (!existsSync(wav)) writeWav(wav, slice);
            },
        });
        at += len;
    }
    return pieces;
}

// ---- whisper ----------------------------------------------------------------

interface RecognizerConfig {
    lang: 'en' | 'zh';
    model: string;
    modelFile: string;
}

/** The shell's whisper_model_file: .en for English below large, multilingual otherwise. */
function whisperModelFile(size: string, lang: string): string {
    if (size === 'large') return 'ggml-large-v3.bin';
    return lang === 'en' ? `ggml-${size}.en.bin` : `ggml-${size}.bin`;
}

function findModel(file: string): string | null {
    for (const dir of MODEL_DIRS) {
        const path = join(dir, file);
        if (existsSync(path)) return path;
    }
    return null;
}

async function transcribeAll(
    config: RecognizerConfig,
    prompt: string | null,
    clips: Clip[],
    cache: Record<string, string>,
    cacheKey: (clip: Clip) => string,
    save: () => void
): Promise<void> {
    const todo = clips.filter((c) => cache[cacheKey(c)] === undefined);
    if (todo.length === 0) return;
    const chunks: Clip[][] = [];
    for (let i = 0; i < todo.length; i += 100) chunks.push(todo.slice(i, i + 100));
    let done = 0;
    // One Whisper process at a time, never in parallel.
    for (const chunk of chunks) {
        for (const c of chunk) await c.make();
        const args = ['--model', config.model, '--lang', config.lang, ...(prompt ? ['--prompt', prompt] : [])];
        const out = await throttled(WHISPER_BIN, args, chunk.map((c) => c.wav).join('\n') + '\n');
        const byFile = new Map(chunk.map((c) => [c.wav, c]));
        for (const line of out.split('\n')) {
            if (!line.trim()) continue;
            const row = JSON.parse(line) as { file: string; text?: string; error?: string };
            const clip = byFile.get(row.file);
            if (!clip) continue;
            if (row.error !== undefined) throw new Error(`${row.file}: ${row.error}`);
            cache[cacheKey(clip)] = row.text ?? '';
        }
        done += chunk.length;
        save();
        process.stderr.write(`  ${config.lang} ${config.modelFile} ${prompt ? 'prompt' : 'no prompt'}: ${done}/${todo.length}\n`);
    }
}

// ---- scoring ----------------------------------------------------------------

type ParseSetup = (s: string) => SetupAction[] | null;
type ParseBegin = (s: string) => BeginRequest | null;

interface Row {
    set: Clip['set'];
    tier: Clip['tier'];
    lang: 'en' | 'zh';
    voice: string;
    condition: string;
    prompt: boolean;
    /** The phrase meant, or the noise / prose piece. */
    text: string;
    group?: string;
    expect?: Phrase['expect'];
    begin?: BeginRequest;
    transcript: string;
}

type Outcome = 'exact' | 'wrong' | 'miss';

interface Scored extends Row {
    outcome: Outcome | 'ok' | 'false-setup' | 'false-begin';
    parsedAs: string;
    /** Begin heard where it wasn't meant. */
    falseBegin: boolean;
    /** The transcript is the phrase, give or take how it's written. */
    faithful: boolean;
}

/** Traditional characters base Whisper writes, to simplified (for diagnosis only). */
const T2S: Record<string, string> = Object.fromEntries(
    (
        '點点導导體体會会標标記记錄录緒绪開开闊阔愛爱輕轻鬆松計计時时鐘钟說说應应簡简長长問问關关聽听靜静麥麦幫帮選选項项圖图刪删' +
        '設设為为換换個个費费覺觉內内隨随擾扰無无們们請请嗎吗謝谢這这讓让調调練练習习號号歡欢視视電电幾几飯饭後后麼么談谈論论預预' +
        '單单議议對对經经現现從从給给還还進进過过種种樣样動动東东車车門门見见聲声話话語语氣气頭头書书讀读寫写學学處处帶带師师劃划' +
        '啟启夠够腦脑臉脸圍围兩两準准備备誰谁沒没閉闭麼么歲岁裡里邊边著着嗎吗難难裏里臺台檯台鬧闹顯显風风聞闻橋桥機机區区員员買买賣卖'
    )
        .match(/../gu)!
        .map((pair) => [pair[0]!, pair[1]!])
);
const toSimplified = (s: string): string => s.replace(/[^\x00-\x7f]/gu, (c) => T2S[c] ?? c);

const EN_UNITS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ZH_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function zhNumerals(s: string): string {
    return s.replace(/[零一二两三四五六七八九十]+(?=分|个?小时|个?半)/gu, (m) => {
        const at = m.indexOf('十');
        if (at < 0) return m.length === 1 ? String(ZH_DIGIT[m] ?? m) : m;
        const tens = at === 0 ? 1 : ZH_DIGIT[m[at - 1]!] ?? 0;
        const ones = at === m.length - 1 ? 0 : ZH_DIGIT[m[at + 1]!] ?? 0;
        return String(tens * 10 + ones);
    });
}

/** How a phrase reads with formatting set aside: case, punctuation, digits vs words, script. */
function normalize(text: string, lang: 'en' | 'zh'): string {
    if (lang === 'zh' || /[㐀-鿿]/u.test(text)) {
        return zhNumerals(toSimplified(text)).replace(/[^\p{L}\p{N}]+/gu, '');
    }
    const words = text
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/-/g, ' ')
        .replace(/[^a-z0-9' ]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => (w === 'okay' ? 'ok' : w === 'checkins' ? 'check ins' : w === 'checkin' ? 'check in' : w));
    const out: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i]!;
        if (w in EN_TENS) {
            const next = words[i + 1];
            if (next && next in EN_UNITS && EN_UNITS[next]! < 10) {
                out.push(String(EN_TENS[w]! + EN_UNITS[next]!));
                i++;
            } else out.push(String(EN_TENS[w]));
        } else if (w in EN_UNITS) out.push(String(EN_UNITS[w]));
        else out.push(w);
    }
    return out.join(' ');
}

const intentionText = (s: string): string =>
    normalize(s, /[㐀-鿿]/u.test(s) ? 'zh' : 'en').replace(/^(?:to be |to |just |is )+/, '');

function actionKey(a: SetupAction): string {
    if (a.kind === 'intention') return `intention:${intentionText(a.text)}`;
    return JSON.stringify(a, Object.keys(a).sort());
}

function sameActions(got: SetupAction[], want: SetupAction[]): boolean {
    if (got.length !== want.length) return false;
    const a = got.map(actionKey).sort();
    const b = want.map(actionKey).sort();
    if (a.some((k, i) => k !== b[i])) return false;
    // A clear has to come ahead of what it makes room for.
    for (const group of ['focus', 'quality'] as const) {
        const clearAt = got.findIndex((x) => x.kind === 'clear' && x.group === group);
        if (clearAt < 0) continue;
        if (got.some((x, i) => i < clearAt && x.kind === group && x.on)) return false;
    }
    return true;
}

const sameBegin = (got: BeginRequest, want: BeginRequest): boolean => got.mode === want.mode && got.minutes === want.minutes;

function describe(begin: BeginRequest | null, setup: SetupAction[] | null): string {
    if (begin) return `begin${begin.mode ? ` ${begin.mode}` : ''}${begin.minutes ? ` ${begin.minutes}m` : ''}`;
    if (!setup) return '-';
    return setup
        .map((a) => {
            switch (a.kind) {
                case 'mode': return `mode ${a.mode}`;
                case 'length': return `length ${a.minutes}`;
                case 'no-timer': return 'no-timer';
                case 'focus': return `${a.focus} ${a.on ? 'on' : 'off'}`;
                case 'quality': return `${a.quality} ${a.on ? 'on' : 'off'}`;
                case 'clear': return `clear ${a.group}`;
                case 'guidance': return `guidance ${a.to}`;
                case 'verbosity': return `verbosity ${a.to}`;
                case 'intention': return `intention "${a.text}"`;
                case 'checkins': return `checkins ${a.on ? 'on' : 'off'}`;
                default: return a.kind;
            }
        })
        .join(', ');
}

function score(row: Row, parseSetup: ParseSetup, parseBegin: ParseBegin): Scored {
    const t = row.transcript;
    const begin = t ? parseBegin(t) : null;
    const setup = t && !begin ? parseSetup(t) : null;
    const parsedAs = describe(begin, setup);
    // Spacing is spelling, not hearing: "light-hearted", "talkless", "aspacious".
    const squash = (x: string): string => normalize(x, row.lang).replace(/ /g, '');
    const faithful = row.set === 'command' || row.set === 'negative' ? squash(t) === squash(row.text) : false;
    if (row.expect === undefined || row.expect === null) {
        const outcome = begin ? 'false-begin' : setup ? 'false-setup' : 'ok';
        return { ...row, outcome, parsedAs, falseBegin: !!begin, faithful };
    }
    let outcome: Outcome;
    if (row.expect === 'begin') {
        outcome = begin ? (sameBegin(begin, row.begin ?? {}) ? 'exact' : 'wrong') : setup ? 'wrong' : 'miss';
    } else {
        outcome = begin ? 'wrong' : !setup ? 'miss' : sameActions(setup, row.expect) ? 'exact' : 'wrong';
    }
    return { ...row, outcome, parsedAs, falseBegin: !!begin && row.expect !== 'begin', faithful };
}

function expectText(p: { expect?: Phrase['expect']; begin?: BeginRequest }): string {
    if (p.expect === 'begin') return describe(p.begin ?? {}, null);
    if (!p.expect) return '-';
    return describe(null, p.expect);
}

// ---- summary ----------------------------------------------------------------

const pct = (n: number, d: number): string => (d === 0 ? '   -' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);
const pad2 = (s: string | number, n: number): string => String(s).padEnd(n);
const lpad = (s: string | number, n: number): string => String(s).padStart(n);

interface ResultsFile {
    model: string;
    lang: 'en' | 'zh';
    prompt: string;
    voices: string[];
    scope?: string;
    conditions: string[];
    generatedAt: string;
    rows: Row[];
}

async function summarize(files: ResultsFile[]): Promise<void> {
    const setupMod = (await import('../../src/facilitation/setup-command.js')) as {
        parseSetupCommand: ParseSetup;
        setupVocabulary?: (l: string) => { prompt: string | null };
    };
    const beginMod = (await import('../../src/facilitation/begin-command.js')) as { parseBeginRequest: ParseBegin };
    const parseSetup = setupMod.parseSetupCommand;
    const parseBegin = beginMod.parseBeginRequest;
    const lines: string[] = [];
    const say = (s = ''): void => void lines.push(s);

    say('SETUP-SCREEN SPEECH THROUGH LOCAL WHISPER (synthetic voices)');
    say('Synthetic macOS voices through one recognizer: good for systematic mishearings and the');
    say("prompt's effect, not a measure of accuracy in a real room with a real voice.");
    say(`Scored with the parser as of ${new Date().toISOString()}.`);
    say();
    for (const f of files) {
        say(`${f.lang}: ${f.model}; voices: ${f.voices.join(', ')}`);
        if (f.scope) say(`  scope: ${f.scope}`);
        say(`  prompt: ${JSON.stringify(f.prompt)}`);
        const now = setupMod.setupVocabulary?.(f.lang).prompt;
        if (now === null) say(`  NOTE: the app sends no prompt for ${f.lang}. The prompt-on rows are what the one above did, which is why.`);
        else if (now !== undefined && now !== f.prompt) say(`  NOTE: setupVocabulary('${f.lang}').prompt has changed since; prompt-on rows used the one above. Rerun without --summary-only.`);
    }
    say(`rooms: clean (padded ${LEAD_S}s/${TRAIL_S}s); noisy (speech ${ROOM.noisy.levelDb} dBFS, pink/brown room noise at ${ROOM.noisy.snrDb} dB SNR);`);
    say(`       far (${FAR_FILTER}; speech ${ROOM.far.levelDb} dBFS, noise at ${ROOM.far.snrDb} dB SNR)`);

    // The phrase list against the parser, no audio at all.
    const textFailures = [...PHRASES, ...NEGATIVES]
        .map((p) => ({ p, s: score({ set: p.expect === null ? 'negative' : 'command', tier: 'core', lang: p.lang, voice: '-', condition: 'text', prompt: false, text: p.text, expect: p.expect, ...(p.begin ? { begin: p.begin } : {}), transcript: p.text }, parseSetup, parseBegin) }))
        .filter(({ s }) => s.outcome !== 'exact' && s.outcome !== 'ok');
    say();
    say(`== 1. Parser on the written phrases (no audio): ${textFailures.length} of ${PHRASES.length + NEGATIVES.length} not as labelled`);
    for (const { p, s } of textFailures) {
        say(`  [${p.lang} ${p.group}] "${p.text}"  want: ${expectText(p)}  got: ${s.parsedAs}  (${s.outcome})`);
    }
    const textFailing = new Set(textFailures.map(({ p }) => `${p.lang}|${p.text}`));

    const scored = files.flatMap((f) => f.rows.map((r) => score(r, parseSetup, parseBegin)));
    const commands = scored.filter((r) => r.set === 'command');

    say();
    say('== 2. Command phrases: exact / wrong (a different change, or a begin) / missed');
    say(`  ${pad2('lang room', 14)} ${pad2('n', 6)} ${pad2('  no prompt: exact  wrong   miss', 34)}   with prompt: exact  wrong   miss`);
    const table = (rows: Scored[]): string => {
        const n = rows.length;
        const c = (o: Outcome): number => rows.filter((r) => r.outcome === o).length;
        return `${pct(c('exact'), n)} ${pct(c('wrong'), n)} ${pct(c('miss'), n)}`;
    };
    const tableRows: Array<Record<string, unknown>> = [];
    for (const lang of ['en', 'zh'] as const) {
        for (const room of [...CONDITIONS, 'all'] as const) {
            const rows = commands.filter((r) => r.lang === lang && (room === 'all' || r.condition === room));
            if (rows.length === 0) continue;
            const off = rows.filter((r) => !r.prompt);
            const on = rows.filter((r) => r.prompt);
            say(`  ${pad2(`${lang} ${room}`, 14)} ${pad2(off.length, 6)}          ${table(off)}                ${table(on)}`);
            for (const [prompt, rs] of [[false, off], [true, on]] as const) {
                tableRows.push({
                    lang, room, prompt, n: rs.length,
                    exact: rs.filter((r) => r.outcome === 'exact').length,
                    wrong: rs.filter((r) => r.outcome === 'wrong').length,
                    miss: rs.filter((r) => r.outcome === 'miss').length,
                });
            }
        }
    }
    say();
    say('  by request kind (all rooms), exact share: no prompt -> with prompt');
    for (const lang of ['en', 'zh'] as const) {
        const groups = [...new Set(commands.filter((r) => r.lang === lang).map((r) => r.group!))];
        if (groups.length === 0) continue;
        say(
            '  ' +
                lang +
                ': ' +
                groups
                    .map((g) => {
                        const rs = commands.filter((r) => r.lang === lang && r.group === g);
                        const e = (p: boolean): string => pct(rs.filter((r) => r.prompt === p && r.outcome === 'exact').length, rs.filter((r) => r.prompt === p).length).trim();
                        return `${g} ${e(false)}->${e(true)}`;
                    })
                    .join('; ')
        );
    }
    say('  by voice (all rooms), exact share: no prompt -> with prompt');
    for (const lang of ['en', 'zh'] as const) {
        const voices = [...new Set(commands.filter((r) => r.lang === lang).map((r) => r.voice))];
        if (voices.length === 0) continue;
        say(
            '  ' +
                lang +
                ': ' +
                voices
                    .map((v) => {
                        const rs = commands.filter((r) => r.lang === lang && r.voice === v);
                        const e = (p: boolean): string => pct(rs.filter((r) => r.prompt === p && r.outcome === 'exact').length, rs.filter((r) => r.prompt === p).length).trim();
                        return `${v} ${e(false)}->${e(true)} (n=${rs.length / 2})`;
                    })
                    .join('; ')
        );
    }

    // Faithful transcripts the parser still gets wrong: parser work, not hearing.
    const failures = commands.filter((r) => r.outcome !== 'exact');
    const zhScriptOnly = new Set(
        failures.filter(
            (r) => r.lang === 'zh' && r.transcript !== toSimplified(r.transcript) && score({ ...r, transcript: toSimplified(r.transcript) }, parseSetup, parseBegin).outcome === 'exact'
        )
    );
    const faithfulFails = failures.filter((r) => r.faithful && !zhScriptOnly.has(r) && !textFailing.has(`${r.lang}|${r.text}`));
    const zhRows = scored.filter((r) => r.lang === 'zh' && (r.set === 'command' || r.set === 'negative'));
    if (zhRows.length > 0) {
        say();
        say('  zh transcript artifacts (command + negative clips): no prompt -> with prompt');
        const count = (p: boolean, test: (t: string) => boolean): string => {
            const rs = zhRows.filter((r) => r.prompt === p);
            return `${rs.filter((r) => test(r.transcript)).length}/${rs.length}`;
        };
        const artifacts: Array<[string, (t: string) => boolean]> = [
            ['traditional characters', (t) => t !== toSimplified(t)],
            ['a stray fullwidth digit at the end ("...４")', (t) => /[０-９][，。,.\s]*$/u.test(t) && !/[０-９]/u.test(t.slice(0, -3))],
            ['a broken character (U+FFFD)', (t) => t.includes('\ufffd')],
        ];
        for (const [name, test] of artifacts) say(`    ${name}: ${count(false, test)} -> ${count(true, test)}`);
    }

    say();
    say('== 3. Clean-transcript failures (Whisper heard the phrase; the parser missed it)');
    say(`  3a. the written phrase itself fails: see section 1 (${textFailures.filter(({ p }) => p.expect !== null).length} command phrases).`);
    const faithfulGroups = groupBy(faithfulFails, (r) => `${r.lang}|${r.text}|${r.transcript}`);
    say(`  3b. the phrase passes as written but Whisper's spelling of it fails: ${faithfulFails.length} transcripts, ${faithfulGroups.size} distinct`);
    for (const rs of [...faithfulGroups.values()].sort((a, b) => b.length - a.length)) {
        const r = rs[0]!;
        say(`    ${lpad(rs.length, 3)}x "${r.transcript}"  (said: "${r.text}")  want: ${expectText(r)}  got: ${r.parsedAs}`);
    }
    if (zhScriptOnly.size > 0) {
        const g = groupBy([...zhScriptOnly], (r) => `${r.text}|${r.transcript}`);
        say(`  3c. zh: ${zhScriptOnly.size} of ${failures.filter((r) => r.lang === 'zh').length} zh failures are traditional characters only (they parse once converted to simplified), ${g.size} distinct:`);
        for (const rs of [...g.values()].sort((a, b) => b.length - a.length).slice(0, 25)) {
            say(`    ${lpad(rs.length, 3)}x "${rs[0]!.transcript}"  (said: "${rs[0]!.text}")`);
        }
    }

    // Mishearings: the transcript is not the phrase, and the parser didn't land it.
    const misheard = failures.filter((r) => !r.faithful && !zhScriptOnly.has(r) && /\p{L}/u.test(r.transcript));
    const empty = failures.filter((r) => !/\p{L}/u.test(r.transcript));
    const byPhrase = groupBy(misheard, (r) => `${r.lang}|${r.text}`);
    say();
    say(`== 4. Mishearings the parser misses or gets wrong: ${misheard.length} transcripts over ${byPhrase.size} phrases (plus ${empty.length} with no words at all)`);
    const mishearingList: Array<{ text: string; lang: string; expect: Phrase['expect']; begin?: BeginRequest; total: number; variants: Array<{ heard: string; count: number; parsedAs: string; outcome: string; prompt: number; rooms: string[] }> }> = [];
    for (const rs of [...byPhrase.values()].sort((a, b) => b.length - a.length)) {
        const variants = [...groupBy(rs, (r) => r.transcript.trim()).values()]
            .map((vs) => ({
                heard: vs[0]!.transcript.trim(),
                count: vs.length,
                parsedAs: vs[0]!.parsedAs,
                outcome: vs[0]!.outcome,
                prompt: vs.filter((v) => v.prompt).length,
                rooms: [...new Set(vs.map((v) => v.condition))],
            }))
            .sort((a, b) => b.count - a.count);
        const r = rs[0]!;
        mishearingList.push({ text: r.text, lang: r.lang, expect: r.expect!, ...(r.begin ? { begin: r.begin } : {}), total: rs.length, variants });
    }
    for (const m of mishearingList.slice(0, 45)) {
        const n = commands.filter((r) => r.text === m.text && r.lang === m.lang).length;
        say(`  "${m.text}" (${m.lang}) ${m.total}/${n} misheard-and-failed; want ${expectText(m)}`);
        for (const v of m.variants.slice(0, 6)) {
            say(`      ${lpad(v.count, 3)}x "${v.heard}" -> ${v.outcome === 'miss' ? 'nothing' : `WRONG: ${v.parsedAs}`}  [${v.rooms.join('/')}, ${v.prompt}/${v.count} with prompt]`);
        }
        if (m.variants.length > 6) say(`      ... ${m.variants.length - 6} more`);
    }
    if (mishearingList.length > 45) say(`  ... ${mishearingList.length - 45} more phrases in results/summary.json`);

    // False triggers.
    say();
    say('== 5. False triggers');
    const triggerSets: Array<[string, Scored[]]> = [
        ['negative phrases (room/TV talk)', scored.filter((r) => r.set === 'negative')],
        ['noise only (10 s clips)', scored.filter((r) => r.set === 'noise')],
        ['prose under noise (3-10 s pieces)', scored.filter((r) => r.set === 'prose')],
    ];
    say(`  ${pad2('set', 36)} ${pad2('lang', 5)} ${pad2('prompt', 7)} ${pad2('n', 5)} ${pad2('setup', 7)} begin`);
    const falseRows: Array<Record<string, unknown>> = [];
    for (const [name, rs] of triggerSets) {
        for (const lang of ['en', 'zh'] as const) {
            for (const prompt of [false, true]) {
                const sub = rs.filter((r) => r.lang === lang && r.prompt === prompt);
                if (sub.length === 0) continue;
                const setupN = sub.filter((r) => r.outcome === 'false-setup').length;
                const beginN = sub.filter((r) => r.outcome === 'false-begin').length;
                falseRows.push({ set: name, lang, prompt, n: sub.length, setup: setupN, begin: beginN });
                say(`  ${pad2(name, 36)} ${pad2(lang, 5)} ${pad2(prompt ? 'on' : 'off', 7)} ${pad2(sub.length, 5)} ${pad2(setupN, 7)} ${beginN}`);
            }
        }
    }
    const falseBegins = scored.filter((r) => r.falseBegin);
    say();
    say(`  Every false "begin" (${falseBegins.length}), verbatim:`);
    for (const r of falseBegins) {
        say(`    "${r.transcript}" -> ${r.parsedAs}  [${r.set}: ${r.set === 'noise' || r.set === 'prose' ? r.text : `"${r.text}"`}; ${r.voice}; ${r.condition}; prompt ${r.prompt ? 'on' : 'off'}]`);
    }
    const falseSetups = scored.filter((r) => r.outcome === 'false-setup');
    const fsGroups = groupBy(falseSetups, (r) => `${r.transcript.trim()}`);
    say();
    say(`  False setup changes (${falseSetups.length}, ${fsGroups.size} distinct transcripts):`);
    for (const rs of [...fsGroups.values()].sort((a, b) => b.length - a.length)) {
        const r = rs[0]!;
        const sources = [...new Set(rs.map((x) => (x.set === 'noise' || x.set === 'prose' ? `${x.set}: ${x.text}` : `"${x.text}"`)))].slice(0, 3).join('; ');
        say(`    ${lpad(rs.length, 3)}x "${r.transcript}" -> ${r.parsedAs}  [${rs.filter((x) => x.prompt).length}/${rs.length} with prompt; ${sources}]`);
    }

    // The prompt, in numbers.
    say();
    say('== 6. Does the prompt help? (same clip, prompt off vs on)');
    for (const [lang, subset] of [['en', 'all'], ['en', 'core'], ['zh', 'all'], ['zh', 'core']] as const) {
        const rs = commands.filter((r) => r.lang === lang && (subset === 'all' || r.tier === 'core'));
        if (rs.length === 0) continue;
        const key = (r: Scored): string => `${r.text}|${r.voice}|${r.condition}`;
        const off = new Map(rs.filter((r) => !r.prompt).map((r) => [key(r), r]));
        let gained = 0;
        let lost = 0;
        let wrongMore = 0;
        let wrongLess = 0;
        for (const r of rs.filter((x) => x.prompt)) {
            const o = off.get(key(r));
            if (!o) continue;
            if (r.outcome === 'exact' && o.outcome !== 'exact') gained++;
            if (r.outcome !== 'exact' && o.outcome === 'exact') lost++;
            if (r.outcome === 'wrong' && o.outcome !== 'wrong') wrongMore++;
            if (r.outcome !== 'wrong' && o.outcome === 'wrong') wrongLess++;
        }
        const e = (p: boolean): number => rs.filter((r) => r.prompt === p && r.outcome === 'exact').length;
        const w = (p: boolean): number => rs.filter((r) => r.prompt === p && r.outcome === 'wrong').length;
        const n = rs.filter((r) => !r.prompt).length;
        say(`  ${lang} ${subset === 'all' ? 'all clips' : 'core voices, clean+noisy'} (n=${n}): exact ${pct(e(false), n).trim()} -> ${pct(e(true), n).trim()} (${gained} clips fixed by the prompt, ${lost} broken by it); wrong ${pct(w(false), n).trim()} -> ${pct(w(true), n).trim()} (${wrongMore} newly wrong, ${wrongLess} no longer wrong)`);
        if (subset === 'core') continue;
        const fb = (p: boolean): number => scored.filter((r) => r.lang === lang && r.prompt === p && r.falseBegin).length;
        const fs = (p: boolean): number => scored.filter((r) => r.lang === lang && r.prompt === p && r.outcome === 'false-setup').length;
        say(`      false begins ${fb(false)} -> ${fb(true)}; false setup changes (negatives, noise, prose) ${fs(false)} -> ${fs(true)}`);
    }

    const text = lines.join('\n');
    console.log(text);
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(join(RESULTS, 'summary.txt'), text + '\n');
    writeFileSync(
        join(RESULTS, 'summary.json'),
        JSON.stringify(
            {
                scoredAt: new Date().toISOString(),
                note: 'Synthetic voices through one recognizer: systematic mishearings and the prompt effect, not real-room accuracy.',
                configs: files.map((f) => ({ model: f.model, lang: f.lang, prompt: f.prompt, voices: f.voices, scope: f.scope, conditions: f.conditions })),
                textFailures: textFailures.map(({ p, s }) => ({ text: p.text, lang: p.lang, group: p.group, want: expectText(p), got: s.parsedAs, outcome: s.outcome })),
                commandTable: tableRows,
                cleanTranscriptFailures: [...faithfulGroups.values()].map((rs) => ({ said: rs[0]!.text, heard: rs[0]!.transcript, count: rs.length, want: expectText(rs[0]!), got: rs[0]!.parsedAs })),
                zhTraditionalOnly: zhScriptOnly.size,
                mishearings: mishearingList,
                falseTriggers: falseRows,
                falseBegins: falseBegins.map((r) => ({ transcript: r.transcript, parsedAs: r.parsedAs, set: r.set, source: r.text, voice: r.voice, condition: r.condition, prompt: r.prompt })),
                falseSetups: [...fsGroups.values()].map((rs) => ({ transcript: rs[0]!.transcript, parsedAs: rs[0]!.parsedAs, count: rs.length, withPrompt: rs.filter((x) => x.prompt).length })),
            },
            null,
            1
        ) + '\n'
    );

    // The importable corpus: [heard, what was said, what it should do].
    const body = mishearingList
        .flatMap((m) => m.variants.map((v) => `    ${JSON.stringify([v.heard, m.text, m.expect])}, // ${v.count}x`))
        .join('\n');
    writeFileSync(
        MISHEARD_TS,
        `/**\n * Generated by run.ts (do not edit): what local Whisper wrote for a setup-screen request\n * when the parser then missed it or got it wrong, from synthetic voices.\n * [heard, intended phrase, what the intended phrase should do], most frequent first.\n */\n\n` +
            `import type { SetupAction } from '../../src/facilitation/setup-command.js';\n\n` +
            `export const MISHEARD: ReadonlyArray<readonly [heard: string, intended: string, expect: 'begin' | SetupAction[]]> = [\n${body}\n];\n`
    );
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const x of xs) {
        const k = key(x);
        const list = m.get(k);
        if (list) list.push(x);
        else m.set(k, [x]);
    }
    return m;
}

// ---- main -------------------------------------------------------------------

function installedVoices(): Promise<Set<string>> {
    return run('say', ['-v', '?']).then(
        (out) =>
            new Set(
                out
                    .split('\n')
                    .map((l) => /^(.+?)\s+[a-z]{2,3}_[A-Z0-9]{2,3}\s+#/.exec(l)?.[1]?.trim())
                    .filter((v): v is string => !!v)
            )
    );
}

function resultsPath(config: RecognizerConfig): string {
    return join(RESULTS, `whisper-${config.modelFile.replace(/^ggml-|\.bin$/g, '')}-${config.lang}.json`);
}

async function main(): Promise<void> {
    try {
        setPriority(19);
    } catch {
        // Not allowed to lower our own priority: the children are throttled anyway.
    }
    mkdirSync(RESULTS, { recursive: true });
    const configs: RecognizerConfig[] = [];
    for (const lang of ['en', 'zh'] as const) {
        const modelFile = whisperModelFile(SIZE, lang);
        const model = findModel(modelFile);
        if (model) configs.push({ lang, model, modelFile });
        else console.error(`skipping ${lang}: ${modelFile} not found in ${MODEL_DIRS.join(', ')}`);
    }

    if (SUMMARY_ONLY) {
        const files = configs.map(resultsPath).filter(existsSync).map((p) => JSON.parse(readFileSync(p, 'utf8')) as ResultsFile);
        if (files.length === 0) throw new Error(`no results for size ${SIZE} in ${RESULTS}`);
        // A saved row carries the label it was transcribed under; score it
        // against the label phrases.ts gives the phrase now.
        const labels = new Map(PHRASES.map((p) => [`${p.lang}:${p.text}`, p]));
        for (const row of files.flatMap((f) => f.rows)) {
            const now = labels.get(`${row.lang}:${row.text}`);
            if (!now) continue;
            row.expect = now.expect;
            if (now.begin) row.begin = now.begin;
            else delete row.begin;
        }
        await summarize(files);
        return;
    }

    const { setupVocabulary } = (await import('../../src/facilitation/setup-command.js')) as {
        setupVocabulary: (l: string) => { prompt: string | null; phrases: string[] };
    };
    const installed = await installedVoices();
    const voices = {
        en: { core: CORE.en.filter((v) => installed.has(v)), extra: EXTRA.en.filter((v) => installed.has(v)) },
        zh: { core: CORE.zh.filter((v) => installed.has(v)), extra: EXTRA.zh.filter((v) => installed.has(v)) },
    };
    for (const lang of ['en', 'zh'] as const) {
        const missing = [...CORE[lang], ...EXTRA[lang]].filter((v) => !installed.has(v));
        if (missing.length) console.error(`${lang}: voices not installed, skipped: ${missing.join(', ')}`);
    }
    if (voices.zh.core.length === 0) console.error('no Mandarin voice installed: zh phrases skipped');

    if (!existsSync(WHISPER_BIN)) {
        console.error('building the whisper_batch example...');
        await throttled('cargo', ['build', '-j', '2', '--example', 'whisper_batch', '--manifest-path', join(TS_ROOT, 'src-tauri/Cargo.toml')]);
    }

    const cachePath = join(RESULTS, 'cache.json');
    const cache: Record<string, string> = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, string>) : {};
    const used = new Set<string>();
    // Pruned to what this run used only at the end, so a crash mid-run keeps the rest.
    const saveCache = (prune = false): void => {
        const kept = prune ? Object.fromEntries(Object.entries(cache).filter(([k]) => used.has(k))) : cache;
        writeFileSync(cachePath, JSON.stringify(kept) + '\n');
    };

    const plans = configs
        .filter((config) => voices[config.lang].core.length > 0)
        .map((config) => {
            // Where the app sends none (zh), the prompt it would be: its phrases as one line.
            const vocabulary = setupVocabulary(config.lang);
            const prompt = vocabulary.prompt ?? `${vocabulary.phrases.join('，')}。`;
            const cacheKeyFor = (p: string | null) => (clip: Clip): string => sha(`${clip.key}|${config.modelFile}|${config.lang}|${p ?? ''}`);
            const clips: Clip[] = [
                ...phraseClips(PHRASES.filter((p) => p.lang === config.lang), 'command', voices),
                ...phraseClips(NEGATIVES.filter((p) => p.lang === config.lang), 'negative', voices),
                ...noiseClips(config.lang),
            ];
            return { config, prompt, cacheKeyFor, clips, paragraphs: proseClips(voices).filter((c) => c.lang === config.lang) };
        });

    // The prose has to be spoken before it can be cut.
    for (const plan of plans) {
        for (const c of plan.paragraphs) await c.make();
        plan.clips.push(...plan.paragraphs.flatMap(cutProse));
        for (const p of [null, plan.prompt]) for (const c of plan.clips) used.add(plan.cacheKeyFor(p)(c));
        const todo = plan.clips.filter((c) => [null, plan.prompt].some((p) => cache[plan.cacheKeyFor(p)(c)] === undefined)).length;
        console.error(`${plan.config.lang}: ${plan.clips.length} clips, ${todo} still to transcribe in at least one prompt setting`);
    }

    // Most important first: every phrase with the core voices, then the
    // false-trigger set, then the sampled rooms and voices.
    for (const tier of ['core', 'noise', 'sample'] as const) {
        for (const plan of plans) {
            for (const p of [null, plan.prompt]) {
                await transcribeAll(plan.config, p, plan.clips.filter((c) => c.tier === tier), cache, plan.cacheKeyFor(p), saveCache);
            }
        }
    }

    const files: ResultsFile[] = plans.map(({ config, prompt, cacheKeyFor, clips }) => {
        const rows: Row[] = [null, prompt].flatMap((p) =>
            clips.map((c) => ({
                set: c.set,
                tier: c.tier,
                lang: c.lang,
                voice: c.voice,
                condition: c.condition,
                prompt: p !== null,
                text: c.phrase?.text ?? c.label ?? '',
                ...(c.phrase ? { group: c.phrase.group, expect: c.phrase.expect, ...(c.phrase.begin ? { begin: c.phrase.begin } : {}) } : {}),
                transcript: cache[cacheKeyFor(p)(c)] ?? '',
            }))
        );
        const file: ResultsFile = {
            model: config.modelFile,
            lang: config.lang,
            prompt,
            voices: [...voices[config.lang].core, ...voices[config.lang].extra],
            scope: FULL ? 'full' : 'core voices clean+noisy on every phrase; every third phrase far (one core voice) and one extra voice clean+noisy',
            conditions: [...CONDITIONS],
            generatedAt: new Date().toISOString(),
            rows,
        };
        const { rows: _rows, ...meta } = file;
        writeFileSync(resultsPath(config), `${JSON.stringify(meta).slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`);
        return file;
    });
    saveCache(true);
    await summarize(files);
}

main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
});
