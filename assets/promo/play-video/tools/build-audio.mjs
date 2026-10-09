#!/usr/bin/env node
/**
 * Stage 1 of the Play video build: cut and level every spoken line, lay the
 * soundtrack, and write the timeline the picture follows.
 *
 *   node assets/promo/play-video/tools/build-audio.mjs [--clips <stt-clips dir>]
 *
 * Reads script.md (lines by id, the "Real excerpts" table), the recordings in
 * recordings/, the Harper takes named in HARPER_TAKES, and the bowls. Writes
 * build/audio/mix.wav and build/timeline.json. The edit follows the audio: a
 * line that runs long stretches its beat, and a line missing from script.md
 * drops out with the time it took.
 *
 * Needs ffmpeg. The recipe (fades, levels, spacing) is the one in
 * ../README.md, "Audio recipe".
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILD_DIR, REPO_ROOT, VIDEO_DIR, readScript } from './lib/script.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};

const FPS = 30;
const RATE = 48000;

/** The dev's side of the 2026-10-07 sit ("Save my speech clips"). Personal, so
 *  it stays in app data and never lands in the repo. */
const CLIPS_DIR = flag(
    'clips',
    join(homedir(), 'Library/Application Support/app.aloud.meditation/stt-clips/aloud-stt-clips-2026-10-08-06-07-45')
);
const HARPER_DIR = join(BUILD_DIR, 'audition', 'harper');
const AUDIO_DIR = join(BUILD_DIR, 'audio');
const CLIP_OUT = join(AUDIO_DIR, 'clips');

/**
 * Which render-line.mts takes voice each facilitator line, one per chunk the
 * app would send to TTS (a sentence, or a short one with its neighbour). The
 * takes are in build/ and so not in the repo: after rewording a line in
 * script.md, render it again and name the new takes here.
 */
const HARPER_TAKES = {
    f0: ['f0-arrive-take2'],
    f1: ['f-present-s1-take2', 'f-anywhere-s2-take2'],
    f3: ['f3-felt-sense-take2'],
};

/** Silence between a line and the reply, on top of the clips' own. */
const GAP = { f0_e1: 0.6, e1_f1: 0.5, e3_e4: 0.8 };
/** Where the first line's clip starts: the opening bowl has the first ~3s. */
const FIRST_VOICE = 2.5;
/** How long each silent caption holds. */
const HOLD = {
    c1: 3.0,
    c2: 1.4, c3: 1.4, c4: 1.7,
    c7: 1.9, c8: 1.9, c9: 1.9, c10: 1.9,
    c11: 2.1, c12: 2.4,
    end: 5.0,
};
const HARPER_LUFS = -19;
const EXCERPT_FILTER = 'loudnorm=I=-18:TP=-2:LRA=11';
/** Gain on the finished mix, then a ceiling just under it: the excerpts peak
 *  at -2, so this lifts the lot without the limiter having anything to do. */
const MASTER_DB = 1;
const CEILING_DB = -1;

const BOWL_DEEP = join(VIDEO_DIR, '..', 'bowl-candidates', 'bowl-deep-long.mp3');
const RIN_LONG = join(VIDEO_DIR, '..', 'bowl-candidates', 'rin-long.mp3');
/** The app's own noting sounds, as a noting circle plays them. */
const NOTING_BOWL = join(REPO_ROOT, 'ts/ui/public/audio/bowl.mp3');
const NOTING_RIN = join(REPO_ROOT, 'ts/ui/public/audio/rin.mp3');
/**
 * Bowl and rin levels, as plain gain on files whose strike sits at -20 LUFS.
 * The opening bowl is the rough cut's; the rest are there so no stretch of
 * captions plays over dead air, and are kept well under the voices. Zero one
 * to drop it.
 */
const LEVEL = {
    open: 0.22,
    /** A rin as the picture cuts away from the exchange; rings under 3. */
    cut: 0.18,
    noting: 0.6,
    /** A short rin as each setup control lands in 6. */
    tick: 0.14,
    /** The same rin, a little louder, as the timer takes. */
    timer: 0.22,
    /** The opening bowl again under 7's last caption, into 8. */
    back: 0.22,
    /** And once more between the two closing excerpts, as their bed. */
    bed: 0.16,
    close: 0.3,
};

