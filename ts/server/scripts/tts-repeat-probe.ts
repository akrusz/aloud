/**
 * How often a hosted voice says part of a line twice, and what keeps the
 * voice and loses the fault: renders session lines N times each through the
 * server's own path (routes/tts.ts synthFor), as plain takes or under a
 * variant (another model, the style off, a clause split, a spoken lead, a
 * trailing word cut off again), then hears every take with the renderer's
 * gate (voice-clips/analysis.ts bursts, voice-clips/transcript.ts
 * repeatedWords on local Whisper), its length against its line's median, and
 * its pauses inside a clause (voice-clips/cadence.ts). Run from ts/, the
 * Whisper steps at low priority:
 *
 *   tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts synth   --out <dir> [--env <.env>] [--dry-run]
 *   taskpolicy -b nice -n 10 tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts analyze --out <dir> [--whisper-bin <path>]
 *   taskpolicy -b nice -n 10 tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts recheck --out <dir> [--whisper-bin <path>]
 *   tsx --tsconfig server/tsconfig.json server/scripts/tts-repeat-probe.ts report  --out <dir>
 *
 * recheck hears each burst of a take with more bursts than phrases, or a long
 * one, on its own. The plan (voice, variants, lines, takes, spend cap) is
 * PLAN below, as last run (Ethan, 2026-11-18); edit it and run again: every
 * step picks up where the last run stopped. Synthesis is
 * sequential with a pause, backs off on 429, and stops before the cap, which
 * covers every take in <dir>/takes.jsonl. Every take is kept under
 * <dir>/<variant>/.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadConfig } from '../src/config.js';
import { ttsRateFor } from '../src/pricing/providers.js';
import { TtsUpstreamError, azureBilledChars, isProviderAccountFailure } from '../src/providers/tts.js';
import { resolveVoice, type ResolvedVoice } from '../src/providers/voice-catalog.js';
import { billedCharsFor, synthFor } from '../src/routes/tts.js';
import { analyzePcm, clipFaults, phraseCount, spokenChars, windowDb, type ClipAnalysis } from './voice-clips/analysis.js';
import { PAUSE_CAP_S, findPauses } from './voice-clips/cadence.js';
import { missingWords, repeatedWords, transcribe, type Whisper } from './voice-clips/transcript.js';

interface Variant {
    label: string;
    voiceId: string;
    /** Express-as style: the curated voice's when absent, none when null. */
    style?: string | null;
    /** A spoken lead the route cuts off again (CuratedVoice.lead). */
    lead?: string;
    /** A word spoken after the text and cut off here (a tail guard). */
    tail?: string;
    /** Each line sent as its SPLITS parts, one synthesis each. */
    split?: boolean;
    /** Line numbers (1-based); all when absent. */
    lines?: number[];
    takes: number;
}

const LINES = [
    "Before that, I asked you to notice the pressure of your weight against the chair or floor, and where it's heaviest.",
    'Which side is it, and does the pressure stay in one spot or spread out?',
    "Your weight against the chair or floor, and where it's heaviest.",
    'Is there a particular edge where it starts or stops?',
    'Let that spread be what you stay with.',
    "Notice where you feel contact with whatever you're sitting or lying on.",
];

/** Lines split at their clause comma. */
const SPLITS: Record<number, string[]> = {
    1: ['Before that, I asked you to notice the pressure of your weight against the chair or floor,', "and where it's heaviest."],
    2: ['Which side is it,', 'and does the pressure stay in one spot or spread out?'],
    3: ['Your weight against the chair or floor,', "and where it's heaviest."],
};

const FLASH = 'en-US-Ethan:MAI-Voice-2.1-Flash';
const FULL = 'en-US-Ethan:MAI-Voice-2.1';

const PLAN: { voice: string; variants: Variant[]; capUsd: number; pauseMs: number } = {
    voice: 'Ethan',
    variants: [
        // Lines 4-6 stopped at 8 and 5 takes; 1-3 draw the fault.
        { label: 'flash', voiceId: FLASH, lines: [1, 2, 3], takes: 80 },
        { label: 'full', voiceId: FULL, lines: [1, 2, 3], takes: 20 },
        // Ways of keeping the voice, one change each against flash.
        { label: 'split', voiceId: FLASH, split: true, lines: [1, 2, 3], takes: 30 },
        { label: 'plain', voiceId: FLASH, style: null, lines: [1, 2, 3], takes: 30 },
        { label: 'lead', voiceId: FLASH, lead: 'Okay.', lines: [1, 2, 3], takes: 30 },
        { label: 'tail', voiceId: FLASH, tail: 'Okay.', lines: [1, 2, 3], takes: 30 },
        // What is left, on the line that drew the fault: more of each model.
        { label: 'flash', voiceId: FLASH, lines: [1], takes: 140 },
        { label: 'full', voiceId: FULL, lines: [1], takes: 60 },
    ],
    // $2 for the job, less $0.02 of raw lead takes outside this log.
    capUsd: 1.98,
    pauseMs: 1200,
};

