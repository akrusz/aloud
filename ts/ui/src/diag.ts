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
export function diag(...args: unknown[]): void {
    if (!diagOn()) return;
    console.info(...args);
    const line = args.map(String).join(' ');
    if (!KEPT_TAG.test(line)) return;
    kept.push(line.length > MAX_KEPT_CHARS ? `${line.slice(0, MAX_KEPT_CHARS)}…` : line);
    if (kept.length > MAX_KEPT) kept.shift();
}

/** The most recent audio diagnostic lines, oldest first; empty unless dev
 *  mode was on while they happened. */
export function recentAudioDiag(): string[] {
    return kept.slice();
}