function ffmpeg(argv, { capture = false } = {}) {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1 << 28,
        encoding: capture ? 'buffer' : 'utf8',
    });
    return out;
}

/** ffmpeg writes its measurements to stderr, which execFileSync only hands
 *  back on failure - so run it through the shell with 2>&1. */
function ffmpegLog(argv) {
    const quoted = ['ffmpeg', '-hide_banner', '-nostats', ...argv].map((a) => `'${a.replaceAll("'", "'\\''")}'`);
    return execFileSync('/bin/sh', ['-c', `${quoted.join(' ')} 2>&1`], { encoding: 'utf8', maxBuffer: 1 << 26 });
}

function need(path, hint) {
    if (!existsSync(path)) {
        console.error(`missing: ${path}\n  ${hint}`);
        process.exit(1);
    }
    return path;
}

/** Decode to mono float samples at RATE. */
function pcm(path) {
    const buf = ffmpeg(['-loglevel', 'error', '-i', path, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], {
        capture: true,
    });
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function lufs(path) {
    const log = ffmpegLog(['-i', path, '-af', 'ebur128', '-f', 'null', '-']);
    const m = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
    if (!m) throw new Error(`no loudness reading for ${path}`);
    return Number(m[1]);
}

/** RMS in dBFS over 10ms windows. */
function levels(samples) {
    const win = RATE / 100;
    const out = new Float32Array(Math.floor(samples.length / win));
    for (let i = 0; i < out.length; i++) {
        let sum = 0;
        for (let j = i * win; j < (i + 1) * win; j++) sum += samples[j] * samples[j];
        out[i] = 10 * Math.log10(sum / win + 1e-12);
    }
    return out;
}

/** Stretches of speech, in seconds: anything above the floor, with gaps
 *  shorter than `minGap` (stop consonants, breaths) bridged. The floor is low
 *  because the sit's quietest words trail off near -45, and still clear of
 *  everything between words: gated capture, TTS silence, -55 room tone. */
function voicedSpans(samples, floorDb = -48, minGap = 0.15) {
    const db = levels(samples);
    const spans = [];
    let start = -1;
    let quiet = 0;
    for (let i = 0; i <= db.length; i++) {
        const loud = i < db.length && db[i] > floorDb;
        if (loud) {
            if (start < 0) start = i;
            quiet = 0;
        } else if (start >= 0) {
            quiet++;
            if (quiet >= minGap * 100 || i === db.length) {
                spans.push([start / 100, (i - quiet + 1) / 100]);
                start = -1;
                quiet = 0;
            }
        }
    }
    return spans.filter(([a, b]) => b - a >= 0.04);
}

/** Loudness of the speech itself, ignoring the pauses: what "as loud as the
 *  excerpts" means for a clip too short for a LUFS reading. */
function speechDb(samples) {
    const win = RATE / 100;
    const db = levels(samples);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < db.length; i++) {
        if (db[i] <= -42) continue;
        for (let j = i * win; j < (i + 1) * win; j++) sum += samples[j] * samples[j];
        n += win;
    }
    return 10 * Math.log10(sum / Math.max(1, n) + 1e-12);
}

function peakDb(samples) {
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    return 20 * Math.log10(peak + 1e-12);
}

// ---- word timing ----------------------------------------------------------

function syllables(word) {
    const letters = word.toLowerCase().replace(/[^a-z]/g, '');
    const groups = (letters.match(/[aeiouy]+/g) ?? []).length;
    return Math.max(1, groups - (groups > 1 && /[^aeiouy]e$/.test(letters) ? 1 : 0));
}

/**
 * When each word of `text` is said, from where the clip's speech sits. Each
 * stretch of speech takes a run of words about as long as it is, at the
 * clip's average pace by syllable count; a silence costs nothing after a comma
 * or a full stop and more the longer it is anywhere else, so a real pause pins
 * the words around it and a long breath mid-line doesn't drag every later word
 * early. Good to a word or so, which is what a caption fading in needs.
 */
