/**
 * Render the setup screen's fixed lines (core facilitation/setup-lines.ts)
 * once per house voice (voice-catalog `house`) into static clips the UI
 * ships, and write the manifest it reads (ui/src/voice-clips.json). Run from
 * ts/:
 *
 *   npm run clips:render -- --dry-run    # what would render and what it costs; no provider calls
 *   npm run clips:render:yes             # render what is missing or stale (= clips:render -- --yes)
 *   npm run clips:check                  # exit 1 if any clip is missing, stale or ends in long silence (pre-release)
 *   npm run clips:render -- --trim       # cut the silence after each clip's voice, from the files; no provider calls
 *   npm run clips:render -- --voice Harper --only mode-noting,timer-off --force --yes
 *
 * Flags: --voice <name>[,<name>], --only <line-id>[,<line-id>], --force
 * (re-render current clips too), --yes (without it a run prints the estimate
 * and stops before spending), --no-gate (skip the quality gate; no ffmpeg),
 * --trim (a run of its own, like --check and --dry-run).
 *
 * Cheap to re-run: a clip whose manifest entry has the line's current text,
 * whose file name carries the current (text, voice id, style, gain) hash and
 * whose file exists is skipped. A clip whose only change is the voice's gainDb
 * is moved by the difference from its own file (mp3-gain.ts), with no
 * synthesis. Clips of removed lines and replaced renders are deleted. Each
 * clip is synthesized through the server's own path (routes/tts.ts synthFor,
 * lead silence included) at rate 1, so it is what a session would hear; a
 * styled voice ignores rate anyway.
 *
 * THE GATE (voice-clips/analysis.ts). Every clip is decoded with ffmpeg and
 * checked for a repeated utterance (on a short line, more bursts than its
 * phrases; on a long one, a word Whisper hears said again), for words Whisper
 * does not hear, the first above all (an English line of MIN_HEARD_WORDS or
 * more, transcript.ts), and a cut first word (no onset rise); a failing clip
 * is re-rendered, up to
 * MAX_ATTEMPTS. A long line is rendered until LONG_LINE_TAKES pass and keeps
 * the one with the fewest pauses inside a clause. A second pass checks each
 * new clip's length against its voice's own seconds-per-character norm,
 * computed from the voice's whole set, and re-rolls the outliers. A clip that fails every attempt keeps its
 * best render and is marked `suspect` in the manifest: the run ends by
 * listing those, which are the only ones anyone needs to listen to. Deleting
 * a `suspect` field by hand after listening clears it; it stays cleared until
 * the line re-renders. Each re-roll is billed, so the estimate is a floor.
 *
 * Before the 48 kbps encode, every pause longer than its punctuation can
 * carry is shortened (voice-clips/cadence.ts), and the silence after the last
 * sound is cut to TAIL.keepS (voice-clips/tail.ts), since the setup screen's
 * mic stays shut until a clip's file ends. --check lists a clip that ends in
 * more than TAIL.maxS of silence; --trim cuts the ones on disk on whole MP3
 * frames, with no synthesis (a stream it can't walk is re-encoded).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { loadServerEnv } from '../../soak/env.js';
import { SETUP_LINE_IDS, setupLineText, type SetupLineId } from '../../src/facilitation/setup-lines.js';
import { loadConfig } from '../src/config.js';
import { ttsRateFor } from '../src/pricing/providers.js';
import { withGain } from '../src/providers/mp3-gain.js';
import { TtsUpstreamError, isProviderAccountFailure } from '../src/providers/tts.js';
import { CURATED_VOICES, resolveVoice, type ResolvedVoice } from '../src/providers/voice-catalog.js';
import { billedCharsFor, synthFor } from '../src/routes/tts.js';
import { GATE, analyzePcm, clipFaults, secondsPerCharNorm, wordCount, type ClipAnalysis } from './voice-clips/analysis.js';
import { capPauses, findPauses } from './voice-clips/cadence.js';
import { TAIL, cutMp3Tail, soundEndS, trailingSilenceS, trimTail, withoutHeader } from './voice-clips/tail.js';
import { MIN_HEARD_WORDS, findWhisper, transcriptFaults, transcribe, words } from './voice-clips/transcript.js';
import {
    emptyManifest,
    orphanFiles,
    planClips,
    pruneManifest,
    serializeManifest,
    voiceDetails,
    type ClipEntry,
    type ClipManifest,
    type ClipTarget,
    type HouseVoice,
} from './voice-clips/plan.js';

const UI_DIR = resolve(import.meta.dirname, '..', '..', 'ui');
const CLIPS_DIR = resolve(UI_DIR, 'public', 'voice-clips');
const MANIFEST_PATH = resolve(UI_DIR, 'src', 'voice-clips.json');

const MAX_ATTEMPTS = 4;
/** On these voices a long line's pauses vary more from take to take than
 *  anything else about it (2026-11-16: 0 to 6 inside a clause over ten takes
 *  of one line), so it is rendered until this many takes pass. */
