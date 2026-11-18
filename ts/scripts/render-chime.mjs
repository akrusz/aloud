/**
 * Writes ts/ui/public/audio/chime.wav, the noting turn chime.
 *
 *   node ts/scripts/render-chime.mjs
 *
 * The numbers are the oscillator chime noting played through Web Audio until
 * every sound moved to <audio> elements (dev-docs/audio-output.md): a sine at
 * 440 Hz for 0.1 s, then 554 Hz (A4 to C#5) with no phase jump, its level
 * ramping exponentially from 0.15 to 0.01 over the 0.2 s, and stopped there.
 * Its level is the file's: iOS ignores an element's volume.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 48000;
const SECONDS = 0.2;
const STEP_AT = 0.1;
const FREQS = [440, 554];
const FROM = 0.15;
const TO = 0.01;

const n = Math.round(RATE * SECONDS);
const pcm = new Int16Array(n);
let phase = 0;
for (let i = 0; i < n; i++) {
    const t = i / RATE;
    // An exponential ramp: the value at t is FROM * (TO / FROM) ^ (t / SECONDS).
    const level = FROM * (TO / FROM) ** (t / SECONDS);
    pcm[i] = Math.round(Math.sin(phase) * level * 32767);
    phase += (2 * Math.PI * (t < STEP_AT ? FREQS[0] : FREQS[1])) / RATE;
}

const data = Buffer.from(pcm.buffer);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), '../ui/public/audio/chime.wav');
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out}: ${n} samples, ${RATE} Hz mono 16-bit`);