function timeWords(text, spans) {
    const words = text.split(/\s+/).filter(Boolean);
    const weight = words.map((w) => syllables(w) + 0.4);
    const before = [0];
    for (const w of weight) before.push(before.at(-1) + w);
    const voiced = spans.reduce((a, [s, e]) => a + (e - s), 0);
    const pace = voiced / before.at(-1);
    const pauseCost = (boundary, gap) =>
        boundary > 0 && /[.,;:?!\u2026-]$/.test(words[boundary - 1]) ? 0 : 2 * gap * gap + 0.03;
    // Relative, not absolute: people speed up and slow down by the sentence,
    // and a long stretch said quickly shouldn't outvote a pause at a full stop.
    // A stretch of speech with no words in it is almost never right.
    const fitCost = (length, said) => (said === 0 ? 0.3 : 0) + (length - said) ** 2 / (length + said + 0.2);

    // cost[m][b]: the first m spans hold the first b words.
    const cost = Array.from({ length: spans.length + 1 }, () => new Array(words.length + 1).fill(Infinity));
    const from = Array.from({ length: spans.length + 1 }, () => new Array(words.length + 1).fill(0));
    cost[0][0] = 0;
    for (let m = 0; m < spans.length; m++) {
        const length = spans[m][1] - spans[m][0];
        const gap = m > 0 ? spans[m][0] - spans[m - 1][1] : 0;
        for (let b1 = 0; b1 <= words.length; b1++) {
            if (cost[m][b1] === Infinity) continue;
            const pause = m > 0 ? pauseCost(b1, gap) : 0;
            for (let b2 = b1; b2 <= words.length; b2++) {
                const c = cost[m][b1] + fitCost(length, pace * (before[b2] - before[b1])) + pause;
                if (c < cost[m + 1][b2]) {
                    cost[m + 1][b2] = c;
                    from[m + 1][b2] = b1;
                }
            }
        }
    }
    const cuts = [words.length];
    for (let m = spans.length, b = words.length; m > 0; m--) {
        b = from[m][b];
        cuts.unshift(b);
    }

    const timed = [];
    spans.forEach(([start, end], m) => {
        const total = before[cuts[m + 1]] - before[cuts[m]] || 1;
        for (let i = cuts[m]; i < cuts[m + 1]; i++) {
            const at = (b) => start + ((before[b] - before[cuts[m]]) / total) * (end - start);
            timed.push({ w: words[i], t: at(i), e: at(i + 1) });
        }
    });
    return timed;
}

/**
 * Word times from the desktop app's Whisper model (tools/transcribe.py), keyed
 * by file. It hears where a word starts far better than timeWords can guess
 * it, but it also mishears now and then, so its words are matched back onto
 * the script's and only the times are kept. Null if uv or the model is
 * missing: the build then falls back on timeWords alone.
 */
function whisperWords(paths) {
    let out;
    try {
        out = execFileSync(
            'uv',
            ['run', '--python', '3.12', '--with', 'pywhispercpp', 'python', join(VIDEO_DIR, 'tools', 'transcribe.py'), '--words', ...paths],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, UV_PYTHON_PREFERENCE: 'only-managed' } }
        );
    } catch {
        console.warn('  (no Whisper word times: uv or the model is missing, so captions use estimated timing)');
        return null;
    }
    const heard = {};
    for (const path of paths) {
        const name = path.split('/').pop();
        const row = out.split('\n').find((l) => l.startsWith(`${name}: `));
        heard[path] = (row ?? '')
            .slice(name.length + 2)
            .split(' ')
            .map((token) => token.split('|'))
            .filter(([t, w]) => w && /[a-z0-9]/i.test(w) && !w.startsWith('*'))
            .map(([t, w]) => ({ w, t: Number(t) }));
    }
    return heard;
}

const bare = (word) => word.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Move the script's words onto the times Whisper heard: the two word lists
 * are lined up by edit distance, a word Whisper also has takes its time, and
 * a word it dropped is spaced between its neighbours. Each word is then kept
 * in order and out of the clip's silences.
 */