const LONG_LINE_TAKES = 3;
const isLongLine = (text: string) => wordCount(text) > GATE.burstCheckMaxWords;
const CONCURRENCY = 3;
/** Decode rate for the gate; Azure renders at 24kHz. */
const DECODE_RATE = 24_000;

type SynthFn = NonNullable<ReturnType<typeof synthFor>>;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
    dryRun: boolean;
    check: boolean;
    trim: boolean;
    force: boolean;
    yes: boolean;
    gate: boolean;
    voices: string[] | null;
    only: string[] | null;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { dryRun: false, check: false, trim: false, force: false, yes: false, gate: true, voices: null, only: null };
    const list = (v: string | undefined, flag: string): string[] => {
        const items = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!items.length) fail(`${flag} needs a value`);
        return items;
    };
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i]!;
        const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
        const value = () => inline ?? argv[++i];
        switch (flag) {
            case '--dry-run':
                args.dryRun = true;
                break;
            case '--check':
                args.check = true;
                break;
            case '--trim':
                args.trim = true;
                break;
            case '--force':
                args.force = true;
                break;
            case '--yes':
                args.yes = true;
                break;
            case '--no-gate':
                args.gate = false;
                break;
            case '--voice':
                args.voices = [...(args.voices ?? []), ...list(value(), '--voice')];
                break;
            case '--only':
                args.only = [...(args.only ?? []), ...list(value(), '--only')];
                break;
            default:
                // Strict on purpose: a misspelt --dry-run next to --yes would spend.
                fail(`unknown argument "${raw}"`);
        }
    }
    if ([args.dryRun, args.check, args.trim].filter(Boolean).length > 1) fail('--dry-run, --check and --trim are separate runs; pick one');
    return args;
}

