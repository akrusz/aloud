/**
 * Replay a real sit's speech clips against hosted STT models
 * (meditation-pal-376v). No public benchmark covers soft, short meditation
 * speech or breath-only clips, so the corpus is a capture the app made itself:
 * Settings > Developer > "Save my speech clips" (ui/src/stt-clip-recorder.ts)
 * writes NNNN-tNNN-<label>.wav + .json per transcription pass on desktop, and
 * a .tar with one clips.json manifest in a browser (untar it and pass the dir).
 *
 *   npm run stt:replay -- <capture-dir>                      (gpt-transcribe: battery + finals)
 *   npm run stt:replay -- <capture-dir> --models openai,azure,groq,or:qwen/qwen3-asr-1.7b
 *   npm run stt:replay -- <any-dir> --set noise --models ... (synthetic noise only: no capture needed, nobody's voice sent)
 *   npm run stt:replay -- <capture-dir> --set battery        (the full no-speech gate: noise + the capture's wordless clips)
 *   npm run stt:replay -- <capture-dir> --set passes         (every pass: the end-of-turn table)
 *   npm run stt:replay -- <capture-dir> --set incremental    (each pass sends only its new audio: gpt-transcribe only)
 *   npm run stt:replay -- <capture-dir> --set incremental --models local   (the same on the desktop's whisper.cpp: nothing sent)
 *   npm run stt:replay -- <capture-dir> --report --show      (no calls; print where models differ)
 *
 * `--set incremental` (meditation-pal-12q9) asks whether a pass can send only
 * the audio since the pass before, prompted with the turn's text so far, and
 * be stitched (joinTranscripts) without changing what the turn says or how
 * the end-of-turn check reads it. It cuts the pieces from the capture's own
 * passes, which share an exact sample prefix, two ways: "stitched" (pass 1
 * whole, then from just before where each pass parts from the last) and
 * "seam" (the engine's cut: each piece ends in the quietest 85 ms near the
 * pass's end and the next starts there). Both score against the `openai`
 * cache of whole passes: run `--set passes` first. Every non-first pass also
 * goes again whole, once, as the noise floor (gpt-transcribe against itself).
 * Refuses to send over $0.20 in a run, or --max-usd.
 *
 * Models: `openai` and `groq` go through the server's own forwarder
 * (transcribeWhisper), so the request is the production one. `azure` is
 * MAI-Transcribe-2 on the Speech key, verbatim by default (it writes down
 * every "um" and cut-off word); `azure:clean` asks for its tidied style.
 * `or:<id>` is any model on OpenRouter's transcription API, which lists most
 * of the field behind one key.
 *
 * `local` is the desktop shell's own Whisper, run on this machine through
 * src-tauri/examples/whisper_batch.rs (built here first, -j 2) on the model the
 * app would load for English (localWhisperFile); `local:<size>` picks the
 * Settings size instead. It sends nothing anywhere, runs at background
 * priority and rests after each call as long as the call took, so its timings
 * are slower than the app's. With `--set incremental` it replays the seam arm
 * against its own whole passes, which it transcribes first.
 *
 * THE CLIPS ARE SOMEONE'S MEDITATION and a capture never leaves the device on
 * its own: every model named here receives that voice. `--set noise` is the
 * exception (generated noise, read from no file), so gate a new model on it
 * first and send speech only to what passes.
 * A model that invents a sentence on silence takes the meditator's turn with
 * it; nothing else about it matters after that.
 *
 * A capture made with incremental passes holds pieces; loadCapture puts each
 * back after the pieces before it, so every set reads a pass as the audio and
 * text the turn had at that point, as with a capture of full passes.
 *
 * Results cache per model in <capture-dir>/replay/, so a rerun re-sends
 * nothing and `--report` is free. Transcript text prints only with --show.
 *
 * Keys come from ts/server/.env or the environment: OPENAI_API_KEY,
 * GROQ_API_KEY, AZURE_SPEECH_KEY + AZURE_SPEECH_REGION, OPENROUTER_API_KEY.
 * Latency is from this machine, and OpenRouter adds a hop.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { transcriptLooksIncomplete } from '../src/facilitation/end-of-turn.js';
import { isNonSpeechOnly } from '../src/platform/stt.js';
import { joinTranscripts, priorPrompt } from '../src/platform/stt-stitch.js';
import { resolveSttConfig } from '../server/src/config.js';
import { sttBilledSeconds, sttUsdPerSecond } from '../server/src/pricing/providers.js';
import { int16ToFloat32, transcribeWhisper } from '../server/src/providers/stt.js';
import { normalizeForWer, wordErrorRate } from '../soak/browser/wer.js';
import { loadServerEnv } from '../soak/env.js';

const SAMPLE_RATE = 16_000;
const LANGUAGE = 'en';
const REQUEST_TIMEOUT_MS = 60_000;
/** Finals at or under this are the "short" slice: one-breath replies, where a
 *  model has the least context and a wrong word is the whole turn. */
const SHORT_CLIP_SECONDS = 5;

interface Clip {
    name: string;
    seconds: number;
    pcm: Int16Array;
    wav: Uint8Array;
    /** What the capture's own recognizer heard. */
    captured: string;
    turn: number;
    /** The turn's last pass, i.e. the audio the turn was submitted on. */
    last: boolean;
}

interface Outcome {
    text: string;
    ms: number;
    /** Dollars the provider reported for the call, where it reports one. */
    costUsd?: number;
    /** Audio seconds the provider says it billed, where it says. */
    billedSeconds?: number;
    error?: string;
    /** Incremental set: the prompt the piece went with, and its audio length. */
    prompt?: string;
    seconds?: number;
}

interface Heard {
    text: string;
    costUsd?: number;
    billedSeconds?: number;
    /** The engine's own time for the call, where it measures one (local:
     *  without the rest after it). */
    ms?: number;
}

interface Model {
    id: string;
    /** Env var that must be set for the model to run (none: local). */
    needs?: string;
    /** `prompt` reaches only the Whisper-compatible models and local. */
    transcribe(clip: Clip, prompt?: string): Promise<Heard>;
    /** Dollars for one request of `seconds`, used when the call reports none. */
    price(seconds: number): number;
    /** Where `price` is a list rate we could not confirm against a bill. */
    priceNote?: string;
}

const env = (name: string | undefined): string => (name ? process.env[name] ?? '' : '');

async function postJson(url: string, init: RequestInit, who: string): Promise<unknown> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${who} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
}

function whisperCompatible(id: 'openai' | 'groq', needs: string, price: Model['price'], priceNote?: string): Model {
    // resolveSttConfig on a one-key env picks that backend's production
    // defaults (URL + model), so this can't drift from what the server sends.
    const backend = () =>
        resolveSttConfig(
            id === 'openai'
                ? { OPENAI_API_KEY: env('OPENAI_API_KEY'), OPENAI_STT_API_KEY: env('OPENAI_STT_API_KEY') }
                : { GROQ_API_KEY: env('GROQ_API_KEY') }
        )!;
    return {
        id,
        needs,
        price,
        ...(priceNote ? { priceNote } : {}),
        async transcribe(clip, prompt) {
            const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
            const withTimeout: typeof fetch = (input, init) => fetch(input, { ...init, signal });
            const r = await transcribeWhisper(int16ToFloat32(clip.pcm), SAMPLE_RATE, backend(), { language: LANGUAGE, prompt }, withTimeout);
            return { text: r.text, ...(r.reportedSeconds !== undefined ? { billedSeconds: r.reportedSeconds } : {}) };
        },
    };
}

