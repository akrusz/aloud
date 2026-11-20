/**
 * How a hosted voice holds up on what it is sent, and what keeps the voice
 * and loses a fault: renders facilitator lines N times each through the
 * server's own path (routes/tts.ts synthFor), sent as one input, as the
 * client sends a streamed reply (one synthesis per sentence chunk, ui
 * streaming-tts.ts splitOffSentences), as everything after the first chunk,
 * or under a variant (another model, the style off, a clause split, a spoken
 * lead, a trailing word cut off again). Then hears every take with the
 * renderer's gate (voice-clips/analysis.ts bursts, voice-clips/transcript.ts
 * on local Whisper), its length against its line's median, and its pauses
 * inside a clause (voice-clips/cadence.ts), and each sentence on its own:
 * cut at the pauses that fall at the sentence ends, heard alone for a lost
 * opening word, with its onset rise, pace and level, and the silence after
 * it, inside an input or between two clips. The synth step times every
 * provider call (first byte, whole body). Run from ts/, the Whisper steps at
 * low priority:
 *
 *   tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts synth   --out <dir> [--env <.env>] [--rounds <n>] [--variants <a,b>] [--dry-run]
 *   taskpolicy -b nice -n 10 tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts analyze --out <dir> [--whisper-bin <path>]
 *   taskpolicy -b nice -n 10 tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts recheck --out <dir> [--whisper-bin <path>]
 *   tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts gaps    --out <dir>
 *   tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts report  --out <dir>
 *   tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts bill    [--sessions <dir>] [--since YYYY-MM-DD]
 *
 * recheck hears each burst of a take with more bursts than phrases, or a long
 * one, on its own. gaps measures every silence of every take from the PCM
 * alone, for the report's played-silence section. bill prices LINES, and the
 * replies in the desktop app's session logs, sent per chunk, first chunk
 * alone and the rest as one, and whole (billedCharsFor). A variant may also
 * carry SSML the route would escape (a <break> between sentences, an
 * mstts:silence, sentence elements, <voice> parameters), sent through the
 * probe's own Azure call. The plan (voices, variants, lines, takes, spend
 * cap) is PLAN below, as last run (Ethan per sentence against whole replies,
 * 2026-11-20); edit it and run again: every step picks up where the last run
 * stopped. Synthesis is sequential with a pause, backs off on 429, and stops
 * before the cap, which covers every take in <dir>/takes.jsonl. Every take
 * is kept under <dir>/<variant>/.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseTurnSignals } from '../../src/facilitation/index.js';
import { splitOffSentences } from '../../ui/src/streaming-tts.js';
import { loadConfig } from '../src/config.js';
import { ttsRateFor } from '../src/pricing/providers.js';
import { withGain } from '../src/providers/mp3-gain.js';
import { withLeadSilence } from '../src/providers/mp3-lead-silence.js';
import { TtsUpstreamError, azureBilledChars, isProviderAccountFailure } from '../src/providers/tts.js';
import { resolveVoice, type ResolvedVoice } from '../src/providers/voice-catalog.js';
import { billedCharsFor, leadFor, synthFor } from '../src/routes/tts.js';
import { analyzePcm, clipFaults, phraseCount, spokenChars, windowDb } from './voice-clips/analysis.js';
import { PAUSE_CAP_S, findPauses, pauseMarks } from './voice-clips/cadence.js';
import { MIN_HEARD_WORDS, align, missingWords, repeatedWords, transcribe, words, type Whisper } from './voice-clips/transcript.js';

type Send = 'whole' | 'chunks' | 'rest';

interface Variant {
    label: string;
    /** The curated voice (voice-catalog); PLAN.voice when absent. */
    voice?: string;
    /** Its provider voice; the curated voice's when absent. */
    voiceId?: string;
    /** Express-as style: the curated voice's when absent, none when null. */
    style?: string | null;
    /** A spoken lead the route cuts off again (CuratedVoice.lead); the
     *  curated voice's own lead applies without it. */
    lead?: string;
    /** A word spoken after the text and cut off here (a tail guard). */
    tail?: string;
    /** Each line sent as its SPLITS parts, one synthesis each. */
    split?: boolean;
    /** How a line goes out: as one input (whole, the default); as the client
     *  sends a streamed reply, one synthesis per sentence chunk (chunks); or
     *  everything after its first chunk as one input (rest). */
    send?: Send;
    /** SSML put between the sentences of each input (a <break>), or an
     *  mstts:silence element ahead of its text: sent through the probe's own
     *  Azure call (ssmlSynthFor), since the route escapes markup. */
    between?: string;
    silence?: string;
    /** Each sentence of an input in its own SSML element (s, p). */
    sentenceTag?: string;
    /** A parameters attribute on <voice> (HD voices: temperature=0.5). */
    voiceParams?: string;
    /** Line numbers (1-based); all when absent. */
    lines?: number[];
    takes: number;
}

/** Facilitator replies in the app's register: consonant openings after the
 *  first sentence, a very short second sentence, a question followed by a
 *  statement, a short opener the client merges into the next sentence. */
const LINES = [
    "That makes sense. What's the tightness like right now? Take your time with it.",
    'Notice where the breath is easiest to feel. Take your time. Let it move on its own.',
    'Where do you feel the clenching most? Stay with that spot for a little while.',
    'Some joy, and room around it. Nothing needs to happen with that. Just let it be there. Where is it in your body?',
    'Okay. Stay with that pressure for a moment. Does it feel firm, soft, or somewhere in between?',
    // Longer replies, four to six sentences.
    'Good. Let your attention rest on that warmth in your chest. Notice whether it stays in one place or moves. There is no need to hold on to it. What do you notice now?',
    "Okay. Breathing in, feel the air at the nostrils. Breathing out, let the shoulders soften a little. If the mind wanders, that's fine. Just come back to the breath. How does it feel right now?",
    "It sounds like there's a lot of restlessness in the body today, and that's okay. See if you can find the place where it's strongest, without trying to change it. Maybe it has a shape, or a temperature, or a movement to it. Tell me what you find when you're ready.",
];

/** Lines split at their clause comma (the split variant). */
const SPLITS: Record<number, string[]> = {};

const PLAN: { voice: string; variants: Variant[]; capUsd: number; pauseMs: number } = {
    voice: 'Ethan',
    variants: [
        // The two arms (2026-11-20, spread over an hour with --rounds 1 and
        // --variants): as the client sends a reply today, and the whole reply
        // in one input. Takes 1-3 of ethan-whole on L1-5 come from the
        // 2026-11-19 harper-batch run. Chunks stopped at four to pay for
        // pilot-temp.
        { label: 'ethan-chunks', send: 'chunks', takes: 4 },
        { label: 'ethan-whole', send: 'whole', lines: [1, 2, 3, 4, 5], takes: 14 },
        { label: 'ethan-whole', send: 'whole', lines: [6, 7, 8], takes: 11 },
        // Can the gap inside one input be set from the request? None of these
        // capped it: 2.95s under a 300ms break, 4.84s under an exact 300ms
        // sentence-boundary silence, 4.00s with each sentence in <s>, 3.44s at
        // temperature 0.3 (HD voices take one on <voice>, unbilled; MAI
        // accepts the attribute, whether it acts is unknown).
        { label: 'pilot-break', send: 'whole', between: '<break time="300ms"/>', lines: [6, 4], takes: 2 },
        { label: 'pilot-silence', send: 'whole', silence: '<mstts:silence type="Sentenceboundary-exact" value="300ms"/>', lines: [6, 4], takes: 2 },
        { label: 'pilot-s', send: 'whole', sentenceTag: 's', lines: [6, 4], takes: 2 },
        { label: 'pilot-temp', send: 'whole', voiceParams: 'temperature=0.3', lines: [4, 6, 7, 8], takes: 2 },
    ],
    // Half a dollar for the job, plus the $0.0323 the copied takes cost then.
    capUsd: 0.49 + 0.0323,
    pauseMs: 1200,
};

/** A take this far over its line's median voiced length is a candidate. */
const LONG_OVER_MEDIAN = 0.15;
const DECODE_RATE = 24_000;
const WHISPER_PAUSE_MS = 1500;
/** A longer rest after this many Whisper runs, so the machine is never busy for long. */
const WHISPER_REST_EVERY = 15;
const WHISPER_REST_MS = 15_000;

/** One provider call, timed from the request: headers, first body byte, last. */
interface ProviderCall {
    headersMs: number;
    firstByteMs: number;
    totalMs: number;
}

interface PartRow {
    /** What this synthesis was sent (a tail take: without its guard). */
    text: string;
    file: string;
    billedChars: number;
    /** synthFor's whole call: every provider call, the lead's cut, the gain. */
    ms: number;
    calls: ProviderCall[];
    /** The route spoke its lead ahead of the text and cut it off again. */
    led: boolean;
    /** A lead take re-rolled once, or said without its lead in the end. */
    leadReroll?: boolean;
    leadDropped?: boolean;
}

interface TakeRow {
    /** The variant's label. */
    model: string;
    voice: string;
    voiceId: string;
    send?: Send;
    line: number;
    take: number;
    /** What the take should say, and where its first sentence sits in the line (1-based). */
    text: string;
    firstPos: number;
    /** The audio to judge: the take, the parts back to back, or the tail cut off. */
    file: string;
    parts: PartRow[];
    /** A tail take as synthesized. */
    raw?: string;
    billedChars: number;
    usd: number;
    ms: number;
    at: string;
}

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keys from a server .env into process.env, without echoing any. */
function loadEnvFile(path: string): void {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m) continue;
        let value = m[2]!;
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (value && process.env[m[1]!] === undefined) process.env[m[1]!] = value;
    }
}

function isTransient(err: unknown): boolean {
    if (!(err instanceof TtsUpstreamError) || isProviderAccountFailure(err)) return false;
    return err.status === null || err.status === 429 || err.status >= 500;
}

