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

/** Guard anything costly to format with `diagOn()` rather than paying for it
 *  on every utterance. */
export function diag(...args: unknown[]): void {
    if (diagOn()) console.info(...args);
}