const azure = (style?: 'clean'): Model => ({
    id: style ? `azure:${style}` : 'azure',
    needs: 'AZURE_SPEECH_KEY',
    // The $0.10/audio-hr promo, through 2026-12-31. The rate after it is
    // unpublished; its sibling meters are $0.36/hr.
    price: (seconds) => (seconds * 0.1) / 3600,
    priceNote: '$0.10/hr is a promo to 2026-12-31; billing increment unstated',
    async transcribe(clip) {
        const form = new FormData();
        form.append('audio', new Blob([clip.wav as BlobPart], { type: 'audio/wav' }), 'audio.wav');
        form.append(
            'definition',
            JSON.stringify({
                locales: [LANGUAGE],
                enhancedMode: {
                    enabled: true,
                    model: 'MAI-Transcribe-2',
                    ...(style ? { modelOptions: { transcribeStyle: style } } : {}),
                },
            })
        );
        const region = env('AZURE_SPEECH_REGION') || 'eastus';
        const data = (await postJson(
            `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15`,
            { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': env('AZURE_SPEECH_KEY') }, body: form },
            'azure'
        )) as { combinedPhrases?: Array<{ text?: string }> };
        return { text: (data.combinedPhrases ?? []).map((p) => p.text ?? '').join(' ').trim() };
    },
});

function openRouter(modelId: string): Model {
    return {
        id: `or:${modelId}`,
        needs: 'OPENROUTER_API_KEY',
        // OpenRouter reports each call's cost; a call that doesn't is unpriced
        // here on purpose (its list prices mix per-second and per-hour units).
        price: () => NaN,
        async transcribe(clip) {
            const data = (await postJson(
                'https://openrouter.ai/api/v1/audio/transcriptions',
                {
                    method: 'POST',
                    headers: { authorization: `Bearer ${env('OPENROUTER_API_KEY')}`, 'content-type': 'application/json' },
                    body: JSON.stringify({
                        model: modelId,
                        input_audio: { data: Buffer.from(clip.wav).toString('base64'), format: 'wav' },
                        language: LANGUAGE,
                    }),
                },
                modelId
            )) as { text?: string; usage?: { cost?: unknown; seconds?: unknown } };
            const cost = data.usage?.cost;
            const secs = data.usage?.seconds;
            return {
                text: (data.text ?? '').trim(),
                ...(typeof cost === 'number' ? { costUsd: cost } : {}),
                ...(typeof secs === 'number' ? { billedSeconds: secs } : {}),
            };
        },
    };
}

// --- local whisper ----------------------------------------------------------

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WHISPER_BIN = join(TS_ROOT, 'src-tauri/target/debug/examples/whisper_batch');
/** The desktop shell's data dir: models/, and `whisper-model`, the file name
 *  of the model it last loaded (server.rs LAST_WHISPER_MODEL_FILE). */
const APP_DATA_DIR = join(homedir(), 'Library/Application Support/app.aloud.meditation');
/** After each local call, rest this many times as long as it ran. */
const LOCAL_REST_RATIO = 1;
const LOCAL_SIZES = ['tiny', 'base', 'small', 'medium', 'large'];
const throttle = ['-b', 'nice', '-n', '10'];

/** server.rs whisper_model_file, for English. */
const whisperModelFile = (size: string): string => (size === 'large' ? 'ggml-large-v3.bin' : `ggml-${size}.en.bin`);

/** The model the app transcribes English on: the Settings size of the model
 *  the shell last loaded (whichever language that was for), else the default
 *  size (app-settings.ts sttWhisperModel). */
function localWhisperFile(): string {
    let saved = '';
    try {
        saved = readFileSync(join(APP_DATA_DIR, 'whisper-model'), 'utf8').trim();
    } catch {
        // The shell has never switched models: it loads the default.
    }
    const size = /^ggml-(tiny|base|small|medium)(?:\.en)?\.bin$/.exec(saved)?.[1] ?? (saved === 'ggml-large-v3.bin' ? 'large' : 'base');
    return whisperModelFile(size);
}

const localClosers: Array<() => void> = [];
let localScratch: string | undefined;

/** Where a clip waits for whisper_batch to read it, deleted after the call
 *  and the directory at exit: it is someone's meditation. */
function localScratchDir(): string {
    if (!localScratch) {
        const made = mkdtempSync(join(tmpdir(), 'stt-replay-'));
        localScratch = made;
        process.on('exit', () => rmSync(made, { recursive: true, force: true }));
        process.once('SIGINT', () => process.exit(130));
    }
    return localScratch;
}

/** whisper_batch, one process per model for the run (the model loads once),
 *  each clip with its own prompt. */
function localWhisper(size?: string): Model {
    const file = size ? whisperModelFile(size) : localWhisperFile();
    const path = join(APP_DATA_DIR, 'models', file);
    let proc: ChildProcessWithoutNullStreams | undefined;
    let replies: AsyncIterator<string> | undefined;
    let stderr = '';
    let rest = 0;
    let n = 0;
    const start = async (): Promise<void> => {
        if (!existsSync(path)) throw new Error(`${path} is missing: picking that size in the app's Settings downloads it.`);
        // Every run, so the binary is the example as it stands (a no-op when it is).
        await new Promise<void>((ok, fail) => {
            const args = ['cargo', 'build', '-j', '2', '--example', 'whisper_batch', '--manifest-path', join(TS_ROOT, 'src-tauri/Cargo.toml')];
            const cargo = spawn('taskpolicy', [...throttle, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
            cargo.on('error', fail);
            cargo.on('close', (code) => (code === 0 ? ok() : fail(new Error(`cargo build exited ${code}`))));
        });
        const p = spawn('taskpolicy', [...throttle, WHISPER_BIN, '--model', path, '--lang', LANGUAGE]);
        p.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
        replies = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
        localClosers.push(() => p.stdin.end());
        proc = p;
    };
    return {
        id: `local:${file.replace(/^ggml-|\.bin$/g, '')}`,
        price: () => 0,
        priceNote: `${file}, on this machine`,
        async transcribe(clip, prompt) {
            if (!proc) await start();
            await new Promise((r) => setTimeout(r, rest));
            const wav = join(localScratchDir(), `${n++}.wav`);
            writeFileSync(wav, clip.wav);
            try {
                proc!.stdin.write(`${JSON.stringify({ file: wav, prompt: prompt ?? null })}\n`);
                const reply = await replies!.next();
                if (reply.done) throw new Error(`whisper_batch exited: ${stderr.trim().slice(-300)}`);
                const row = JSON.parse(reply.value) as { text?: string; ms?: number; error?: string };
                if (row.error !== undefined) throw new Error(row.error);
                rest = (row.ms ?? 0) * LOCAL_REST_RATIO;
                return { text: row.text ?? '', ...(row.ms !== undefined ? { ms: row.ms } : {}) };
            } finally {
                rmSync(wav, { force: true });
            }
        },
    };
}

function modelFor(id: string): Model {
    if (id === 'local' || id.startsWith('local:')) {
        const size = id.slice(6).replace(/\.en$/, '');
        if (size && !LOCAL_SIZES.includes(size)) throw new Error(`Unknown Whisper size "${size}". Use ${LOCAL_SIZES.join(', ')}.`);
        return localWhisper(size || undefined);
    }
    if (id === 'openai') {
        return whisperCompatible('openai', 'OPENAI_API_KEY', (s) => sttBilledSeconds(s, 'gpt-transcribe') * sttUsdPerSecond('gpt-transcribe'));
    }
    if (id === 'groq') {
        // $0.04/audio-hr list, and every request bills at least 10 seconds.
        return whisperCompatible('groq', 'GROQ_API_KEY', (s) => (Math.max(s, 10) * 0.04) / 3600, '10 s minimum per request');
    }
    if (id === 'azure') return azure();
    if (id === 'azure:clean') return azure('clean');
    if (id.startsWith('or:') && id.length > 3) return openRouter(id.slice(3));
    throw new Error(`Unknown model "${id}". Use openai, groq, azure, azure:clean, or:<openrouter-model-id>, or local[:<size>].`);
}

// --- corpus ---------------------------------------------------------------

function wavOf(pcm: Int16Array): Uint8Array {
    const out = new Uint8Array(44 + pcm.length * 2);
    const v = new DataView(out.buffer);
    const tag = (at: number, s: string): void => {
        for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
    };
    tag(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    tag(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, SAMPLE_RATE, true);
    v.setUint32(28, SAMPLE_RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    tag(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
    return out;
}

interface ClipMeta {
    /** Path of the .wav under the capture dir, without the extension. */
    name: string;
    turn: number;
    seconds: number;
    /** Seconds of the turn's audio before this clip's: above 0 for an
     *  incremental piece, absent from captures made before them. */
    from?: number;
    text: string;
}

function captureIndex(dir: string): ClipMeta[] {
    type Entry = { file?: string; turn: number; seconds: number; from?: number; text: string };
    const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'));
    // A browser capture: one manifest for clips/*.wav.
    if (readdirSync(dir).includes('clips.json')) {
        const manifest = read('clips.json') as { clips: Entry[] };
        return manifest.clips.map((c) => ({ ...c, name: c.file!.replace(/\.wav$/, '') }));
    }
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({ ...(read(f) as Entry), name: f.slice(0, -5) }));
}

/** Slack when chaining pieces by `from` + `seconds`: the recorder rounds each
 *  to the millisecond. Pieces are far longer, so no two ends are this close. */
const PIECE_JOIN_SLACK_SECONDS = 0.003;

/**
 * Every clip as the audio its turn had been transcribed on at that pass, and
 * the text the turn had then. An incremental piece (`from` > 0) is put after
 * the chain before it: the latest earlier piece of the turn that ends where it
 * starts, which skips a piece whose pass heard no words (it was sent again
 * from the same place). Its recorded text is already the joined text.
 */
function loadCapture(dir: string): Clip[] {
    const built: Array<{ clip: Clip; from: number; seconds: number }> = [];
    let orphans = 0;
    for (const meta of captureIndex(dir)) {
        const name = meta.name;
        const wav = new Uint8Array(readFileSync(join(dir, `${name}.wav`)));
        const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
        if (v.getUint32(24, true) !== SAMPLE_RATE || v.getUint16(22, true) !== 1) {
            throw new Error(`${name}.wav is not ${SAMPLE_RATE} Hz mono (the recorder's format)`);
        }
        const piece = new Int16Array((wav.byteLength - 44) >> 1);
        for (let i = 0; i < piece.length; i++) piece[i] = v.getInt16(44 + i * 2, true);
        const from = meta.from ?? 0;
        let clip: Clip = { name, seconds: meta.seconds, pcm: piece, wav, captured: meta.text, turn: meta.turn, last: false };
        if (from > 0) {
            const before = [...built]
                .reverse()
                .find((b) => b.clip.turn === meta.turn && Math.abs(b.from + b.seconds - from) < PIECE_JOIN_SLACK_SECONDS);
            if (!before) {
                orphans++;
                continue;
            }
            const pcm = new Int16Array(before.clip.pcm.length + piece.length);
            pcm.set(before.clip.pcm);
            pcm.set(piece, before.clip.pcm.length);
            clip = { ...clip, pcm, wav: wavOf(pcm), seconds: before.clip.seconds + meta.seconds };
        }
        built.push({ clip, from, seconds: meta.seconds });
    }
    if (orphans) console.log(`${orphans} pieces left out: the piece before each is missing from the capture.`);
    const clips = built.map((b) => b.clip);
    if (clips.length === 0) throw new Error(`No clips in ${dir} (expected NNNN-tNNN-<label>.wav + .json pairs)`);
    const lastOfTurn = new Map<number, Clip>();
    for (const c of clips) lastOfTurn.set(c.turn, c);
    for (const c of lastOfTurn.values()) c.last = true;
    return clips;
}

/** Deterministic noise, so two runs send the same battery. */
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function noiseClip(kind: 'silence' | 'white' | 'pink' | 'brown', dbfs: number, seconds = 3): Clip {
    const n = seconds * SAMPLE_RATE;
    const x = new Float64Array(n);
    if (kind !== 'silence') {
        const rand = mulberry32(kind.length * 1000 + Math.abs(dbfs));
        const white = (): number => rand() + rand() + rand() - 1.5;
        let b0 = 0, b1 = 0, b2 = 0, brown = 0;
        for (let i = 0; i < n; i++) {
            const w = white();
            if (kind === 'white') x[i] = w;
            else if (kind === 'pink') {
                // Paul Kellet's economy filter: -3 dB/octave within ~0.5 dB.
                b0 = 0.99765 * b0 + w * 0.099046;
                b1 = 0.963 * b1 + w * 0.2965164;
                b2 = 0.57 * b2 + w * 1.0526913;
                x[i] = b0 + b1 + b2 + w * 0.1848;
            } else {
                brown = 0.995 * brown + w * 0.05;
                x[i] = brown;
            }
        }
        let sum = 0;
        for (let i = 0; i < n; i++) sum += x[i]! * x[i]!;
        const gain = 10 ** (dbfs / 20) / Math.sqrt(sum / n);
        for (let i = 0; i < n; i++) x[i] = x[i]! * gain;
    }
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767)));
    const name = kind === 'silence' ? 'synthetic silence' : `synthetic ${kind} ${dbfs} dBFS`;
    return { name, seconds, pcm, wav: wavOf(pcm), captured: '', turn: -1, last: false };
}

/** Clips with no words in them: digital silence, noise at room-tone and at
 *  soft-speech level, and whatever the capture itself recorded without words
 *  (a VAD trip on a breath or a sniff - the real thing the noise stands in for). */
function batteryOf(capture: Clip[]): Clip[] {
    const synthetic = [
        noiseClip('silence', 0),
        ...(['white', 'pink', 'brown'] as const).flatMap((k) => [noiseClip(k, -60), noiseClip(k, -40)]),
    ];
    const real = capture
        .filter((c) => isNonSpeechOnly(c.captured))
        .map((c) => ({ ...c, name: `capture ${c.name}` }));
    return [...synthetic, ...real];
}

// --- run ------------------------------------------------------------------

type Cache = Record<string, Outcome>;

const cachePath = (dir: string, modelId: string): string =>
    join(dir, 'replay', `${modelId.replace(/[^a-z0-9.-]+/gi, '_')}.json`);

function readCache(dir: string, modelId: string): Cache {
    try {
        return JSON.parse(readFileSync(cachePath(dir, modelId), 'utf8')) as Cache;
    } catch {
        return {};
    }
}

interface Job {
    key: string;
    clip: Clip;
}

const usable = (o: Outcome | undefined): Outcome | undefined => (o && !o.error ? o : undefined);

async function transcribeTimed(model: Model, clip: Clip, prompt?: string): Promise<Outcome> {
    let t0 = performance.now();
    try {
        // A free tier's requests-per-minute cap (Groq: 20) is not a failure.
        for (let attempt = 0; ; attempt++) {
            t0 = performance.now();
            try {
                const heard = await model.transcribe(clip, prompt);
                return { ...heard, ms: heard.ms ?? Math.round(performance.now() - t0) };
            } catch (err) {
                if (attempt >= 3 || !/ 429[: ]/.test(String(err))) throw err;
                await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
            }
        }
    } catch (err) {
        return { text: '', ms: Math.round(performance.now() - t0), error: String(err).slice(0, 300) };
    }
}

async function run(dir: string, model: Model, jobs: Job[]): Promise<void> {
    const cache = readCache(dir, model.id);
    const todo = jobs.filter((j) => !usable(cache[j.key]));
    if (todo.length === 0) return;
    if (model.needs && !env(model.needs)) {
        console.log(`${model.id}: skipped, ${model.needs} is not set`);
        return;
    }
    mkdirSync(join(dir, 'replay'), { recursive: true });
    let failed = 0;
    for (const [i, job] of todo.entries()) {
        cache[job.key] = await transcribeTimed(model, job.clip);
        if (cache[job.key]!.error) {
            failed++;
            if (failed === 1) console.log(`${model.id}: ${cache[job.key]!.error}`);
            // A model that fails its first three calls is misconfigured, not flaky.
            if (failed === 3 && i === 2) {
                console.log(`${model.id}: giving up after three straight failures`);
                break;
            }
        }
        if ((i + 1) % 10 === 0 || i === todo.length - 1) writeFileSync(cachePath(dir, model.id), JSON.stringify(cache, null, 1));
    }
    writeFileSync(cachePath(dir, model.id), JSON.stringify(cache, null, 1));
    console.log(`${model.id}: ${todo.length - failed} transcribed${failed ? `, ${failed} failed` : ''}`);
}

// --- report ---------------------------------------------------------------

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs: number[], q: number): number => {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const pad = (s: string, n: number): string => s.padEnd(n);

function table(rows: string[][]): void {
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
    for (const r of rows) console.log('  ' + r.map((c, i) => pad(c, widths[i]!)).join('  ').trimEnd());
}

function report(
    dir: string,
    models: Model[],
    capture: Clip[],
    battery: Job[],
    refId: string,
    show: boolean
): void {
    const caches = new Map(models.map((m) => [m.id, readCache(dir, m.id)]));
    const got = (id: string, key: string): Outcome | undefined => {
        const o = caches.get(id)?.[key];
        return o && !o.error ? o : undefined;
    };
    const spoken = capture.filter((c) => !isNonSpeechOnly(c.captured));
    const finals = spoken.filter((c) => c.last);

    console.log(`\nNo-speech battery: replies that would take the meditator's turn (${battery.length} calls)`);
    // Apart on purpose: text on synthetic noise is an invention, text on a
    // captured breath may be a faint "mm" the capture's recognizer missed.
    const batteryRows = [['model', 'on noise', 'on captured non-speech', 'what it said']];
    for (const m of models) {
        const outs = battery
            .map((j) => ({ real: j.clip.turn >= 0, out: got(m.id, j.key) }))
            .filter((o): o is { real: boolean; out: Outcome } => !!o.out);
        if (outs.length === 0) continue;
        const invented = outs.filter((o) => !isNonSpeechOnly(o.out.text));
        const share = (real: boolean): string =>
            `${invented.filter((o) => o.real === real).length}/${outs.filter((o) => o.real === real).length}`;
        const tally = new Map<string, number>();
        for (const o of invented) tally.set(o.out.text, (tally.get(o.out.text) ?? 0) + 1);
        const said = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `"${t.slice(0, 40)}"${n > 1 ? ` x${n}` : ''}`);
        batteryRows.push([m.id, share(false), share(true), said.join(', ')]);
    }
    table(batteryRows);

    if (capture.length === 0) return;
    const ref = (c: Clip): string | undefined => (refId === 'capture' ? c.captured : got(refId, c.name)?.text);
    const scored = finals.filter((c) => ref(c) !== undefined);
    const totalSeconds = scored.reduce((s, c) => s + c.seconds, 0);
    console.log(
        `\nSpoken turns: ${scored.length} finals, ${totalSeconds.toFixed(0)} s, ` +
            `${scored.filter((c) => c.seconds <= SHORT_CLIP_SECONDS).length} of them <= ${SHORT_CLIP_SECONDS} s. WER is against ${refId}.`
    );
    const rows = [['model', 'n', 'WER', `WER <=${SHORT_CLIP_SECONDS}s`, 'same words', 'empty', 'p50 ms', 'p90 ms', '$/audio-hr', '']];
    const columns: Array<{ id: string; text: (c: Clip) => string | undefined; out: (c: Clip) => Outcome | undefined; model?: Model }> = [
        ...models.map((m) => ({ id: m.id, text: (c: Clip) => got(m.id, c.name)?.text, out: (c: Clip) => got(m.id, c.name), model: m })),
        { id: 'capture', text: (c: Clip) => c.captured, out: () => undefined },
    ];
    for (const col of columns) {
        const have = scored.filter((c) => col.text(c) !== undefined);
        if (have.length === 0) continue;
        // Pooled, not averaged per clip: one wrong word in a two-word turn
        // would otherwise weigh as much as fifty in a long one.
        const wer = (cs: Clip[]): string => {
            const words = cs.reduce((n, c) => n + normalizeForWer(ref(c)!).length, 0);
            const errs = cs.reduce((n, c) => n + wordErrorRate(ref(c)!, col.text(c)!) * normalizeForWer(ref(c)!).length, 0);
            return words ? pct(errs / words) : '-';
        };
        const same = have.filter((c) => normalizeForWer(ref(c)!).join(' ') === normalizeForWer(col.text(c)!).join(' ')).length;
        const empty = have.filter((c) => isNonSpeechOnly(col.text(c)!)).length;
        const ms = have.map((c) => col.out(c)?.ms).filter((x): x is number => x !== undefined);
        const secs = have.reduce((s, c) => s + c.seconds, 0);
        const usd = have.reduce((s, c) => s + (col.out(c)?.costUsd ?? col.model?.price(c.seconds) ?? NaN), 0);
        rows.push([
            col.id,
            String(have.length),
            col.id === refId ? 'ref' : wer(have),
            col.id === refId ? 'ref' : wer(have.filter((c) => c.seconds <= SHORT_CLIP_SECONDS)),
            `${same}/${have.length}`,
            String(empty),
            ms.length ? String(Math.round(quantile(ms, 0.5))) : '-',
            ms.length ? String(Math.round(quantile(ms, 0.9))) : '-',
            Number.isFinite(usd) && secs ? `$${((usd / secs) * 3600).toFixed(3)}` : '-',
            col.model?.priceNote ?? '',
        ]);
    }
    table(rows);

    // Every non-final pass is a pause the speaker then talked through; every
    // final is where they stopped. Scores the detector on each model's own
    // punctuation, which is what it actually reads.
    const eot = [['model', 'pauses held', 'endings held (each +4 s before the reply)']];
    for (const col of columns) {
        if (spoken.some((c) => col.text(c) === undefined)) continue;
        const flagged = (cs: Clip[]): string => `${cs.filter((c) => transcriptLooksIncomplete(col.text(c)!)).length}/${cs.length}`;
        eot.push([col.id, flagged(spoken.filter((c) => !c.last)), flagged(spoken.filter((c) => c.last))]);
    }
    if (eot.length > 1) {
        console.log('\nEnd-of-turn check on each model\'s own text (models with every pass replayed)');
        table(eot);
    }

    if (!show) {
        console.log('\n(--show prints the turns where the models differ. It prints the meditator\'s words.)');
        return;
    }
    console.log('\nTurns where a model departs from the reference:');
    for (const c of scored) {
        const others = columns.filter((col) => col.id !== refId && col.text(c) !== undefined);
        if (!others.some((col) => wordErrorRate(ref(c)!, col.text(c)!) > 0)) continue;
        console.log(`\n  ${c.name} (${c.seconds.toFixed(1)} s)`);
        console.log(`    ${pad(refId, 28)} ${ref(c)}`);
        for (const col of others) {
            const w = wordErrorRate(ref(c)!, col.text(c)!);
            if (w > 0) console.log(`    ${pad(col.id, 28)} ${col.text(c)}  [${pct(w)}]`);
        }
    }
}

// --- incremental (meditation-pal-12q9) -------------------------------------

const INCREMENTAL_ID = 'openai-incremental';
const SEAM_ID = 'openai-seam';
const RERUN_ID = 'openai-rerun';
/** The long slice: turns whose submitted audio runs past this. */
const LONG_TURN_SECONDS = 28;
/** The stitched arm's increment starts this far before the point where two
 *  passes' audio parts, back inside the quiet they share. */
const INCREMENT_BACKUP_SAMPLES = 0.2 * SAMPLE_RATE;
/** The seam arm cuts at the quietest 85 ms window of the shared prefix's last
 *  half second, and never leaves a piece under half a second. */
const SEAM_WINDOW = 1365;
const SEAM_SPAN = 0.5 * SAMPLE_RATE;
/** Text this dense for its audio is an echo or an invention, not speech. */
const DENSE_CHARS_PER_SECOND = 25;
/** Upper edges (s) of the piece-length buckets the word errors are split by. */
const PIECE_BUCKETS = [5, 10];

/** A request an arm sends at a pass. */
interface Sent {
    key: string;
    pass: Clip;
    seconds: number;
    prompt?: string;
    outcome?: Outcome | undefined;
    /** Speech replies only: the turn's text before, what the reply added,
     *  and the two joined. */
    before?: string;
    added?: string;
    joined?: string;
}

interface Piece {
    text: string;
    seconds: number;
}

/** A spoken pass as an arm leaves it. */
interface ArmPass {
    clip: Clip;
    /** What the end-of-turn check reads after this pass; undefined once a
     *  missing reply breaks the turn's chain. */
    text: string | undefined;
    pieces: Piece[];
}

interface Arm {
    id: string;
    turns: ArmPass[][];
    sent: Sent[];
    /** Over every spoken pass, ceil per request. */
    billed: number;
    notes: string[];
}

type Send = (sent: Sent, pcm: Int16Array) => Promise<void>;

const secondsOf = (pcm: Int16Array): number => pcm.length / SAMPLE_RATE;
const total = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((n, x) => n + f(x), 0);
const sameWords = (a: string, b: string): boolean => normalizeForWer(a).join(' ') === normalizeForWer(b).join(' ');
const billedSeconds = (seconds: number): number => sttBilledSeconds(seconds, 'gpt-transcribe');
const samePrompt = (o: Outcome, prompt: string | undefined): boolean => (o.prompt ?? '') === (prompt ?? '');
const sentenceEnds = (t: string): number => (t.match(/[.!?](?=\s|$)/gu) ?? []).length;
const endsTerminated = (t: string): boolean => /[.!?]["')\]]*$/u.test(t.trim());
const lastOf = <T>(xs: T[]): T => xs[xs.length - 1]!;

function byTurn(clips: Clip[]): Clip[][] {
    const turns = new Map<number, Clip[]>();
    for (const c of clips) turns.set(c.turn, [...(turns.get(c.turn) ?? []), c]);
    return [...turns.values()];
}

function sharedPrefix(a: Int16Array, b: Int16Array): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
}

/** Leading words of `reply` that repeat the end of `before`, 3 or more, else
 *  0. A prompt echo, or the speaker saying it twice: --show tells them apart. */
function echoWords(before: string, reply: string): number {
    const key = (t: string): string[] => normalizeForWer(t);
    const a = key(before);
    const b = key(reply);
    for (let k = Math.min(a.length, b.length); k >= 3; k--) {
        if (b.slice(0, k).every((w, i) => w === a[a.length - k + i])) return k;
    }
    return 0;
}

/** Looks the reply up, sending it when the cache lacks it or holds one made
 *  with another prompt (the chain upstream changed). */
async function settle(s: Sent, pcm: Int16Array, cache: Cache, send?: Send): Promise<void> {
    const have = usable(cache[s.key]);
    if (send && (!have || !samePrompt(have, s.prompt))) await send(s, pcm);
    s.outcome = usable(cache[s.key]);
}

/** The turn's text with the reply joined on (unchanged for a wordless reply). */
function fold(s: Sent, text: string, pieces: Piece[]): string {
    if (isNonSpeechOnly(s.outcome!.text)) return text;
    const joined = joinTranscripts(text, s.outcome!.text);
    s.before = text;
    s.added = s.outcome!.text.trim();
    s.joined = joined;
    pieces.push({ text: s.added, seconds: s.seconds });
    return joined;
}

interface Step {
    clip: Clip;
    first: boolean;
    /** Not a clean extension of the pass before: its full-pass text stands. */
    fallback: boolean;
    increment?: Int16Array;
}

/** The stitched arm: pass 1 whole (the cached full pass), then each pass's
 *  audio from just before where it parts from the pass before. */
function planIncremental(spoken: Clip[]): Step[][] {
    return byTurn(spoken).map((clips) =>
        clips.map((clip, k): Step => {
            if (k === 0) return { clip, first: true, fallback: false };
            const prev = clips[k - 1]!.pcm;
            const shared = sharedPrefix(prev, clip.pcm);
            const fallback = shared < SAMPLE_RATE || shared < prev.length / 2;
            return {
                clip,
                first: false,
                fallback,
                ...(fallback ? {} : { increment: clip.pcm.subarray(Math.max(0, shared - INCREMENT_BACKUP_SAMPLES)) }),
            };
        })
    );
}

async function stitchedArm(plan: Step[][], full: Cache, cache: Cache, send?: Send): Promise<Arm> {
    const sent: Sent[] = [];
    const turns: ArmPass[][] = [];
    for (const steps of plan) {
        let text: string | undefined;
        let pieces: Piece[] = [];
        const passes: ArmPass[] = [];
        for (const step of steps) {
            if (step.first || step.fallback) {
                text = full[step.clip.name]!.text.trim();
                pieces = [{ text, seconds: step.clip.seconds }];
            } else if (text !== undefined) {
                const s: Sent = { key: step.clip.name, pass: step.clip, seconds: secondsOf(step.increment!), prompt: priorPrompt(text) };
                sent.push(s);
                await settle(s, step.increment!, cache, send);
                text = s.outcome ? fold(s, text, pieces) : undefined;
            }
            passes.push({ clip: step.clip, text, pieces: [...pieces] });
        }
        turns.push(passes);
    }
    const steps = plan.flat();
    const fallbacks = steps.filter((s) => s.fallback);
    return {
        id: 'stitched',
        turns,
        sent,
        billed: total(steps, (s) => billedSeconds(s.increment ? secondsOf(s.increment) : s.clip.seconds)),
        notes: [
            `pass 1 whole, then ${sent.length} increments; ${fallbacks.length} non-prefix fallbacks` +
                (fallbacks.length ? ` (${fallbacks.map((s) => s.clip.name).join(', ')})` : ''),
        ],
    };
}

/** Where a pass's piece ends: the start of the quietest SEAM_WINDOW in the
 *  last SEAM_SPAN of the audio it shares with the next pass, at window steps
 *  back from where they part, and more than SEAM_SPAN past `cursor`. */
function seamAt(pass: Int16Array, next: Int16Array, cursor: number): number | undefined {
    const shared = sharedPrefix(pass, next);
    let best: number | undefined;
    let bestEnergy = Infinity;
    for (let start = shared - SEAM_WINDOW; start >= shared - SEAM_SPAN && start > cursor + SEAM_SPAN; start -= SEAM_WINDOW) {
        let energy = 0;
        for (let i = start; i < start + SEAM_WINDOW; i++) energy += next[i]! * next[i]!;
        if (energy < bestEnergy) {
            bestEnergy = energy;
            best = start;
        }
    }
    return best;
}

/** The seam arm, the engine's own cut: each piece runs from the last seam to
 *  this pass's, so no audio goes twice, except after a wordless reply, which
 *  commits nothing (the next piece starts from the same seam). A turn's
 *  wordless passes are in the chain, as the engine would send them. */
async function seamArm(capture: Clip[], full: Cache, cache: Cache, send?: Send): Promise<Arm> {
    const sent: Sent[] = [];
    const turns: ArmPass[][] = [];
    let billed = 0;
    let unseamed = 0;
    let resent = 0;
    let wordless = 0;
    for (const clips of byTurn(capture)) {
        const spoken = clips.filter((c) => !isNonSpeechOnly(c.captured));
        if (spoken.length === 0) continue;
        if (clips.length === 1) {
            const clip = clips[0]!;
            const text = full[clip.name]!.text.trim();
            turns.push([{ clip, text, pieces: [{ text, seconds: clip.seconds }] }]);
            billed += billedSeconds(clip.seconds);
            continue;
        }
        let cursor = 0;
        let text: string | undefined = '';
        const pieces: Piece[] = [];
        const passes: ArmPass[] = [];
        for (const [k, clip] of clips.entries()) {
            const next = clips[k + 1];
            const source = next ? next.pcm : clip.pcm;
            const end = next ? seamAt(clip.pcm, next.pcm, cursor) : source.length;
            if (end === undefined) unseamed++;
            else if (text !== undefined) {
                const pcm = source.subarray(cursor, end);
                const s: Sent = { key: `${clip.name}@${cursor}-${end}`, pass: clip, seconds: secondsOf(pcm), ...(text ? { prompt: priorPrompt(text) } : {}) };
                sent.push(s);
                billed += billedSeconds(s.seconds);
                await settle(s, pcm, cache, send);
                if (!s.outcome) text = undefined;
                else {
                    text = fold(s, text, pieces);
                    if (!isNonSpeechOnly(s.outcome.text)) cursor = end;
                    else if (next) {
                        resent += s.seconds;
                        wordless++;
                    }
                }
            }
            if (!isNonSpeechOnly(clip.captured)) passes.push({ clip, text, pieces: [...pieces] });
        }
        turns.push(passes);
    }
    return {
        id: 'seam',
        turns,
        sent,
        billed,
        notes: [
            `${sent.length} pieces, ${unseamed} passes with no seam, ` +
                `${resent.toFixed(1)} s re-sent after ${wordless} wordless pieces`,
        ],
    };
}

/** Word-level edits from `ref` to `hyp`, each with its index in `hyp`. */
function wordEdits(ref: string, hyp: string): Array<{ op: string; at: number }> {
    const a = normalizeForWer(ref);
    const b = normalizeForWer(hyp);
    const d = a.map(() => new Array<number>(b.length + 1).fill(0));
    d.push(new Array<number>(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) d[i]![0] = i;
    for (let j = 0; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    const edits: Array<{ op: string; at: number }> = [];
    let i = a.length;
    let j = b.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)) {
            if (a[i - 1] !== b[j - 1]) edits.push({ op: `${a[i - 1]}>${b[j - 1]}`, at: j - 1 });
            i--;
            j--;
        } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
            // A deletion sits between hyp words; it counts against the one before.
            edits.push({ op: `-${a[i - 1]}`, at: Math.max(0, j - 1) });
            i--;
        } else {
            edits.push({ op: `+${b[j - 1]}`, at: j - 1 });
            j--;
        }
    }
    return edits.reverse();
}

