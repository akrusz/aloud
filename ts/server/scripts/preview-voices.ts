/**
 * Audition Google Cloud TTS voices for the curated hosted set.
 *
 * Two modes:
 *   - `curated`: audition exactly the voices aloud actually offers
 *     (voice-catalog.ts), labeled with the friendly name, tier, and the ☁️
 *     credit-rate — the one to use when SETTING DEFAULTS (which voice leads, and
 *     whether a value voice should be the default to lower credit burn).
 *   - substring filter (default): browse Google's wider catalog to find new
 *     candidates to add to the curated set.
 *
 * Both synthesize a short meditation sample, write MP3s to voice-previews/, and
 * generate an index.html with a labeled <audio> player per voice.
 *
 *   cd ts/server
 *   npx tsx scripts/preview-voices.ts curated         # the offered set (defaults)
 *   npx tsx scripts/preview-voices.ts                 # all Chirp3-HD en-US
 *   npx tsx scripts/preview-voices.ts Neural2         # filter by name substring
 *   npx tsx scripts/preview-voices.ts Chirp3-HD en-GB # filter + language
 *
 * Needs GOOGLE_TTS_API_KEY in .env (the same key /v1/tts uses). Output is
 * gitignored. Cost is a few cents — one short clip per voice.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { synthesizeWithGoogle } from '../src/providers/tts.js';
import { CURATED_VOICES } from '../src/providers/voice-catalog.js';
import { voiceCreditsPerHourTypical } from '../src/pricing/estimate.js';

const SAMPLE =
    "Let's begin. Find a comfortable position, and when you're ready, gently " +
    'let your eyes close. Take a slow breath in... and let it go.';

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

/** Synthesize a meditation sample for each curated voice, labeled with tier +
 *  ☁️ rate — the audition that informs the default-voice decision. */
async function previewCurated(apiKey: string, outDir: string): Promise<PreviewEntry[]> {
    const entries: PreviewEntry[] = [];
    for (const cv of CURATED_VOICES) {
        try {
            const mp3 = await synthesizeWithGoogle(SAMPLE, cv.googleId, 1.0, apiKey);
            const file = `${cv.name}.mp3`;
            writeFileSync(resolve(outDir, file), mp3);
            entries.push({
                name: `${cv.name}${cv.default ? ' — current default' : ''}`,
                gender: cv.gender,
                file,
                sub: `${cv.tier} · ~${voiceCreditsPerHourTypical(cv.googleId)}☁️/hr · ${cv.googleId}`,
            });
            console.log(`  ✓ ${cv.name} (${cv.tier}, ~${voiceCreditsPerHourTypical(cv.googleId)}☁️/hr)`);
        } catch (err) {
            console.log(`  ✗ ${cv.name} — ${String(err)}`);
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
    const apiKey = process.env['GOOGLE_TTS_API_KEY'];
    if (!apiKey) {
        console.error('GOOGLE_TTS_API_KEY not set (put it in ts/server/.env).');
        process.exit(1);
    }

    const filter = process.argv[2] ?? 'Chirp3-HD';
    const languageCode = process.argv[3] ?? 'en-US';

    const outDir = resolve(import.meta.dirname, '..', 'voice-previews');
    mkdirSync(outDir, { recursive: true });

    // `curated` mode: audition exactly the offered set (for the defaults pass).
    if (filter.toLowerCase() === 'curated') {
        console.log(`Auditioning ${CURATED_VOICES.length} curated voices → ${outDir}`);
        const entries = await previewCurated(apiKey, outDir);
        writeFileSync(resolve(outDir, 'index.html'), html(entries));
        console.log(`\nOpen: ${resolve(outDir, 'index.html')}`);
        return;
    }

    const all = await listVoices(apiKey, languageCode);
    const voices = all.filter((v) => v.name.includes(filter)).sort((a, b) => a.name.localeCompare(b.name));
    if (voices.length === 0) {
        console.error(`No voices match "${filter}" for ${languageCode}. Try a different filter.`);
        process.exit(1);
    }

    console.log(`Synthesizing ${voices.length} "${filter}" voices (${languageCode}) → ${outDir}`);

    const entries: PreviewEntry[] = [];
    for (const v of voices) {
        try {
            const mp3 = await synthesizeWithGoogle(SAMPLE, v.name, 1.0, apiKey);
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
