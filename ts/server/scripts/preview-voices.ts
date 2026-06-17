/**
 * Audition hosted TTS voices for the curated set.
 *
 * Modes:
 *   - `curated`: audition exactly the voices aloud offers (voice-catalog.ts)
 *     across BOTH providers (Google + OpenAI), labeled with the friendly name,
 *     tier, and the ☁️ credit-rate — the SET-DEFAULTS pass.
 *   - `openai`: audition OpenAI's FULL voice roster (alloy, ash, ballad, coral,
 *     echo, fable, onyx, nova, sage, shimmer, verse) to pick/replace the curated
 *     OpenAI voices; currently-curated voices are flagged.
 *   - substring filter (default): browse Google's wider catalog to find new
 *     candidates to add to the curated set.
 *
 * Each synthesizes a short meditation sample, writes MP3s to voice-previews/, and
 * (re)generates an index.html with a labeled <audio> player per voice.
 *
 *   cd ts/server
 *   npx tsx scripts/preview-voices.ts curated         # the offered set (defaults)
 *   npx tsx scripts/preview-voices.ts openai          # OpenAI's full roster
 *   npx tsx scripts/preview-voices.ts                 # all Chirp3-HD en-US
 *   npx tsx scripts/preview-voices.ts Neural2         # filter by name substring
 *   npx tsx scripts/preview-voices.ts Chirp3-HD en-GB # filter + language
 *
 * Needs GOOGLE_TTS_API_KEY in .env for the Google modes; OPENAI_API_KEY for the
 * OpenAI voices (curated reads both and skips any provider whose key is absent).
 * Output is gitignored. Cost is a few cents — one short clip per voice.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { synthesizeWithGoogle, synthesizeWithOpenAI } from '../src/providers/tts.js';
import { CURATED_VOICES } from '../src/providers/voice-catalog.js';
import { voiceCreditsPerHourTypical } from '../src/pricing/estimate.js';

const SAMPLE =
    "Let's begin. Find a comfortable position, and when you're ready, gently " +
    'let your eyes close. Take a slow breath in... and let it go.';

/** OpenAI's full TTS voice roster — gpt-4o-mini-tts has no list endpoint, so
 *  these are the documented voices. The `note` is a rough perceived character to
 *  orient the listen, not authoritative; audition to decide. Update if OpenAI
 *  ships more. */
const OPENAI_VOICES: ReadonlyArray<{ id: string; note: string }> = [
    { id: 'alloy', note: 'neutral, even' },
    { id: 'ash', note: 'male' },
    { id: 'ballad', note: 'male, lyrical' },
    { id: 'coral', note: 'female, warm' },
    { id: 'echo', note: 'male' },
    { id: 'fable', note: 'male, British' },
    { id: 'onyx', note: 'male, deep' },
    { id: 'nova', note: 'female' },
    { id: 'sage', note: 'androgynous, calm' },
    { id: 'shimmer', note: 'female, soft' },
    { id: 'verse', note: 'neutral, expressive' },
];

const VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices';

interface GoogleVoice {
    name: string;
    languageCodes: string[];
    ssmlGender?: string;
}

async function listVoices(apiKey: string, languageCode: string): Promise<GoogleVoice[]> {
    const res = await fetch(`${VOICES_URL}?key=${encodeURIComponent(apiKey)}&languageCode=${languageCode}`);
    if (!res.ok) throw new Error(`voices.list ${res.status}: ${await res.text().catch(() => '')}`);
    const data = (await res.json()) as { voices?: GoogleVoice[] };
    return data.voices ?? [];
}

interface PreviewEntry {
    name: string;
    gender: string;
    file: string;
    /** Optional second line, e.g. "premium · ~8☁️/hr · en-US-Chirp3-HD-Leda". */
    sub?: string;
}