/** Index of the hyp word each piece starts at. */
const pieceStarts = (pieces: Piece[]): number[] => {
    const starts: number[] = [];
    let n = 0;
    for (const p of pieces) {
        starts.push(n);
        n += normalizeForWer(p.text).length;
    }
    return starts;
};

interface Column {
    id: string;
    text: (c: Clip) => string | undefined;
    arm?: Arm;
    pass?: (c: Clip) => ArmPass | undefined;
}

/** `local`: the reference is that model's own whole passes, run beside the
 *  pieces, and nothing is billed. */
function reportIncremental(spoken: Clip[], arms: Arm[], full: Cache, rerun: Cache, show: boolean, local?: string): void {
    const turns = byTurn(spoken);
    const multi = turns.filter((t) => t.length > 1);
    const lasts = multi.map(lastOf);
    const endings = turns.map(lastOf);
    const pauses = turns.flatMap((t) => t.slice(0, -1));
    const later = turns.flatMap((t) => t.slice(1, -1));
    const fullText = (c: Clip): string => full[c.name]!.text;
    const armCols: Column[] = arms.map((arm) => {
        const by = new Map(arm.turns.flat().map((p) => [p.clip.name, p]));
        return { id: arm.id, arm, pass: (c: Clip) => by.get(c.name), text: (c: Clip) => by.get(c.name)?.text };
    });
    const rerunCol: Column = { id: 'rerun', text: (c) => usable(rerun[c.name])?.text };
    const cols = [...armCols, rerunCol];

    console.log(
        `\nIncremental passes: ${turns.length} spoken turns, ${multi.length} multi-pass, ${spoken.length} passes ` +
            `(${pauses.length} pauses, ${endings.length} endings). Reference: ${local ? `${local}'s own whole passes` : 'the openai cache, every pass sent whole'}.`
    );
    for (const arm of arms) {
        const broken = arm.turns.filter((t) => t.some((p) => p.text === undefined)).length;
        const stale = arm.sent.filter((s) => s.outcome && !samePrompt(s.outcome, s.prompt)).length;
        console.log(
            `  ${arm.id}: ${arm.notes.join('; ')}` +
                (broken ? `; ${broken} turns lack a reply and are left out` : '') +
                (stale ? `; ${stale} cached replies went with another prompt than this chain builds` : '')
        );
    }
    console.log(`  rerun: ${[...later, ...lasts].filter((c) => rerunCol.text(c) !== undefined).length} non-first passes sent whole again`);

    const isLong = (c: Clip): boolean => c.seconds > LONG_TURN_SECONDS;
    const long = lasts.filter(isLong);
    const short = lasts.filter((c) => !isLong(c));
    // Pooled, as in the main report.
    const scored = (cs: Clip[], col: Column): [string, string] => {
        const have = cs.filter((c) => col.text(c) !== undefined);
        const words = total(have, (c) => normalizeForWer(fullText(c)).length);
        const errs = total(have, (c) => wordErrorRate(fullText(c), col.text(c)!) * normalizeForWer(fullText(c)).length);
        return [words ? pct(errs / words) : '-', `${have.filter((c) => sameWords(fullText(c), col.text(c)!)).length}/${have.length}`];
    };
    console.log(`\nFinals of the ${lasts.length} multi-pass turns against the full-pass text (pooled WER, same words)`);
    const finals = [['arm', 'WER', 'same', `WER >${LONG_TURN_SECONDS}s (n=${long.length})`, 'same', `WER <=${LONG_TURN_SECONDS}s (n=${short.length})`, 'same']];
    for (const col of cols) finals.push([col.id === 'rerun' ? 'rerun whole (noise floor)' : col.id, ...scored(lasts, col), ...scored(long, col), ...scored(short, col)]);
    table(finals);

    const held = (t: string): boolean => transcriptLooksIncomplete(t);
    const eotRow = (label: string, cs: Clip[], col: Column): string[] => {
        const have = cs.filter((c) => col.text(c) !== undefined);
        const n = (f: (c: Clip) => boolean): string => String(have.filter(f).length);
        return [
            label,
            col.id,
            String(have.length),
            n((c) => held(fullText(c))),
            n((c) => held(col.text(c)!)),
            n((c) => held(fullText(c)) && !held(col.text(c)!)),
            n((c) => !held(fullText(c)) && held(col.text(c)!)),
        ];
    };
    const eot = [['passes', 'arm', 'n', 'held: full', 'held: arm', 'full only', 'arm only']];
    const sets: Array<[string, Clip[], Column[]]> = [
        ['pauses (should hold)', pauses, armCols],
        ['  not a first pass', later, cols],
        ['endings (should not)', endings, armCols],
        ['  of multi-pass turns', lasts, cols],
    ];
    for (const [label, cs, which] of sets) which.forEach((col, i) => eot.push(eotRow(i === 0 ? label : '', cs, col)));
    console.log('\nEnd-of-turn check on the text each arm has at the pass (seam: through the seam, before the pass\'s end)');
    table(eot);

    const terminated = (cs: Clip[], col: Column): string => {
        const have = cs.filter((c) => col.text(c) !== undefined);
        return have.length ? `${have.filter((c) => endsTerminated(col.text(c)!)).length}/${have.length}` : '-';
    };
    const fullCol: Column = { id: 'full', text: fullText };
    // Joins where joinTranscripts dropped a clip's period before a capital
    // (the clip closed on a word no sentence ends on), read in the turn's
    // full-pass final at the same two words: there the second in lowercase
    // with no sentence end between (same), or not (a real sentence end, or a
    // capital such as a name), or the two words not side by side (unaligned).
    const finalOf = new Map(lasts.map((c) => [c.turn, c]));
    const bare = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}'’]/gu, '');
    const reopened = (arm: Arm): string[] => {
        const n = { same: 0, closed: 0, unaligned: 0 };
        for (const s of arm.sent) {
            const last = finalOf.get(s.pass.turn);
            // The joined text no longer ends with the reply: its capital went.
            if (!s.before || !s.added || !s.joined || s.joined.endsWith(s.added) || !last) continue;
            const [a, b] = [bare(s.before.split(/\s+/).pop()!), bare(s.added.split(/\s+/)[0]!)];
            const ref = fullText(last).split(/\s+/).filter(Boolean);
            const spots = ref.slice(1).flatMap((w, i) => (bare(ref[i]!) === a && bare(w) === b ? [[ref[i]!, w]] : []));
            if (!spots.length) n.unaligned++;
            else if (spots.some(([x, y]) => !endsTerminated(x!) && !/^\p{Lu}/u.test(y!))) n.same++;
            else n.closed++;
        }
        return [String(n.same + n.closed + n.unaligned), String(n.same), String(n.closed), String(n.unaligned)];
    };
    console.log('\nPunctuation shape');
    const shape = [[
        'text', 'byte-identical finals', 'sentence ends in finals', 'pauses ending .!?', 'later pauses ending .!?',
        'joins reopened', 'full: same', 'full: closed', 'unaligned',
    ]];
    for (const col of [fullCol, ...cols]) {
        const have = lasts.filter((c) => col.text(c) !== undefined);
        shape.push([
            col.id,
            col === fullCol ? 'ref' : `${have.filter((c) => col.text(c)!.trim() === fullText(c).trim()).length}/${have.length}`,
            `${total(have, (c) => sentenceEnds(col.text(c)!))} in ${have.length}`,
            col === rerunCol ? '-' : terminated(pauses, col),
            terminated(later, col),
            ...(col.arm ? reopened(col.arm) : ['-', '-', '-', '-']),
        ]);
    }
    table(shape);

    const buckets = [...PIECE_BUCKETS.map((s, i) => (i === 0 ? `<${s}s` : `${PIECE_BUCKETS[i - 1]}-${s}s`)), `>${lastOf(PIECE_BUCKETS)}s`];
    const bucketOf = (seconds: number): number => {
        const i = PIECE_BUCKETS.findIndex((s) => seconds < s);
        return i < 0 ? PIECE_BUCKETS.length : i;
    };
    console.log('\nWhere the final\'s word edits fall, by the length of the piece they land in (edits / words in those pieces)');
    const split = [['arm', ...buckets]];
    for (const col of armCols) {
        const words = buckets.map(() => 0);
        const errs = buckets.map(() => 0);
        for (const c of lasts) {
            const p = col.pass!(c);
            if (p?.text === undefined || p.pieces.length === 0) continue;
            const starts = pieceStarts(p.pieces);
            p.pieces.forEach((piece) => (words[bucketOf(piece.seconds)]! += normalizeForWer(piece.text).length));
            for (const e of wordEdits(fullText(c), p.text)) {
                let i = starts.length - 1;
                while (i > 0 && starts[i]! > e.at) i--;
                errs[bucketOf(p.pieces[i]!.seconds)]!++;
            }
        }
        split.push([col.id, ...buckets.map((_, i) => `${errs[i]}/${words[i]}${words[i] ? ` (${pct(errs[i]! / words[i]!)})` : ''}`)]);
    }
    table(split);

    console.log('\nArtifacts in the replies');
    const art = [['', ...arms.map((a) => a.id)]];
    const per = (f: (a: Arm, answered: Sent[]) => string): string[] => arms.map((a) => f(a, a.sent.filter((s) => s.outcome)));
    const density = (s: Sent): number => s.outcome!.text.length / s.seconds;
    // The joined text kept a clip's closing period before a lowercase word.
    const periodJoin = (s: Sent): boolean =>
        !!s.before && /(?:^|[^.])\.$/u.test(s.before) && /^\p{Ll}/u.test(s.added ?? '') && !!s.joined?.startsWith(s.before);
    art.push(['replies', ...per((_, ok) => String(ok.length))]);
    art.push(['empty or non-speech', ...per((_, ok) => String(ok.filter((s) => isNonSpeechOnly(s.outcome!.text)).length))]);
    art.push(['opens repeating 3+ words of the text before', ...per((_, ok) => String(ok.filter((s) => s.before && echoWords(s.before, s.added!)).length))]);
    art.push([`over ${DENSE_CHARS_PER_SECOND} chars/s of audio`, ...per((_, ok) => String(ok.filter((s) => density(s) > DENSE_CHARS_PER_SECOND).length))]);
    art.push(['". " then lowercase at a join', ...per((_, ok) => String(ok.filter(periodJoin).length))]);
    table(art);

    const fullBilled = total(spoken, (c) => billedSeconds(c.seconds));
    if (!local) console.log(`\nBilled seconds (ceil per request): full passes ${fullBilled} s over ${spoken.length} passes`);
    for (const arm of local ? [] : arms) {
        const reported = arm.sent.filter((s) => s.outcome?.billedSeconds !== undefined);
        console.log(
            `  ${arm.id}: ${arm.billed} s, saving ${fullBilled - arm.billed} s (${pct((fullBilled - arm.billed) / fullBilled)}). ` +
                `OpenAI reported ${total(reported, (s) => s.outcome!.billedSeconds!)} s for ${reported.length} replies we ceil to ${total(reported, (s) => billedSeconds(s.seconds))} s.`
        );
    }

    const latency = [['last passes', 'n', 'full p50', 'full p90', ...cols.flatMap((c) => [`${c.id} p50`, `${c.id} p90`])]];
    const lastMs = (col: Column, c: Clip): number | undefined =>
        col.arm ? usable(col.arm.sent.filter((s) => s.pass === c).pop()?.outcome)?.ms : usable(rerun[c.name])?.ms;
    for (const [label, cs] of [['all', lasts], [`>${LONG_TURN_SECONDS}s`, long]] as const) {
        const q = (f: (c: Clip) => number | undefined): string[] => {
            const ms = cs.map(f).filter((x): x is number => x !== undefined);
            return [0.5, 0.9].map((p) => (ms.length ? String(Math.round(quantile(ms, p))) : '-'));
        };
        latency.push([label, String(cs.length), ...q((c) => full[c.name]!.ms), ...cols.flatMap((col) => q((c) => lastMs(col, c)))]);
    }
    console.log(
        `\nRequest ms on last passes (this machine; ${local ? 'whole passes and pieces in one run' : 'the full passes ran on an earlier day, the rest on one day'})`
    );
    table(latency);

    if (!show) {
        console.log('\n(--show prints the finals that differ and the artifacts. It prints the meditator\'s words.)');
        return;
    }
    const words = (t: string): string[] => t.split(/\s+/).filter(Boolean);
    const tail = (t: string): string => words(t).slice(-6).join(' ');
    for (const col of armCols) {
        console.log(`\n[${col.id}] finals that depart from the full pass (" | " marks a join; * an edit within two words of one):`);
        for (const c of lasts) {
            const p = col.pass!(c);
            if (p?.text === undefined || wordErrorRate(fullText(c), p.text) === 0) continue;
            const joins = pieceStarts(p.pieces).slice(1);
            const edits = wordEdits(fullText(c), p.text).map((e) => `${joins.some((j) => Math.abs(e.at - j) <= 2) ? '*' : ''}${e.op}`);
            console.log(`\n  ${c.name} (${c.seconds.toFixed(1)} s, pieces ${p.pieces.map((x) => x.seconds.toFixed(1)).join('/')} s)`);
            console.log(`    ${pad('full', 10)} ${fullText(c)}`);
            console.log(`    ${pad(col.id, 10)} ${p.pieces.map((x) => x.text).join(' | ')}  [${pct(wordErrorRate(fullText(c), p.text))}]`);
            const r = rerunCol.text(c);
            if (r !== undefined) console.log(`    ${pad('rerun', 10)} ${r}  [${pct(wordErrorRate(fullText(c), r))}]`);
            console.log(`    ${pad('edits', 10)} ${edits.join('  ')}`);
        }
        console.log(`\n[${col.id}] end-of-turn disagreements with the full pass:`);
        for (const c of [...pauses, ...endings]) {
            const t = col.text(c);
            if (t === undefined || held(t) === held(fullText(c))) continue;
            console.log(`  ${c.name} ${endings.includes(c) ? 'ending' : 'pause'}: ${held(fullText(c)) ? 'full' : col.id} holds. full "...${tail(fullText(c))}"  ${col.id} "...${tail(t)}"`);
        }
        for (const s of col.arm!.sent.filter((x) => x.outcome)) {
            const what = s.outcome!.text;
            if (isNonSpeechOnly(what)) console.log(`  empty: ${s.key} (${s.seconds.toFixed(1)} s) "${what}"`);
            else if (s.before && echoWords(s.before, s.added!)) console.log(`  repeat: ${s.key} ${echoWords(s.before, s.added!)} words: "...${tail(s.before)}" | "${words(s.added!).slice(0, 8).join(' ')}"`);
            if (density(s) > DENSE_CHARS_PER_SECOND) console.log(`  dense: ${s.key} ${density(s).toFixed(0)} chars/s on ${s.seconds.toFixed(1)} s: "${what.slice(0, 80)}"`);
            if (periodJoin(s)) console.log(`  period join: ${s.key} ...${words(s.before!).slice(-5).join(' ')} | ${words(s.added!).slice(0, 6).join(' ')}...`);
        }
    }
    console.log('\n[rerun] end-of-turn disagreements with the full pass:');
    for (const c of [...later, ...lasts]) {
        const t = rerunCol.text(c);
        if (t === undefined || held(t) === held(fullText(c))) continue;
        console.log(`  ${c.name}: ${held(fullText(c)) ? 'full' : 'rerun'} holds. full "...${tail(fullText(c))}"  rerun "...${tail(t)}"`);
    }
}

