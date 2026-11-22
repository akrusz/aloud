/**
 * What a recognizer does to the sim meditator's lines before the engine sees
 * them (Scenario.transform). The sim writes tidy sentences; real turns arrive
 * unpunctuated, or cut short by endpointing, and some bugs only show that way.
 *
 * Deterministic: the same line and turn give the same output every run, so a
 * scenario is a repro and not a dice roll.
 */

import type { SimLineTransform } from './types.js';

export interface TransformedLine {
    /** What the engine is given. */
    text: string;
    cut: boolean;
}

/** `turn` counts the sim's spoken lines from 1. */
export function transformLine(line: string, transform: SimLineTransform | undefined, turn: number): TransformedLine {
    let text = line;
    let cut = false;
    if (transform?.cut?.turns.includes(turn)) {
        const tail = trailingFragment(text, transform.cut.seed, turn);
        cut = tail !== text;
        text = tail;
    }
    if (transform?.recognizer === 'web-speech') text = asWebSpeech(text);
    return { text, cut };
}

/**
 * Chrome's Web Speech final, as the tier-2 runs show it ("I'm back it was a
 * lot of tingling and it settled now"): no punctuation but apostrophes and
 * in-word hyphens, no capital at a sentence start except the first, and "I"
 * kept up. Words capitalized mid-sentence (names) keep their case.
 */
export function asWebSpeech(line: string): string {
    const normalized = line
        .replace(/[’‘]/g, "'")
        .replace(/[—–/]|\s-\s/g, ' ');
    const words: string[] = [];
    for (const sentence of normalized.split(/(?<=[.!?…])\s+/)) {
        const tokens = sentence.split(/\s+/).map(stripPunctuation).filter(Boolean);
        tokens.forEach((w, i) => words.push(i === 0 ? uncapitalize(w) : w));
    }
    const out = words.join(' ');
    return out.charAt(0).toUpperCase() + out.slice(1);
}

function stripPunctuation(word: string): string {
    return word.replace(/[^\p{L}\p{N}'-]/gu, '').replace(/^['-]+|['-]+$/g, '');
}

/** "Okay" at a sentence start becomes "okay"; "I", "I'm" and "OK" stay. */
function uncapitalize(word: string): string {
    if (/^I(?:'|$)/.test(word)) return word;
    return /^\p{Lu}\p{Ll}*(?:'\p{Ll}+)?$/u.test(word) ? word.toLowerCase() : word;
}

/** The last one to three words of a line (fewer than it has), chosen by a
 *  PRNG seeded on (seed, turn). A one-word line cannot be cut. */
export function trailingFragment(line: string, seed: number, turn: number): string {
    const words = line.trim().split(/\s+/);
    if (words.length < 2) return line;
    const keep = Math.min(words.length - 1, 1 + (seededInt(seed, turn) % 3));
    return words.slice(-keep).join(' ');
}

/** mulberry32, one draw. */
function seededInt(seed: number, turn: number): number {
    let t = (seed ^ Math.imul(turn, 0x9e3779b1)) >>> 0;
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return (r ^ (r >>> 14)) >>> 0;
}