function fail(message: string): never {
    console.error(`clips:render: ${message}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Manifest and files
// ---------------------------------------------------------------------------

function readManifest(): ClipManifest {
    if (!existsSync(MANIFEST_PATH)) {
        // The UI imports the manifest, so it must exist even before a render.
        writeFileSync(MANIFEST_PATH, serializeManifest(emptyManifest()));
        console.log(`Created an empty ${rel(MANIFEST_PATH)}.`);
        return emptyManifest();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    } catch (err) {
        fail(`${rel(MANIFEST_PATH)} is not valid JSON (${String(err)}); fix it or delete it to start over`);
    }
    const voices = (parsed as { voices?: unknown } | null)?.voices;
    if (!voices || typeof voices !== 'object') fail(`${rel(MANIFEST_PATH)} has no "voices" object`);
    return parsed as ClipManifest;
}

function clipPath(file: string): string {
    return resolve(CLIPS_DIR, file);
}

function clipsOnDisk(): string[] {
    if (!existsSync(CLIPS_DIR)) return [];
    return readdirSync(CLIPS_DIR, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.mp3'))
        .map((f) => f.split(sep).join('/'))
        .sort();
}

function deleteClip(file: string): void {
    rmSync(clipPath(file), { force: true });
    // Drop directories the delete emptied, up to (not including) CLIPS_DIR.
    for (let dir = dirname(clipPath(file)); dir.startsWith(CLIPS_DIR + sep); dir = dirname(dir)) {
        try {
            rmdirSync(dir);
        } catch {
            break; // not empty
        }
    }
}

function rel(path: string): string {
    return path.slice(resolve(UI_DIR, '..').length + 1);
}

// ---------------------------------------------------------------------------
// Synthesis and the gate
// ---------------------------------------------------------------------------

function findFfmpeg(): string | null {
    for (const candidate of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
        try {
            execFileSync(candidate, ['-version'], { stdio: 'ignore' });
            return candidate;
        } catch {
            /* try the next */
        }
    }
    return null;
}

function decodeMp3(ffmpeg: string, mp3: Uint8Array): Float32Array {
    const out = execFileSync(
        ffmpeg,
        ['-v', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(DECODE_RATE), 'pipe:1'],
        { input: mp3, maxBuffer: 256 * 1024 * 1024 }
    );
    // Copied: a Float32Array view needs 4-byte alignment the Buffer may not have.
    const bytes = new Uint8Array(out.byteLength);
    bytes.set(out);
    return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

/** What a shipped clip is encoded at. The providers send 96 kbps; these are
 *  a few seconds of one voice each and there are a couple of hundred of them
 *  in every build, so they ship at half that. */
const CLIP_BITRATE = '48k';

/** What a clip is levelled to: the catalog average (CuratedVoice.gainDb), or
 *  for a voice that can't reach it, where its sessions sit (sessionLufs), so
 *  the tour is never louder than what follows. A voice's gainDb is one trim
 *  for all its audio and some voices move 8 dB from take to take (Dahai,
 *  Serena); a clip is one take, decoded here anyway, so it gets its own. */
const CLIP_LUFS = -22.4;
/** The sample peak a boosted clip is limited to: about -3 dBFS, which keeps
 *  the encoded file under -2 dBTP. */
const CLIP_PEAK = 0.7;
const CLIP_GAIN_DB: readonly [number, number] = [-6, 12];

const PCM_IN = ['-f', 'f32le', '-ar', String(DECODE_RATE), '-ac', '1', '-i', 'pipe:0'];

/** Integrated loudness in LUFS, or null for a clip too short to have one. */
function loudness(ffmpeg: string, pcm: Float32Array): number | null {
    // Once in a couple of hundred runs this ffmpeg sat idle for good on its
    // piped input, so it gets a clock and a second go.
    for (let attempt = 0; attempt < 2; attempt++) {
        const run = spawnSync(ffmpeg, ['-hide_banner', '-nostats', ...PCM_IN, '-af', 'ebur128', '-f', 'null', '-'], {
            input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
            maxBuffer: 64 * 1024 * 1024,
            timeout: 20_000,
        });
        if (run.error || run.status !== 0) continue;
        const summary = String(run.stderr).split('Summary:').pop() ?? '';
        const lufs = Number(/\bI:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
        return Number.isFinite(lufs) && lufs > -60 ? lufs : null;
    }
    return null;
}

/** The gain that brings `pcm` to `target` LUFS, in dB, or null when its
 *  loudness can't be measured. */
function levelGain(ffmpeg: string, pcm: Float32Array, target: number): number | null {
    const lufs = loudness(ffmpeg, pcm);
    if (lufs === null) return null;
    return Math.round(Math.min(CLIP_GAIN_DB[1], Math.max(CLIP_GAIN_DB[0], target - lufs)) * 10) / 10;
}

function encodeClip(ffmpeg: string, pcm: Float32Array, gainDb = 0): Uint8Array {
    const level = gainDb ? ['-af', `volume=${gainDb}dB,alimiter=limit=${CLIP_PEAK}:level=false:latency=true`] : [];
    return execFileSync(
        ffmpeg,
        ['-v', 'error', ...PCM_IN, ...level, '-codec:a', 'libmp3lame', '-b:a', CLIP_BITRATE, '-f', 'mp3', 'pipe:1'],
        { input: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), maxBuffer: 64 * 1024 * 1024 }
    );
}

/** The clip at `from` moved by its gain change, or null when withGain can't
 *  walk it (the line is synthesized again instead). */
function relevelled(from: { file: string; deltaDb: number }): Uint8Array | null {
    const bytes = new Uint8Array(readFileSync(clipPath(from.file)));
    // A levelled clip is already where it belongs: only its name changes.
    if (from.deltaDb === 0) return bytes;
    const moved = withGain(bytes, from.deltaDb);
    return moved === bytes ? null : moved;
}

/** The clips on disk with more silence after the voice than TAIL.maxS. */
function longTails(ffmpeg: string, targets: readonly ClipTarget[]): { target: ClipTarget; silenceS: number }[] {
    return targets
        .map((target) => ({ target, silenceS: trailingSilenceS(decodeMp3(ffmpeg, readFileSync(clipPath(target.file))), DECODE_RATE) }))
        .filter((t) => t.silenceS > TAIL.maxS);
}

/** Each clip on disk cut to TAIL.keepS after its voice, on whole frames, or
 *  re-encoded where the stream can't be walked and runs long. The file keeps
 *  its name, which hashes what was rendered, not the bytes. */
function trimOnDisk(ffmpeg: string, targets: readonly ClipTarget[]): void {
    let trimmed = 0;
    for (const target of targets) {
        const bytes = withoutHeader(new Uint8Array(readFileSync(clipPath(target.file))));
        const pcm = decodeMp3(ffmpeg, bytes);
        const end = soundEndS(pcm, DECODE_RATE);
        const before = pcm.length / DECODE_RATE - end;
        const cut = cutMp3Tail(bytes, end);
        const out = cut ?? (before > TAIL.maxS ? encodeClip(ffmpeg, trimTail(pcm, DECODE_RATE)) : bytes);
        if (out === bytes) continue;
        writeFileSync(clipPath(target.file), out);
        const after = trailingSilenceS(decodeMp3(ffmpeg, out), DECODE_RATE);
        console.log(`  ${label(target).padEnd(32)} ${before.toFixed(2)}s -> ${after.toFixed(2)}s${cut ? '' : ' (re-encoded)'}`);
        trimmed++;
    }
    console.log(`\n${trimmed} of ${targets.length} clip${targets.length === 1 ? '' : 's'} trimmed.`);
}

/** A burst limit or a network blip, worth another go; an account refusal
 *  (bad key, spent quota) or a bad request is not. */
function isTransient(err: unknown): boolean {
    if (!(err instanceof TtsUpstreamError) || isProviderAccountFailure(err)) return false;
    return err.status === null || err.status === 429 || err.status >= 500;
}

async function synthWithRetry(synth: SynthFn, text: string): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await synth(text, 1);
        } catch (err) {
            if (attempt >= 2 || !isTransient(err)) throw err;
            await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        }
    }
}

interface Attempt {
    bytes: Uint8Array;
    analysis?: ClipAnalysis;
    /** Pauses inside a clause (cadence.ts), what picks among a long line's takes. */
    midClause?: number;
    /** What the transcript check found wrong. */
    heardFaults?: string[];
}

interface Job {
    target: ClipTarget;
    resolved: ResolvedVoice;
    synth: SynthFn;
    billedChars: number;
    attempts: Attempt[];
    error?: string;
}

function faultsOf(attempt: Attempt, text: string, norm: number | null): string[] {
    const faults = attempt.analysis ? clipFaults(attempt.analysis, text, norm) : [];
    faults.push(...(attempt.heardFaults ?? []));
    return faults;
}

/** The attempt to keep: fewest faults, then fewest pauses inside a clause,
 *  then (a repeat runs long) the shortest. */
function bestAttempt(job: Job, norm: number | null): Attempt | undefined {
    const score = (a: Attempt) => {
        const faults = faultsOf(a, job.target.text, norm);
        const silent = a.analysis && a.analysis.bursts.length === 0 ? 1e6 : 0;
        return silent + faults.length * 1e4 + (a.midClause ?? 0) * 1e2 + (a.analysis?.voicedS ?? 0);
    };
    return job.attempts.reduce<Attempt | undefined>((best, a) => (!best || score(a) < score(best) ? a : best), undefined);
}

function describe(a: ClipAnalysis): string {
    const gaps = a.gapsS.length ? ` (gaps ${a.gapsS.map((g) => `${g.toFixed(2)}s`).join(', ')})` : '';
    const onset = a.onsetRiseMs === null ? 'onset soft' : `onset ${a.onsetRiseMs}ms`;
    return `voiced ${a.voicedS.toFixed(2)}s, ${a.bursts.length} burst${a.bursts.length === 1 ? '' : 's'}${gaps}, ${onset}`;
}

const label = (t: ClipTarget) => `${t.voice.name}/${t.lineId}`;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function usd(resolved: ResolvedVoice, chars: number): number {
    return chars * ttsRateFor(resolved.provider, resolved.voiceId);
}

function money(n: number): string {
    return `$${n.toFixed(4)}`;
}

/** Billed characters and dollars per voice, one attempt per clip. */
function printEstimate(jobs: readonly { target: ClipTarget; resolved: ResolvedVoice }[]): void {
    const byVoice = new Map<string, { count: number; chars: number; usd: number }>();
    let worst = 0;
    for (const { target, resolved } of jobs) {
        const row = byVoice.get(target.voice.name) ?? { count: 0, chars: 0, usd: 0 };
        const once = billedCharsFor(resolved, target.text, 1);
        const chars = once * (isLongLine(target.text) ? LONG_LINE_TAKES : 1);
        row.count++;
        row.chars += chars;
        row.usd += usd(resolved, chars);
        worst += usd(resolved, once * MAX_ATTEMPTS);
        byVoice.set(target.voice.name, row);
    }
    let total = { count: 0, chars: 0, usd: 0 };
    console.log(`\nEstimate (one take per clip, ${LONG_LINE_TAKES} for a long line):`);
    for (const [name, row] of byVoice) {
        console.log(`  ${name.padEnd(10)} ${String(row.count).padStart(4)} clips  ${String(row.chars).padStart(7)} billed chars  ${money(row.usd)}`);
        total = { count: total.count + row.count, chars: total.chars + row.chars, usd: total.usd + row.usd };
    }
    console.log(`  ${'total'.padEnd(10)} ${String(total.count).padStart(4)} clips  ${String(total.chars).padStart(7)} billed chars  ${money(total.usd)}`);
    console.log(`  Each gate re-roll bills again, up to ${MAX_ATTEMPTS} attempts per clip (${money(worst)} at worst).`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await work(items[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    const allVoices: HouseVoice[] = CURATED_VOICES.filter((v) => v.house).map((v) => ({
        name: v.name,
        language: v.house!,
        gender: v.gender,
        providerVoiceId: v.providerVoiceId,
        ...(v.style ? { style: v.style } : {}),
        ...(v.gainDb ? { gainDb: v.gainDb } : {}),
        ...(v.sessionLufs !== undefined ? { sessionLufs: v.sessionLufs } : {}),
    }));
    if (!allVoices.length) fail('no curated voice carries `house` (server/src/providers/voice-catalog.ts)');
    const wanted = args.voices?.map((name) => {
        const v = allVoices.find((h) => h.name.toLowerCase() === name.toLowerCase());
        if (!v) fail(`"${name}" is not a house voice; house voices: ${allVoices.map((h) => h.name).join(', ')}`);
        return v.name;
    });
    for (const id of args.only ?? []) {
        if (!(SETUP_LINE_IDS as readonly string[]).includes(id)) fail(`"${id}" is not a line id in setup-lines.ts`);
    }
    const voices = wanted ? allVoices.filter((v) => wanted.includes(v.name)) : allVoices;
    const lineIds = args.only ? SETUP_LINE_IDS.filter((id) => args.only!.includes(id)) : SETUP_LINE_IDS;
    const textFor = (voice: HouseVoice, id: string) => setupLineText(id as SetupLineId, voice.language, { name: voice.name });

    const pruned = pruneManifest(readManifest(), allVoices, SETUP_LINE_IDS);
    const manifest = pruned.manifest;
    for (const v of voices) manifest.voices[v.name] ??= { ...voiceDetails(v), clips: {} };
    const targets = planClips(voices, lineIds, textFor, manifest, (f) => existsSync(clipPath(f)));
    const pending = targets.filter((t) => t.status !== 'current');
    const suspects = targets.filter((t) => manifest.voices[t.voice.name]?.clips[t.lineId]?.suspect);

    const scope = `${voices.length} voice${voices.length === 1 ? '' : 's'} x ${lineIds.length} line${lineIds.length === 1 ? '' : 's'}`;

    if (args.check) {
        const orphans = orphanFiles(manifest, clipsOnDisk());
        const ffmpeg = findFfmpeg();
        const tails = ffmpeg ? longTails(ffmpeg, targets.filter((t) => t.status === 'current')) : [];
        const problems = pending.length + pruned.removed.length + orphans.length;
        const status = [
            pending.length ? `${pending.length} missing or stale` : 'all current',
            ...(tails.length ? [`${tails.length} with over ${TAIL.maxS}s of silence after the voice`] : []),
        ];
        console.log(`Setup clips (${scope}): ${status.join(', ')}.`);
        for (const t of pending) console.log(`  ${t.status.padEnd(7)} ${label(t).padEnd(32)} ${t.why}`);
        for (const r of pruned.removed) console.log(`  extra   ${r}`);
        for (const f of orphans) console.log(`  orphan  ${f}`);
        for (const { target, silenceS } of tails) console.log(`  tail    ${label(target).padEnd(32)} ${silenceS.toFixed(2)}s`);
        if (!ffmpeg) console.log('  (no ffmpeg: the silence after each voice was not checked)');
        printSuspects(suspects, manifest);
        if (problems) console.log('\nFix with: npm run clips:render:yes');
        if (tails.length) console.log('\nTrim with: npm run clips:render -- --trim (from the files, no cost)');
        if (problems || tails.length) process.exit(1);
        return;
    }

    if (args.trim) {
        const ffmpeg = findFfmpeg();
        if (!ffmpeg) fail('ffmpeg not found (brew install ffmpeg); --trim decodes each clip to find where its voice ends.');
        console.log(`Setup clips (${scope}): the silence after each voice cut to ${TAIL.keepS}s, from the files.`);
        trimOnDisk(ffmpeg, targets.filter((t) => t.status === 'current'));
        return;
    }

    const toRender = args.force ? targets : pending;
    // A clip whose only change is the voice's gain is moved from its own file:
    // the same take, no synthesis. --force asks for new takes instead.
    const relevels: { target: ClipTarget; bytes: Uint8Array }[] = [];
    const toSynth: ClipTarget[] = [];
    for (const target of toRender) {
        const bytes = !args.force && target.from ? relevelled(target.from) : null;
        if (bytes) relevels.push({ target, bytes });
        else toSynth.push(target);
    }
    loadServerEnv();
    const config = loadConfig();
    const jobs: Job[] = [];
    for (const target of toSynth) {
        const resolved = resolveVoice(target.voice.name);
        const synth = synthFor(config, resolved);
        if (!synth && !args.dryRun) fail(`no ${resolved.provider} key for ${target.voice.name} (ts/server/.env)`);
        jobs.push({
            target,
            resolved,
            synth: synth ?? (() => Promise.reject(new Error('dry run'))),
            billedChars: billedCharsFor(resolved, target.text, 1),
            attempts: [],
        });
    }

    console.log(
        `Setup clips (${scope}): ${jobs.length} to render, ${relevels.length} to re-level, ${targets.length - pending.length} current` +
            (args.force ? ' (forced)' : '') +
            '.'
    );

    if (args.dryRun) {
        for (const j of jobs)
            console.log(`  ${label(j.target).padEnd(32)} ${(args.force && j.target.status === 'current' ? 'forced' : `${j.target.status}: ${j.target.why}`).padEnd(36)} ${String(j.billedChars).padStart(4)}c  ${JSON.stringify(j.target.text)}`);
        for (const { target } of relevels) console.log(`  ${label(target).padEnd(32)} relevel: ${target.why} (from its file, free)`);
        for (const r of pruned.removed) console.log(`  would drop ${r}`);
        for (const f of orphanFiles(manifest, clipsOnDisk())) console.log(`  would delete ${f}`);
        if (jobs.length) printEstimate(jobs);
        printSuspects(suspects, manifest);
        return;
    }

    if (jobs.length) printEstimate(jobs);
    if (relevels.length) console.log(`\n${relevels.length} clip${relevels.length === 1 ? '' : 's'} to re-level from the file: no synthesis, no cost.`);
    if ((jobs.length || relevels.length) && !args.yes) {
        // `npm run clips:render --yes` hands --yes to npm, not to this script.
        const eaten = process.env['npm_config_yes'] ? ' (npm kept your --yes for itself: it needs the bare -- first)' : '';
        console.log(`\nNothing ${jobs.length ? 'spent' : 'changed'}${eaten}. To render: npm run clips:render:yes`);
        return;
    }

    const ffmpeg = jobs.length && args.gate ? findFfmpeg() : null;
    if (jobs.length && args.gate && !ffmpeg)
        fail('ffmpeg not found (brew install ffmpeg); the quality gate decodes every clip. --no-gate renders without it.');
    const hearable = (t: ClipTarget) => t.voice.language === 'en' && words(t.text).length >= MIN_HEARD_WORDS;
    const whisper = ffmpeg && jobs.some((j) => hearable(j.target)) ? findWhisper() : null;
    if (ffmpeg && !whisper && jobs.some((j) => hearable(j.target)))
        console.log(
            '\nTranscript check off: no whisper_batch build or base.en model ' +
                '(cargo build --manifest-path ts/src-tauri/Cargo.toml --example whisper_batch).'
        );

    const billed = new Map<string, { chars: number; usd: number }>();
    const save = () => writeFileSync(MANIFEST_PATH, serializeManifest(manifest));

    if (relevels.length) {
        console.log('\nRe-levelling:');
        for (const { target, bytes } of relevels) {
            mkdirSync(dirname(clipPath(target.file)), { recursive: true });
            writeFileSync(clipPath(target.file), bytes);
            const entry: ClipEntry = { ...manifest.voices[target.voice.name]!.clips[target.lineId]!, file: target.file };
            delete entry.gainDb;
            if (target.voice.gainDb) entry.gainDb = target.voice.gainDb;
            manifest.voices[target.voice.name]!.clips[target.lineId] = entry;
            console.log(`  ${label(target).padEnd(32)} ${target.why}`);
        }
        save();
    }

    const run = async (job: Job, norm: number | null) => {
        const { target } = job;
        const wanted = isLongLine(target.text) ? LONG_LINE_TAKES : 1;
        for (;;) {
            if (job.attempts.filter((a) => faultsOf(a, target.text, norm).length === 0).length >= wanted) return;
            if (job.attempts.length >= MAX_ATTEMPTS) return;
            let bytes: Uint8Array;
            try {
                bytes = await synthWithRetry(job.synth, target.text);
            } catch (err) {
                job.error = String(err).slice(0, 200);
                console.log(`  ${label(target).padEnd(32)} FAILED: ${job.error}`);
                return;
            }
            const row = billed.get(target.voice.name) ?? { chars: 0, usd: 0 };
            billed.set(target.voice.name, {
                chars: row.chars + job.billedChars,
                usd: row.usd + usd(job.resolved, job.billedChars),
            });
            const attempt: Attempt = { bytes };
            if (ffmpeg) {
                try {
                    const pcm = decodeMp3(ffmpeg, bytes);
                    attempt.analysis = analyzePcm(pcm, DECODE_RATE);
                    if (isLongLine(target.text))
                        attempt.midClause = findPauses(pcm, DECODE_RATE, target.text).filter((p) => p.kind === 'word').length;
                } catch (err) {
                    console.log(`  ${label(target).padEnd(32)} could not decode: ${String(err).slice(0, 160)}`);
                    attempt.analysis = { durationS: 0, bursts: [], gapsS: [], voicedS: 0, onsetRiseMs: null };
                }
                const heard = whisper && hearable(target) ? transcribe(whisper, ffmpeg, bytes) : null;
                if (heard !== null) attempt.heardFaults = transcriptFaults(target.text, heard, isLongLine(target.text));
            }
            job.attempts.push(attempt);
            const faults = faultsOf(attempt, target.text, norm);
            console.log(
                `  ${label(target).padEnd(32)} try ${job.attempts.length}  ` +
                    (attempt.analysis ? describe(attempt.analysis) : 'ungated') +
                    (attempt.midClause !== undefined ? `, ${attempt.midClause} inside a clause` : '') +
                    (faults.length ? `  FAIL: ${faults.join('; ')}` : '  ok')
            );
        }
    };

    const finalize = (job: Job, norm: number | null) => {
        const best = bestAttempt(job, norm);
        if (!best) return;
        const { target } = job;
        mkdirSync(dirname(clipPath(target.file)), { recursive: true });
        const pcm = ffmpeg ? capPauses(decodeMp3(ffmpeg, best.bytes), DECODE_RATE, target.text) : null;
        const gain = ffmpeg && pcm ? levelGain(ffmpeg, pcm, target.voice.sessionLufs ?? CLIP_LUFS) : null;
        writeFileSync(
            clipPath(target.file),
            ffmpeg && pcm ? encodeClip(ffmpeg, trimTail(pcm, DECODE_RATE, gain ?? 0), gain ?? 0) : best.bytes
        );
        const faults = faultsOf(best, target.text, norm);
        manifest.voices[target.voice.name]!.clips[target.lineId] = {
            file: target.file,
            text: target.text,
            ...(target.voice.gainDb ? { gainDb: target.voice.gainDb } : {}),
            ...(gain !== null ? { levelled: true as const } : {}),
            ...(faults.length ? { suspect: true as const, suspectReason: faults.join('; ') } : {}),
        };
        save();
    };

    if (jobs.length) {
        console.log(`\nRendering${ffmpeg ? '' : ' (no gate)'}:`);
        await pool(jobs, CONCURRENCY, async (job) => {
            await run(job, null);
            finalize(job, null);
        });
    }

    // Second pass: each voice's length norm from its whole set on disk, then
    // re-roll the new clips that run long against it.
    if (ffmpeg) {
        for (const voice of voices) {
            const mine = jobs.filter((j) => j.target.voice.name === voice.name && j.attempts.length);
            if (!mine.length) continue;
            const clips = Object.entries(manifest.voices[voice.name]!.clips)
                .filter(([, c]) => !c.suspect && existsSync(clipPath(c.file)))
                .map(([lineId, c]) => {
                    const job = mine.find((j) => j.target.lineId === lineId);
                    const analysis = job ? bestAttempt(job, null)?.analysis : undefined;
                    const voicedS = (analysis ?? analyzePcm(decodeMp3(ffmpeg, readFileSync(clipPath(c.file))), DECODE_RATE)).voicedS;
                    return { voicedS, text: c.text };
                });
            const norm = secondsPerCharNorm(clips);
            if (norm === null) {
                console.log(
                    `\n${voice.name}: length check skipped (${clips.length} clean clip${clips.length === 1 ? '' : 's'}; ` +
                        `it needs ${GATE.minNormClips} to judge against).`
                );
                continue;
            }
            console.log(`\n${voice.name}: ${(norm * 1000).toFixed(0)}ms of voice per spoken character across ${clips.length} clips.`);
            await pool(mine, CONCURRENCY, async (job) => {
                await run(job, norm);
                finalize(job, norm);
            });
        }
    }

    const finalManifest = pruneManifest(manifest, allVoices, SETUP_LINE_IDS).manifest;
    writeFileSync(MANIFEST_PATH, serializeManifest(finalManifest));
    for (const r of pruned.removed) console.log(`Dropped ${r}.`);
    for (const f of orphanFiles(finalManifest, clipsOnDisk())) {
        deleteClip(f);
        console.log(`Deleted ${f}.`);
    }

    const failed = jobs.filter((j) => j.error && !j.attempts.length);
    const finalTargets = planClips(voices, lineIds, textFor, finalManifest, (f) => existsSync(clipPath(f)));
    printSuspects(finalTargets.filter((t) => finalManifest.voices[t.voice.name]?.clips[t.lineId]?.suspect), finalManifest);
    console.log('\nBilled:');
    let total = { chars: 0, usd: 0 };
    for (const [name, row] of billed) {
        console.log(`  ${name.padEnd(10)} ${String(row.chars).padStart(7)} chars  ${money(row.usd)}`);
        total = { chars: total.chars + row.chars, usd: total.usd + row.usd };
    }
    console.log(`  ${'total'.padEnd(10)} ${String(total.chars).padStart(7)} chars  ${money(total.usd)}`);
    if (failed.length) {
        console.log(`\n${failed.length} clip${failed.length === 1 ? '' : 's'} failed to synthesize: ${failed.map((j) => label(j.target)).join(', ')}`);
        process.exit(1);
    }
}

function printSuspects(suspects: readonly ClipTarget[], manifest: ClipManifest): void {
    if (!suspects.length) return;
    console.log(`\nSuspect clips, listen to these (${suspects.length}):`);
    const byVoice = new Map<string, string[]>();
    for (const t of suspects) {
        const clip = manifest.voices[t.voice.name]?.clips[t.lineId];
        console.log(`  ${label(t).padEnd(32)} ui/public/voice-clips/${clip?.file}  ${clip?.suspectReason ?? ''}`);
        byVoice.set(t.voice.name, [...(byVoice.get(t.voice.name) ?? []), t.lineId]);
    }
    console.log('Re-roll them with:');
    for (const [name, ids] of byVoice) console.log(`  npm run clips:render -- --voice ${name} --only ${ids.join(',')} --force --yes`);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