async function incremental(dir: string, modelIds: string[], reportOnly: boolean, show: boolean, maxUsd: number): Promise<void> {
    if (modelIds.length === 1 && /^local(?::|$)/.test(modelIds[0]!)) return incrementalLocal(dir, modelFor(modelIds[0]!), reportOnly, show);
    if (modelIds.join(',') !== 'openai') throw new Error('--set incremental sends to gpt-transcribe only (or runs on local): drop --models.');
    const capture = loadCapture(dir);
    const spoken = capture.filter((c) => !isNonSpeechOnly(c.captured));
    const full = readCache(dir, 'openai');
    const missing = spoken.filter((c) => !usable(full[c.name]));
    if (missing.length) throw new Error(`${missing.length} spoken passes have no whole-pass result in the openai cache: run --set passes first.`);
    const plan = planIncremental(spoken);
    const caches = { stitched: readCache(dir, INCREMENTAL_ID), seam: readCache(dir, SEAM_ID) };
    const rerunJobs: Job[] = byTurn(spoken).flatMap((t) => t.slice(1).map((clip) => ({ key: clip.name, clip })));
    const model = modelFor('openai');

    let sends: { stitched?: Send; seam?: Send } = {};
    if (!reportOnly) {
        const later = plan.flat().filter((s) => !s.first);
        const clean = later.filter((s) => !s.fallback).length;
        console.log(`Shared prefix: ${clean}/${later.length} passes extend the one before.`);
        if (clean < later.length / 2) throw new Error('Most passes do not share a long exact prefix with the pass before: not sending.');

        // Every reply this run lacks, as if each comes back with words: a
        // wordless one makes the seam arm re-send its audio, which the
        // running cap below catches.
        const rerunCache = readCache(dir, RERUN_ID);
        const rerunTodo = rerunJobs.filter((j) => !usable(rerunCache[j.key]));
        const pending: number[] = rerunTodo.map((j) => j.clip.seconds);
        const dry = (cache: Cache): Send => async (s) => {
            pending.push(s.seconds);
            cache[s.key] = { text: 'words', ms: 0, ...(s.prompt !== undefined ? { prompt: s.prompt } : {}) };
        };
        const stitchedScratch = { ...caches.stitched };
        await stitchedArm(plan, full, stitchedScratch, dry(stitchedScratch));
        const seamScratch = { ...caches.seam };
        await seamArm(capture, full, seamScratch, dry(seamScratch));
        const usd = total(pending, (s) => model.price(s));
        console.log(
            `To send: ${pending.length} requests, ${total(pending, (s) => s).toFixed(1)} s of audio, ` +
                `billed ${total(pending, billedSeconds)} s = $${usd.toFixed(4)} at $0.27/audio-hr (cap $${maxUsd}).`
        );
        if (usd > maxUsd) throw new Error('Over the cap: not sending.');
        if (pending.length && !env(model.needs)) throw new Error(`${model.needs} is not set.`);
        mkdirSync(join(dir, 'replay'), { recursive: true });

        await run(dir, { ...model, id: RERUN_ID }, rerunJobs);
        let spent = total(rerunTodo, (j) => model.price(j.clip.seconds));
        let capped = false;
        const live = (id: string, cache: Cache): Send => async (s, pcm) => {
            const usd = model.price(s.seconds);
            if (spent + usd > maxUsd) {
                if (!capped) console.log(`Stopping at the $${maxUsd} cap: the rest of the chain is left unsent.`);
                capped = true;
                return;
            }
            spent += usd;
            const out = await transcribeTimed(model, { ...s.pass, pcm, wav: wavOf(pcm), seconds: s.seconds }, s.prompt);
            cache[s.key] = { ...out, ...(s.prompt !== undefined ? { prompt: s.prompt } : {}), seconds: s.seconds };
            writeFileSync(cachePath(dir, id), JSON.stringify(cache, null, 1));
            if (out.error) console.log(`${id}: ${out.error}`);
        };
        sends = { stitched: live(INCREMENTAL_ID, caches.stitched), seam: live(SEAM_ID, caches.seam) };
    }
    const arms = [
        await stitchedArm(plan, full, caches.stitched, sends.stitched),
        await seamArm(capture, full, caches.seam, sends.seam),
    ];
    reportIncremental(spoken, arms, full, readCache(dir, RERUN_ID), show);
}