function readRows(out: string): TakeRow[] {
    const log = join(out, 'takes.jsonl');
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as TakeRow) : [];
}

const voiceOf = (v: Variant) => v.voice ?? PLAN.voice;

function resolvedFor(v: Variant): ResolvedVoice {
    const r: ResolvedVoice = { ...resolveVoice(voiceOf(v)) };
    if (v.voiceId) r.voiceId = v.voiceId;
    if (v.style === null) delete r.style;
    else if (v.style) r.style = v.style;
    if (v.lead) r.lead = v.lead;
    return r;
}

/** The SSML body of an input under a markup variant (Variant.between,
 *  silence), escaped and styled as providers/tts.ts azureSsmlBody does. */
function ssmlInner(v: Variant, r: ResolvedVoice, text: string): string {
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    const tag = (x: string) => (v.sentenceTag ? `<${v.sentenceTag}>${x}</${v.sentenceTag}>` : x);
    const body = v.between || v.sentenceTag ? sentencesOf(text).map((x) => tag(esc(x))).join(v.between ? `${v.between} ` : '') : esc(text);
    return (v.silence ?? '') + (r.style ? `<mstts:express-as style="${r.style}">${body}</mstts:express-as>` : body);
}

const markupVariant = (v: Variant) => !!(v.between || v.silence || v.sentenceTag || v.voiceParams);

/** What an input bills, markup variants included (Azure bills everything
 *  inside <voice>; English text, so no doubled characters). */
function plannedChars(v: Variant, r: ResolvedVoice, input: string): number {
    return markupVariant(v) ? ssmlInner(v, r, input).length : billedCharsFor(r, input, 1);
}

/** The route's Azure path (synthFor: no lead, the lead-silence pad, the
 *  voice's gain) for a markup variant, which the route would escape. */