function html(entries: PreviewEntry[]): string {
    const rows = entries
        .map(
            (e) => `
    <div class="row">
      <div class="meta"><span class="name">${e.name}</span><span class="g">${e.gender}</span>${
          e.sub ? `<div class="sub">${e.sub}</div>` : ''
      }</div>
      <audio controls preload="none" src="${e.file}"></audio>
    </div>`
        )
        .join('');
    return `<!doctype html><meta charset="utf-8"><title>aloud voice audition</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}
 h1{font-size:1.2rem} .sample{color:#666;font-style:italic;margin-bottom:1.5rem}
 .row{display:flex;align-items:center;gap:1rem;padding:.5rem 0;border-bottom:1px solid #eee}
 .meta{width:300px} .name{font-weight:600} .g{color:#999;margin-left:.5rem;font-size:.85em}
 .sub{color:#999;font-size:.78em;margin-top:.15rem}
 audio{flex:1}
</style>
<h1>aloud voice audition — ${entries.length} voices</h1>
<p class="sample">“${SAMPLE}”</p>${rows}
`;
}

/** Synthesize a meditation sample for each curated voice, labeled with provider,
 *  tier + ☁️ rate — the audition that informs the default-voice decision.
 *  Dispatches per provider; an OpenAI voice with no openaiKey is skipped. */
async function previewCurated(
    googleKey: string | undefined,
    openaiKey: string | undefined,
    outDir: string
): Promise<PreviewEntry[]> {
    const entries: PreviewEntry[] = [];
    for (const cv of CURATED_VOICES) {
        try {
            const key = cv.provider === 'openai' ? openaiKey : googleKey;
            if (!key) {
                const envName = cv.provider === 'openai' ? 'OPENAI_API_KEY' : 'GOOGLE_TTS_API_KEY';
                console.log(`  – ${cv.name} (${cv.provider}) — skipped, ${envName} not set`);
                continue;
            }
            const mp3 =
                cv.provider === 'openai'
                    ? await synthesizeWithOpenAI(SAMPLE, cv.providerVoiceId, 1.0, key)
                    : await synthesizeWithGoogle(SAMPLE, cv.providerVoiceId, 1.0, key);
            const file = `${cv.name}.mp3`;
            writeFileSync(resolve(outDir, file), mp3);
            const rate = voiceCreditsPerHourTypical(cv.provider, cv.providerVoiceId);
            entries.push({
                name: `${cv.name}${cv.default ? ' — current default' : ''}`,
                gender: cv.gender,
                file,
                sub: `${cv.provider} · ${cv.tier} · ~${rate}☁️/hr · ${cv.providerVoiceId}`,
            });
            console.log(`  ✓ ${cv.name} (${cv.provider}, ${cv.tier}, ~${rate}☁️/hr)`);
        } catch (err) {
            console.log(`  ✗ ${cv.name} — ${String(err)}`);
        }
    }
    return entries;
}

/** Synthesize every voice in OpenAI's roster, flagging which are currently
 *  curated, so you can pick replacements/additions for voice-catalog.ts. */
async function previewOpenaiRoster(openaiKey: string, outDir: string): Promise<PreviewEntry[]> {
    const curatedByVoice = new Map(
        CURATED_VOICES.filter((v) => v.provider === 'openai').map((v) => [v.providerVoiceId, v.name])
    );
    const rate = voiceCreditsPerHourTypical('openai', 'any'); // flat per-char rate, voice-independent
    const entries: PreviewEntry[] = [];
    for (const v of OPENAI_VOICES) {
        try {
            const mp3 = await synthesizeWithOpenAI(SAMPLE, v.id, 1.0, openaiKey);
            const file = `openai-${v.id}.mp3`;
            writeFileSync(resolve(outDir, file), mp3);
            const curated = curatedByVoice.get(v.id);
            entries.push({
                name: `${v.id}${curated ? ` — currently "${curated}"` : ''}`,
                gender: v.note,
                file,
                sub: `openai · gpt-4o-mini-tts · ~${rate}☁️/hr`,
            });
            console.log(`  ✓ ${v.id}${curated ? ` (curated as ${curated})` : ''}`);
        } catch (err) {
            console.log(`  ✗ ${v.id} — ${String(err)}`);
        }
    }
    return entries;
}