/** `--set incremental --models local`: the seam arm on the desktop's own
 *  whisper.cpp, scored against its own whole passes (transcribed first, cached
 *  under the model's id). No rerun: greedy whisper.cpp on the CPU gives the
 *  same audio and prompt the same bytes every time, so the floor is 0. */
async function incrementalLocal(dir: string, model: Model, reportOnly: boolean, show: boolean): Promise<void> {
    const capture = loadCapture(dir);
    const spoken = capture.filter((c) => !isNonSpeechOnly(c.captured));
    if (!reportOnly) await run(dir, model, spoken.map((clip) => ({ key: clip.name, clip })));
    const full = readCache(dir, model.id);
    const missing = spoken.filter((c) => !usable(full[c.name]));
    if (missing.length) throw new Error(`${missing.length} spoken passes have no whole-pass result in the ${model.id} cache.`);
    const seamId = `${model.id}-seam`;
    const cache = readCache(dir, seamId);
    const send: Send = async (s, pcm) => {
        const out = await transcribeTimed(model, { ...s.pass, pcm, wav: wavOf(pcm), seconds: s.seconds }, s.prompt);
        cache[s.key] = { ...out, ...(s.prompt !== undefined ? { prompt: s.prompt } : {}), seconds: s.seconds };
        writeFileSync(cachePath(dir, seamId), JSON.stringify(cache, null, 1));
        if (out.error) console.log(`${seamId}: ${out.error}`);
    };
    const arm = await seamArm(capture, full, cache, reportOnly ? undefined : send);
    console.log(`\n${model.id} (${model.priceNote}). No rerun: the floor is 0.`);
    reportIncremental(spoken, [arm], full, {}, show, model.id);
}

