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
 *   npm run stt:replay -- <capture-dir> --set incremental    (each pass sends only its new audio: gpt-transcribe)
 *   npm run stt:replay -- <capture-dir> --set incremental --models or:moondream/parakeet-ultra   (the same, unprompted)
 *   npm run stt:replay -- <capture-dir> --set incremental --models local   (the same on the desktop's whisper.cpp: nothing sent)
 *   npm run stt:replay -- <capture-dir> --set latency --models or:moondream/parakeet-ultra,openai --runs 2   (each turn's final request, interleaved)
 *   npm run stt:replay -- <capture-dir> [<capture-dir>...] --set pauses   (an incremental gpt-transcribe pass at every pause; see the section)
 *   npm run stt:replay -- <capture-dir> --report --show      (no calls; print where models differ)
 *
 * `--set incremental` (meditation-pal-12q9) asks whether a pass can send only
 * the audio since the pass before, prompted with the turn's text so far, and
 * be stitched (joinTranscripts) without changing what the turn says or how
 * the end-of-turn check reads it. It cuts the pieces from the capture's own
 * passes, which share an exact sample prefix, two ways: "stitched" (pass 1
 * whole, then from just before where each pass parts from the last) and
 * "seam" (the engine's cut: each piece ends in the quietest 85 ms near the
 * pass's end and the next starts there). Both score against the model's own
 * cache of whole passes: run `--set passes` for it first. Every non-first
 * pass also goes again whole, once, as the noise floor (the model against
 * itself). An OpenRouter model aloud cloud serves takes no prompt, so its
 * pieces go unprompted, as the server would forward them. Request times are
 * split by audio length, with a fixed-plus-per-second fit, whole against
 * pieces. Refuses to send over $0.20 in a run, or --max-usd.
 *
 * Models: `openai` and `groq` go through the server's own forwarder
 * (transcribeWhisper), so the request is the production one. `azure` is
 * MAI-Transcribe-2 on the Speech key, verbatim by default (it writes down
 * every "um" and cut-off word); `azure:clean` asks for its tidied style.
 * `or:<id>` is any model on OpenRouter's transcription API, which lists most
 * of the field behind one key; one aloud cloud serves (OPENROUTER_STT_MODELS)
 * goes through the server's forwarder (transcribeOpenRouter: its host pin and
 * zero-retention filter), so its cache is the production request.
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
import { OPENROUTER_STT_MODELS, int16ToFloat32, transcribeOpenRouter, transcribeWhisper } from '../server/src/providers/stt.js';
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
    /** Whether `prompt` reaches the model at all. */
    prompted: boolean;
    /** Seconds the provider bills for one request of `seconds`. */
    billed(seconds: number): number;
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

function whisperCompatible(
    id: 'openai' | 'groq',
    needs: string,
    billed: Model['billed'],
    price: Model['price'],
    priceNote?: string
): Model {
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
        prompted: true,
        billed,
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
    prompted: false,
    billed: (seconds) => seconds,
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
    const route = OPENROUTER_STT_MODELS[modelId];
    return {
        id: `or:${modelId}`,
        needs: 'OPENROUTER_API_KEY',
        prompted: false,
        billed: (seconds) => sttBilledSeconds(seconds, modelId),
        // OpenRouter reports each call's cost; a call that doesn't is unpriced
        // here on purpose (its list prices mix per-second and per-hour units),
        // except a model aloud cloud serves: its table rate, so the
        // incremental set's cap has a price to stop at.
        price: route ? (seconds) => seconds * sttUsdPerSecond(modelId) : () => NaN,
        ...(route ? { priceNote: `server route: ${route.host} only${route.zdr ? ', zdr' : ''}` } : {}),
        async transcribe(clip) {
            if (route) {
                // The server's own forwarder, so the request is production's;
                // the tap reads the cost OpenRouter reports beside the text.
                let cost: unknown;
                const tapped: typeof fetch = async (input, init) => {
                    const res = await fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
                    if (res.ok) cost = ((await res.clone().json()) as { usage?: { cost?: unknown } }).usage?.cost;
                    return res;
                };
                const r = await transcribeOpenRouter(
                    int16ToFloat32(clip.pcm),
                    SAMPLE_RATE,
                    env('OPENROUTER_API_KEY'),
                    modelId,
                    { language: LANGUAGE },
                    tapped
                );
                return {
                    text: r.text,
                    ...(typeof cost === 'number' ? { costUsd: cost } : {}),
                    ...(r.reportedSeconds !== undefined ? { billedSeconds: r.reportedSeconds } : {}),
                };
            }
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
        prompted: true,
        billed: (seconds) => seconds,
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
        const billed = (s: number): number => sttBilledSeconds(s, 'gpt-transcribe');
        return whisperCompatible('openai', 'OPENAI_API_KEY', billed, (s) => billed(s) * sttUsdPerSecond('gpt-transcribe'));
    }
    if (id === 'groq') {
        // $0.04/audio-hr list, and every request bills at least 10 seconds.
        const billed = (s: number): number => Math.max(s, 10);
        return whisperCompatible('groq', 'GROQ_API_KEY', billed, (s) => (billed(s) * 0.04) / 3600, '10 s minimum per request');
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

/** Each arm's cache, beside the model's own cache of whole passes. */
const armIds = (modelId: string): { stitched: string; seam: string; rerun: string } => ({
    stitched: `${modelId}-incremental`,
    seam: `${modelId}-seam`,
    rerun: `${modelId}-rerun`,
});
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
/** Upper edges (s) of the audio-length buckets request times are split by. */
const LATENCY_BUCKETS = [5, 10, 20, 40];
/** A piece whose loudest SEAM_WINDOW is under this holds no speech: room
 *  tone, a breath. Soft speech in the captures peaks well above it. */
const QUIET_PIECE_DBFS = -40;

/** A request an arm sends at a pass. */
interface Sent {
    key: string;
    pass: Clip;
    seconds: number;
    prompt?: string;
    /** dBFS of the piece's loudest SEAM_WINDOW. */
    level: number;
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
const samePrompt = (o: Outcome, prompt: string | undefined): boolean => (o.prompt ?? '') === (prompt ?? '');
const sentenceEnds = (t: string): number => (t.match(/[.!?](?=\s|$)/gu) ?? []).length;
const endsTerminated = (t: string): boolean => /[.!?]["')\]]*$/u.test(t.trim());
const lastOf = <T>(xs: T[]): T => xs[xs.length - 1]!;

function byTurn(clips: Clip[]): Clip[][] {
    const turns = new Map<number, Clip[]>();
    for (const c of clips) turns.set(c.turn, [...(turns.get(c.turn) ?? []), c]);
    return [...turns.values()];
}

/** dBFS of the loudest SEAM_WINDOW in `pcm`, at half-window steps. */
function loudestDb(pcm: Int16Array): number {
    let best = 0;
    for (let start = 0; start < pcm.length; start += SEAM_WINDOW >> 1) {
        const end = Math.min(pcm.length, start + SEAM_WINDOW);
        let sum = 0;
        for (let i = start; i < end; i++) sum += pcm[i]! * pcm[i]!;
        best = Math.max(best, sum / (end - start));
        if (end === pcm.length) break;
    }
    return best > 0 ? 10 * Math.log10(best / 32768 ** 2) : -Infinity;
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

/** What an arm needs of its model: whether a piece carries the text so far,
 *  and what a request bills. */
type Chain = Pick<Model, 'prompted' | 'billed'>;

async function stitchedArm(plan: Step[][], full: Cache, cache: Cache, chain: Chain, send?: Send): Promise<Arm> {
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
                const s: Sent = {
                    key: step.clip.name,
                    pass: step.clip,
                    seconds: secondsOf(step.increment!),
                    level: loudestDb(step.increment!),
                    ...(chain.prompted ? { prompt: priorPrompt(text) } : {}),
                };
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
        billed: total(steps, (s) => chain.billed(s.increment ? secondsOf(s.increment) : s.clip.seconds)),
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
async function seamArm(capture: Clip[], full: Cache, cache: Cache, chain: Chain, send?: Send): Promise<Arm> {
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
            billed += chain.billed(clip.seconds);
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
                const s: Sent = {
                    key: `${clip.name}@${cursor}-${end}`,
                    pass: clip,
                    seconds: secondsOf(pcm),
                    level: loudestDb(pcm),
                    ...(text && chain.prompted ? { prompt: priorPrompt(text) } : {}),
                };
                sent.push(s);
                billed += chain.billed(s.seconds);
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

interface Timed {
    seconds: number;
    ms: number;
}

/** Theil-Sen line through request times: the median slope over every pair at
 *  least a second of audio apart, and the median intercept under it. A slow
 *  outlier moves neither, as it would a least-squares line. */
function robustLine(xs: Timed[]): { fixed: number; perSecond: number } | undefined {
    const slopes: number[] = [];
    for (let i = 0; i < xs.length; i++) {
        for (let j = i + 1; j < xs.length; j++) {
            const dx = xs[j]!.seconds - xs[i]!.seconds;
            if (Math.abs(dx) >= 1) slopes.push((xs[j]!.ms - xs[i]!.ms) / dx);
        }
    }
    if (slopes.length === 0) return undefined;
    const perSecond = quantile(slopes, 0.5);
    return { fixed: quantile(xs.map((x) => x.ms - perSecond * x.seconds), 0.5), perSecond };
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

/** The reference is `model`'s own whole passes. `local`: run beside the
 *  pieces, and nothing is billed. */
function reportIncremental(
    spoken: Clip[],
    arms: Arm[],
    full: Cache,
    rerun: Cache,
    show: boolean,
    model: Pick<Model, 'id' | 'billed'>,
    local = false
): void {
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
            `(${pauses.length} pauses, ${endings.length} endings). Reference: ${local ? `${model.id}'s own whole passes` : `the ${model.id} cache, every pass sent whole`}.`
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
    // The model's own whole pass gained no words over the pass before (or the
    // capture heard none in it): the piece is the pause, a breath, the tail.
    const previous = new Map(turns.flatMap((t) => t.slice(1).map((c, i) => [c.name, t[i]!] as const)));
    const noNewWords = (s: Sent): boolean => {
        if (!full[s.pass.name]) return true;
        const before = previous.get(s.pass.name);
        return !!before && sameWords(fullText(before), fullText(s.pass));
    };
    const wordy = (ss: Sent[]): string => `${ss.filter((s) => !isNonSpeechOnly(s.outcome!.text)).length}/${ss.length}`;
    art.push(['replies', ...per((_, ok) => String(ok.length))]);
    art.push(['empty or non-speech', ...per((_, ok) => String(ok.filter((s) => isNonSpeechOnly(s.outcome!.text)).length))]);
    art.push(['opens repeating 3+ words of the text before', ...per((_, ok) => String(ok.filter((s) => s.before && echoWords(s.before, s.added!)).length))]);
    art.push([`over ${DENSE_CHARS_PER_SECOND} chars/s of audio`, ...per((_, ok) => String(ok.filter((s) => density(s) > DENSE_CHARS_PER_SECOND).length))]);
    art.push(['". " then lowercase at a join', ...per((_, ok) => String(ok.filter(periodJoin).length))]);
    art.push(['opens on the last word before', ...per((_, ok) => String(ok.filter(doubledAtJoin).length))]);
    art.push(['capital mid-sentence at a join', ...per((_, ok) => String(ok.filter(capitalAtJoin).length))]);
    art.push(['no new words in the whole pass: replies with words', ...per((_, ok) => wordy(ok.filter(noNewWords)))]);
    art.push([`under ${QUIET_PIECE_DBFS} dBFS: replies with words`, ...per((_, ok) => wordy(ok.filter((s) => s.level < QUIET_PIECE_DBFS)))]);
    table(art);

    const fullBilled = total(spoken, (c) => model.billed(c.seconds));
    if (!local) console.log(`\nBilled seconds (per request, as ${model.id} bills): full passes ${fullBilled.toFixed(0)} s over ${spoken.length} passes`);
    for (const arm of local ? [] : arms) {
        const reported = arm.sent.filter((s) => s.outcome?.billedSeconds !== undefined);
        console.log(
            `  ${arm.id}: ${arm.billed.toFixed(0)} s, saving ${(fullBilled - arm.billed).toFixed(0)} s (${pct((fullBilled - arm.billed) / fullBilled)}). ` +
                `${model.id} reported ${total(reported, (s) => s.outcome!.billedSeconds!).toFixed(1)} s for ${reported.length} replies ` +
                `we bill at ${total(reported, (s) => model.billed(s.seconds)).toFixed(1)} s.`
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
        `\nRequest ms on last passes (this machine; ${local ? 'whole passes and pieces in one run' : 'each reply timed in the run that cached it'})`
    );
    table(latency);

    // Every reply each arm holds, by its audio length: a piece saves only the
    // per-second part of a request, never the fixed part.
    const timed = (pairs: Array<[number, Outcome | undefined]>): Timed[] =>
        pairs.flatMap(([seconds, o]) => (usable(o) ? [{ seconds, ms: o!.ms }] : []));
    const timedRows: Array<[string, Timed[]]> = [
        ['whole passes (cache)', timed(spoken.map((c) => [c.seconds, full[c.name]]))],
        ['whole again (rerun)', timed(spoken.map((c) => [c.seconds, rerun[c.name]]))],
        ...arms.map((a): [string, Timed[]] => [`pieces (${a.id})`, timed(a.sent.map((s) => [s.seconds, s.outcome]))]),
    ];
    const edges = [0, ...LATENCY_BUCKETS, Infinity];
    const byLength = [['requests', 'n', ...edges.slice(1).map((e, i) => (e === Infinity ? `>${edges[i]}s` : `${edges[i]}-${e}s`)), 'fixed ms + ms per audio s']];
    for (const [label, xs] of timedRows) {
        if (xs.length === 0) continue;
        const cells = edges.slice(1).map((e, i) => {
            const ms = xs.filter((x) => x.seconds >= edges[i]! && x.seconds < e).map((x) => x.ms);
            return ms.length ? `${Math.round(quantile(ms, 0.5))}/${Math.round(quantile(ms, 0.9))} (${ms.length})` : '-';
        });
        const line = robustLine(xs);
        byLength.push([label, String(xs.length), ...cells, line ? `${Math.round(line.fixed)} + ${Math.round(line.perSecond)}` : '-']);
    }
    console.log('\nRequest ms by audio length, p50/p90 (n), and a Theil-Sen line through every reply');
    table(byLength);

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
            if (doubledAtJoin(s)) console.log(`  doubled: ${s.key} ...${words(s.before!).slice(-5).join(' ')} | ${words(s.added!).slice(0, 6).join(' ')}...`);
            if (capitalAtJoin(s)) console.log(`  capital: ${s.key} ...${words(s.before!).slice(-5).join(' ')} | ${words(s.added!).slice(0, 6).join(' ')}...`);
            if (!isNonSpeechOnly(what) && (noNewWords(s) || s.level < QUIET_PIECE_DBFS)) {
                console.log(`  words on a quiet piece: ${s.key} (${s.seconds.toFixed(1)} s, ${s.level.toFixed(0)} dBFS${noNewWords(s) ? ', no new words in the whole pass' : ''}) "${what.slice(0, 60)}"`);
            }
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
    const id = modelIds.join(',');
    if (id !== 'openai' && !(id.startsWith('or:') && id.slice(3) in OPENROUTER_STT_MODELS)) {
        throw new Error(
            `--set incremental takes one model: openai, local, or or:<id> for ${Object.keys(OPENROUTER_STT_MODELS).join(', ')} (the ones the cap can price).`
        );
    }
    const model = modelFor(id);
    const capture = loadCapture(dir);
    const spoken = capture.filter((c) => !isNonSpeechOnly(c.captured));
    const full = readCache(dir, model.id);
    const missing = spoken.filter((c) => !usable(full[c.name]));
    if (missing.length) {
        throw new Error(`${missing.length} spoken passes have no whole-pass result in the ${model.id} cache: run --set passes --models ${model.id} first.`);
    }
    const plan = planIncremental(spoken);
    const ids = armIds(model.id);
    const caches = { stitched: readCache(dir, ids.stitched), seam: readCache(dir, ids.seam) };
    const rerunJobs: Job[] = byTurn(spoken).flatMap((t) => t.slice(1).map((clip) => ({ key: clip.name, clip })));

    let sends: { stitched?: Send; seam?: Send } = {};
    if (!reportOnly) {
        const later = plan.flat().filter((s) => !s.first);
        const clean = later.filter((s) => !s.fallback).length;
        console.log(`Shared prefix: ${clean}/${later.length} passes extend the one before.`);
        if (clean < later.length / 2) throw new Error('Most passes do not share a long exact prefix with the pass before: not sending.');

        // Every reply this run lacks, as if each comes back with words: a
        // wordless one makes the seam arm re-send its audio, which the
        // running cap below catches.
        const rerunCache = readCache(dir, ids.rerun);
        const rerunTodo = rerunJobs.filter((j) => !usable(rerunCache[j.key]));
        const pending: number[] = rerunTodo.map((j) => j.clip.seconds);
        const dry = (cache: Cache): Send => async (s) => {
            pending.push(s.seconds);
            cache[s.key] = { text: 'words', ms: 0, ...(s.prompt !== undefined ? { prompt: s.prompt } : {}) };
        };
        const stitchedScratch = { ...caches.stitched };
        await stitchedArm(plan, full, stitchedScratch, model, dry(stitchedScratch));
        const seamScratch = { ...caches.seam };
        await seamArm(capture, full, seamScratch, model, dry(seamScratch));
        const usd = total(pending, (s) => model.price(s));
        console.log(
            `To send: ${pending.length} requests, ${total(pending, (s) => s).toFixed(1)} s of audio, ` +
                `billed ${total(pending, model.billed).toFixed(1)} s = $${usd.toFixed(4)} at $${model.price(3600).toFixed(3)}/audio-hr (cap $${maxUsd}).`
        );
        if (usd > maxUsd) throw new Error('Over the cap: not sending.');
        if (pending.length && !env(model.needs)) throw new Error(`${model.needs} is not set.`);
        mkdirSync(join(dir, 'replay'), { recursive: true });

        await run(dir, { ...model, id: ids.rerun }, rerunJobs);
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
        sends = { stitched: live(ids.stitched, caches.stitched), seam: live(ids.seam, caches.seam) };
    }
    const arms = [
        await stitchedArm(plan, full, caches.stitched, model, sends.stitched),
        await seamArm(capture, full, caches.seam, model, sends.seam),
    ];
    reportIncremental(spoken, arms, full, readCache(dir, ids.rerun), show, model);
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
    const arm = await seamArm(capture, full, cache, model, reportOnly ? undefined : send);
    console.log(`\n${model.id} (${model.priceNote}). No rerun: the floor is 0.`);
    reportIncremental(spoken, [arm], full, {}, show, model, true);
}

// --- latency ----------------------------------------------------------------

/** The engine holds the submit while the terminal speculative pass is in
 *  flight, and fires it this long before the submit on a long buffer
 *  (ui/src/adapters/whisper-pcm-stt.ts SPEC_TERMINAL_LEAD_MS): only a request
 *  slower than this keeps the meditator waiting. */
const TERMINAL_LEAD_MS = 1500;
/** Upper edges (s) of the turn-length buckets the probe is split by. */
const TURN_BUCKETS = [10, 20, 40];

/** A multi-pass turn's last piece on the engine's cut, as if every piece
 *  before it came back with words: from the last seam to the end. */
function terminalPiece(clips: Clip[]): Int16Array {
    let cursor = 0;
    for (let k = 0; k < clips.length - 1; k++) {
        const end = seamAt(clips[k]!.pcm, clips[k + 1]!.pcm, cursor);
        if (end !== undefined) cursor = end;
    }
    return lastOf(clips).pcm.subarray(cursor);
}

/**
 * `--set latency`: each multi-pass turn's final request, timed back to back
 * across models so a slow minute lands on every side of a comparison. A model
 * that takes a prompt sends what production sends, the terminal piece with
 * the text before it; one that takes none sends its whole last pass (today's
 * request) and the terminal piece (the candidate). The order rotates turn by
 * turn. Text is cached but not scored: --set incremental scores it.
 */
async function latencyProbe(dir: string, modelIds: string[], runs: number, reportOnly: boolean, maxUsd: number): Promise<void> {
    const models = modelIds.map(modelFor);
    const capture = loadCapture(dir);
    const turns = byTurn(capture).filter((t) => t.length > 1 && !isNonSpeechOnly(lastOf(t).captured));
    type Probe = { model: Model; kind: 'whole' | 'piece'; key: string; clip: Clip; prompt?: string };
    const caches = new Map(models.map((m) => [m.id, readCache(dir, `${m.id}-latency`)]));
    const own = new Map(models.map((m) => [m.id, readCache(dir, m.id)]));
    const rounds: Probe[][] = [];
    for (let r = 1; r <= runs; r++) {
        for (const [i, clips] of turns.entries()) {
            const last = lastOf(clips);
            const pcm = terminalPiece(clips);
            const piece: Clip = { ...last, pcm, wav: wavOf(pcm), seconds: secondsOf(pcm) };
            const jobs = models.flatMap((model): Probe[] => {
                const before = clips[clips.length - 2]!;
                const text = usable(own.get(model.id)![before.name])?.text ?? before.captured;
                return [
                    ...(model.prompted ? [] : [{ model, kind: 'whole' as const, key: `${last.name}|whole|${r}`, clip: last }]),
                    { model, kind: 'piece', key: `${last.name}|piece|${r}`, clip: piece, ...(model.prompted ? { prompt: priorPrompt(text) } : {}) },
                ];
            });
            const shift = (i + r) % jobs.length;
            rounds.push([...jobs.slice(shift), ...jobs.slice(0, shift)]);
        }
    }
    if (!reportOnly) {
        const todo = rounds.flat().filter((p) => !usable(caches.get(p.model.id)![p.key]));
        const usd = total(todo, (p) => p.model.price(p.clip.seconds));
        console.log(`To send: ${todo.length} requests, ${total(todo, (p) => p.clip.seconds).toFixed(1)} s of audio, $${usd.toFixed(4)} (cap $${maxUsd}).`);
        if (!(usd <= maxUsd)) throw new Error('Over the cap, or a model with no price: not sending.');
        for (const m of models) if (todo.some((p) => p.model === m) && m.needs && !env(m.needs)) throw new Error(`${m.needs} is not set.`);
        mkdirSync(join(dir, 'replay'), { recursive: true });
        for (const p of todo) {
            const cache = caches.get(p.model.id)!;
            const out = await transcribeTimed(p.model, p.clip, p.prompt);
            cache[p.key] = { ...out, seconds: p.clip.seconds };
            writeFileSync(cachePath(dir, `${p.model.id}-latency`), JSON.stringify(cache, null, 1));
            if (out.error) console.log(`${p.model.id}: ${out.error}`);
        }
    }

    const edges = [0, ...TURN_BUCKETS, Infinity];
    const bucketLabels = edges.slice(1).map((e, i) => (e === Infinity ? `>=${edges[i]}s` : `${edges[i]}-${e}s`));
    const inBucket = (seconds: number, i: number): boolean => seconds >= edges[i]! && seconds < edges[i + 1]!;
    const ms = (m: Model, kind: string, clip: Clip, r: number): number | undefined => usable(caches.get(m.id)![`${clip.name}|${kind}|${r}`])?.ms;
    const runsList = Array.from({ length: runs }, (_, r) => r + 1);
    const rows = models.flatMap((m) => (m.prompted ? ['piece'] : ['whole', 'piece']).map((kind) => ({ m, kind })));
    const pieceSeconds = new Map(turns.map((t) => [lastOf(t).name, secondsOf(terminalPiece(t))]));
    const turnSeconds = (t: Clip[]): number => lastOf(t).seconds;

    console.log(
        `\nFinal requests on ${turns.length} multi-pass turns x ${runs} rounds, interleaved. Turn length = the whole last pass; ` +
            `the terminal piece holds ${pct(total(turns, (t) => pieceSeconds.get(lastOf(t).name)!) / total(turns, turnSeconds))} of the turns' audio.`
    );
    const head = ['request', 'n', 'p50', 'p90', `wait past ${TERMINAL_LEAD_MS} ms (mean)`, ...bucketLabels.map((b) => `${b} p50 (n)`)];
    const tab = [head];
    for (const { m, kind } of rows) {
        const all = turns.flatMap((t) => runsList.map((r) => ms(m, kind, lastOf(t), r))).filter((x): x is number => x !== undefined);
        if (all.length === 0) continue;
        tab.push([
            `${m.id} ${kind}`,
            String(all.length),
            String(Math.round(quantile(all, 0.5))),
            String(Math.round(quantile(all, 0.9))),
            String(Math.round(mean(all.map((x) => Math.max(0, x - TERMINAL_LEAD_MS))))),
            ...bucketLabels.map((_, i) => {
                const xs = turns.filter((t) => inBucket(turnSeconds(t), i)).flatMap((t) => runsList.map((r) => ms(m, kind, lastOf(t), r))).filter((x): x is number => x !== undefined);
                return xs.length ? `${Math.round(quantile(xs, 0.5))} (${xs.length})` : '-';
            }),
        ]);
    }
    tab.push([
        'audio s: turn / terminal piece', '', '', '', '',
        ...bucketLabels.map((_, i) => {
            const ts = turns.filter((t) => inBucket(turnSeconds(t), i));
            return ts.length ? `${quantile(ts.map(turnSeconds), 0.5).toFixed(0)} / ${quantile(ts.map((t) => pieceSeconds.get(lastOf(t).name)!), 0.5).toFixed(0)}` : '-';
        }),
    ]);
    table(tab);

    // Paired within a turn and round: the same moment, so drift cancels.
    const pairs: Array<[string, (t: Clip[], r: number) => number | undefined]> = [];
    for (const a of rows) {
        for (const b of rows) {
            if (a === b || a.kind !== 'whole') continue;
            pairs.push([
                `${a.m.id} whole - ${b.m.id} ${b.kind}`,
                (t, r) => {
                    const x = ms(a.m, a.kind, lastOf(t), r);
                    const y = ms(b.m, b.kind, lastOf(t), r);
                    return x !== undefined && y !== undefined ? x - y : undefined;
                },
            ]);
        }
    }
    if (pairs.length) {
        console.log('\nPaired differences, ms (median [p10, p90]): what the whole pass costs over the other request');
        const ptab = [['pair', 'all', ...bucketLabels]];
        const cell = (xs: number[]): string =>
            xs.length ? `${Math.round(quantile(xs, 0.5))} [${Math.round(quantile(xs, 0.1))}, ${Math.round(quantile(xs, 0.9))}]` : '-';
        for (const [label, diff] of pairs) {
            const of = (ts: Clip[][]): number[] => ts.flatMap((t) => runsList.map((r) => diff(t, r))).filter((x): x is number => x !== undefined);
            ptab.push([label, cell(of(turns)), ...bucketLabels.map((_, i) => cell(of(turns.filter((t) => inBucket(turnSeconds(t), i)))))]);
        }
        table(ptab);
    }
}

// --- every pause (meditation-pal-35nr) --------------------------------------

/*
 * `--set pauses`: an incremental pass at EVERY pause of SPECULATIVE_SILENCE_MS
 * (up to ENGINE.maxEveryPasses, the last on the late trigger), where the
 * engine today fires one only while the turn's buffer is under
 * CLOUD_SPEC_EARLY_MAX_BUFFER_MS and then waits for the late trigger. Each
 * spoken turn is rebuilt from its last clip and run through the engine's rules
 * twice: today's (planned only: nothing is sent) and every pause (each piece
 * sent to gpt-transcribe through the server's forwarder with the turn's text so
 * far as its prompt, the replies stitched with joinTranscripts). It is scored
 * against the model's whole pass on the same clip, with that clip sent whole
 * again as the floor, and at each mid-turn pause against a whole pass of the
 * turn up to there, as a full-pass engine would have sent it.
 *
 * Finding the pauses. The engine's chunks are 4096 samples at the capture's
 * 48 kHz, so a clip is a whole number of them (checked) and its chunk grid is
 * known. Silero runs over the clip here (the app's model, onnxruntime's wasm in
 * node) for each chunk's speech probability and debounced verdict, read one
 * chunk late as the engine reads them. A capture's payloads had every quiet run
 * longer than COMPACT_GAP_MS cut to COMPACT_KEEP_MS (five chunks), so a run of
 * exactly five quiet chunks between sounds is read as a pause of at least
 * 768 ms and rebuilt to PAUSE_REBUILT_MS with copies of its own room tone. A
 * pause the VAD heard but compaction left whole (a breath in it) is in the clip
 * as it was. The run-length table shows a capture's runs of five beside its
 * fours and sixes: the excess at five is compaction, the rest natural pauses
 * this reads as long ones. What it cannot see: how long a rebuilt pause really
 * was (so today's display lag is a floor, and a pass in flight may have
 * finished inside a long pause), a pause the live VAD heard differently from
 * Silero here, and a compacted run whose five chunks Silero here scores above
 * COMPACT_QUIET_PROB.
 */

const ENGINE_FRAME = 4096;
const NATIVE_RATE = 48_000;
/** 16 kHz samples per engine chunk, and its length. */
const CHUNK = (ENGINE_FRAME * SAMPLE_RATE) / NATIVE_RATE;
const CHUNK_MS = (ENGINE_FRAME / NATIVE_RATE) * 1000;
const chunksIn = (ms: number): number => Math.ceil(ms / CHUNK_MS);
/** The engine's numbers (ui/src/adapters/whisper-pcm-stt.ts; pacing.ts
 *  defaultPacingConfig; silero-vad.ts), mirrored: the arm replays its rules. */
const ENGINE = {
    specSilenceMs: 750, // SPECULATIVE_SILENCE_MS
    pollMs: 200,
    terminalLeadMs: 1500, // SPEC_TERMINAL_LEAD_MS
    earlyMaxBufferMs: 6000, // CLOUD_SPEC_EARLY_MAX_BUFFER_MS
    maxPasses: 6, // MAX_SPECULATIVE_PASSES
    // The every-pause rule's cap, the last pass on the late trigger, so a turn
    // past it still gets its terminal pass.
    maxEveryPasses: 24,
    preBufferFrames: Math.round((2000 / 1000) * NATIVE_RATE / ENGINE_FRAME), // PRE_BUFFER_MS
    tailKeepMs: 1000, // TAIL_KEEP_MS
    seamSpanMs: 500, // SEAM_SPAN_MS
    compactGap: Math.round(700 / CHUNK_MS), // COMPACT_GAP_MS
    compactKeep: Math.round(400 / CHUNK_MS), // COMPACT_KEEP_MS
    compactQuietProb: 0.2, // COMPACT_QUIET_PROB
    // NOISE_FLOOR_SEED * 2: the noise floor moves only without Silero.
    quietEnergy: 0.01,
    hintEnergy: 0.015, // TAIL_RETRANSCRIBE_ENERGY
    hintProb: 0.4, // TAIL_RETRANSCRIBE_PROB
    minFinalPieceMs: 250, // MIN_FINAL_PIECE_MS
    incompleteExtraMs: 4000, // INCOMPLETE_CLAUSE_EXTRA_MS
    silenceBaseMs: 3000,
    silenceMaxMs: 6000,
    silenceRampRate: 0.16,
    speechOn: 0.5, // SPEECH_ON
    speechOff: 0.35, // SPEECH_OFF
};
/** A rebuilt pause: a compacted run says only that it ran past COMPACT_GAP_MS. */
const PAUSE_REBUILT_MS = 1000;
/** Quiet after a clip's end, where the final's tail cut ended it: the submit
 *  window ran on, up to silenceMaxMs + INCOMPLETE_CLAUSE_EXTRA_MS. */
const TAIL_PAD_MS = 11_000;
/** Request time on the fit in meditation-pal-gxk8 (GPT: 490 ms + 24-33 ms per
 *  audio second), so a plan never depends on one run's network. */
const rttMs = (seconds: number): number => 490 + 28 * seconds;
/** GPT's seed in HOSTED_STT (ui/src/adapters/stt-picker.ts): credits per
 *  session hour on today's rules. */
const GPT_CREDITS_PER_HOUR = 2.11;
const SILERO_MODEL = join(TS_ROOT, 'ui/src/assets/silero_vad_op18_ifless.onnx');
const SILERO_FRAME = 512;
const SILERO_CONTEXT = 64;
/** Upper edges of the seams-per-turn buckets word loss is split by. */
const SEAM_BUCKETS = [1, 3, 7, 15];

interface Chunk {
    /** First 16 kHz sample in the clip, and how many. */
    at: number;
    n: number;
    e: number;
    p: number;
    speech: boolean;
    /** Room tone copied into a rebuilt pause or past the clip's end. */
    copy?: true;
}

let sileroRun: Promise<(pcm: Int16Array) => Promise<Float32Array>> | undefined;

/** Silero's speech probability per 512-sample frame, fed as silero-vad.ts
 *  feeds it (64 samples of context carried, state carried). */
function silero(): Promise<(pcm: Int16Array) => Promise<Float32Array>> {
    sileroRun ??= (async () => {
        const ort = await import('onnxruntime-web/wasm');
        ort.env.wasm.numThreads = 1;
        ort.env.logLevel = 'error';
        const session = await ort.InferenceSession.create(readFileSync(SILERO_MODEL), { executionProviders: ['wasm'] });
        const sr = new ort.Tensor('int64', BigInt64Array.from([16_000n]), []);
        return async (pcm: Int16Array) => {
            let state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128]);
            const frame = new Float32Array(SILERO_CONTEXT + SILERO_FRAME);
            const probs = new Float32Array(Math.floor(pcm.length / SILERO_FRAME));
            for (let k = 0; k < probs.length; k++) {
                frame.copyWithin(0, SILERO_FRAME);
                for (let i = 0; i < SILERO_FRAME; i++) frame[SILERO_CONTEXT + i] = pcm[k * SILERO_FRAME + i]! / 32768;
                const out = await session.run({ input: new ort.Tensor('float32', frame.slice(), [1, frame.length]), state, sr });
                state = out['stateN'] as typeof state;
                probs[k] = (out['output']!.data as Float32Array)[0]!;
            }
            return probs;
        };
    })();
    return sileroRun;
}

/** Each clip's Silero track, cached in replay/silero.json (probabilities, no
 *  text). */
async function sileroTracks(dir: string, clips: Clip[]): Promise<Map<string, Float32Array>> {
    const path = cachePath(dir, 'silero');
    let cache: Record<string, { samples: number; probs: number[] }> = {};
    try {
        cache = JSON.parse(readFileSync(path, 'utf8')) as typeof cache;
    } catch {
        // First run.
    }
    const todo = clips.filter((c) => cache[c.name]?.samples !== c.pcm.length);
    if (todo.length) {
        console.log(`Silero over ${todo.length} clips (${total(todo, (c) => c.seconds).toFixed(0)} s of audio), at background priority...`);
        const run = await silero();
        for (const c of todo) cache[c.name] = { samples: c.pcm.length, probs: Array.from(await run(c.pcm), (p) => Math.round(p * 1000) / 1000) };
        mkdirSync(join(dir, 'replay'), { recursive: true });
        writeFileSync(path, JSON.stringify(cache));
    }
    return new Map(clips.map((c) => [c.name, Float32Array.from(cache[c.name]!.probs)]));
}

/** The clip as the engine's chunks: energy, and Silero's probability and
 *  verdict as of the chunk before (inference runs behind the audio callback). */
function chunkTrack(pcm: Int16Array, probs: Float32Array): Chunk[] {
    const out: Chunk[] = [];
    let speaking = false;
    let p = 0;
    let k = 0;
    const count = Math.round(pcm.length / CHUNK);
    for (let c = 0; c < count; c++) {
        const at = Math.round(c * CHUNK);
        const end = Math.min(pcm.length, Math.round((c + 1) * CHUNK));
        while (k < probs.length && (k + 1) * SILERO_FRAME <= at) {
            p = probs[k++]!;
            if (p >= ENGINE.speechOn) speaking = true;
            else if (p < ENGINE.speechOff) speaking = false;
        }
        let sum = 0;
        for (let i = at; i < end; i++) sum += (pcm[i]! / 32768) ** 2;
        out.push({ at, n: end - at, e: Math.sqrt(sum / Math.max(1, end - at)), p, speech: speaking });
    }
    return out;
}

const chunkQuiet = (c: Chunk): boolean => c.e < ENGINE.quietEnergy && c.p < ENGINE.compactQuietProb;
const chunkHint = (c: Chunk): boolean => c.e >= ENGINE.hintEnergy || c.p >= ENGINE.hintProb;

interface Rebuilt {
    chunks: Chunk[];
    /** Quiet runs between sounds, by length in chunks. */
    runs: Map<number, number>;
    rebuilt: number;
}

/** Compacted pauses rebuilt to PAUSE_REBUILT_MS, and TAIL_PAD_MS of the clip's
 *  last quiet appended. */
function rebuildPauses(track: Chunk[]): Rebuilt {
    const runs = new Map<number, number>();
    const out: Chunk[] = [];
    const firstSound = track.findIndex((c) => !chunkQuiet(c));
    let rebuilt = 0;
    for (let i = 0; i < track.length; ) {
        if (!chunkQuiet(track[i]!)) {
            out.push(track[i++]!);
            continue;
        }
        let j = i;
        while (j < track.length && chunkQuiet(track[j]!)) j++;
        const run = track.slice(i, j);
        const between = firstSound >= 0 && i > firstSound && j < track.length;
        if (between) runs.set(run.length, (runs.get(run.length) ?? 0) + 1);
        if (between && run.length === ENGINE.compactKeep) {
            const head = Math.ceil(ENGINE.compactKeep / 2);
            out.push(...run.slice(0, head));
            for (let k = 0; k < chunksIn(PAUSE_REBUILT_MS) - run.length; k++) out.push({ ...run[k % run.length]!, speech: false, copy: true });
            out.push(...run.slice(head));
            rebuilt++;
        } else out.push(...run);
        i = j;
    }
    const tone = [...track].reverse().find(chunkQuiet) ?? track[track.length - 1]!;
    for (let k = 0; k < chunksIn(TAIL_PAD_MS); k++) out.push({ ...tone, speech: false, copy: true });
    return { chunks: out, runs, rebuilt };
}

/** submitPayload's cut: from `from` to the tail cut, a speculative pass's end
 *  pulled back to the quietest chunk of the last SEAM_SPAN_MS (`seam`), quiet
 *  runs compacted (compactQuietRuns). */
function piecePayload(
    pcm: Int16Array,
    chunks: Chunk[],
    from: number,
    landed: number,
    lastHint: number,
    seamCut: boolean
): { pcm: Int16Array; to: number; seam: number | null } {
    let end = landed;
    if (lastHint > 0) end = Math.min(end, lastHint + chunksIn(ENGINE.tailKeepMs));
    let seam: number | null = null;
    if (seamCut) {
        const span = chunksIn(ENGINE.seamSpanMs);
        let quietest = Infinity;
        for (let i = end - 1; i >= end - span && i > from + span; i--) {
            if (chunks[i]!.e < quietest) {
                quietest = chunks[i]!.e;
                seam = i;
            }
        }
        if (seam !== null) end = seam;
    }
    const keep: Chunk[] = [];
    if (end > from) {
        const quiet = chunks.slice(from, end).map(chunkQuiet);
        for (const [a, b] of compactRuns(quiet, ENGINE.compactGap, ENGINE.compactKeep)) keep.push(...chunks.slice(from + a, from + b));
    }
    const out = new Int16Array(total(keep, (c) => c.n));
    let at = 0;
    for (const c of keep) {
        out.set(pcm.subarray(c.at, c.at + c.n), at);
        at += c.n;
    }
    return { pcm: out, to: end, seam };
}

/** compactQuietRuns (whisper-pcm-stt.ts). */
function compactRuns(quiet: boolean[], gap: number, keep: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let cursor = 0;
    for (let i = 0; i < quiet.length; ) {
        if (!quiet[i]) {
            i++;
            continue;
        }
        let j = i;
        while (j < quiet.length && quiet[j]) j++;
        if (j - i > gap && j - i > keep) {
            const head = Math.ceil(keep / 2);
            ranges.push([cursor, i + head]);
            cursor = j - (keep - head);
        }
        i = j;
    }
    ranges.push([cursor, quiet.length]);
    return ranges.filter(([a, b]) => b > a);
}

/** FNV-1a over the samples: a piece's cache key, whatever cut made it. */
function pcmHash(pcm: Int16Array): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < pcm.length; i++) {
        h ^= pcm[i]! & 0xffff;
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

type Rule = 'today' | 'every';

interface SimPass {
    kind: 'spec' | 'final';
    firedAt: number;
    shownAt: number;
    /** Timeline chunks the piece covers (before compaction), and where the
     *  pass stopped (a speculative pass's end, before its seam cut). */
    from: number;
    to: number;
    landed: number;
    lastHint: number;
    /** The VAD's last speech chunk when it fired. */
    after: number;
    seconds: number;
    sent?: Sent;
    /** Came back with words, and moved the seam. */
    heard: boolean;
    committed: boolean;
    /** The turn's text once it came back. */
    text?: string;
    /** Speech-hint and VAD-speech chunks in the piece. */
    hints: number;
    voiced: number;
}

interface Sim {
    rule: Rule;
    clip: Clip;
    chunks: Chunk[];
    passes: SimPass[];
    /** The final's text; undefined when a reply is missing. */
    text: string | undefined;
    speechStart: number;
    lastSpeech: number;
    doneAt: number;
    /** Requests sent, their audio, and the seconds billed (per request, as
     *  the server meters). */
    requests: number;
    audio: number;
    billed: number;
}

/** What a pass's request comes back with, given the turn's text before it
 *  (sent as the prompt: priorPrompt): undefined when it has no reply (the cap,
 *  or a report-only run missing it). */
type Ask = (pcm: Int16Array, before: string, kind: SimPass['kind']) => Promise<{ text: string; sent?: Sent } | undefined>;

const atChunk = (c: number): number => (c + 1) * CHUNK_MS;

/**
 * One turn through WhisperPcmSttEngine.start()'s loop on incremental passes:
 * frames land every CHUNK_MS, the loop polls every 200 ms and blocks while a
 * pass is in flight (rttMs), the submit waits out the adaptive window and any
 * pass in flight, and the final reuses the last speculative text unless a
 * speech hint lies past the seam.
 */
async function simulateTurn(clip: Clip, chunks: Chunk[], rule: Rule, ask: Ask, maxPasses: number): Promise<Sim> {
    const firstSpeech = chunks.findIndex((c) => c.speech);
    // The engine's buffer holds the whole pre-buffer before the VAD's trip;
    // the clip kept only LEAD_KEEP_MS of it.
    const bufferOffset = ENGINE.preBufferFrames - Math.max(0, firstSpeech);
    const passes: SimPass[] = [];
    let lastSpeech = -1;
    let speechStart = -1;
    let lastHint = 0;
    let partialIncomplete = false;
    let seam = 0;
    let textSoFar = '';
    let specPasses = 0;
    let lastSpecSpeech = -2;
    let lastSpecText: string | null = null;
    let broken = false;
    let landed = 0;
    let pollAt = ENGINE.pollMs;
    let busyUntil = -Infinity;
    let pending: { at: number; apply: () => void } | null = null;
    let doneAt = -1;
    let hintAtSubmit = 0;
    let requests = 0;
    let audio = 0;
    let billed = 0;
    const window = (): number =>
        Math.min(ENGINE.silenceBaseMs + (atChunk(lastSpeech) - atChunk(speechStart)) * ENGINE.silenceRampRate, ENGINE.silenceMaxMs) +
        (partialIncomplete ? ENGINE.incompleteExtraMs : 0);
    const inPiece = (from: number, to: number): { hints: number; voiced: number } => {
        const cs = chunks.slice(from, to);
        return { hints: cs.filter(chunkHint).length, voiced: cs.filter((c) => c.speech).length };
    };
    const send = async (pcm: Int16Array, kind: SimPass['kind']) => {
        if (pcm.length === 0) return { text: '' };
        requests++;
        audio += secondsOf(pcm);
        billed += sttBilledSeconds(secondsOf(pcm), 'gpt-transcribe');
        return ask(pcm, textSoFar, kind);
    };

    while (doneAt < 0 && landed < chunks.length && !broken) {
        const nextLand = atChunk(landed);
        const nextPoll = pending ? Infinity : pollAt;
        if (pending && pending.at <= Math.min(nextLand, nextPoll)) {
            pending.apply();
            pending = null;
            continue;
        }
        if (nextPoll < nextLand) {
            const t = pollAt;
            pollAt += ENGINE.pollMs;
            if (speechStart < 0) continue;
            const bufferedMs = (landed + bufferOffset) * CHUNK_MS;
            const late = rule === 'today' ? bufferedMs > ENGINE.earlyMaxBufferMs : specPasses >= maxPasses - 1;
            const after = late ? Math.max(ENGINE.specSilenceMs, window() - ENGINE.terminalLeadMs) : ENGINE.specSilenceMs;
            if (t - atChunk(lastSpeech) < after || lastSpeech === lastSpecSpeech || specPasses >= maxPasses) continue;
            specPasses++;
            lastSpecSpeech = lastSpeech;
            lastSpecText = null;
            const cut = piecePayload(clip.pcm, chunks, seam, landed, lastHint, true);
            const reply = await send(cut.pcm, 'spec');
            const pass: SimPass = {
                kind: 'spec',
                firedAt: t,
                shownAt: t + rttMs(secondsOf(cut.pcm)),
                from: seam,
                to: cut.to,
                landed,
                lastHint,
                after: lastSpeech,
                seconds: secondsOf(cut.pcm),
                ...(reply?.sent ? { sent: reply.sent } : {}),
                heard: !!reply && !isNonSpeechOnly(reply.text),
                committed: false,
                ...inPiece(seam, cut.to),
            };
            passes.push(pass);
            if (!reply) broken = true;
            busyUntil = pass.shownAt;
            pollAt = pass.shownAt + ENGINE.pollMs;
            pending = {
                at: pass.shownAt,
                apply: () => {
                    if (!pass.heard) return;
                    const text = withPieceText(textSoFar, reply!.text);
                    pass.text = text;
                    if (cut.seam !== null) {
                        lastSpecText = text;
                        seam = cut.seam;
                        textSoFar = text;
                        pass.committed = true;
                    }
                    partialIncomplete = transcriptLooksIncomplete(text);
                },
            };
            continue;
        }
        const chunk = chunks[landed]!;
        const now = nextLand;
        landed++;
        if (chunk.speech) {
            if (speechStart < 0) speechStart = landed - 1;
            lastSpeech = landed - 1;
            partialIncomplete = false;
        }
        if (chunkHint(chunk)) lastHint = landed;
        if (!chunk.speech && speechStart >= 0 && now - atChunk(lastSpeech) >= window() && now >= busyUntil) {
            doneAt = now;
            hintAtSubmit = lastHint;
        }
    }
    if (pending) (pending as { apply: () => void }).apply();

    let text: string | undefined = broken ? undefined : textSoFar;
    if (!broken && doneAt >= 0) {
        if (lastSpecText !== null && lastSpeech === lastSpecSpeech && hintAtSubmit <= seam) {
            text = lastSpecText;
        } else {
            const cut = piecePayload(clip.pcm, chunks, seam, landed, hintAtSubmit, false);
            const seconds = secondsOf(cut.pcm);
            const final: SimPass = {
                kind: 'final',
                firedAt: doneAt,
                shownAt: doneAt,
                from: seam,
                to: cut.to,
                landed,
                lastHint: hintAtSubmit,
                after: lastSpeech,
                seconds,
                heard: false,
                committed: false,
                ...inPiece(seam, cut.to),
            };
            if (!(seam > 0 && seconds * 1000 < ENGINE.minFinalPieceMs)) {
                const reply = await send(cut.pcm, 'final');
                final.shownAt = doneAt + rttMs(seconds);
                if (reply?.sent) final.sent = reply.sent;
                if (!reply) text = undefined;
                else {
                    final.heard = !isNonSpeechOnly(reply.text);
                    text = withPieceText(textSoFar, reply.text);
                    final.text = text;
                }
            }
            passes.push(final);
        }
    }
    return { rule, clip, chunks, passes, text, speechStart, lastSpeech, doneAt, requests, audio, billed };
}

/** withPiece (whisper-pcm-stt.ts): a wordless reply adds nothing. */
function withPieceText(textSoFar: string, reply: string): string {
    if (!textSoFar) return reply;
    return isNonSpeechOnly(reply) ? textSoFar : joinTranscripts(textSoFar, reply);
}

const bareWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}'’]/gu, '');
// Join artifacts, read off a request's Sent (--set incremental and pauses).
/** The joined text kept a clip's closing period before a lowercase word. */
const periodJoin = (s: Sent): boolean =>
    !!s.before && /(?:^|[^.])\.$/u.test(s.before) && /^\p{Ll}/u.test(s.added ?? '') && !!s.joined?.startsWith(s.before);
/** The reply's first word is the text's last: a word heard on both sides of
 *  the cut, or the speaker saying it twice (--show tells them apart). */
const doubledAtJoin = (s: Sent): boolean =>
    !!s.before && !!s.added && bareWord(s.before.split(/\s+/).pop()!) !== '' &&
    bareWord(s.before.split(/\s+/).pop()!) === bareWord(s.added.split(/\s+/)[0]!);
/** A piece opening as a sentence (an unprompted one does): a capital the
 *  join kept after text that ends on no sentence end ("I" and its
 *  contractions aside). */
const capitalAtJoin = (s: Sent): boolean =>
    !!s.before && !!s.added && !!s.joined?.endsWith(s.added) &&
    !/[.!?…]["')\]]*$/u.test(s.before.trim()) && /^\p{Lu}/u.test(s.added) && !/^I(?!\p{L})/u.test(s.added);

interface PauseTurn {
    dir: string;
    clip: Clip;
    /** The model's whole pass on the clip. */
    ref: string;
    every: Sim;
    today: Sim;
    rebuilt: number;
    /** Where the capture's own passes before its last ended, in clip seconds. */
    captured: number[];
    /** Whole passes of the turn up to each committed mid-turn pass of `every`. */
    prefix: Array<{ pass: SimPass; whole: string | undefined }>;
}

interface PauseCapture {
    dir: string;
    lasts: Clip[];
    full: Cache;
    rerun: Cache;
    pieces: Cache;
    prefixes: Cache;
    rebuilt: Map<string, Rebuilt>;
    /** The capture's passes of each turn, by its last clip's name. */
    passesOf: Map<string, Clip[]>;
    wholeJobs: Job[];
    rerunJobs: Job[];
}

/** The committed mid-turn passes of a turn on `every`: the pauses a whole
 *  pass up to the same point is compared at (the terminal one is the final). */
const midPauses = (sim: Sim): SimPass[] => sim.passes.filter((p) => p.kind === 'spec' && p.committed && p.to <= sim.lastSpeech);

async function everyPause(dirs: string[], reportOnly: boolean, show: boolean, maxUsd: number, earlyWindow: number): Promise<void> {
    const model = modelFor('openai');
    const captures: PauseCapture[] = [];
    const pending: number[] = [];
    const runsAll = new Map<number, number>();

    for (const dir of dirs) {
        const capture = loadCapture(dir);
        const off = capture.filter((c) => Math.abs(c.pcm.length / CHUNK - Math.round(c.pcm.length / CHUNK)) * CHUNK > 1.5);
        if (off.length) throw new Error(`${dir}: ${off.length} clips are not whole ${ENGINE_FRAME}-sample frames at ${NATIVE_RATE} Hz.`);
        const lasts = byTurn(capture).map(lastOf).filter((c) => !isNonSpeechOnly(c.captured));
        const tracks = await sileroTracks(dir, lasts);
        const st: PauseCapture = {
            dir,
            lasts,
            full: readCache(dir, model.id),
            rerun: readCache(dir, armIds(model.id).rerun),
            pieces: readCache(dir, `${model.id}-pauses`),
            prefixes: readCache(dir, `${model.id}-prefix`),
            rebuilt: new Map(lasts.map((c) => [c.name, rebuildPauses(chunkTrack(c.pcm, tracks.get(c.name)!))])),
            passesOf: new Map(byTurn(capture).map((t) => [lastOf(t).name, t])),
            wholeJobs: [],
            rerunJobs: [],
        };
        st.wholeJobs = lasts.filter((c) => !usable(st.full[c.name])).map((clip) => ({ key: clip.name, clip }));
        st.rerunJobs = lasts.filter((c) => !usable(st.rerun[c.name])).map((clip) => ({ key: clip.name, clip }));
        for (const r of st.rebuilt.values()) for (const [k, v] of r.runs) runsAll.set(k, (runsAll.get(k) ?? 0) + v);
        captures.push(st);

        // Dry plan: every missing reply comes back with words. A wordless one
        // makes the chain send its piece again, which the running cap catches.
        if (reportOnly) continue;
        pending.push(...[...st.wholeJobs, ...st.rerunJobs].map((j) => j.clip.seconds));
        for (const clip of lasts) {
            const { chunks } = st.rebuilt.get(clip.name)!;
            const dry: Ask = async (pcm, before) => {
                const prompt = before ? priorPrompt(before) : undefined;
                const have = usable(st.pieces[`${clip.name}#${pcmHash(pcm)}`]);
                if (have && samePrompt(have, prompt)) return { text: have.text };
                pending.push(secondsOf(pcm));
                return { text: 'words' };
            };
            const sim = await simulateTurn(clip, chunks, 'every', dry, ENGINE.maxEveryPasses);
            for (const p of midPauses(sim)) {
                const whole = piecePayload(clip.pcm, chunks, 0, p.landed, p.lastHint, false).pcm;
                if (!usable(st.prefixes[`${clip.name}#${pcmHash(whole)}`])) pending.push(secondsOf(whole));
            }
        }
    }

    let spent = 0;
    let capped = false;
    if (!reportOnly) {
        const usd = total(pending, (s) => model.price(s));
        console.log(
            `To send: ${pending.length} requests, ${total(pending, (s) => s).toFixed(1)} s of audio, ` +
                `billed ${total(pending, model.billed).toFixed(0)} s = $${usd.toFixed(4)} (cap $${maxUsd}).`
        );
        if (usd > maxUsd) throw new Error('Over the cap: not sending.');
        if (pending.length && !env(model.needs)) throw new Error(`${model.needs} is not set.`);
    }
    /** The reply for `key`, sent when the cache lacks one with this prompt. */
    const fetchOnce = async (dir: string, id: string, cache: Cache, clip: Clip, key: string, pcm: Int16Array, prompt: string | undefined): Promise<Outcome | undefined> => {
        const have = usable(cache[key]);
        if (have && samePrompt(have, prompt)) return have;
        if (reportOnly) return undefined;
        const usd = model.price(secondsOf(pcm));
        if (spent + usd > maxUsd) {
            if (!capped) console.log(`Stopping at the $${maxUsd} cap: the rest is left unsent.`);
            capped = true;
            return undefined;
        }
        spent += usd;
        const out = await transcribeTimed(model, { ...clip, pcm, wav: wavOf(pcm), seconds: secondsOf(pcm) }, prompt);
        cache[key] = { ...out, ...(prompt !== undefined ? { prompt } : {}), seconds: secondsOf(pcm) };
        mkdirSync(join(dir, 'replay'), { recursive: true });
        writeFileSync(cachePath(dir, id), JSON.stringify(cache, null, 1));
        if (out.error) console.log(`${id}: ${out.error}`);
        return usable(cache[key]);
    };

    const turns: PauseTurn[] = [];
    const floor: Array<{ full: string; rerun: string }> = [];
    const boundaryFloor: Array<{ full: string; rerun: string }> = [];
    for (const st of captures) {
        const { dir, full, rerun } = st;
        for (const job of [...st.wholeJobs, ...st.rerunJobs]) {
            const isRerun = st.rerunJobs.includes(job);
            await fetchOnce(dir, isRerun ? armIds(model.id).rerun : model.id, isRerun ? rerun : full, job.clip, job.key, job.clip.pcm, undefined);
        }
        for (const clip of st.lasts) {
            const ref = usable(full[clip.name]);
            if (!ref) continue;
            const again = usable(rerun[clip.name]);
            if (again) floor.push({ full: ref.text, rerun: again.text });
            const { chunks, rebuilt } = st.rebuilt.get(clip.name)!;
            const ask: Ask = async (pcm, before) => {
                const prompt = before ? priorPrompt(before) : undefined;
                const key = `${clip.name}#${pcmHash(pcm)}`;
                const out = await fetchOnce(dir, `${model.id}-pauses`, st.pieces, clip, key, pcm, prompt);
                if (!out) return undefined;
                const s: Sent = { key, pass: clip, seconds: secondsOf(pcm), level: loudestDb(pcm), outcome: out, ...(prompt !== undefined ? { prompt } : {}) };
                if (!isNonSpeechOnly(out.text)) {
                    s.before = before;
                    s.added = out.text.trim();
                    s.joined = withPieceText(before, out.text);
                }
                return { text: out.text, sent: s };
            };
            const every = await simulateTurn(clip, chunks, 'every', ask, ENGINE.maxEveryPasses);
            const today = await simulateTurn(clip, chunks, 'today', async () => ({ text: 'Words.' }), ENGINE.maxPasses);
            const prefix: PauseTurn['prefix'] = [];
            if (every.text !== undefined) {
                for (const pass of midPauses(every)) {
                    const whole = piecePayload(clip.pcm, chunks, 0, pass.landed, pass.lastHint, false).pcm;
                    prefix.push({ pass, whole: (await fetchOnce(dir, `${model.id}-prefix`, st.prefixes, clip, `${clip.name}#${pcmHash(whole)}`, whole, undefined))?.text });
                }
            }
            const captured = st.passesOf.get(clip.name)!.slice(0, -1).map((c) => c.seconds);
            turns.push({ dir, clip, ref: ref.text, every, today, rebuilt, prefix, captured });
        }
        // The model against itself at the capture's own pass boundaries.
        for (const t of byTurn(loadCapture(dir).filter((c) => !isNonSpeechOnly(c.captured)))) {
            for (const c of t.slice(0, -1)) {
                const a = usable(full[c.name]);
                const b = usable(rerun[c.name]);
                if (a && b) boundaryFloor.push({ full: a.text, rerun: b.text });
            }
        }
    }
    if (!reportOnly) console.log(`Spent this run: $${spent.toFixed(4)}${capped ? ' (stopped at the cap)' : ''}.`);
    reportEveryPause(turns, runsAll, floor, boundaryFloor, show, earlyWindow);
}

/** The pass that first put timeline chunk `c` on screen: the first that came
 *  back with words over audio reaching past it. */
function shownBy(sim: Sim, c: number): SimPass | undefined {
    return sim.passes.filter((p) => (p.heard || sim.rule === 'today') && p.to > c).sort((a, b) => a.shownAt - b.shownAt)[0];
}

/** Each committed word's end on the timeline: a piece's words spread evenly
 *  over its VAD-speech chunks (else its hint chunks, else all of it). */
function wordEnds(sim: Sim): number[] {
    const ends: number[] = [];
    for (const p of sim.passes.filter((x) => (x.committed || (x.kind === 'final' && x.heard)) && x.sent?.added)) {
        const words = normalizeForWer(p.sent!.added!).length;
        const span = Array.from({ length: p.to - p.from }, (_, i) => p.from + i);
        const voiced = span.filter((c) => sim.chunks[c]!.speech);
        const at = voiced.length ? voiced : span.filter((c) => chunkHint(sim.chunks[c]!)).length ? span.filter((c) => chunkHint(sim.chunks[c]!)) : span;
        for (let i = 0; i < words && at.length; i++) ends.push(at[Math.max(0, Math.ceil(((i + 1) * at.length) / words) - 1)]!);
    }
    return ends;
}

function reportEveryPause(
    turns: PauseTurn[],
    runs: Map<number, number>,
    floorAll: Array<{ full: string; rerun: string }>,
    boundaryFloorAll: Array<{ full: string; rerun: string }>,
    show: boolean,
    earlyWindow: number
): void {
    // The pieces go out with LANGUAGE; a turn the whole pass heard as Chinese
    // (a voice in the room, or the meditator in 中文) is scored by no one.
    let floor = floorAll;
    let boundaryFloor = boundaryFloorAll;
    const han = (t: string): boolean => /\p{Script=Han}/u.test(t);
    const chinese = turns.filter((t) => han(t.ref));
    const ok = turns.filter((t) => t.every.text !== undefined && !chinese.includes(t));
    floor = floor.filter((f) => !han(f.full));
    boundaryFloor = boundaryFloor.filter((f) => !han(f.full));
    // Today's plan sends the same pieces (a short turn): its text is today's.
    const plan = (sim: Sim): string =>
        sim.passes.filter((p) => (sim.rule === 'every' ? !!p.sent : p.shownAt !== p.firedAt)).map((p) => `${p.from}-${p.to}`).join(',');
    const changed = ok.filter((t) => plan(t.every) !== plan(t.today));
    const ref = (t: PauseTurn): string => t.ref;
    const long = ok.filter((t) => t.clip.seconds > LONG_TURN_SECONDS);
    const pieceCount = (t: PauseTurn): number => t.every.passes.filter((p) => p.committed || (p.kind === 'final' && p.heard)).length;
    const joins = (t: PauseTurn): number => Math.max(0, pieceCount(t) - 1);
    const q = (xs: number[], p: number, digits = 1): string => (xs.length ? quantile(xs, p).toFixed(digits) : '-');

    console.log(
        `\nEvery pause: ${turns.length} spoken turns from ${new Set(turns.map((t) => t.dir)).size} captures, ${ok.length} with every reply ` +
            `(${long.length} over ${LONG_TURN_SECONDS} s), ${total(ok, (t) => t.clip.seconds).toFixed(0)} s of clips` +
            `${chinese.length ? `; ${chinese.length} left out whose whole pass is Chinese` : ''}. Reference: gpt-transcribe's whole pass on each turn's last clip.`
    );
    const runRow = Array.from({ length: 12 }, (_, i) => `${i + 1}:${runs.get(i + 1) ?? 0}`).join(' ');
    const longer = [...runs.entries()].filter(([k]) => k > 12).reduce((n, [, v]) => n + v, 0);
    console.log(
        `  Quiet runs between sounds, by length in ${CHUNK_MS.toFixed(0)} ms chunks: ${runRow} 13+:${longer}. ` +
            `Runs of ${ENGINE.compactKeep} rebuilt to ${PAUSE_REBUILT_MS} ms: ${total(turns, (t) => t.rebuilt)}.`
    );
    // Inside the capture engine's early window it fired a pass at every pause
    // of SPECULATIVE_SILENCE_MS, so there its passes are the pauses.
    let matched = 0;
    let missed = 0;
    let extra = 0;
    for (const t of ok) {
        const until = Math.min(earlyWindow, t.clip.seconds - 1.5);
        const clipAt = (i: number): number => {
            const c = t.every.chunks[Math.max(0, i - 1)]!;
            return (c.at + c.n) / SAMPLE_RATE;
        };
        const mine = t.every.passes
            .filter((p) => p.kind === 'spec')
            .map((p) => clipAt(Math.min(p.landed, p.lastHint + chunksIn(ENGINE.tailKeepMs))))
            .filter((x) => x < until);
        const theirs = t.captured.filter((x) => x < until);
        const used = new Set<number>();
        for (const x of theirs) {
            const k = mine.findIndex((y, i) => !used.has(i) && Math.abs(y - x) <= 1);
            if (k < 0) missed++;
            else {
                used.add(k);
                matched++;
            }
        }
        extra += mine.length - used.size;
    }
    console.log(
        `  Against the capture's own passes in each turn's first ${earlyWindow} s (its engine's early window: a pass at every pause): ` +
            `${matched} found within 1 s, ${missed} missed, ${extra} found where it fired none.`
    );

    // Words.
    const pooled = (ts: Array<{ ref: string; hyp: string }>): [string, string] => {
        const words = total(ts, (t) => normalizeForWer(t.ref).length);
        const errs = total(ts, (t) => wordErrorRate(t.ref, t.hyp) * normalizeForWer(t.ref).length);
        return [words ? pct(errs / words) : '-', `${ts.filter((t) => sameWords(t.ref, t.hyp)).length}/${ts.length}`];
    };
    const pairs = (ts: PauseTurn[]): Array<{ ref: string; hyp: string }> => ts.map((t) => ({ ref: ref(t), hyp: t.every.text! }));
    console.log('\nFinals against the whole pass (pooled WER, same words)');
    const wtab = [['text', 'turns', 'joins', 'WER', 'same']];
    wtab.push(['every pause, all turns', String(ok.length), String(total(ok, joins)), ...pooled(pairs(ok))]);
    wtab.push([`  over ${LONG_TURN_SECONDS} s`, String(long.length), String(total(long, joins)), ...pooled(pairs(long))]);
    wtab.push(['  the rule changes', String(changed.length), String(total(changed, joins)), ...pooled(pairs(changed))]);
    const alone = ok.filter((t) => !changed.includes(t));
    wtab.push(["  today's pieces already", String(alone.length), String(total(alone, joins)), ...pooled(pairs(alone))]);
    const edges = [0, ...SEAM_BUCKETS, Infinity];
    for (let i = 0; i < edges.length - 1; i++) {
        const ts = ok.filter((t) => joins(t) >= (i === 0 ? 0 : edges[i]! + 1) && joins(t) <= edges[i + 1]!);
        if (ts.length) wtab.push([`  ${i === 0 ? 0 : edges[i]! + 1}-${edges[i + 1] === Infinity ? '' : edges[i + 1]} joins`, String(ts.length), String(total(ts, joins)), ...pooled(pairs(ts))]);
    }
    wtab.push(['whole again (floor), finals', String(floor.length), '-', ...pooled(floor.map((f) => ({ ref: f.full, hyp: f.rerun })))]);
    wtab.push(['whole again (floor), earlier passes', String(boundaryFloor.length), '-', ...pooled(boundaryFloor.map((f) => ({ ref: f.full, hyp: f.rerun })))]);
    table(wtab);
    let near = 0;
    let far = 0;
    for (const t of ok) {
        const starts = pieceStarts(t.every.passes.filter((p) => p.committed || (p.kind === 'final' && p.heard)).map((p) => ({ text: p.sent?.added ?? '', seconds: p.seconds }))).slice(1);
        for (const e of wordEdits(ref(t), t.every.text!)) (starts.some((j) => Math.abs(e.at - j) <= 2) ? near++ : far++);
    }
    const allJoins = total(ok, joins);
    console.log(
        `  Word edits within two words of a join: ${near} (${allJoins ? (near / allJoins).toFixed(3) : '-'} per join); elsewhere: ${far}. ` +
            `Per-turn WER against joins: r = ${correlation(ok.map(joins), ok.map((t) => wordErrorRate(ref(t), t.every.text!))).toFixed(2)}.`
    );

    // End of turn.
    const held = transcriptLooksIncomplete;
    const mids = ok.flatMap((t) => t.prefix.filter((p) => p.whole !== undefined).map((p) => ({ t, stitched: p.pass.text!, whole: p.whole!, pass: p.pass })));
    const flipRow = (label: string, xs: Array<{ a: string; b: string }>, aName: string, bName: string): string[] => [
        label,
        String(xs.length),
        String(xs.filter((x) => held(x.a)).length),
        String(xs.filter((x) => held(x.b)).length),
        `${xs.filter((x) => held(x.a) && !held(x.b)).length} (${aName} only)`,
        `${xs.filter((x) => !held(x.a) && held(x.b)).length} (${bName} only)`,
    ];
    const todayHad = (t: PauseTurn, p: SimPass): boolean => t.today.passes.some((x) => x.kind === 'spec' && x.after === p.after);
    console.log('\nEnd-of-turn check (transcriptLooksIncomplete): whole pass against the stitched text at the same point');
    const etab = [['where', 'n', 'held: whole', 'held: stitched', 'whole holds, stitched not', 'stitched holds, whole not']];
    etab.push(flipRow('mid-turn pauses', mids.map((m) => ({ a: m.whole, b: m.stitched })), 'whole', 'stitched'));
    etab.push(flipRow('  where today fires no pass', mids.filter((m) => !todayHad(m.t, m.pass)).map((m) => ({ a: m.whole, b: m.stitched })), 'whole', 'stitched'));
    etab.push(flipRow('  floor: earlier passes whole twice', boundaryFloor.map((f) => ({ a: f.full, b: f.rerun })), 'first', 'second'));
    etab.push(flipRow('turn endings', ok.map((t) => ({ a: ref(t), b: t.every.text! })), 'whole', 'stitched'));
    etab.push(flipRow('  floor: finals whole twice', floor.map((f) => ({ a: f.full, b: f.rerun })), 'first', 'second'));
    table(etab);

    // Artifacts.
    const sent = ok.flatMap((t) => t.every.passes.filter((p) => p.sent).map((p) => ({ t, p, s: p.sent! })));
    const words = (x: { s: Sent }): boolean => !isNonSpeechOnly(x.s.outcome!.text);
    console.log('\nArtifacts in the replies');
    const atab = [['', 'n']];
    atab.push(['replies', String(sent.length)]);
    atab.push(['  empty or non-speech (piece sent again)', String(sent.filter((x) => !words(x)).length)]);
    atab.push(['pieces with no speech-hint chunk: with words', `${sent.filter((x) => x.p.hints === 0 && words(x)).length}/${sent.filter((x) => x.p.hints === 0).length}`]);
    atab.push([`pieces under ${QUIET_PIECE_DBFS} dBFS: with words`, `${sent.filter((x) => x.s.level < QUIET_PIECE_DBFS && words(x)).length}/${sent.filter((x) => x.s.level < QUIET_PIECE_DBFS).length}`]);
    atab.push(['finals sent after the terminal pass: with words', `${sent.filter((x) => x.p.kind === 'final' && words(x)).length}/${sent.filter((x) => x.p.kind === 'final').length}`]);
    atab.push(['capital mid-sentence at a join', String(sent.filter((x) => capitalAtJoin(x.s)).length)]);
    atab.push(['opens on the last word before (doubled)', String(sent.filter((x) => doubledAtJoin(x.s)).length)]);
    atab.push(['opens repeating 3+ words of the text before', String(sent.filter((x) => x.s.before && echoWords(x.s.before, x.s.added!)).length)]);
    atab.push(['". " then lowercase at a join', String(sent.filter((x) => periodJoin(x.s)).length)]);
    atab.push([`over ${DENSE_CHARS_PER_SECOND} chars/s of audio`, String(sent.filter((x) => x.s.outcome!.text.length / x.s.seconds > DENSE_CHARS_PER_SECOND).length)]);
    table(atab);

    // Cost.
    const sumBy = (ts: PauseTurn[], f: (s: Sim) => number, rule: Rule): number => total(ts, (t) => f(rule === 'every' ? t.every : t.today));
    console.log('\nRequests and billed seconds (per request, whole seconds rounded up, as /cloud/v1/stt meters gpt-transcribe)');
    const ctab = [['turns', 'rule', 'requests/turn p50/p90/max', 'audio sent s', 'billed s', 'billed vs today']];
    for (const [label, ts] of [['all', ok], [`>${LONG_TURN_SECONDS}s`, long]] as const) {
        for (const rule of ['today', 'every'] as const) {
            const reqs = ts.map((t) => (rule === 'every' ? t.every : t.today).requests);
            ctab.push([
                rule === 'today' ? label : '',
                rule === 'today' ? 'today (planned)' : 'every pause',
                `${q(reqs, 0.5, 0)}/${q(reqs, 0.9, 0)}/${reqs.length ? Math.max(...reqs) : '-'}`,
                sumBy(ts, (s) => s.audio, rule).toFixed(0),
                sumBy(ts, (s) => s.billed, rule).toFixed(0),
                rule === 'every' ? `+${pct(sumBy(ts, (s) => s.billed, 'every') / sumBy(ts, (s) => s.billed, 'today') - 1)}` : '',
            ]);
        }
    }
    table(ctab);
    const ratio = sumBy(ok, (s) => s.billed, 'every') / sumBy(ok, (s) => s.billed, 'today');
    const specs = ok.map((t) => t.every.passes.filter((p) => p.kind === 'spec').length);
    console.log(
        `  At GPT's ${GPT_CREDITS_PER_HOUR} credits per session hour today: ${(GPT_CREDITS_PER_HOUR * ratio).toFixed(2)} (+${(GPT_CREDITS_PER_HOUR * (ratio - 1)).toFixed(2)}). ` +
            `Speculative passes per turn on every pause: p50 ${q(specs, 0.5, 0)}, p90 ${q(specs, 0.9, 0)}, max ${Math.max(...specs)}; ` +
            [8, 12, 16, 24].map((cap) => `a cap of ${cap} binds on ${specs.filter((n) => n > cap).length}`).join(', ') + '.'
    );

    // Lag.
    const lagRows = [['words', 'rule', 'n', 'lag p50 s', 'lag p90 s', 'words >3 s before the end: p50', 'p90']];
    const turnRows = [['turns', 'rule', 'first text after onset p50 s', 'whole turn on screen after speech ends p50 s', 'p90', 'max']];
    for (const [label, ts] of [['all', ok], [`>${LONG_TURN_SECONDS}s`, long]] as const) {
        for (const rule of ['today', 'every'] as const) {
            const lags: number[] = [];
            const early: number[] = [];
            const firsts: number[] = [];
            const wholes: number[] = [];
            for (const t of ts) {
                const sim = rule === 'every' ? t.every : t.today;
                const end = atChunk(t.every.lastSpeech);
                for (const c of wordEnds(t.every)) {
                    const by = shownBy(sim, c);
                    if (!by) continue;
                    const lag = (by.shownAt - atChunk(c)) / 1000;
                    lags.push(lag);
                    if (atChunk(c) < end - 3000) early.push(lag);
                }
                const first = sim.passes.filter((p) => p.heard || rule === 'today').sort((a, b) => a.shownAt - b.shownAt)[0];
                if (first) firsts.push((first.shownAt - atChunk(sim.speechStart)) / 1000);
                const last = shownBy(sim, t.every.lastSpeech);
                if (last) wholes.push((last.shownAt - end) / 1000);
            }
            const r = rule === 'today' ? 'today' : 'every pause';
            lagRows.push([rule === 'today' ? label : '', r, String(lags.length), q(lags, 0.5), q(lags, 0.9), q(early, 0.5), q(early, 0.9)]);
            turnRows.push([rule === 'today' ? label : '', r, q(firsts, 0.5), q(wholes, 0.5), q(wholes, 0.9), wholes.length ? Math.max(...wholes).toFixed(1) : '-']);
        }
    }
    console.log(`\nDisplay lag: a word's end (its piece's words spread over its speech chunks) to the pass that shows it, requests at ${rttMs(0)} ms + ${rttMs(1) - rttMs(0)} ms per audio second`);
    table(lagRows);
    table(turnRows);
    const measured = sent.filter((x) => x.s.outcome?.ms !== undefined);
    console.log(
        `  Measured request ms on the pieces this run sent: p50 ${q(measured.map((x) => x.s.outcome!.ms), 0.5, 0)}, p90 ${q(measured.map((x) => x.s.outcome!.ms), 0.9, 0)} ` +
            `(the model gives ${q(measured.map((x) => rttMs(x.s.seconds)), 0.5, 0)} / ${q(measured.map((x) => rttMs(x.s.seconds)), 0.9, 0)} for the same pieces).`
    );

    if (!show) {
        console.log('\n(--show lists each failure with a few words around it.)');
        return;
    }
    const words3 = (t: string, from: number, n = 3): string => t.split(/\s+/).filter(Boolean).slice(Math.max(0, from), Math.max(0, from) + n).join(' ');
    const tail = (t: string, n = 3): string => t.split(/\s+/).filter(Boolean).slice(-n).join(' ');
    console.log('\nWord edits (op @ hyp word index, * within two words of a join):');
    for (const t of ok) {
        const edits = wordEdits(ref(t), t.every.text!);
        if (!edits.length) continue;
        const starts = pieceStarts(t.every.passes.filter((p) => p.committed || (p.kind === 'final' && p.heard)).map((p) => ({ text: p.sent?.added ?? '', seconds: p.seconds }))).slice(1);
        console.log(`  ${t.clip.name} (${t.clip.seconds.toFixed(0)} s, ${joins(t)} joins): ${edits.map((e) => `${starts.some((j) => Math.abs(e.at - j) <= 2) ? '*' : ''}${e.op}@${e.at}`).join('  ')}`);
    }
    console.log('\nEnd-of-turn flips:');
    for (const m of mids) if (held(m.whole) !== held(m.stitched)) console.log(`  pause ${m.t.clip.name}: ${held(m.whole) ? 'whole' : 'stitched'} holds. whole "...${tail(m.whole)}" stitched "...${tail(m.stitched)}"`);
    for (const t of ok) if (held(ref(t)) !== held(t.every.text!)) console.log(`  ending ${t.clip.name}: ${held(ref(t)) ? 'whole' : 'stitched'} holds. whole "...${tail(ref(t))}" stitched "...${tail(t.every.text!)}"`);
    console.log('\nReplies worth a look:');
    for (const x of sent) {
        const w = x.s.outcome!.text;
        if (words(x) && (x.p.hints === 0 || x.s.level < QUIET_PIECE_DBFS)) console.log(`  quiet piece ${x.s.key} (${x.s.seconds.toFixed(1)} s, ${x.s.level.toFixed(0)} dBFS, ${x.p.hints} hint chunks): "${words3(w, 0, 4)}"`);
        if (capitalAtJoin(x.s)) console.log(`  capital ${x.s.key}: ...${tail(x.s.before!)} | ${words3(x.s.added!, 0)}`);
        if (doubledAtJoin(x.s)) console.log(`  doubled ${x.s.key}: ...${tail(x.s.before!)} | ${words3(x.s.added!, 0)}`);
    }
}

function correlation(xs: number[], ys: number[]): number {
    const mx = mean(xs);
    const my = mean(ys);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < xs.length; i++) {
        sxy += (xs[i]! - mx) * (ys[i]! - my);
        sxx += (xs[i]! - mx) ** 2;
        syy += (ys[i]! - my) ** 2;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
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
    const runsArg = take('--runs');
    const runs = Number(runsArg ?? 3);
    const refId = take('--ref') ?? 'openai';
    const reportOnly = has('--report');
    const show = has('--show');
    const maxUsd = Number(take('--max-usd') ?? 0.2);
    // --set pauses: the capture engine's early window, in clip seconds. About
    // 10 before 2026-10-08's 2b0a5a14 (a 12 s buffer), about 4 on hosted STT
    // after it.
    const earlyWindow = Number(take('--early-window') ?? 4);
    const dir = args[0];
    if (!dir) {
        console.error('Usage: npm run stt:replay -- <capture-dir> [--models a,b] [--set noise|battery,finals,passes|incremental|latency|pauses] [--runs 3] [--ref openai|capture] [--report] [--show] [--max-usd 0.2]');
        process.exit(2);
    }
    if (sets.has('incremental')) {
        if (sets.size > 1) throw new Error('--set incremental runs on its own.');
        return incremental(dir, modelIds, reportOnly, show, maxUsd);
    }
    if (sets.has('pauses')) {
        if (sets.size > 1 || modelIds.join(',') !== 'openai') throw new Error('--set pauses runs on its own, on openai (gpt-transcribe).');
        return everyPause(args, reportOnly, show, maxUsd, earlyWindow);
    }
    if (sets.has('latency')) {
        if (sets.size > 1) throw new Error('--set latency runs on its own.');
        return latencyProbe(dir, modelIds, Number(runsArg ?? 1), reportOnly, maxUsd);
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