function ssmlSynthFor(config: { azureSpeechKey?: string; azureSpeechRegion: string }, r: ResolvedVoice, v: Variant) {
    const key = config.azureSpeechKey;
    if (!key || r.provider !== 'azure' || r.lead) throw new Error('a markup variant needs an Azure key and a voice without a lead');
    return async (text: string, _rate?: number, _extraBilled?: (chars: number) => void): Promise<Uint8Array> => {
        const ssml =
            `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">` +
            `<voice name="${r.voiceId}"${v.voiceParams ? ` parameters="${v.voiceParams}"` : ''}>${ssmlInner(v, r, text)}</voice></speak>`;
        let res: Response;
        try {
            res = await globalThis.fetch(`https://${config.azureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
                method: 'POST',
                headers: { 'Ocp-Apim-Subscription-Key': key, 'content-type': 'application/ssml+xml', 'x-microsoft-outputformat': 'audio-24khz-96kbitrate-mono-mp3', 'user-agent': 'aloud-cloud-tts' },
                body: ssml,
            });
        } catch (err) {
            throw new TtsUpstreamError(`Azure TTS: ${String(err)}`, null);
        }
        if (!res.ok) throw new TtsUpstreamError(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
        const mp3 = withLeadSilence(new Uint8Array(await res.arrayBuffer()));
        return r.gainDb ? withGain(mp3, r.gainDb) : mp3;
    };
}

/** A reply as the client sends it: the sentence chunks splitOffSentences
 *  completes while it streams, then what is left at the end. */
function clientChunks(text: string): string[] {
    const { complete, remainder } = splitOffSentences(text);
    return remainder.trim() ? [...complete, remainder.trim()] : complete;
}

/** Sentences at the client's boundary (.!? after a non-mark, then a space),
 *  without its merging of short ones. */
const sentencesOf = (text: string) =>
    text
        .split(/(?<=[^.!?][.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

/** What one take of `line` sends, one string per synthesis; none when the
 *  variant has nothing to send for it (the rest of a one-chunk reply). */
function inputsFor(v: Variant, line: number): string[] {
    const text = LINES[line - 1]!;
    if (v.split && SPLITS[line]) return SPLITS[line]!;
    if (v.tail) return [`${text} ${v.tail}`];
    if (v.send === 'chunks') return clientChunks(text);
    if (v.send === 'rest') {
        const rest = clientChunks(text).slice(1).join(' ');
        return rest ? [rest] : [];
    }
    return [text];
}

/** Where a take's first sentence sits in its line, 1-based. */
const firstPosFor = (v: Variant, line: number) =>
    v.send === 'rest' ? sentencesOf(clientChunks(LINES[line - 1]!)[0]!).length + 1 : 1;

const linesOf = (v: Variant) => (v.lines ?? LINES.map((_, i) => i + 1)).filter((line) => inputsFor(v, line).length);

/** Every provider call made through fetch, timed. The body is read here and
 *  handed on whole, which is all synthesizeWithAzure does with it. */
const providerCalls: ProviderCall[] = [];
function timeProviderCalls(): void {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const t0 = performance.now();
        const res = await realFetch(input, init);
        const headersMs = performance.now() - t0;
        if (!res.ok || !res.body) return res;
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let firstByteMs = -1;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (firstByteMs < 0) firstByteMs = performance.now() - t0;
            chunks.push(value);
        }
        providerCalls.push({ headersMs, firstByteMs, totalMs: performance.now() - t0 });
        return new Response(Buffer.concat(chunks), { status: res.status, headers: res.headers });
    }) as typeof fetch;
}

async function synthPhase(out: string, dryRun: boolean): Promise<void> {
    const envFile = arg('--env') ?? resolve(import.meta.dirname, '..', '.env');
    if (existsSync(envFile)) loadEnvFile(envFile);
    const config = loadConfig();
    const rows = readRows(out);
    const done = new Set(rows.map((r) => r.file));
    const spentBefore = rows.reduce((s, r) => s + r.usd, 0);
    // --variants a,b: only those labels this run (to space one out over time).
    const only = arg('--variants')?.split(',');
    const variants = PLAN.variants.filter((v) => !only || only.includes(v.label));

    let planned = 0;
    for (const v of variants) {
        const r = resolvedFor(v);
        const rate = ttsRateFor(r.provider, r.voiceId);
        let usd = 0;
        for (const line of linesOf(v)) {
            for (let take = 1; take <= v.takes; take++) {
                if (done.has(join(v.label, `L${line}-t${take}.mp3`))) continue;
                usd += inputsFor(v, line).reduce((s, t) => s + plannedChars(v, r, t), 0) * rate;
            }
        }
        planned += usd;
        console.log(
            `${v.label.padEnd(14)} ${voiceOf(v)} ${r.voiceId} style=${r.style ?? '-'} lead=${r.lead ?? '-'} send=${v.send ?? 'whole'}` +
                `${v.tail ? ` tail=${v.tail}` : ''}${v.split ? ' split' : ''}: lines ${linesOf(v).join(',')} x ${v.takes}, to do $${usd.toFixed(4)}`
        );
    }
    console.log(`spent $${spentBefore.toFixed(4)}, planned $${planned.toFixed(4)} more (a lead re-roll bills again), cap $${PLAN.capUsd}`);
    if (spentBefore + planned > PLAN.capUsd) throw new Error('plan is over the cap; cut takes');
    if (dryRun) return;

    timeProviderCalls();
    mkdirSync(out, { recursive: true });
    const log = join(out, 'takes.jsonl');
    let spent = spentBefore;
    // Each variant's missing takes in rounds, a take of every line per round
    // and the variants interleaved, so drift at the provider over the run
    // spreads across every line and variant, extensions of an old one too.
    const missing = variants.map((v) => {
        const takes: number[] = [];
        for (let take = 1; take <= v.takes; take++) {
            if (linesOf(v).some((line) => !done.has(join(v.label, `L${line}-t${take}.mp3`)))) takes.push(take);
        }
        return takes;
    });
    const rounds = Math.min(Number(arg('--rounds') ?? Infinity), Math.max(...missing.map((m) => m.length)));
    for (let round = 0; round < rounds; round++) {
        for (const [vi, v] of variants.entries()) {
            const take = missing[vi]![round];
            if (take === undefined) continue;
            const resolved = resolvedFor(v);
            const synth = markupVariant(v) ? ssmlSynthFor(config, resolved, v) : synthFor(config, resolved);
            if (!synth) throw new Error(`no ${resolved.provider} key`);
            const rate = ttsRateFor(resolved.provider, resolved.voiceId);
            for (const line of linesOf(v)) {
                const file = join(v.label, `L${line}-t${take}.mp3`);
                if (done.has(file)) continue;
                const inputs = inputsFor(v, line);
                const planned = inputs.reduce((s, t) => s + plannedChars(v, resolved, t), 0);
                if (spent + planned * rate > PLAN.capUsd) throw new Error(`stopping before the cap at $${spent.toFixed(4)}`);
                const started = performance.now();
                const clips: Uint8Array[] = [];
                const parts: PartRow[] = [];
                for (const [pi, input] of inputs.entries()) {
                    const part: PartRow = {
                        text: v.tail ? LINES[line - 1]! : input,
                        file: inputs.length > 1 ? join(v.label, `L${line}-t${take}-${'abcdefgh'[pi]}.mp3`) : file,
                        billedChars: plannedChars(v, resolved, input),
                        ms: 0,
                        calls: [],
                        led: false,
                    };
                    const callsBefore = providerCalls.length;
                    const partStarted = performance.now();
                    for (let attempt = 0; ; attempt++) {
                        try {
                            clips.push(
                                await synth(input, 1, (chars) => {
                                    part.billedChars += chars;
                                    // The text alone, without its lead, is the fallback.
                                    if (chars === azureBilledChars(input, 1, resolved.style)) part.leadDropped = true;
                                    else part.leadReroll = true;
                                })
                            );
                            break;
                        } catch (err) {
                            if (attempt >= 3 || !isTransient(err)) throw err;
                            console.log(`  ${file}: ${String(err).slice(0, 120)}; backing off`);
                            await sleep(2000 * 2 ** attempt);
                        }
                    }
                    part.ms = Math.round(performance.now() - partStarted);
                    part.calls = providerCalls.slice(callsBefore).map((c) => ({
                        headersMs: Math.round(c.headersMs),
                        firstByteMs: Math.round(c.firstByteMs),
                        totalMs: Math.round(c.totalMs),
                    }));
                    part.led = leadFor(resolved, input) !== null && !part.leadDropped;
                    parts.push(part);
                    if (inputs.length > 1) await sleep(PLAN.pauseMs / 2);
                }
                const billedChars = parts.reduce((s, p) => s + p.billedChars, 0);
                spent += billedChars * rate;
                mkdirSync(join(out, v.label), { recursive: true });
                let raw: string | undefined;
                if (clips.length > 1) {
                    clips.forEach((c, i) => writeFileSync(join(out, parts[i]!.file), c));
                    // MP3 frames concatenate cleanly (mp3-lead-silence.ts does
                    // the same): the parts as played back to back, less the
                    // client's handover between two clips.
                    writeFileSync(join(out, file), Buffer.concat(clips));
                } else if (v.tail) {
                    // Cut off in the analysis step, which writes `file`.
                    raw = join(v.label, `L${line}-t${take}-raw.mp3`);
                    writeFileSync(join(out, raw), clips[0]!);
                } else writeFileSync(join(out, file), clips[0]!);
                const full: TakeRow = {
                    model: v.label,
                    voice: voiceOf(v),
                    voiceId: resolved.voiceId,
                    ...(v.send ? { send: v.send } : {}),
                    line,
                    take,
                    text: v.tail ? LINES[line - 1]! : inputs.join(' '),
                    firstPos: firstPosFor(v, line),
                    file,
                    parts,
                    ...(raw ? { raw } : {}),
                    billedChars,
                    usd: billedChars * rate,
                    ms: Math.round(performance.now() - started),
                    at: new Date().toISOString(),
                };
                appendFileSync(log, JSON.stringify(full) + '\n');
                const notes = parts.map((p) => (p.leadReroll ? 'R' : '') + (p.leadDropped ? 'D' : '')).join('');
                console.log(`  ${file.padEnd(26)} ${parts.map((p) => p.ms).join('+')}ms  $${spent.toFixed(4)}${notes ? `  lead ${notes}` : ''}`);
                await sleep(PLAN.pauseMs);
            }
        }
    }
    console.log(`spent $${spent.toFixed(4)} in all`);
}

function findFfmpeg(): string {
    for (const c of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
        try {
            execFileSync(c, ['-version'], { stdio: 'ignore' });
            return c;
        } catch {
            /* next */
        }
    }
    throw new Error('ffmpeg not found');
}

function decode(ffmpeg: string, mp3: Uint8Array): Float32Array {
    const outBuf = execFileSync(ffmpeg, ['-v', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(DECODE_RATE), 'pipe:1'], {
        input: mp3,
        maxBuffer: 256 * 1024 * 1024,
    });
    const bytes = new Uint8Array(outBuf.byteLength);
    bytes.set(outBuf);
    return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

function encode(ffmpeg: string, pcm: Float32Array): Uint8Array {
    return execFileSync(
        ffmpeg,
        ['-v', 'error', '-f', 'f32le', '-ar', String(DECODE_RATE), '-ac', '1', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1'],
        { input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), maxBuffer: 64 * 1024 * 1024 }
    );
}

/** The desktop shell's whisper_batch build: this checkout's, or the one
 *  named by --whisper-bin (a worktree has no target/). */
function whisperFor(): Whisper {
    const model = join(homedir(), 'Library', 'Application Support', 'app.aloud.meditation', 'models', 'ggml-base.en.bin');
    const target = resolve(import.meta.dirname, '..', '..', 'src-tauri', 'target');
    const binary = arg('--whisper-bin') ?? ['release', 'debug'].map((p) => join(target, p, 'examples', 'whisper_batch')).find((p) => existsSync(p));
    if (!binary || !existsSync(binary) || !existsSync(model)) throw new Error('no whisper_batch build or base.en model');
    return { binary, model };
}

let whisperRuns = 0;
/** transcribe, paced: a pause after every run and a rest now and then. */
async function hear(whisper: Whisper, ffmpeg: string, mp3: Uint8Array): Promise<string | null> {
    const heard = transcribe(whisper, ffmpeg, mp3);
    whisperRuns++;
    await sleep(whisperRuns % WHISPER_REST_EVERY ? WHISPER_PAUSE_MS : WHISPER_REST_MS);
    return heard;
}

/** Speech spans at the gate's floor, joined across gaps under `joinS`. */
function spans(pcm: Float32Array, joinS: number): { startS: number; endS: number }[] {
    const levels = windowDb(pcm, DECODE_RATE, 10);
    const out: { startS: number; endS: number }[] = [];
    levels.forEach((db, i) => {
        if (db < -40) return;
        const startS = i * 0.01;
        const last = out[out.length - 1];
        if (last && startS - last.endS < joinS) last.endS = startS + 0.01;
        else out.push({ startS, endS: startS + 0.01 });
    });
    return out.filter((s) => s.endS - s.startS >= 0.06);
}

/** A tail-guard take cut before its trailing word: the samples up to
 *  0.15s past the line's last sound, when the last burst is short and
 *  stands apart; null when it can't tell where the guard word starts.
 *  The last burst is not always the guard: the voice ran on past it ("Okay,
 *  and I...") in 2 of 90 Ethan takes, and this cut then kept the guard. */
function cutTail(pcm: Float32Array): { pcm: Float32Array; gapS: number; guardS: number } | null {
    const s = spans(pcm, 0.3);
    const guard = s[s.length - 1];
    const before = s[s.length - 2];
    if (!guard || !before) return null;
    const guardS = guard.endS - guard.startS;
    const gapS = guard.startS - before.endS;
    if (guardS > 1.0 || gapS < 0.3) return null;
    const cut = Math.min(before.endS + 0.15, guard.startS - 0.05);
    return { pcm: pcm.subarray(0, Math.round(cut * DECODE_RATE)), gapS, guardS };
}

/** Mean power of the 10ms windows over the gate's floor, in dBFS: the
 *  level of the speech, its pauses left out. */
function activeLevelDb(pcm: Float32Array): number | null {
    const voiced = windowDb(pcm, DECODE_RATE, 10).filter((db) => db >= -40);
    if (!voiced.length) return null;
    return 10 * Math.log10(voiced.reduce((s, db) => s + 10 ** (db / 10), 0) / voiced.length);
}

interface SentenceHeard {
    /** Its place in the line, 1-based. */
    pos: number;
    text: string;
    /** Where it sat in what was sent: first in its input, behind the route's
     *  lead (led) or not (first), or after another sentence (mid). */
    sits: 'led' | 'first' | 'mid';
    heard: string | null;
    /** Heard alone, or as part of its whole input when the input could not
     *  be cut at its sentence ends. */
    by: 'sentence' | 'part';
    /** Heard alone as about its own words (fits): the cut fell at its ends. */
    fits: boolean;
    /** Its first word missing from the input's hearings in a row; null for a
     *  sentence too short to judge (under MIN_HEARD_WORDS) or none heard. */
    openingLost: boolean | null;
    /** Measured on the sentence alone, when it fits; null otherwise. */
    onsetRiseMs: number | null;
    speechS: number | null;
    sPerSpokenChar: number | null;
    levelDb: number | null;
    /** Its pauses at no punctuation, and those past 0.4s (cadence.ts kind 'word'). */
    midClause: number | null;
    midClauseLong: number | null;
    /** The silence after it inside the same input, when its seam is clean;
     *  null otherwise and for the input's last. */
    pauseAfterS: number | null;
    /** How the cut after it went (hearPart), for all but an input's last. */
    seam?: 'ok' | 'run-together' | 'unresolved';
}

interface PartHeard {
    text: string;
    durationS: number;
    /** Silence ahead of the first sound and after the last. */
    headS: number;
    tailS: number;
    voicedS: number;
    speechS: number;
    midClause: number;
    midClauseLong: number;
    bursts: number;
    gateFaults: string[];
    segmented: boolean;
    /** Its sentences' hearings in a row, and the transcript check on them. */
    heard: string | null;
    missing: string[];
    repeated: string[];
    sentences: SentenceHeard[];
}

interface Heard extends TakeRow {
    durationS: number;
    voicedS: number;
    /** Voiced span less the pauses inside it (cadence.ts findPauses), summed over the parts. */
    speechS: number;
    longestPauseS: number;
    /** Pauses inside each part's voiced span, seconds and what they fall at. */
    pauses: { s: number; kind: string }[];
    /** Pauses at no punctuation (cadence.ts kind 'word'), and those past its 0.4s cap. */
    midClause: number;
    midClauseLong: number;
    bursts: number;
    msPerTextChar: number;
    sPerSpokenChar: number;
    heard: string | null;
    repeated: string[];
    missing: string[];
    gateFaults: string[];
    partsHeard: PartHeard[];
    /** Between consecutive parts: the first's tail silence plus the next one's head. */
    joinsS: number[];
    /** A tail take: what was heard before the cut, its repeats, and the guard's gap and length; cutFailed when no cut. */
    rawHeard?: string | null;
    rawRepeated?: string[];
    tailGapS?: number;
    guardS?: number;
    cutFailed?: boolean;
    /** A take with more bursts than phrases, or long: each burst heard alone,
     *  since Whisper can smooth a phrase said twice into once. */
    burstHeard?: (string | null)[];
    burstRepeated?: string[];
}

/** The sentences of `text` (0-based) that a word heard twice follows:
 *  transcript.ts repeatedWords, each extra word placed after the line word
 *  before it. */
function repeatSentences(text: string, heard: string): number[] {
    const want = words(text);
    const starts: number[] = [];
    let n = 0;
    for (const s of sentencesOf(text)) {
        starts.push(n);
        n += words(s).length;
    }
    const found = new Set<number>();
    for (const step of align(want, words(heard))) {
        if (step.kind !== 'extra') continue;
        const w = step.got;
        const near = want.slice(Math.max(0, step.at - 3), step.at + 3).some((x) => x === w || (w.length >= 2 && x.startsWith(w)) || (w.length >= 3 && x.startsWith(w.slice(0, 3))));
        if (!near) continue;
        const before = Math.max(0, step.at - 1);
        let k = 0;
        while (k + 1 < starts.length && starts[k + 1]! <= before) k++;
        found.add(k);
    }
    return [...found];
}

/** Set by main: where report finds gaps.json. */
let outDir: string | undefined;

/** Said again, as the sentences heard or the bursts heard alone. */
const repeats = (h: Heard) => (h.repeated.length ? h.repeated : (h.burstRepeated ?? []));

/** What was heard, a bracket per hearing. */
const heardOf = (h: Heard) =>
    h.partsHeard.map((p) => (p.segmented ? p.sentences.map((s) => `[${s.heard}]`).join(' ') : `[${p.heard}]`)).join(' | ');

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function quantile(xs: number[], q: number): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
}

/** The pauses inside the voiced span of `pcm`, matched to the marks of `text`. */
function insidePauses(pcm: Float32Array, text: string) {
    const a = analyzePcm(pcm, DECODE_RATE);
    const pauses = findPauses(pcm, DECODE_RATE, text);
    const inside = pauses.filter((p) => p.startS >= (a.bursts[0]?.startS ?? 0) && p.endS <= (a.bursts.at(-1)?.endS ?? 0));
    return { a, inside };
}

/** A pause this far from its sentence end, as a share of the speech, costs as
 *  much as this many seconds of pause. */
const END_DISTANCE_COST_S = 5;

/** The pauses at the sentence ends of `text` in `pcm`: of the pauses inside
 *  its voiced span, the (sentences - 1) in time order that best fit the
 *  sentence marks, each scored by its length less END_DISTANCE_COST_S for
 *  its distance from its mark. Softvoice pauses longest at a sentence end,
 *  but not always (a second inside a clause, a quarter at a full stop), and
 *  the pace drifts along a line, so neither length nor place alone finds
 *  them (cadence.ts findPauses, which takes the longest pause near each
 *  mark, put about one cut in four in the wrong pause on these replies).
 *  Every pause, and the ones picked by index; null when there are fewer
 *  pauses than sentence ends. */
function sentenceEnds(pcm: Float32Array, text: string, count: number): { cands: { startS: number; endS: number }[]; picks: number[] } | null {
    const marks = pauseMarks(text).filter((m) => m.kind === 'sentence');
    if (count === 1 || !marks.length) return { cands: [], picks: [] };
    const a = analyzePcm(pcm, DECODE_RATE);
    const startS = a.bursts[0]?.startS ?? 0;
    const endS = a.bursts.at(-1)?.endS ?? 0;
    const pauses = findPauses(pcm, DECODE_RATE, text).filter((p) => p.startS >= startS && p.endS <= endS);
    const speech = endS - startS - pauses.reduce((s, p) => s + (p.endS - p.startS), 0);
    let paused = 0;
    const cands = pauses.map((p) => {
        const at = (p.startS - startS - paused) / speech;
        paused += p.endS - p.startS;
        return { p, at, s: p.endS - p.startS };
    });
    const m = marks.length;
    const c = cands.length;
    if (c < m) return null;
    const score = (i: number, j: number) => cands[j]!.s - END_DISTANCE_COST_S * Math.abs(cands[j]!.at - marks[i]!.at);
    // best[i][j]: the best fit of the first i marks to the first j pauses.
    const best = Array.from({ length: m + 1 }, (_, i) => Array<number>(c + 1).fill(i ? -Infinity : 0));
    for (let i = 1; i <= m; i++) {
        for (let j = i; j <= c; j++) best[i]![j] = Math.max(best[i]![j - 1]!, best[i - 1]![j - 1]! + score(i - 1, j - 1));
    }
    const picks: number[] = [];
    for (let i = m, j = c; i > 0; ) {
        if (j > i && best[i]![j] === best[i]![j - 1]) j--;
        else {
            picks.unshift(j - 1);
            i--;
            j--;
        }
    }
    return { cands: cands.map((x) => x.p), picks };
}

/** Whisper's spelling of the same word (transcript.ts align on the pair). */
const sameWord = (a: string, b: string) => align([a], [b]).some((s) => s.kind === 'heard');
const near = (w: string, set: string[]) => set.some((x) => sameWord(x, w));

/** A cut between sentences `a` and `b` in the wrong pause, by the words at
 *  the seam of their hearings: b's words at the end of a's hearing (-1, the
 *  cut is late) or a's at the start of b's (1, early); 0 when neither. */
function seam(a: string, b: string, heardA: string | null, heardB: string | null): -1 | 0 | 1 {
    const wa = words(a);
    const wb = words(b);
    const ha = words(heardA ?? '');
    const hb = words(heardB ?? '');
    if (ha.slice(-3).some((w) => near(w, wb) && !near(w, wa.slice(-3)))) return -1;
    if (hb.slice(0, 3).some((w) => near(w, wa) && !near(w, wb.slice(0, 3)))) return 1;
    return 0;
}

/** A sentence heard alone as about its own words: at most one missed past
 *  its first and one extra. */
function fits(sentence: string, heard: string | null): boolean {
    if (heard === null) return false;
    const steps = align(words(sentence), words(heard));
    return steps.filter((s) => s.kind === 'missed' && s.want > 0).length <= 1 && steps.filter((s) => s.kind === 'extra').length <= 1;
}

async function hearPart(whisper: Whisper, ffmpeg: string, mp3: Uint8Array, text: string, firstPos: number, led: boolean): Promise<PartHeard> {
    const pcm = decode(ffmpeg, mp3);
    const { a, inside } = insidePauses(pcm, text);
    const pausedS = inside.reduce((s, p) => s + (p.endS - p.startS), 0);
    const sents = sentencesOf(text);
    const n = sents.length;
    const ends = sentenceEnds(pcm, text, n);
    const sits = (i: number): SentenceHeard['sits'] => (i ? 'mid' : led ? 'led' : 'first');
    // Each sentence heard alone, cut in the middle of the pause at its end;
    // the whole input heard at once when its sentence ends can't be found.
    const cutAt = (k: number) => {
        const p = ends!.cands[ends!.picks[k]!]!;
        return (p.startS + p.endS) / 2;
    };
    const segOf = (i: number) => pcm.subarray(Math.round((i ? cutAt(i - 1) : 0) * DECODE_RATE), Math.round((i < n - 1 ? cutAt(i) : a.durationS) * DECODE_RATE));
    const hearSeg = (i: number) => hear(whisper, ffmpeg, n === 1 ? mp3 : encode(ffmpeg, segOf(i)));
    const hearings: (string | null)[] = [];
    // Each seam between sentences: its cut in the right pause (ok), or none
    // found there, with no pause left on the side the words point to (the
    // voice ran the two together, or paused under 0.2s) or one move not
    // enough (unresolved).
    const seams: ('ok' | 'run-together' | 'unresolved')[] = [];
    if (ends) {
        for (let i = 0; i < n; i++) hearings.push(await hearSeg(i));
        for (let b = 0; b < n - 1; b++) {
            const dir = seam(sents[b]!, sents[b + 1]!, hearings[b]!, hearings[b + 1]!);
            if (!dir) {
                seams.push('ok');
                continue;
            }
            const was = ends.picks[b]!;
            const next = was + dir;
            const lo = b ? ends.picks[b - 1]! : -1;
            const hi = b < n - 2 ? ends.picks[b + 1]! : ends.cands.length;
            if (next <= lo || next >= hi) {
                seams.push('run-together');
                continue;
            }
            // One pause that way, heard again; kept only if the seam is then clean.
            ends.picks[b] = next;
            const [ha, hb] = [await hearSeg(b), await hearSeg(b + 1)];
            if (seam(sents[b]!, sents[b + 1]!, ha, hb) === 0) {
                hearings[b] = ha;
                hearings[b + 1] = hb;
                seams.push('ok');
            } else {
                ends.picks[b] = was;
                seams.push('unresolved');
            }
        }
    } else hearings.push(await hear(whisper, ffmpeg, mp3));
    const joined = hearings.some((h) => h !== null) ? hearings.map((h) => h ?? '').join(' ').trim() : null;
    // Openings judged on the hearings in a row: a cut in the wrong pause
    // moves words between neighbours, and loses none.
    const steps = joined === null ? [] : align(words(text), words(joined));
    let offset = 0;
    const sentences: SentenceHeard[] = sents.map((sentence, i) => {
        const count = words(sentence).length;
        const at = offset;
        offset += count;
        const heard = ends ? hearings[i]! : joined;
        const ok = ends !== null && fits(sentence, heard) && (i === 0 || seams[i - 1] === 'ok') && (i === n - 1 || seams[i] === 'ok');
        const seg = ok ? segOf(i) : null;
        const s = seg ? insidePauses(seg, sentence) : null;
        const speechS = s ? s.a.voicedS - s.inside.reduce((t, p) => t + (p.endS - p.startS), 0) : null;
        const endPause = ends && i < n - 1 && seams[i] === 'ok' ? ends.cands[ends.picks[i]!]! : null;
        return {
            pos: firstPos + i,
            text: sentence,
            sits: sits(i),
            heard,
            by: ends ? 'sentence' : 'part',
            fits: ok,
            openingLost: joined === null || count < MIN_HEARD_WORDS ? null : steps.some((st) => st.kind === 'missed' && st.want === at),
            onsetRiseMs: s ? s.a.onsetRiseMs : null,
            speechS,
            sPerSpokenChar: speechS === null ? null : speechS / spokenChars(sentence),
            levelDb: seg ? activeLevelDb(seg) : null,
            midClause: s ? s.inside.filter((p) => p.kind === 'word').length : null,
            midClauseLong: s ? s.inside.filter((p) => p.kind === 'word' && p.endS - p.startS > PAUSE_CAP_S.word).length : null,
            pauseAfterS: endPause ? endPause.endS - endPause.startS : null,
            ...(ends && i < n - 1 ? { seam: seams[i]! } : {}),
        };
    });
    return {
        text,
        durationS: a.durationS,
        headS: a.bursts[0]?.startS ?? a.durationS,
        tailS: a.durationS - (a.bursts.at(-1)?.endS ?? 0),
        voicedS: a.voicedS,
        speechS: a.voicedS - pausedS,
        midClause: inside.filter((p) => p.kind === 'word').length,
        midClauseLong: inside.filter((p) => p.kind === 'word' && p.endS - p.startS > PAUSE_CAP_S.word).length,
        bursts: a.bursts.length,
        gateFaults: clipFaults(a, text),
        segmented: ends !== null,
        heard: joined,
        missing: joined === null ? [] : missingWords(text, joined),
        repeated: joined === null ? [] : repeatedWords(text, joined),
        sentences,
    };
}

async function analyzePhase(out: string): Promise<void> {
    const ffmpeg = findFfmpeg();
    const whisper = whisperFor();
    const rows = readRows(out);
    const cachePath = join(out, 'heard.json');
    const cache: Record<string, Heard> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
    for (const row of rows) {
        if (cache[row.file]) continue;
        const extra: Partial<Heard> = {};
        if (row.raw) {
            const rawMp3 = new Uint8Array(readFileSync(join(out, row.raw)));
            const rawPcm = decode(ffmpeg, rawMp3);
            const variant = PLAN.variants.find((v) => v.label === row.model);
            extra.rawHeard = await hear(whisper, ffmpeg, rawMp3);
            extra.rawRepeated = extra.rawHeard === null ? [] : repeatedWords(`${row.text} ${variant?.tail ?? ''}`, extra.rawHeard);
            const cut = cutTail(rawPcm);
            if (cut) {
                extra.tailGapS = cut.gapS;
                extra.guardS = cut.guardS;
                writeFileSync(join(out, row.file), encode(ffmpeg, cut.pcm));
            } else {
                extra.cutFailed = true;
                writeFileSync(join(out, row.file), rawMp3);
            }
        }
        const partsHeard: PartHeard[] = [];
        let pos = row.firstPos;
        for (const part of row.parts) {
            const p = await hearPart(whisper, ffmpeg, new Uint8Array(readFileSync(join(out, part.file))), part.text, pos, part.led);
            partsHeard.push(p);
            pos += p.sentences.length;
        }
        const joined = analyzePcm(decode(ffmpeg, new Uint8Array(readFileSync(join(out, row.file)))), DECODE_RATE);
        const sentences = partsHeard.flatMap((p) => p.sentences);
        const heard = partsHeard.some((p) => p.heard !== null) ? partsHeard.map((p) => p.heard ?? '').join(' ').trim() : null;
        const pauses = sentences.filter((s) => s.pauseAfterS !== null).map((s) => ({ s: Math.round(s.pauseAfterS! * 100) / 100, kind: 'sentence' }));
        cache[row.file] = {
            ...row,
            ...extra,
            durationS: joined.durationS,
            voicedS: joined.voicedS,
            speechS: partsHeard.reduce((s, p) => s + p.speechS, 0),
            longestPauseS: Math.max(0, ...pauses.map((p) => p.s)),
            pauses,
            midClause: partsHeard.reduce((s, p) => s + p.midClause, 0),
            midClauseLong: partsHeard.reduce((s, p) => s + p.midClauseLong, 0),
            bursts: joined.bursts.length,
            msPerTextChar: (joined.durationS * 1000) / row.text.length,
            sPerSpokenChar: joined.voicedS / spokenChars(row.text),
            heard,
            repeated: partsHeard.flatMap((p) => p.repeated),
            missing: partsHeard.flatMap((p) => p.missing),
            gateFaults: partsHeard.flatMap((p, i) => p.gateFaults.map((f) => (partsHeard.length > 1 ? `${'abcdefgh'[i]}: ${f}` : f))),
            partsHeard,
            joinsS: partsHeard.slice(1).map((p, i) => partsHeard[i]!.tailS + p.headS),
        };
        writeFileSync(cachePath, JSON.stringify(cache, null, 1));
        const h = cache[row.file]!;
        const lost = sentences.filter((s) => s.openingLost).map((s) => `${s.pos}${s.sits[0]}`);
        console.log(
            `${row.file.padEnd(26)} ${h.durationS.toFixed(2)}s  voiced ${h.voicedS.toFixed(2)}  mid ${h.midClause}` +
                (h.joinsS.length ? `  joins ${h.joinsS.map((j) => j.toFixed(2)).join(',')}` : '') +
                (pauses.length ? `  ends ${pauses.map((p) => p.s.toFixed(2)).join(',')}` : '') +
                (partsHeard.some((p) => !p.segmented) ? '  UNCUT' : '') +
                (sentences.some((s) => s.by === 'sentence' && !s.fits) ? '  MISFIT' : '') +
                (sentences.some((s) => s.seam && s.seam !== 'ok') ? `  SEAMS ${sentences.filter((s) => s.seam).map((s) => s.seam![0]).join('')}` : '') +
                (lost.length ? `  OPENING LOST ${lost.join(',')}` : '') +
                (h.repeated.length ? `  REPEAT "${h.repeated.join(' ')}"` : '') +
                (h.missing.length ? `  MISSING "${h.missing.join(' ')}"` : '') +
                (h.rawRepeated?.length ? `  RAW REPEAT "${h.rawRepeated.join(' ')}"` : '') +
                (h.cutFailed ? '  CUT FAILED' : '') +
                `  ${heardOf(h)}`
        );
    }
    report(Object.values(cache));
}

async function recheckPhase(out: string): Promise<void> {
    const ffmpeg = findFfmpeg();
    const whisper = whisperFor();
    const cachePath = join(out, 'heard.json');
    const cache: Record<string, Heard> = JSON.parse(readFileSync(cachePath, 'utf8'));
    const all = Object.values(cache);
    for (const h of all) {
        if (h.burstHeard) continue;
        const med = median(all.filter((o) => o.model === h.model && o.line === h.line).map((o) => o.voicedS));
        if (h.bursts <= phraseCount(h.text) && h.voicedS <= med * (1 + LONG_OVER_MEDIAN)) continue;
        const pcm = decode(ffmpeg, new Uint8Array(readFileSync(join(out, h.file))));
        const { bursts } = analyzePcm(pcm, DECODE_RATE);
        const heard: (string | null)[] = [];
        for (const b of bursts) {
            const from = Math.max(0, Math.round((b.startS - 0.1) * DECODE_RATE));
            const to = Math.min(pcm.length, Math.round((b.endS + 0.15) * DECODE_RATE));
            heard.push(await hear(whisper, ffmpeg, encode(ffmpeg, pcm.subarray(from, to))));
        }
        h.burstHeard = heard;
        h.burstRepeated = repeatedWords(h.text, heard.filter((t) => t !== null).join(' '));
        writeFileSync(cachePath, JSON.stringify(cache, null, 1));
        console.log(`${h.file.padEnd(26)} ${bursts.length} bursts${h.burstRepeated.length ? `  REPEAT "${h.burstRepeated.join(' ')}"` : ''}  ${heard.map((t) => `[${t}]`).join(' ')}`);
    }
    report(Object.values(cache));
}

/** Every silence a take holds, sentence end or not, from the PCM alone (no
 *  Whisper): per part, its head and tail and each pause inside its voiced
 *  span (cadence.ts findPauses: 0.2s or more under -40 dB, matched to a mark
 *  where one is near). */
interface PartGaps {
    headS: number;
    tailS: number;
    pauses: { s: number; kind: string; atS: number }[];
}
type GapsCache = Record<string, PartGaps[]>;

/** What the client adds between two clips (ui adapters/cloud-tts.ts speak:
 *  the ended event, the queue's next speak, a new src on the shared <audio>
 *  element, play()). Not measured; an assumption for the per-sentence arm. */
const HANDOVER_S = 0.1;

function gapsPhase(out: string): void {
    const ffmpeg = findFfmpeg();
    const path = join(out, 'gaps.json');
    const cache: GapsCache = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    for (const row of readRows(out)) {
        if (cache[row.file]) continue;
        cache[row.file] = row.parts.map((part) => {
            const pcm = decode(ffmpeg, new Uint8Array(readFileSync(join(out, part.file))));
            const { a, inside } = insidePauses(pcm, part.text);
            return {
                headS: a.bursts[0]?.startS ?? a.durationS,
                tailS: a.durationS - (a.bursts.at(-1)?.endS ?? 0),
                pauses: inside.map((p) => ({ s: Math.round((p.endS - p.startS) * 1000) / 1000, kind: p.kind, atS: Math.round(p.startS * 100) / 100 })),
            };
        });
    }
    writeFileSync(path, JSON.stringify(cache));
    console.log(`${Object.keys(cache).length} takes in ${path}`);
}

/** The silences of a take as played: each part's pauses, and between two
 *  parts the first's tail, the next one's head and HANDOVER_S. */
function playedSilences(parts: PartGaps[]): { s: number; kind: string }[] {
    const out: { s: number; kind: string }[] = [];
    parts.forEach((p, i) => {
        if (i) out.push({ s: parts[i - 1]!.tailS + p.headS + HANDOVER_S, kind: 'join' });
        out.push(...p.pauses.map((x) => ({ s: x.s, kind: x.kind })));
    });
    return out;
}

const f2 = (x: number) => x.toFixed(2);
/** Median and the 10th to 90th percentile, and the extremes. */
const spread = (xs: number[]) =>
    xs.length ? `${f2(median(xs))} (p10-p90 ${f2(quantile(xs, 0.1))}-${f2(quantile(xs, 0.9))}, ${f2(Math.min(...xs))}-${f2(Math.max(...xs))}) n=${xs.length}` : '-';

/** A count out of n, with its Wilson 95% interval in percent. */
function rate(k: number, n: number): string {
    if (!n) return '-';
    const z = 1.96;
    const p = k / n;
    const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
    return `${k}/${n} (${(100 * p).toFixed(1)}%, ${(100 * Math.max(0, centre - half)).toFixed(1)}-${(100 * Math.min(1, centre + half)).toFixed(1)})`;
}

function report(all: Heard[]): void {
    // In PLAN order, so each voice's first variant is its baseline.
    const order = (m: string) => {
        const i = PLAN.variants.findIndex((v) => v.label === m);
        return i < 0 ? Infinity : i;
    };
    const variants = [...new Set(all.map((h) => h.model))].sort((a, b) => order(a) - order(b));
    const flagged: (Heard & { over: number; speechOver: number })[] = [];
    for (const variant of variants) {
        console.log(`\n== ${variant} ==`);
        console.log('line  takes  heard-again  missing  long(>15% voiced)  mid-clause pauses (>0.4s)  median voiced  range voiced');
        let tot = { takes: 0, rep: 0, miss: 0, long: 0, mid: 0, midLong: 0 };
        for (let line = 1; line <= LINES.length; line++) {
            const takes = all.filter((h) => h.model === variant && h.line === line).sort((a, b) => a.take - b.take);
            if (!takes.length) continue;
            const med = median(takes.map((t) => t.voicedS));
            const medSpeech = median(takes.map((t) => t.speechS));
            let long = 0;
            for (const t of takes) {
                const over = t.voicedS / med - 1;
                const speechOver = t.speechS / medSpeech - 1;
                if (over > LONG_OVER_MEDIAN) long++;
                if (over > LONG_OVER_MEDIAN || repeats(t).length || t.rawRepeated?.length || t.gateFaults.length || t.missing.length || t.cutFailed || t.partsHeard.some((p) => p.sentences.some((s) => s.openingLost)))
                    flagged.push({ ...t, over, speechOver });
            }
            const rep = takes.filter((t) => repeats(t).length).length;
            const miss = takes.filter((t) => t.missing.length).length;
            const mid = takes.reduce((s, t) => s + t.midClause, 0);
            const midLong = takes.reduce((s, t) => s + t.midClauseLong, 0);
            tot = { takes: tot.takes + takes.length, rep: tot.rep + rep, miss: tot.miss + miss, long: tot.long + long, mid: tot.mid + mid, midLong: tot.midLong + midLong };
            const vs = takes.map((t) => t.voicedS);
            const joins = takes.flatMap((t) => t.joinsS);
            const raw = takes.filter((t) => t.rawRepeated?.length).length;
            const cutFailed = takes.filter((t) => t.cutFailed).length;
            const lead = takes.flatMap((t) => t.parts.filter((p) => p.leadReroll || p.leadDropped).map((p) => (p.leadDropped ? 'D' : 'R'))).join('');
            // A lead or guard word left in what plays.
            const guardHeard = takes.filter((t) => (t.raw || t.parts.some((p) => p.led)) && /\bokay\b/i.test(t.heard ?? '') && !/\bokay\b/i.test(t.text)).length;
            console.log(
                `L${line}    ${String(takes.length).padStart(3)}  ${String(rep).padStart(6)}     ${String(miss).padStart(6)}     ${String(long).padStart(6)}            ${String(mid).padStart(4)} (${midLong})               ${med.toFixed(2)}s        ${Math.min(...vs).toFixed(2)}-${Math.max(...vs).toFixed(2)}s` +
                    (joins.length ? `  join median ${median(joins).toFixed(2)}s (${Math.min(...joins).toFixed(2)}-${Math.max(...joins).toFixed(2)})` : '') +
                    (raw ? `  raw repeats ${raw}` : '') +
                    (cutFailed ? `  cut failed ${cutFailed}` : '') +
                    (lead ? `  lead ${lead}` : '') +
                    (guardHeard ? `  "okay" heard ${guardHeard}` : '')
            );
        }
        console.log(`all   ${String(tot.takes).padStart(3)}  ${String(tot.rep).padStart(6)}     ${String(tot.miss).padStart(6)}     ${String(tot.long).padStart(6)}            ${String(tot.mid).padStart(4)} (${tot.midLong})`);
    }

    const sentencesOfVariant = (variant: string) => all.filter((h) => h.model === variant).flatMap((h) => h.partsHeard.flatMap((p) => p.sentences.map((s) => ({ ...s, line: h.line, file: h.file }))));

    console.log('\n== openings: the first word of a sentence not heard (Whisper on each sentence alone, read in a row), and onsets that rise in under 6ms ==');
    console.log('variant          sits   judged  lost                      cut onset (fitting cuts)  cut misfit  uncut');
    for (const variant of variants) {
        const ss = sentencesOfVariant(variant);
        for (const sits of ['led', 'first', 'mid'] as const) {
            const these = ss.filter((s) => s.sits === sits);
            if (!these.length) continue;
            const judged = these.filter((s) => s.openingLost !== null);
            const rise = these.filter((s) => s.onsetRiseMs !== null);
            const cut = these.filter((s) => s.by === 'sentence');
            console.log(
                `${variant.padEnd(16)} ${sits.padEnd(6)} ${String(judged.length).padStart(5)}  ${rate(judged.filter((s) => s.openingLost).length, judged.length).padEnd(24)}  ${rate(rise.filter((s) => s.onsetRiseMs! < 6).length, rise.length).padEnd(24)}  ${String(cut.filter((s) => !s.fits).length).padStart(3)}/${cut.length}  ${these.length - cut.length}`
            );
        }
    }
    console.log('by line and position (lost/judged, sits):');
    for (let line = 1; line <= LINES.length; line++) {
        const sents = sentencesOf(LINES[line - 1]!);
        const cells = variants.map((variant) => {
            const ss = sentencesOfVariant(variant).filter((s) => s.line === line);
            if (!ss.length) return null;
            return `${variant}: ` + sents.map((_, i) => {
                const at = ss.filter((s) => s.pos === i + 1);
                const judged = at.filter((s) => s.openingLost !== null);
                const sits = [...new Set(at.map((s) => s.sits[0]))].join('');
                return judged.length ? `${judged.filter((s) => s.openingLost).length}/${judged.length}${sits}` : `-${sits}`;
            }).join(' ');
        });
        console.log(`L${line}  ${cells.filter(Boolean).join('   ')}`);
    }

    console.log('\n== silence at a sentence end: inside one input, and between two clips (tail + head, before the client\'s handover) ==');
    for (const variant of variants) {
        const ss = sentencesOfVariant(variant);
        const inside = ss.filter((s) => s.pauseAfterS !== null).map((s) => s.pauseAfterS!);
        const seams = ss.filter((s) => s.seam);
        const joins = all.filter((h) => h.model === variant).flatMap((h) => h.joinsS);
        const parts = all.filter((h) => h.model === variant).flatMap((h) => h.partsHeard);
        console.log(`${variant}:`);
        if (seams.length) {
            console.log(`  inside an input   ${spread(inside)}`);
            console.log(`  seams             ${seams.length}: clean ${seams.filter((s) => s.seam === 'ok').length}, no pause at the end ${seams.filter((s) => s.seam === 'run-together').length}, unresolved ${seams.filter((s) => s.seam === 'unresolved').length}`);
        }
        if (joins.length) console.log(`  between clips     ${spread(joins)}`);
        console.log(`  clip head         ${spread(parts.map((p) => p.headS))}`);
        console.log(`  clip tail         ${spread(parts.map((p) => p.tailS))}`);
        const takes = all.filter((h) => h.model === variant);
        console.log(`  mid-clause pauses ${(takes.reduce((s, t) => s + t.midClause, 0) / Math.max(1, takes.length)).toFixed(2)} a take (${(takes.reduce((s, t) => s + t.midClauseLong, 0) / Math.max(1, takes.length)).toFixed(2)} over 0.4s), ${((100 * takes.reduce((s, t) => s + t.midClause, 0)) / Math.max(1, takes.reduce((s, t) => s + spokenChars(t.text), 0))).toFixed(2)} per 100 spoken chars`);
        const cut = ss.filter((s) => s.midClause !== null);
        for (const sits of ['led', 'first', 'mid'] as const) {
            const these = cut.filter((s) => s.sits === sits);
            if (these.length) console.log(`    per ${sits.padEnd(5)} sentence ${(these.reduce((t, s) => t + s.midClause!, 0) / these.length).toFixed(2)} (${(these.reduce((t, s) => t + s.midClauseLong!, 0) / these.length).toFixed(2)} over 0.4s), n=${these.length}`);
        }
    }

    // How long the listener waits between two sentences: inside an input
    // (clean seams only), or between two clips plus HANDOVER_S.
    const shares = (xs: number[]) => [1.5, 2, 3, 5].map((t) => `>${t}s ${rate(xs.filter((x) => x > t).length, xs.length)}`).join('  ');
    console.log(`\n== the wait between two sentences: shares over 1.5/2/3/5s (Wilson 95%); a clip join is tail + head + ${HANDOVER_S}s handover (assumed) ==`);
    for (const variant of variants) {
        const ss = sentencesOfVariant(variant);
        const inside = ss.filter((s) => s.pauseAfterS !== null).map((s) => s.pauseAfterS!);
        const joins = all.filter((h) => h.model === variant).flatMap((h) => h.joinsS.map((j) => j + HANDOVER_S));
        console.log(`${variant}:`);
        if (inside.length) console.log(`  inside an input   ${spread(inside)}\n                    ${shares(inside)}`);
        // Split by what today's client does at that sentence end: a clip join
        // (what batching changes), or inside one chunk already (a short
        // sentence merged into the next, MIN_TTS_SENTENCE_CHARS).
        const joinAfter = (line: number, pos: number) => {
            let n = 0;
            return clientChunks(LINES[line - 1]!).some((c) => (n += sentencesOf(c).length) === pos);
        };
        const ends = ss.filter((s) => s.pauseAfterS !== null);
        const atJoin = ends.filter((s) => joinAfter(s.line, s.pos)).map((s) => s.pauseAfterS!);
        const inChunk = ends.filter((s) => !joinAfter(s.line, s.pos)).map((s) => s.pauseAfterS!);
        if (atJoin.length && inChunk.length) {
            console.log(`    where today's client joins two clips  ${spread(atJoin)}\n                    ${shares(atJoin)}`);
            console.log(`    inside one chunk today                ${spread(inChunk)}\n                    ${shares(inChunk)}`);
        }
        if (joins.length) console.log(`  clip joins        ${spread(joins)}\n                    ${shares(joins)}`);
        if (inside.length && joins.length) console.log(`  every sentence end ${spread([...inside, ...joins])}\n                    ${shares([...inside, ...joins])}`);
    }

    // Every silence as played, sentence end or not (gaps phase), and the
    // longest in each reply.
    const gaps: GapsCache = outDir && existsSync(join(outDir, 'gaps.json')) ? JSON.parse(readFileSync(join(outDir, 'gaps.json'), 'utf8')) : {};
    if (Object.keys(gaps).length) {
        console.log('\n== every silence of 0.2s or more as played (gaps phase, PCM only), and the longest in each reply ==');
        for (const variant of variants) {
            const takes = all.filter((h) => h.model === variant && gaps[h.file]);
            if (!takes.length) continue;
            const played = takes.map((h) => playedSilences(gaps[h.file]!));
            const every = played.flat().map((x) => x.s);
            const worst = played.map((xs) => Math.max(0, ...xs.map((x) => x.s)));
            const byKind = (k: string) => played.flat().filter((x) => x.kind === k).map((x) => x.s);
            console.log(`${variant}: ${takes.length} replies, ${every.length} silences (${(every.length / takes.length).toFixed(2)} a reply)`);
            console.log(`  every silence     ${spread(every)}\n                    ${shares(every)}`);
            for (const k of ['sentence', 'clause', 'word', 'join']) {
                const xs = byKind(k);
                if (xs.length) console.log(`    at a ${k.padEnd(8)} ${spread(xs)}  >2s ${xs.filter((x) => x > 2).length}`);
            }
            console.log(`  longest a reply   ${spread(worst)}\n                    replies with one ${shares(worst)}`);
            for (let line = 1; line <= LINES.length; line++) {
                const w = takes.map((h, i) => ({ h, w: worst[i]! })).filter((x) => x.h.line === line).map((x) => x.w);
                if (w.length) console.log(`    L${line} (${sentencesOf(LINES[line - 1]!).length} sentences) n=${String(w.length).padStart(3)}  longest median ${f2(median(w))}  max ${f2(Math.max(...w))}  >2s ${w.filter((x) => x > 2).length}  >3s ${w.filter((x) => x > 3).length}  >5s ${w.filter((x) => x > 5).length}`);
            }
            const long = takes.flatMap((h, i) => played[i]!.filter((x) => x.s > 3).map((x) => `${h.file} ${f2(x.s)}s ${x.kind} ${h.at.slice(11, 19)}`));
            if (long.length) console.log(`  over 3s: ${long.join('; ')}`);
        }
    }

    // Said again: by take, and by sentence (the sentence a repeated word
    // follows, from the part's hearing; a repeat found only in the burst
    // recheck counts once, for a sentence unknown).
    console.log('\n== said again: replies and sentences with a word or phrase heard twice (Whisper, bursts rechecked), Wilson 95% ==');
    for (const variant of variants) {
        const takes = all.filter((h) => h.model === variant);
        let sentences = 0;
        let hit = 0;
        const at: string[] = [];
        for (const h of takes) {
            let pos = h.firstPos;
            let found = 0;
            for (const p of h.partsHeard) {
                const n = p.sentences.length;
                sentences += n;
                const idx = p.heard === null ? [] : repeatSentences(p.text, p.heard);
                found += idx.length;
                at.push(...idx.map((i) => `${h.file}#${pos + i}`));
                pos += n;
            }
            if (!found && h.burstRepeated?.length) {
                found = 1;
                at.push(`${h.file}#?`);
            }
            hit += found;
        }
        console.log(`${variant.padEnd(16)} replies ${rate(takes.filter((h) => repeats(h).length).length, takes.length).padEnd(24)} sentences ${rate(hit, sentences)}${at.length ? `  ${at.join(', ')}` : ''}`);
    }

    console.log('\n== pace (s of speech per spoken char) and level (dBFS of the voiced windows) per sentence, median over takes ==');
    for (let line = 1; line <= LINES.length; line++) {
        const sents = sentencesOf(LINES[line - 1]!);
        for (const [i, text] of sents.entries()) {
            const cells = variants
                .map((variant) => {
                    const at = sentencesOfVariant(variant).filter((s) => s.line === line && s.pos === i + 1 && s.sPerSpokenChar !== null);
                    if (!at.length) return null;
                    return `${variant} ${(median(at.map((s) => s.sPerSpokenChar!)) * 1000).toFixed(0)}ms ${median(at.map((s) => s.levelDb ?? -99)).toFixed(1)}dB ${at[0]!.sits[0]}(${at.length})`;
                })
                .filter(Boolean);
            if (cells.length) console.log(`L${line}.${i + 1} ${text.slice(0, 28).padEnd(28)} ${cells.join('   ')}`);
        }
    }
    // Each sentence against itself in the voice's first variant: the ratio
    // of its median pace and the difference of its median level.
    for (const variant of variants) {
        const voice = all.find((h) => h.model === variant)!.voice;
        const base = variants.find((v) => all.find((h) => h.model === v)!.voice === voice)!;
        if (base === variant) continue;
        const ratios: number[] = [];
        const dbs: number[] = [];
        for (let line = 1; line <= LINES.length; line++) {
            for (let pos = 1; pos <= sentencesOf(LINES[line - 1]!).length; pos++) {
                const pick = (v: string) => sentencesOfVariant(v).filter((s) => s.line === line && s.pos === pos && s.sPerSpokenChar !== null);
                const a = pick(base);
                const b = pick(variant);
                if (!a.length || !b.length || a[0]!.text !== b[0]!.text) continue;
                ratios.push(median(b.map((s) => s.sPerSpokenChar!)) / median(a.map((s) => s.sPerSpokenChar!)));
                dbs.push(median(b.map((s) => s.levelDb ?? -99)) - median(a.map((s) => s.levelDb ?? -99)));
            }
        }
        if (ratios.length) console.log(`${variant} against ${base}, per sentence: pace x${f2(median(ratios))} (${f2(Math.min(...ratios))}-${f2(Math.max(...ratios))}), level ${median(dbs) >= 0 ? '+' : ''}${f2(median(dbs))} dB (${f2(Math.min(...dbs))} to ${f2(Math.max(...dbs))}), ${ratios.length} sentences`);
    }

    console.log('\n== latency per synthesis, by sentences in the input: synthFor whole call; provider first byte and whole body (first call) ==');
    for (const variant of variants) {
        const parts = all.filter((h) => h.model === variant).flatMap((h) => h.parts.map((p) => ({ ...p, n: sentencesOf(p.text).length })));
        for (const n of [...new Set(parts.map((p) => p.n))].sort()) {
            const ps = parts.filter((p) => p.n === n);
            const calls = ps.map((p) => p.calls[0]).filter((c): c is ProviderCall => !!c);
            console.log(
                `${variant.padEnd(16)} ${n} sentence${n > 1 ? 's' : ' '} ${String(ps.length).padStart(4)}  synth ${f2(median(ps.map((p) => p.ms)) / 1000)}s (p90 ${f2(quantile(ps.map((p) => p.ms), 0.9) / 1000)})` +
                    `  first byte ${f2(median(calls.map((c) => c.firstByteMs)) / 1000)}s (p90 ${f2(quantile(calls.map((c) => c.firstByteMs), 0.9) / 1000)})  body ${f2(median(calls.map((c) => c.totalMs)) / 1000)}s` +
                    `  chars ${median(ps.map((p) => p.text.length))}  calls/part ${(ps.reduce((s, p) => s + p.calls.length, 0) / ps.length).toFixed(2)}`
            );
        }
        const led = parts.filter((p) => p.led || p.leadDropped || p.leadReroll);
        if (led.length) {
            const r = resolvedFor(PLAN.variants.find((v) => v.label === variant) ?? { label: variant, voice: all.find((h) => h.model === variant)!.voice, takes: 0 });
            const by = (key: (p: (typeof led)[number]) => string | number | null) =>
                [...new Set(led.map(key))]
                    .sort()
                    .map((k) => {
                        const l = led.filter((p) => key(p) === k);
                        return `${k}: ${l.filter((p) => p.leadReroll).length}R ${l.filter((p) => p.leadDropped).length}D of ${l.length}`;
                    })
                    .join(', ');
            console.log(
                `${variant.padEnd(16)} lead: ${led.length} led inputs, re-rolled ${rate(led.filter((p) => p.leadReroll).length, led.length)}, said without it ${led.filter((p) => p.leadDropped).length}` +
                    `; by sentences in the input: ${by((p) => p.n)}; by opening: ${by((p) => leadClass(r, p.text))}`
            );
        }
    }

    console.log('\n== billed characters per reply: planned (billedCharsFor) and as billed, lead re-rolls included ==');
    for (const variant of variants) {
        const takes = all.filter((h) => h.model === variant);
        const v = PLAN.variants.find((x) => x.label === variant) ?? { label: variant, voice: takes[0]!.voice, takes: 0 };
        const planned = takes.reduce((s, t) => s + t.parts.reduce((n, p) => n + plannedChars(v, resolvedFor(v), p.text), 0), 0);
        const billed = takes.reduce((s, t) => s + t.billedChars, 0);
        console.log(`${variant.padEnd(16)} ${takes.length} takes, ${(planned / takes.length).toFixed(0)} planned, ${(billed / takes.length).toFixed(0)} billed a take (x${f2(billed / planned)}), $${takes.reduce((s, t) => s + t.usd, 0).toFixed(4)}`);
    }
    // One take of every line both variants have, at each one's mean billed.
    const perLine = (variant: string, line: number) => {
        const ts = all.filter((h) => h.model === variant && h.line === line);
        return ts.length ? ts.reduce((s, t) => s + t.billedChars, 0) / ts.length : null;
    };
    for (const variant of variants) {
        const voice = all.find((h) => h.model === variant)!.voice;
        const base = variants.find((v) => all.find((h) => h.model === v)!.voice === voice)!;
        if (base === variant) continue;
        let a = 0;
        let b = 0;
        const lines: number[] = [];
        for (let line = 1; line <= LINES.length; line++) {
            const x = perLine(base, line);
            const y = perLine(variant, line);
            if (x === null || y === null) continue;
            a += x;
            b += y;
            lines.push(line);
        }
        if (lines.length) console.log(`${variant} against ${base}, one take of L${lines.join(',L')}: ${a.toFixed(0)} -> ${b.toFixed(0)} billed chars (${b <= a ? '-' : '+'}${f2((100 * Math.abs(a - b)) / a)}%)`);
    }

    console.log('\n== flagged takes ==');
    for (const f of flagged.sort((a, b) => b.over - a.over)) {
        const lost = f.partsHeard.flatMap((p) => p.sentences.filter((s) => s.openingLost).map((s) => `${s.pos}(${s.sits}) "${s.text.split(' ')[0]}"`));
        console.log(
            `${f.file}  dur ${f.durationS.toFixed(2)}s  voiced +${(f.over * 100).toFixed(0)}%  speech +${(f.speechOver * 100).toFixed(0)}%  longest end pause ${f.longestPauseS.toFixed(2)}s` +
                (lost.length ? `  OPENING LOST ${lost.join(', ')}` : '') +
                (f.repeated.length ? `  REPEAT "${f.repeated.join(' ')}"` : '') +
                (!f.repeated.length && f.burstRepeated?.length ? `  BURST REPEAT "${f.burstRepeated.join(' ')}"` : '') +
                (f.rawRepeated?.length ? `  RAW REPEAT "${f.rawRepeated.join(' ')}"` : '') +
                (f.missing.length ? `  MISSING "${f.missing.join(' ')}"` : '') +
                (f.gateFaults.length ? `  GATE ${f.gateFaults.join('; ')}` : '') +
                (f.cutFailed ? '  CUT FAILED' : '') +
                `\n    heard: ${heardOf(f)}` +
                (f.burstHeard ? `\n    bursts: ${f.burstHeard.map((t) => `[${t}]`).join(' ')}` : '') +
                (f.rawHeard !== undefined ? `\n    raw:   ${f.rawHeard}` : '')
        );
    }
}

/** How likely a led input is to be re-rolled, by its opening (routes/tts.ts
 *  leadExpect): short (the whole input under 24 characters, one burst
 *  expected), a short opening phrase past its first two words, which the
 *  voice says as a burst of its own behind the lead ("That makes sense.",
 *  "Does it feel firm,"), or plain. Null for an input with no lead. */
function leadClass(r: ResolvedVoice, text: string): 'short' | 'short-opening' | 'plain' | null {
    if (!leadFor(r, text)) return null;
    if (text.length < 24) return 'short';
    const phrase = /^.*?[,.;:!?](?=\s|$)/.exec(text)?.[0] ?? text;
    return phrase.length < 24 && phrase.length < text.length && phrase.trim().split(/\s+/).length > 2 ? 'short-opening' : 'plain';
}

/** A reply's billed characters, sent three ways. */
function shapes(r: ResolvedVoice, text: string): { chunks: number; firstRest: number; whole: number; requests: number; tags: number; lead: number } {
    const chunks = clientChunks(text);
    const sum = (inputs: string[]) => inputs.reduce((s, t) => s + billedCharsFor(r, t, 1), 0);
    const tag = r.style ? azureBilledChars('', 1, r.style) : 0;
    return {
        chunks: sum(chunks),
        firstRest: sum(chunks.length > 1 ? [chunks[0]!, chunks.slice(1).join(' ')] : chunks),
        whole: sum([chunks.join(' ')]),
        requests: chunks.length,
        tags: tag * chunks.length,
        lead: chunks.reduce((s, c) => s + (leadFor(r, c) ? leadFor(r, c)!.length + 1 : 0), 0),
    };
}

function billPhase(): void {
    const dir = arg('--sessions') ?? join(homedir(), 'Library', 'Application Support', 'app.aloud.meditation', 'sessions');
    const since = arg('--since') ?? '';
    const replies: string[] = [];
    let sessions = 0;
    if (existsSync(dir)) {
        for (const name of readdirSync(dir).filter((n) => n.endsWith('.json') && n >= since).sort()) {
            const s = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { language?: string; exchanges?: { role: string; content: string }[] };
            if (s.language && s.language !== 'en') continue;
            const before = replies.length;
            for (const e of s.exchanges ?? []) {
                if (e.role !== 'assistant' || /[〈〉]/.test(e.content)) continue;
                const spoken = parseTurnSignals(e.content).cleanText.trim();
                if (spoken) replies.push(spoken);
            }
            if (replies.length > before) sessions++;
        }
    }
    for (const voice of [...new Set(PLAN.variants.map(voiceOf))]) {
        const r = resolveVoice(voice);
        for (const [label, set] of [
            ['probe lines', LINES],
            [`${sessions} sessions in ${dir}${since ? ` since ${since}` : ''}`, replies],
        ] as const) {
            if (!set.length) continue;
            const t = set.map((text) => shapes(r, text));
            const sum = (k: keyof (typeof t)[number]) => t.reduce((s, x) => s + x[k], 0);
            const chunks = sum('chunks');
            const byCount = [1, 2, 3, 4].map((n) => `${n === 4 ? '4+' : n}: ${t.filter((x) => (n === 4 ? x.requests >= 4 : x.requests === n)).length}`).join(', ');
            console.log(`\n${voice}, ${label}: ${set.length} replies, ${(sum('requests') / set.length).toFixed(2)} requests a reply (${byCount})`);
            // The clip joins a whole-reply request turns into the voice's own
            // pause, and the sentence ends it then pauses at in all.
            const sentenceEnds = set.reduce((s, text) => s + sentencesOf(text).length - 1, 0);
            console.log(`  clip joins ${((sum('requests') - set.length) / set.length).toFixed(2)} a reply, sentence ends ${(sentenceEnds / set.length).toFixed(2)} a reply`);
            console.log(`  per chunk (today)      ${chunks} billed chars, tags ${((100 * sum('tags')) / chunks).toFixed(1)}%, lead ${((100 * sum('lead')) / chunks).toFixed(1)}%`);
            console.log(`  first alone + rest     ${sum('firstRest')}  (-${((100 * (chunks - sum('firstRest'))) / chunks).toFixed(1)}%)`);
            console.log(`  whole reply            ${sum('whole')}  (-${((100 * (chunks - sum('whole'))) / chunks).toFixed(1)}%)`);
            // Led inputs by opening, each shape: what the re-roll rates measured
            // per opening (report) turn into billed characters.
            const inputsOf = {
                'per chunk': set.flatMap((text) => clientChunks(text)),
                'first + rest': set.flatMap((text) => {
                    const c = clientChunks(text);
                    return c.length > 1 ? [c[0]!, c.slice(1).join(' ')] : c;
                }),
                whole: set.map((text) => clientChunks(text).join(' ')),
            };
            for (const [shape, inputs] of Object.entries(inputsOf)) {
                const classes = ['short', 'short-opening', 'plain'] as const;
                console.log(
                    `  led inputs, ${shape.padEnd(12)} ` +
                        classes
                            .map((k) => {
                                const these = inputs.filter((t) => leadClass(r, t) === k);
                                return `${k} ${these.length} (${these.reduce((s, t) => s + billedCharsFor(r, t, 1), 0)} chars)`;
                            })
                            .join(', ') +
                        ` of ${inputs.length} inputs`
                );
            }
            if (label === 'probe lines') set.forEach((text, i) => console.log(`  L${i + 1} ${t[i]!.chunks} / ${t[i]!.firstRest} / ${t[i]!.whole}  ${clientChunks(text).map((c) => `[${c}]`).join(' ')}`));
        }
    }
}

async function main(): Promise<void> {
    const phase = process.argv[2];
    if (phase === 'bill') return billPhase();
    const out = arg('--out');
    if (!out) throw new Error('--out <dir> is required');
    outDir = out;
    if (phase === 'synth') await synthPhase(out, process.argv.includes('--dry-run'));
    else if (phase === 'analyze') await analyzePhase(out);
    else if (phase === 'recheck') await recheckPhase(out);
    else if (phase === 'gaps') gapsPhase(out);
    else if (phase === 'report') report(Object.values(JSON.parse(readFileSync(join(out, 'heard.json'), 'utf8')) as Record<string, Heard>));
    else throw new Error('first argument: synth, analyze, recheck, report or bill');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