// --- cli ------------------------------------------------------------------

async function main(): Promise<void> {
    loadServerEnv();
    const args = process.argv.slice(2);
    const take = (flag: string): string | undefined => {
        const i = args.indexOf(flag);
        return i >= 0 ? args.splice(i, 2)[1] : undefined;
    };
    const has = (flag: string): boolean => {
        const i = args.indexOf(flag);
        if (i >= 0) args.splice(i, 1);
        return i >= 0;
    };
    const modelIds = (take('--models') ?? 'openai').split(',').filter(Boolean);
    const sets = new Set((take('--set') ?? 'battery,finals').split(','));
    const runs = Number(take('--runs') ?? 3);
    const refId = take('--ref') ?? 'openai';
    const reportOnly = has('--report');
    const show = has('--show');
    const maxUsd = Number(take('--max-usd') ?? 0.2);
    const dir = args[0];
    if (!dir) {
        console.error('Usage: npm run stt:replay -- <capture-dir> [--models a,b] [--set noise|battery,finals,passes|incremental] [--runs 3] [--ref openai|capture] [--report] [--show] [--max-usd 0.2]');
        process.exit(2);
    }
    if (sets.has('incremental')) {
        if (sets.size > 1) throw new Error('--set incremental runs on its own.');
        return incremental(dir, modelIds, reportOnly, show, maxUsd);
    }

    const models = modelIds.map(modelFor);
    const noiseOnly = sets.size === 1 && sets.has('noise');
    const capture = noiseOnly ? [] : loadCapture(dir);
    const spoken = capture.filter((c) => !isNonSpeechOnly(c.captured));
    // The battery repeats: a model that invents text does it some of the time.
    const battery: Job[] = batteryOf(capture).flatMap((clip) =>
        Array.from({ length: runs }, (_, r) => ({ key: `battery/${clip.name}#${r + 1}`, clip }))
    );
    const jobs: Job[] = [
        ...(sets.has('battery') || sets.has('noise') ? battery : []),
        ...spoken.filter((c) => sets.has('passes') || (sets.has('finals') && c.last)).map((clip) => ({ key: clip.name, clip })),
    ];

    if (!reportOnly) await Promise.all(models.map((m) => run(dir, m, jobs)));
    report(dir, models, capture, battery, refId, show);
}

main()
    .finally(() => localClosers.forEach((close) => close()))
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