function retime(estimated, heard, spans) {
    if (!heard || heard.length === 0) return estimated;
    const a = estimated.map((x) => bare(x.w));
    const b = heard.map((x) => bare(x.w));
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    const times = new Array(a.length).fill(null);
    for (let i = a.length, j = b.length; i > 0 && j > 0; ) {
        if (d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
            times[i - 1] = heard[j - 1].t;
            i--;
            j--;
        } else if (d[i][j] === d[i - 1][j] + 1) i--;
        else j--;
    }
    if (times.filter((t) => t !== null).length < a.length / 2) return estimated;
    // Whisper often marks the first word at 0; the clip knows where it starts.
    times[0] = spans[0][0];
    const out = estimated.map((word, i) => ({ ...word, t: times[i] }));
    for (let i = 0; i < out.length; i++) {
        if (out[i].t !== null) continue;
        const next = out.findIndex((x, k) => k > i && x.t !== null);
        const from = out[i - 1].t;
        const to = next === -1 ? spans.at(-1)[1] : out[next].t;
        const run = (next === -1 ? out.length : next) - i + 1;
        out[i].t = from + (to - from) / run;
    }
    for (let i = 0; i < out.length; i++) {
        let t = Math.max(out[i].t, i ? out[i - 1].t + 0.06 : 0);
        const inside = spans.some(([s, e]) => t >= s - 0.05 && t < e);
        if (!inside) t = (spans.find(([s]) => s > t) ?? spans.at(-1))[0];
        out[i].t = Math.min(t, spans.at(-1)[1]);
    }
    out.forEach((word, i) => (word.e = out[i + 1]?.t ?? spans.at(-1)[1]));
    return out;
}

// ---- clips ----------------------------------------------------------------

const { lines, excerpts } = readScript();
mkdirSync(CLIP_OUT, { recursive: true });

/** id -> { path, gainDb } for every spoken line the script still has. */
const clips = {};

for (const [id, cut] of Object.entries(excerpts)) {
    if (!lines[id]) continue;
    const src = need(join(CLIPS_DIR, `${cut.clip}.wav`), 'the sit capture; pass --clips <dir> if it moved');
    const out = join(CLIP_OUT, `${id}.wav`);
    const trim = cut.out === null ? ['-ss', String(cut.in)] : ['-ss', String(cut.in), '-to', String(cut.out)];
    const raw = join(CLIP_OUT, `${id}.cut.wav`);
    ffmpeg(['-loglevel', 'error', '-i', src, ...trim, '-c:a', 'pcm_s16le', raw]);
    const length = pcm(raw).length / RATE;
    ffmpeg([
        '-loglevel', 'error', '-i', raw,
        '-af', `afade=t=in:d=0.03,afade=t=out:st=${(length - 0.05).toFixed(3)}:d=0.05,${EXCERPT_FILTER}`,
        '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s16le', out,
    ]);
    clips[id] = { path: out, gainDb: 0 };
}

for (const [id, takes] of Object.entries(HARPER_TAKES)) {
    if (!lines[id]) continue;
    const inputs = takes.map((take) =>
        need(join(HARPER_DIR, `${take}.mp3`), `render it: see tools/render-line.mts (line ${id}: "${lines[id].text}")`)
    );
    const joined = join(CLIP_OUT, `${id}.joined.wav`);
    ffmpeg([
        '-loglevel', 'error',
        ...inputs.flatMap((p) => ['-i', p]),
        '-filter_complex',
        `${inputs.map((_, i) => `[${i}:a]aresample=${RATE},aformat=channel_layouts=mono[a${i}]`).join(';')};` +
            `${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`,
        '-map', '[out]', '-c:a', 'pcm_s16le', joined,
    ]);
    const gainDb = HARPER_LUFS - lufs(joined);
    const out = join(CLIP_OUT, `${id}.wav`);
    ffmpeg(['-loglevel', 'error', '-i', joined, '-af', `volume=${gainDb.toFixed(2)}dB`, '-c:a', 'pcm_s16le', out]);
    // Where each take starts inside the joined clip: the app shows a reply a
    // sentence at a time, as that sentence's audio starts.
    let offset = 0;
    const chunks = inputs.map((p) => {
        const samples = pcm(p);
        const [first] = voicedSpans(samples);
        const chunk = { offset, voiceStart: offset + (first ? first[0] : 0) };
        offset += samples.length / RATE;
        return chunk;
    });
    clips[id] = { path: out, gainDb: 0, chunks };
}

// The dev's own takes: plain gain to sit with the excerpts (loudnorm misbehaves
// on a clip this short), capped so the peak stays under the excerpts' -2.
const excerptLevel = Object.keys(excerpts)
    .filter((id) => clips[id])
    .map((id) => speechDb(pcm(clips[id].path)));
