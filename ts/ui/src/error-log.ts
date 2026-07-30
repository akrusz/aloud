/**
 * Rolling in-memory log of page errors for the bug-report diagnostics block:
 * window "error" / "unhandledrejection" events plus console.error/warn lines.
 * Puts exact error text in a report without asking the user to open DevTools -
 * the difference between "VAD: failed" and the machine-specific ort message an
 * upstream bug report needs (6z11). Capped small and truncated, since some
 * mail clients cut mailto bodies past a few KB.
 */

const MAX_ENTRIES = 20;
const MAX_ENTRY_CHARS = 220;
const entries: string[] = [];

function push(line: string): void {
    const clipped =
        line.length > MAX_ENTRY_CHARS ? `${line.slice(0, MAX_ENTRY_CHARS)}…` : line;
    // Collapse immediate repeats so a failing loop can't evict everything else.
    if (entries[entries.length - 1] === clipped) return;
    entries.push(clipped);
    if (entries.length > MAX_ENTRIES) entries.shift();
}

function text(v: unknown): string {
    if (v instanceof Error) return v.message;
    if (typeof v === 'string') return v;
    try {
        return JSON.stringify(v) ?? String(v);
    } catch {
        return String(v);
    }
}

/** Install the window listeners + console taps. Call once at app start. */
export function installErrorLog(): void {
    window.addEventListener('error', (e) => {
        const at = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
        push(`error: ${e.message}${at}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
        push(`unhandledrejection: ${text(e.reason)}`);
    });
    for (const level of ['error', 'warn'] as const) {
        const orig = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            push(`console.${level}: ${args.map(text).join(' ')}`);
            orig(...args);
        };
    }
}

/** The most recent captured lines, oldest first; empty when the page is clean. */
export function recentErrors(limit = 8): string[] {
    return entries.slice(-limit);
}