async function main(): Promise<void> {
    try {
        process.loadEnvFile();
    } catch {
        /* rely on ambient env */
    }
    // TTS reads the same keys (and OPENAI_API_KEY fallback) the server config does.
    // `||`, not `??`: a blank OPENAI_TTS_API_KEY= line is the empty string, which
    // `??` would not fall through (matches config.ts).
    const googleKey = process.env['GOOGLE_TTS_API_KEY'];
    const openaiKey = process.env['OPENAI_TTS_API_KEY'] || process.env['OPENAI_API_KEY'];

    const filter = process.argv[2] ?? 'Chirp3-HD';
    const languageCode = process.argv[3] ?? 'en-US';

    const outDir = resolve(import.meta.dirname, '..', 'voice-previews');
    mkdirSync(outDir, { recursive: true });

    // `curated` mode: audition exactly the offered set (for the defaults pass).
    // Runs with EITHER provider's key — each voice skips if its own key is absent,
    // so you can audition just the OpenAI voices with only OPENAI_API_KEY set.
    if (filter.toLowerCase() === 'curated') {
        if (!googleKey && !openaiKey) {
            console.error('Set GOOGLE_TTS_API_KEY and/or OPENAI_API_KEY (in ts/server/.env) to audition curated voices.');
            process.exit(1);
        }
        console.log(`Auditioning ${CURATED_VOICES.length} curated voices → ${outDir}`);
        const entries = await previewCurated(googleKey, openaiKey, outDir);
        writeFileSync(resolve(outDir, 'index.html'), html(entries));
        console.log(`\nOpen: ${resolve(outDir, 'index.html')}`);
        return;
    }

    // `openai` mode: audition OpenAI's full voice roster to pick the curated set.
    if (filter.toLowerCase() === 'openai') {
        if (!openaiKey) {
            console.error('Set OPENAI_API_KEY (in ts/server/.env) to audition OpenAI voices.');
            process.exit(1);
        }
        console.log(`Auditioning ${OPENAI_VOICES.length} OpenAI voices → ${outDir}`);
        const entries = await previewOpenaiRoster(openaiKey, outDir);
        writeFileSync(resolve(outDir, 'index.html'), html(entries));
        console.log(`\nOpen: ${resolve(outDir, 'index.html')}`);
        return;
    }

    // Browse mode walks Google's catalog, so it needs the Google key.
    if (!googleKey) {
        console.error('GOOGLE_TTS_API_KEY not set (put it in ts/server/.env).');
        process.exit(1);
    }
    const all = await listVoices(googleKey, languageCode);
    const voices = all.filter((v) => v.name.includes(filter)).sort((a, b) => a.name.localeCompare(b.name));
    if (voices.length === 0) {
        console.error(`No voices match "${filter}" for ${languageCode}. Try a different filter.`);
        process.exit(1);
    }

    console.log(`Synthesizing ${voices.length} "${filter}" voices (${languageCode}) → ${outDir}`);

    const entries: PreviewEntry[] = [];
    for (const v of voices) {
        try {
            const mp3 = await synthesizeWithGoogle(SAMPLE, v.name, 1.0, googleKey);
            const file = `${v.name}.mp3`;
            writeFileSync(resolve(outDir, file), mp3);
            entries.push({ name: v.name, gender: v.ssmlGender ?? '', file });
            console.log(`  ✓ ${v.name}`);
        } catch (err) {
            console.log(`  ✗ ${v.name} — ${String(err)}`);
        }
    }

    writeFileSync(resolve(outDir, 'index.html'), html(entries));
    console.log(`\nOpen: ${resolve(outDir, 'index.html')}`);
}

void main();
