/**
 * Diagnostic console lines ([vad], [stt-cost], [judge], …): tuning and
 * provenance detail that is only useful with DevTools or logcat open. Silent
 * in a release build unless dev mode is on (7 taps on the About version line),
 * so they can be switched on for a device in the field.
 *
 * Failures still go to console.warn/error directly - error-log.ts records
 * those for bug reports, and it never sees anything logged here.
 */

import { isDevMode } from './dev-mode.js';

export function diagOn(): boolean {
    return import.meta.env.DEV || isDevMode();
}

// The audio pipeline's lines, kept for "Report a bug" (bug-report.ts), so a
// tester with dev mode on can send an echo measurement without a Mac attached.
// Audio tags only: [judge] JSON would crowd them out of a buffer this small.
const KEPT_TAG = /^\[(vad|stt-[a-z]+|echo-guard|signature|turn)\]/;
const MAX_KEPT = 40;
const MAX_KEPT_CHARS = 220;
const kept: string[] = [];

/** Guard anything costly to format with `diagOn()` rather than paying for it
 *  on every utterance. */
// A dev build served by Vite also writes the audio and timing lines to a file
// on the dev's machine (the `diag-file` plugin in vite.config.ts), since the
// desktop shell's console is only readable in the Web Inspector. These tags
// carry timings and lengths, never what was said.
const FILED_TAG = /^\[(vad|stt-[a-z]+|echo-guard|signature|turn|setup-clip)\]/;
const FILE_FLUSH_MS = 500;
let unfiled: string[] = [];

function fileLine(line: string): void {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    const d = new Date();
    const at = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    if (unfiled.length === 0) {
        setTimeout(() => {
            const body = unfiled.join('\n');
            unfiled = [];
            navigator.sendBeacon('/__diag', body);
        }, FILE_FLUSH_MS);
    }
    unfiled.push(`${at} ${line}`);
}

export function diag(...args: unknown[]): void {
    if (!diagOn()) return;
    console.info(...args);
    const line = args.map(String).join(' ');
    if (import.meta.env.DEV && FILED_TAG.test(line)) fileLine(line);
    if (!KEPT_TAG.test(line)) return;
    kept.push(line.length > MAX_KEPT_CHARS ? `${line.slice(0, MAX_KEPT_CHARS)}…` : line);
    if (kept.length > MAX_KEPT) kept.shift();
}

/** The most recent audio diagnostic lines, oldest first; empty unless dev
 *  mode was on while they happened. */
export function recentAudioDiag(): string[] {
    return kept.slice();
}