/** A take this far over its line's median voiced length is a candidate. */
const LONG_OVER_MEDIAN = 0.15;
const DECODE_RATE = 24_000;
const WHISPER_PAUSE_MS = 1500;

interface TakeRow {
    /** The variant's label. */
    model: string;
    voiceId: string;
    line: number;
    take: number;
    /** The audio to judge: the take, the parts joined, or the tail cut off. */
    file: string;
    /** A split take's parts, and a tail take as synthesized. */
    parts?: string[];
    raw?: string;
    /** A lead take: re-rolled once, or said without its lead. */
    leadReroll?: boolean;
    leadDropped?: boolean;
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

function resolvedFor(v: Variant): ResolvedVoice {
    const base = resolveVoice(PLAN.voice);
    const r: ResolvedVoice = { ...base, voiceId: v.voiceId };
    if (v.style === null) delete r.style;
    else if (v.style) r.style = v.style;
    if (v.lead) r.lead = v.lead;
    return r;
}

/** What one take of `line` sends, one string per synthesis. */
function inputsFor(v: Variant, line: number): string[] {
    const text = LINES[line - 1]!;
    if (v.split && SPLITS[line]) return SPLITS[line]!;
    if (v.tail) return [`${text} ${v.tail}`];
    return [text];
}

const linesOf = (v: Variant) => v.lines ?? LINES.map((_, i) => i + 1);

async function synthPhase(out: string, dryRun: boolean): Promise<void> {
    const envFile = arg('--env') ?? resolve(import.meta.dirname, '..', '.env');
    if (existsSync(envFile)) loadEnvFile(envFile);
    const config = loadConfig();
    const rows = readRows(out);
    const done = new Set(rows.map((r) => r.file));
    const spentBefore = rows.reduce((s, r) => s + r.usd, 0);

    let planned = 0;
    for (const v of PLAN.variants) {
        const r = resolvedFor(v);
        const rate = ttsRateFor(r.provider, r.voiceId);
        let usd = 0;
        for (const line of linesOf(v)) {
            for (let take = 1; take <= v.takes; take++) {
                if (done.has(join(v.label, `L${line}-t${take}.mp3`))) continue;
                usd += inputsFor(v, line).reduce((s, t) => s + billedCharsFor(r, t, 1), 0) * rate;
            }
        }
        planned += usd;
        console.log(`${v.label.padEnd(12)} ${v.voiceId} style=${r.style ?? '-'}${v.lead ? ` lead=${v.lead}` : ''}${v.tail ? ` tail=${v.tail}` : ''}${v.split ? ' split' : ''}: lines ${linesOf(v).join(',')} x ${v.takes}, to do $${usd.toFixed(4)}`);
    }
    console.log(`spent $${spentBefore.toFixed(4)}, planned $${planned.toFixed(4)} more (a lead re-roll bills again), cap $${PLAN.capUsd}`);
    if (spentBefore + planned > PLAN.capUsd) throw new Error('plan is over the cap; cut takes');
    if (dryRun) return;

    mkdirSync(out, { recursive: true });
    const log = join(out, 'takes.jsonl');
    let spent = spentBefore;
    // Each variant's missing takes in rounds, a take of every line per round
    // and the variants interleaved, so drift at the provider over the run
    // spreads across every line and variant, extensions of an old one too.
    const missing = PLAN.variants.map((v) => {
        const takes: number[] = [];
        for (let take = 1; take <= v.takes; take++) {
            if (linesOf(v).some((line) => !done.has(join(v.label, `L${line}-t${take}.mp3`)))) takes.push(take);
        }
        return takes;
    });
    const rounds = Math.max(...missing.map((m) => m.length));
    for (let round = 0; round < rounds; round++) {
        for (const [vi, v] of PLAN.variants.entries()) {
            const take = missing[vi]![round];
            if (take === undefined) continue;
            const resolved = resolvedFor(v);
            const synth = synthFor(config, resolved);
            if (!synth) throw new Error(`no ${resolved.provider} key`);
            const rate = ttsRateFor(resolved.provider, resolved.voiceId);
            for (const line of linesOf(v)) {
                const file = join(v.label, `L${line}-t${take}.mp3`);
                if (done.has(file)) continue;
                const inputs = inputsFor(v, line);
                let billedChars = inputs.reduce((s, t) => s + billedCharsFor(resolved, t, 1), 0);
                if (spent + billedChars * rate > PLAN.capUsd) throw new Error(`stopping before the cap at $${spent.toFixed(4)}`);
                const started = Date.now();
                const clips: Uint8Array[] = [];
                const row: Partial<TakeRow> = {};
                for (const input of inputs) {
                    for (let attempt = 0; ; attempt++) {
                        try {
                            clips.push(
                                await synth(input, 1, (chars) => {
                                    billedChars += chars;
                                    // The text alone, without its lead, is the fallback.
                                    if (chars === azureBilledChars(input, 1, resolved.style)) row.leadDropped = true;
                                    else row.leadReroll = true;
                                })
                            );
                            break;
                        } catch (err) {
                            if (attempt >= 3 || !isTransient(err)) throw err;
                            console.log(`  ${file}: ${String(err).slice(0, 120)}; backing off`);
                            await sleep(2000 * 2 ** attempt);
                        }
                    }
                    if (inputs.length > 1) await sleep(PLAN.pauseMs / 2);
                }
                spent += billedChars * rate;
                mkdirSync(join(out, v.label), { recursive: true });
                if (clips.length > 1) {
                    row.parts = clips.map((_, i) => join(v.label, `L${line}-t${take}-${'ab'[i]}.mp3`));
                    clips.forEach((c, i) => writeFileSync(join(out, row.parts![i]!), c));
                    // MP3 frames concatenate cleanly (mp3-lead-silence.ts does
                    // the same): the parts as played back to back.
                    writeFileSync(join(out, file), Buffer.concat(clips));
                } else if (v.tail) {
                    // Cut off in the analysis step, which writes `file`.
                    row.raw = join(v.label, `L${line}-t${take}-raw.mp3`);
                    writeFileSync(join(out, row.raw), clips[0]!);
                } else writeFileSync(join(out, file), clips[0]!);
                const full: TakeRow = { model: v.label, voiceId: v.voiceId, line, take, file, ...row, billedChars, usd: billedChars * rate, ms: Date.now() - started, at: new Date().toISOString() };
                appendFileSync(log, JSON.stringify(full) + '\n');
                console.log(`  ${file.padEnd(24)} ${full.ms}ms  $${spent.toFixed(4)}${row.leadReroll ? ' (lead re-rolled)' : ''}${row.leadDropped ? ' (lead dropped)' : ''}`);
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

interface Heard extends TakeRow {
    durationS: number;
    voicedS: number;
    /** Voiced span less the pauses inside it (cadence.ts findPauses). */
    speechS: number;
    longestPauseS: number;
    /** Pauses inside the voiced span, seconds and what they fall at. */
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
    /** A split take: the silence between the parts' voices, and each part's gate faults. */
    joinS?: number;
    partFaults?: string[];
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

/** Said again, as the whole take or its bursts heard alone. */
const repeats = (h: Heard) => (h.repeated.length ? h.repeated : (h.burstRepeated ?? []));

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function measure(pcm: Float32Array, text: string): Omit<Heard, keyof TakeRow | 'heard' | 'repeated' | 'missing'> & { a: ClipAnalysis } {
    const a = analyzePcm(pcm, DECODE_RATE);
    const pauses = findPauses(pcm, DECODE_RATE, text);
    const inside = pauses.filter((p) => p.startS >= (a.bursts[0]?.startS ?? 0) && p.endS <= (a.bursts.at(-1)?.endS ?? 0));
    const pausedS = inside.reduce((s, p) => s + (p.endS - p.startS), 0);
    return {
        a,
        durationS: a.durationS,
        voicedS: a.voicedS,
        speechS: a.voicedS - pausedS,
        longestPauseS: Math.max(0, ...inside.map((p) => p.endS - p.startS)),
        pauses: inside.map((p) => ({ s: Math.round((p.endS - p.startS) * 100) / 100, kind: p.kind })),
        midClause: inside.filter((p) => p.kind === 'word').length,
        midClauseLong: inside.filter((p) => p.kind === 'word' && p.endS - p.startS > PAUSE_CAP_S.word).length,
        bursts: a.bursts.length,
        msPerTextChar: (a.durationS * 1000) / text.length,
        sPerSpokenChar: a.voicedS / spokenChars(text),
        gateFaults: clipFaults(a, text),
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
        const text = LINES[row.line - 1]!;
        const extra: Partial<Heard> = {};
        let mp3: Uint8Array;
        if (row.raw) {
            const rawMp3 = new Uint8Array(readFileSync(join(out, row.raw)));
            const rawPcm = decode(ffmpeg, rawMp3);
            const variant = PLAN.variants.find((v) => v.label === row.model);
            extra.rawHeard = transcribe(whisper, ffmpeg, rawMp3);
            extra.rawRepeated = extra.rawHeard === null ? [] : repeatedWords(`${text} ${variant?.tail ?? ''}`, extra.rawHeard);
            await sleep(WHISPER_PAUSE_MS);
            const cut = cutTail(rawPcm);
            if (cut) {
                extra.tailGapS = cut.gapS;
                extra.guardS = cut.guardS;
                mp3 = encode(ffmpeg, cut.pcm);
            } else {
                extra.cutFailed = true;
                mp3 = rawMp3;
            }
            writeFileSync(join(out, row.file), mp3);
        } else mp3 = new Uint8Array(readFileSync(join(out, row.file)));
        if (row.parts) {
            const [pa, pb] = row.parts.map((p) => decode(ffmpeg, new Uint8Array(readFileSync(join(out, p)))));
            const sa = analyzePcm(pa!, DECODE_RATE);
            const sb = analyzePcm(pb!, DECODE_RATE);
            const tailA = sa.bursts.length ? sa.durationS - sa.bursts.at(-1)!.endS : 0;
            const headB = sb.bursts.length ? sb.bursts[0]!.startS : 0;
            extra.joinS = tailA + headB;
            extra.partFaults = [...clipFaults(sa, SPLITS[row.line]![0]!).map((f) => `a: ${f}`), ...clipFaults(sb, SPLITS[row.line]![1]!).map((f) => `b: ${f}`)];
        }
        const pcm = decode(ffmpeg, mp3);
        const { a: _a, ...m } = measure(pcm, text);
        const heard = transcribe(whisper, ffmpeg, mp3);
        cache[row.file] = {
            ...row,
            ...m,
            ...extra,
            heard,
            repeated: heard === null ? [] : repeatedWords(text, heard),
            missing: heard === null ? [] : missingWords(text, heard),
        };
        writeFileSync(cachePath, JSON.stringify(cache, null, 1));
        const h = cache[row.file]!;
        console.log(
            `${row.file.padEnd(24)} ${h.durationS.toFixed(2)}s  voiced ${h.voicedS.toFixed(2)}  speech ${h.speechS.toFixed(2)}  mid ${h.midClause}` +
                (h.joinS !== undefined ? `  join ${h.joinS.toFixed(2)}` : '') +
                (h.repeated.length ? `  REPEAT "${h.repeated.join(' ')}"` : '') +
                (h.rawRepeated?.length ? `  RAW REPEAT "${h.rawRepeated.join(' ')}"` : '') +
                (h.cutFailed ? '  CUT FAILED' : '') +
                `  ${heard}`
        );
        await sleep(WHISPER_PAUSE_MS);
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
        const text = LINES[h.line - 1]!;
        const med = median(all.filter((o) => o.model === h.model && o.line === h.line).map((o) => o.voicedS));
        if (h.bursts <= phraseCount(text) && h.voicedS <= med * (1 + LONG_OVER_MEDIAN)) continue;
        const pcm = decode(ffmpeg, new Uint8Array(readFileSync(join(out, h.file))));
        const { bursts } = analyzePcm(pcm, DECODE_RATE);
        const heard: (string | null)[] = [];
        for (const b of bursts) {
            const from = Math.max(0, Math.round((b.startS - 0.1) * DECODE_RATE));
            const to = Math.min(pcm.length, Math.round((b.endS + 0.15) * DECODE_RATE));
            heard.push(transcribe(whisper, ffmpeg, encode(ffmpeg, pcm.subarray(from, to))));
            await sleep(WHISPER_PAUSE_MS);
        }
        h.burstHeard = heard;
        h.burstRepeated = repeatedWords(text, heard.filter((t) => t !== null).join(' '));
        writeFileSync(cachePath, JSON.stringify(cache, null, 1));
        console.log(`${h.file.padEnd(24)} ${bursts.length} bursts${h.burstRepeated.length ? `  REPEAT "${h.burstRepeated.join(' ')}"` : ''}  ${heard.map((t) => `[${t}]`).join(' ')}`);
    }
    report(Object.values(cache));
}

function report(all: Heard[]): void {
    const variants = [...new Set(all.map((h) => h.model))];
    const flagged: (Heard & { over: number; speechOver: number })[] = [];
    for (const variant of variants) {
        console.log(`\n== ${variant} ==`);
        console.log('line  takes  heard-again  long(>15% voiced)  mid-clause pauses (>0.4s)  median voiced  range voiced');
        let tot = { takes: 0, rep: 0, long: 0, mid: 0, midLong: 0 };
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
                if (over > LONG_OVER_MEDIAN || repeats(t).length || t.rawRepeated?.length || t.gateFaults.length || t.missing.length || t.partFaults?.length || t.cutFailed)
                    flagged.push({ ...t, over, speechOver });
            }
            const rep = takes.filter((t) => repeats(t).length).length;
            const mid = takes.reduce((s, t) => s + t.midClause, 0);
            const midLong = takes.reduce((s, t) => s + t.midClauseLong, 0);
            tot = { takes: tot.takes + takes.length, rep: tot.rep + rep, long: tot.long + long, mid: tot.mid + mid, midLong: tot.midLong + midLong };
            const vs = takes.map((t) => t.voicedS);
            const joins = takes.filter((t) => t.joinS !== undefined).map((t) => t.joinS!);
            const raw = takes.filter((t) => t.rawRepeated?.length).length;
            const cutFailed = takes.filter((t) => t.cutFailed).length;
            const lead = takes.filter((t) => t.leadReroll || t.leadDropped).map((t) => (t.leadDropped ? 'D' : 'R')).join('');
            // A lead or guard word left in what plays.
            const guardHeard = takes.filter((t) => (t.raw || PLAN.variants.find((v) => v.label === t.model)?.lead) && /\bokay\b/i.test(t.heard ?? '')).length;
            const partFaulted = takes.filter((t) => t.partFaults?.some((f) => /repeat/.test(f))).length;
            console.log(
                `L${line}    ${String(takes.length).padStart(3)}  ${String(rep).padStart(6)}       ${String(long).padStart(6)}            ${String(mid).padStart(4)} (${midLong})               ${med.toFixed(2)}s        ${Math.min(...vs).toFixed(2)}-${Math.max(...vs).toFixed(2)}s` +
                    (joins.length ? `  join median ${median(joins).toFixed(2)}s (${Math.min(...joins).toFixed(2)}-${Math.max(...joins).toFixed(2)})` : '') +
                    (raw ? `  raw repeats ${raw}` : '') +
                    (cutFailed ? `  cut failed ${cutFailed}` : '') +
                    (lead ? `  lead ${lead}` : '') +
                    (guardHeard ? `  "okay" heard ${guardHeard}` : '') +
                    (partFaulted ? `  part bursts>phrases ${partFaulted}` : '')
            );
        }
        console.log(`all   ${String(tot.takes).padStart(3)}  ${String(tot.rep).padStart(6)}       ${String(tot.long).padStart(6)}            ${String(tot.mid).padStart(4)} (${tot.midLong})`);
    }
    console.log('\n== flagged takes ==');
    for (const f of flagged.sort((a, b) => b.over - a.over)) {
        console.log(
            `${f.file}  dur ${f.durationS.toFixed(2)}s  voiced +${(f.over * 100).toFixed(0)}%  speech +${(f.speechOver * 100).toFixed(0)}%  longest pause ${f.longestPauseS.toFixed(2)}s` +
                (f.repeated.length ? `  REPEAT "${f.repeated.join(' ')}"` : '') +
                (!f.repeated.length && f.burstRepeated?.length ? `  BURST REPEAT "${f.burstRepeated.join(' ')}"` : '') +
                (f.rawRepeated?.length ? `  RAW REPEAT "${f.rawRepeated.join(' ')}"` : '') +
                (f.missing.length ? `  MISSING "${f.missing.join(' ')}"` : '') +
                (f.gateFaults.length ? `  GATE ${f.gateFaults.join('; ')}` : '') +
                (f.partFaults?.length ? `  PARTS ${f.partFaults.join('; ')}` : '') +
                (f.cutFailed ? '  CUT FAILED' : '') +
                `\n    heard: ${f.heard}` +
                (f.burstHeard ? `\n    bursts: ${f.burstHeard.map((t) => `[${t}]`).join(' ')}` : '') +
                (f.rawHeard !== undefined ? `\n    raw:   ${f.rawHeard}` : '')
        );
    }
}

async function main(): Promise<void> {
    const phase = process.argv[2];
    const out = arg('--out');
    if (!out) throw new Error('--out <dir> is required');
    if (phase === 'synth') await synthPhase(out, process.argv.includes('--dry-run'));
    else if (phase === 'analyze') await analyzePhase(out);
    else if (phase === 'recheck') await recheckPhase(out);
    else if (phase === 'report') report(Object.values(JSON.parse(readFileSync(join(out, 'heard.json'), 'utf8')) as Record<string, Heard>));
    else throw new Error('first argument: synth, analyze, recheck or report');
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