const targetDb = excerptLevel.length ? excerptLevel.reduce((a, b) => a + b, 0) / excerptLevel.length : -24;
for (const id of ['n1', 'v1']) {
    if (!lines[id]) continue;
    const src = need(join(VIDEO_DIR, 'recordings', `${id}.wav`), `record it as recordings/${id}.wav`);
    const samples = pcm(src);
    const gainDb = Math.min(targetDb - speechDb(samples), -3 - peakDb(samples));
    clips[id] = { path: src, gainDb };
}

for (const [id, clip] of Object.entries(clips)) {
    const samples = pcm(clip.path);
    clip.duration = samples.length / RATE;
    clip.spans = voicedSpans(samples);
    if (clip.spans.length === 0) throw new Error(`${id}: no speech found in ${clip.path}`);
    clip.voiceStart = clip.spans[0][0];
    clip.voiceEnd = clip.spans.at(-1)[1];
    // A line voiced in several takes is timed take by take: each has its own
    // pace, and one average across them puts the second sentence early.
    if (clip.chunks) {
        clip.chunks = sentenceChunks(lines[id].text, clip.chunks);
        clip.words = clip.chunks.flatMap((chunk, i) => {
            const until = clip.chunks[i + 1]?.offset ?? clip.duration;
            return timeWords(chunk.text, clip.spans.filter(([s]) => s >= chunk.offset && s < until));
        });
    } else {
        clip.words = timeWords(lines[id].text, clip.spans);
    }
    clip.samples = samples;
}
const heard = whisperWords(Object.values(clips).map((c) => c.path));
if (heard) for (const clip of Object.values(clips)) clip.words = retime(clip.words, heard[clip.path], clip.spans);

// ---- timeline -------------------------------------------------------------

const timeline = { fps: FPS, width: 1920, height: 1080, beats: [], lines: {}, sounds: [], marks: {} };
const mixInputs = [];
const has = (id) => Boolean(lines[id]) && (lines[id].kind === 'caption' || Boolean(clips[id]));

/** Put a spoken line's clip at `at`; returns when the clip ends. */
function say(id, at) {
    const clip = clips[id];
    const line = lines[id];
    timeline.lines[id] = {
        kind: line.kind,
        text: line.text,
        start: at,
        end: at + clip.duration,
        voiceStart: at + clip.voiceStart,
        voiceEnd: at + clip.voiceEnd,
        words: clip.words.map(({ w, t, e }) => ({ w, t: round(at + t), e: round(at + e) })),
        ...(clip.chunks
            ? { chunks: clip.chunks.map((c) => ({ text: c.text, t: round(at + c.voiceStart) })) }
            : {}),
    };
    mixInputs.push({ path: clip.path, at, gainDb: clip.gainDb, speaker: line.kind });
    return at + clip.duration;
}

/** Show a caption from `at` for `hold` seconds; returns when it leaves. */
function show(id, at, hold) {
    timeline.lines[id] = { kind: 'caption', text: lines[id].text, start: at, end: at + hold };
    return at + hold;
}

function sound(id, path, at, gain, extra = '') {
    if (!gain) return;
    timeline.sounds.push({ id, start: at });
    mixInputs.push({ path: need(path, 'see assets/promo/bowl-candidates/README.md'), at, gain, extra, speaker: 'sound' });
}

/** The text each TTS chunk carried: the line's sentences, dealt out over the
 *  takes that voice it. */
function sentenceChunks(text, chunks) {
    const sentences = text.split(/(?<=[.?!…])\s+/);
    if (chunks.length === 1) return [{ ...chunks[0], text }];
    if (chunks.length !== sentences.length) {
        throw new Error(`"${text}" has ${sentences.length} sentences but ${chunks.length} takes in HARPER_TAKES`);
    }
    return chunks.map((c, i) => ({ ...c, text: sentences[i] }));
}

const round = (n) => Math.round(n * 1000) / 1000;
/** Cuts land on frame boundaries, so no scene shows for a fraction of one. */
const onFrame = (n) => Math.round(n * FPS) / FPS;

function beat(id, start, build) {
    const end = onFrame(build(start));
    if (end > start) timeline.beats.push({ id, start, end });
    return end;
}

let t = 0;

