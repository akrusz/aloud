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
 *   npm run stt:replay -- <capture-dir> --report --show      (no calls; print where models differ)
 *
 * Models: `openai` and `groq` go through the server's own forwarder
 * (transcribeWhisper), so the request is the production one. `azure` is
 * MAI-Transcribe-2 on the Speech key, verbatim by default (it writes down
 * every "um" and cut-off word); `azure:clean` asks for its tidied style.
 * `or:<id>` is any model on OpenRouter's transcription API, which lists most
 * of the field behind one key.
 *
 * THE CLIPS ARE SOMEONE'S MEDITATION and a capture never leaves the device on
 * its own: every model named here receives that voice. `--set noise` is the
 * exception (generated noise, read from no file), so gate a new model on it
 * first and send speech only to what passes.
 * A model that invents a sentence on silence takes the meditator's turn with
 * it; nothing else about it matters after that.
 *
 * Results cache per model in <capture-dir>/replay/, so a rerun re-sends
 * nothing and `--report` is free. Transcript text prints only with --show.
 *
 * Keys come from ts/server/.env or the environment: OPENAI_API_KEY,
 * GROQ_API_KEY, AZURE_SPEECH_KEY + AZURE_SPEECH_REGION, OPENROUTER_API_KEY.
 * Latency is from this machine, and OpenRouter adds a hop.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transcriptLooksIncomplete } from '../src/facilitation/end-of-turn.js';
import { isNonSpeechOnly } from '../src/platform/stt.js';
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
}

interface Heard {
    text: string;
    costUsd?: number;
    billedSeconds?: number;
}

interface Model {
    id: string;
    /** Env var that must be set for the model to run. */
    needs: string;
    transcribe(clip: Clip): Promise<Heard>;
    /** Dollars for one request of `seconds`, used when the call reports none. */
    price(seconds: number): number;
    /** Where `price` is a list rate we could not confirm against a bill. */
    priceNote?: string;
}

const env = (name: string): string => process.env[name] ?? '';

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
        async transcribe(clip) {
            const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
            const withTimeout: typeof fetch = (input, init) => fetch(input, { ...init, signal });
            const r = await transcribeWhisper(int16ToFloat32(clip.pcm), SAMPLE_RATE, backend(), LANGUAGE, withTimeout);
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

function modelFor(id: string): Model {
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
    throw new Error(`Unknown model "${id}". Use openai, groq, azure, azure:clean, or or:<openrouter-model-id>.`);
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
    text: string;
}

function captureIndex(dir: string): ClipMeta[] {
    type Entry = { file?: string; turn: number; seconds: number; text: string };
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

function loadCapture(dir: string): Clip[] {
    const clips: Clip[] = captureIndex(dir).map((meta) => {
        const name = meta.name;
        const wav = new Uint8Array(readFileSync(join(dir, `${name}.wav`)));
        const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
        if (v.getUint32(24, true) !== SAMPLE_RATE || v.getUint16(22, true) !== 1) {
            throw new Error(`${name}.wav is not ${SAMPLE_RATE} Hz mono (the recorder's format)`);
        }
        const pcm = new Int16Array((wav.byteLength - 44) >> 1);
        for (let i = 0; i < pcm.length; i++) pcm[i] = v.getInt16(44 + i * 2, true);
        return { name, seconds: meta.seconds, pcm, wav, captured: meta.text, turn: meta.turn, last: false };
    });
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

async function run(dir: string, model: Model, jobs: Job[]): Promise<void> {
    const cache = readCache(dir, model.id);
    const todo = jobs.filter((j) => !cache[j.key] || cache[j.key]!.error);
    if (todo.length === 0) return;
    if (!env(model.needs)) {
        console.log(`${model.id}: skipped, ${model.needs} is not set`);
        return;
    }
    mkdirSync(join(dir, 'replay'), { recursive: true });
    let failed = 0;
    for (const [i, job] of todo.entries()) {
        let t0 = performance.now();
        try {
            let heard: Heard | undefined;
            // A free tier's requests-per-minute cap (Groq: 20) is not a failure.
            for (let attempt = 0; heard === undefined; attempt++) {
                t0 = performance.now();
                try {
                    heard = await model.transcribe(job.clip);
                } catch (err) {
                    if (attempt >= 3 || !/ 429[: ]/.test(String(err))) throw err;
                    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
                }
            }
            cache[job.key] = { ...heard, ms: Math.round(performance.now() - t0) };
        } catch (err) {
            failed++;
            cache[job.key] = { text: '', ms: Math.round(performance.now() - t0), error: String(err).slice(0, 300) };
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
    const dir = args[0];
    if (!dir) {
        console.error('Usage: npm run stt:replay -- <capture-dir> [--models a,b] [--set noise|battery,finals,passes] [--runs 3] [--ref openai|capture] [--report] [--show]');
        process.exit(2);
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

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
