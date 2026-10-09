/**
 * Voice one facilitator sentence for the promo video the way a sit would: a
 * catalog voice through the server's own synth path (routes/tts.ts synthFor),
 * at the default session speed. The app voices a reply one sentence at a time
 * (ui/src/streaming-tts.ts splitOffSentences, which keeps a sentence under 24
 * characters with the next one), so pass one such chunk per call.
 *
 *   cd ts/server && npx tsx --tsconfig ./tsconfig.json \
 *     ../../assets/promo/play-video/tools/render-line.mts Harper <out-dir> <id> 3 "<sentence>"
 *
 * Writes <out-dir>/<id>-take<N>.mp3. Real provider calls on the keys in
 * ts/server/.env, well under a cent a line. Pace and onsets vary run to run,
 * so render three takes and check each (transcribe.py) before picking one.
 */

import { writeFileSync } from 'node:fs';
import { loadServerEnv } from '../../../../ts/soak/env.js';
import { loadConfig } from '../../../../ts/server/src/config.js';
import { resolveVoice } from '../../../../ts/server/src/providers/voice-catalog.js';
import { billedCharsFor, synthFor } from '../../../../ts/server/src/routes/tts.js';

/** The default session speed, as ts/server/scripts/preview-voices.ts has it. */
const SESSION_RATE = 140 / 160;

const [voice, out, id, takes, text] = process.argv.slice(2);
if (!voice || !out || !id || !takes || !text) {
    console.error('usage: render-line.mts <voice> <out-dir> <id> <takes> "<sentence>"');
    process.exit(1);
}

loadServerEnv();
const resolved = resolveVoice(voice);
const synth = synthFor(loadConfig(), resolved);
if (!synth) throw new Error(`no ${resolved.provider} key in ts/server/.env`);

let billed = 0;
for (let take = 1; take <= Number(takes); take++) {
    writeFileSync(`${out}/${id}-take${take}.mp3`, await synth(text, SESSION_RATE));
    billed += billedCharsFor(resolved, text, SESSION_RATE);
}
console.log(`${voice} (${resolved.provider}): ${takes} takes of ${id}, ${billed} billed chars`);