// 1. settle: the orb and one bowl.
sound('bowl-open', BOWL_DEEP, 0, LEVEL.open, 'afade=t=out:st=6:d=4');
t = beat('settle', 0, () => (has('f0') ? FIRST_VOICE : 2.0));

// 2. the hook: the exchange on the phone, cut straight after f1's question.
t = beat('hook', t, (at) => {
    let end = at;
    if (has('f0')) end = say('f0', end) + GAP.f0_e1;
    if (has('e1')) end = say('e1', end) + GAP.e1_f1;
    if (has('f1')) end = say('f1', end);
    const last = ['f1', 'e1', 'f0'].find((id) => timeline.lines[id]);
    return last ? timeline.lines[last].voiceEnd + 0.3 : at;
});
if (has('c1')) {
    sound('rin-cut', RIN_LONG, t, LEVEL.cut);
    t = beat('claim', t, (at) => show('c1', at, HOLD.c1));
}

// 3. what else it helps with: quick cards.
t = beat('cards', t, (at) => ['c2', 'c3', 'c4'].filter(has).reduce((end, id) => show(id, end, HOLD[id]), at));

// 4. felt sense: the facilitator reads its opener.
if (has('f3')) {
    t = beat('felt', t, (at) => {
        const end = say('f3', at + 0.5);
        if (has('c5')) show('c5', at, end - at);
        return timeline.lines.f3.voiceEnd + 0.5;
    });
    if (timeline.lines.c5) timeline.lines.c5.end = t;
}

// 5. noting: one word, then the app's own bowl.
if (has('n1')) {
    t = beat('noting', t, (at) => {
        say('n1', at + 0.45);
        const strike = timeline.lines.n1.voiceEnd + 0.3;
        sound('bowl-noting', NOTING_BOWL, strike, LEVEL.noting);
        timeline.marks.notingBowl = round(strike);
        if (has('c6')) show('c6', at, strike + 1.25 - at);
        return strike + 1.25;
    });
    if (timeline.lines.c6) timeline.lines.c6.end = t;
}

// 6. yours to tune: the real setup controls, then a timer asked for aloud.
t = beat('tune', t, (at) => {
    let end = ['c7', 'c8', 'c9', 'c10'].filter(has).reduce((e, id, i) => {
        // The first control lands under the noting bowl; the rest get a tick.
        if (i > 0 || !has('n1')) sound(`rin-${id}`, NOTING_RIN, e + 0.08, LEVEL.tick);
        return show(id, e, HOLD[id]);
    }, at);
    if (has('v1')) {
        timeline.marks.timerAsk = round(end);
        say('v1', end + 0.2);
        timeline.marks.timerLands = round(timeline.lines.v1.voiceEnd + 0.3);
        sound('rin-timer', NOTING_RIN, timeline.marks.timerLands, LEVEL.timer);
        end = timeline.marks.timerLands + 1.5;
    }
    return end;
});

// 7. how it's different.
t = beat('different', t, (at) => {
    let end = at;
    if (has('c11')) end = show('c11', end, HOLD.c11);
    if (has('c12')) {
        // The opening bowl again, so its tail is under the first words of 8.
        sound('bowl-return', BOWL_DEEP, end, LEVEL.back);
        end = show('c12', end, HOLD.c12);
    }
    return end;
});

// 8. why it exists: the dev's own words over the orb.
t = beat('why', t, (at) => {
    const said = ['e3', 'e4'].filter(has);
    if (said.length === 0) return at;
    let end = at + 0.5;
    said.forEach((id, i) => {
        if (i) sound('bowl-bed', BOWL_DEEP, end + GAP.e3_e4 / 2, LEVEL.bed);
        end = say(id, end + (i ? GAP.e3_e4 : 0));
    });
    return timeline.lines[said.at(-1)].voiceEnd + 0.6;
});

// 9. end card.
t = beat('end', t, (at) => {
    sound('bowl-close', BOWL_DEEP, at, LEVEL.close);
    for (const id of ['c13', 'c14', 'c15']) if (has(id)) show(id, at, HOLD.end);
    return at + HOLD.end;
});

timeline.duration = t;
timeline.frames = Math.round(t * FPS);

// ---- mix ------------------------------------------------------------------

const filters = mixInputs.map((input, i) => {
    const gain = input.gain ?? 10 ** ((input.gainDb ?? 0) / 20);
    const chain = [
        `aresample=${RATE}`,
        // Not aformat: its mono-to-stereo upmix takes 3 dB off, which would
        // leave every voice that much under the (stereo) bowls.
        input.speaker === 'sound' ? 'aformat=channel_layouts=stereo' : 'pan=stereo|c0=c0|c1=c0',
        ...(input.extra ? [input.extra] : []),
        `volume=${gain.toFixed(4)}`,
        `adelay=${Math.round(input.at * 1000)}:all=1`,
    ];
    return `[${i}:a]${chain.join(',')}[m${i}]`;
});
const ceiling = 10 ** (CEILING_DB / 20);
const mixPath = join(AUDIO_DIR, 'mix.wav');
ffmpeg([
    '-loglevel', 'error',
    ...mixInputs.flatMap((input) => ['-i', input.path]),
    '-filter_complex',
    `${filters.join(';')};${mixInputs.map((_, i) => `[m${i}]`).join('')}` +
        `amix=inputs=${mixInputs.length}:normalize=0:duration=longest,` +
        `volume=${MASTER_DB}dB,alimiter=limit=${ceiling.toFixed(4)}:level=false:attack=3:release=60,` +
        `apad,atrim=0:${t.toFixed(3)},afade=t=out:st=${(t - 1.2).toFixed(3)}:d=1.2[out]`,
    '-map', '[out]', '-ar', String(RATE), '-c:a', 'pcm_s24le', mixPath,
]);

// How loud each voice is, frame by frame, for the picture to move with.
const frameLen = RATE / FPS;
const envelope = (speaker) => {
    const env = new Float32Array(timeline.frames);
    for (const input of mixInputs) {
        if (input.speaker !== speaker) continue;
        const clip = Object.values(clips).find((c) => c.path === input.path);
        const first = Math.round(input.at * FPS);
        for (let f = 0; f * frameLen < clip.samples.length && first + f < env.length; f++) {
            let sum = 0;
            const stop = Math.min(clip.samples.length, (f + 1) * frameLen);
            for (let j = f * frameLen; j < stop; j++) sum += clip.samples[j] * clip.samples[j];
            env[first + f] = Math.max(env[first + f], Math.sqrt(sum / frameLen));
        }
    }
    const peak = Math.max(...env, 1e-6);
    return [...env].map((v) => Math.round(Math.min(1, (v / peak) ** 0.6) * 1000) / 1000);
};
timeline.env = { aloud: envelope('aloud'), you: envelope('you') };

for (const line of Object.values(timeline.lines)) {
    for (const key of ['start', 'end', 'voiceStart', 'voiceEnd']) if (key in line) line[key] = round(line[key]);
}
for (const b of timeline.beats) Object.assign(b, { start: round(b.start), end: round(b.end) });
for (const s of timeline.sounds) s.start = round(s.start);
// What the filmed UI depends on: who says what, when. capture-ui.mjs copies
// this into its manifest, and render-film.mjs refuses a film whose UI shots
// were made for a different cut.
timeline.cut = createHash('sha1')
    .update(JSON.stringify([timeline.beats, timeline.lines, timeline.marks]))
    .digest('hex')
    .slice(0, 12);
writeFileSync(join(BUILD_DIR, 'timeline.json'), JSON.stringify(timeline));

// ---- report ---------------------------------------------------------------

const log = ffmpegLog(['-i', mixPath, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
const integrated = [...log.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()?.[1];
const truePeak = [...log.matchAll(/Peak:\s+(-?[\d.]+) dBFS/g)].pop()?.[1];
console.log(`${mixPath}\n  ${t.toFixed(2)}s, ${integrated} LUFS integrated, peak ${truePeak} dBFS`);
for (const b of timeline.beats) {
    const inside = Object.entries(timeline.lines)
        .filter(([, l]) => l.start >= b.start - 0.001 && l.start < b.end)
        .map(([id]) => id);
    console.log(`  ${b.start.toFixed(2).padStart(6)} - ${b.end.toFixed(2).padStart(6)}  ${b.id.padEnd(10)} ${inside.join(' ')}`);
}
for (const id of ['n1', 'v1']) if (clips[id]) console.log(`  ${id}: ${clips[id].gainDb.toFixed(1)} dB of gain`);
