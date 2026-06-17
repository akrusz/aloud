/**
 * Structured logger with a HARD privacy invariant: meditation content never
 * touches a log line. This is the operational half of meditation-pal-dn2
 * (no-retention default for the multi-user aloud cloud) — the architecture
 * already keeps sessions client-side, and this guarantees the one place
 * content transits the server (the forwarding proxy) doesn't quietly persist
 * it via logs.
 *
 * The proxy handles `messages[]` and completion `text`. Those are NEVER passed
 * to the logger. To make that auditable rather than aspirational, `log()`
 * runs `assertNoContent()` over the metadata it's handed and throws in dev if
 * a field looks like it carries a message body. We'd rather crash a request in
 * testing than leak a sutra into stdout in production.
 */

const SECRET_KEYS = /(_key|_secret|token|authorization|password|cookie)$/i;
const BANNED_KEYS = /^(messages|content|text|system|prompt|transcript|delta)$/i;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let strictContentCheck = true;

/** In production we don't want a stray field to crash a paying user's
 *  request, so the content assertion downgrades to "drop the field". In dev
 *  and tests it throws, surfacing the mistake immediately. */
export function setStrictContentCheck(on: boolean): void {
    strictContentCheck = on;
}

export function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redactSecrets(v);
        }
        return out;
    }
    return value;
}

function assertNoContent(meta: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
        if (BANNED_KEYS.test(k)) {
            const msg = `logger: refusing to log content-bearing field "${k}" (privacy invariant, meditation-pal-dn2)`;
            if (strictContentCheck) throw new Error(msg);
            continue; // production: drop it silently rather than fail the request
        }
        out[k] = v;
    }
    return out;
}

function emit(level: LogLevel, msg: string, meta: Record<string, unknown>): void {
    const safe = redactSecrets(assertNoContent(meta)) as Record<string, unknown>;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

export const log = {
    debug: (msg: string, meta: Record<string, unknown> = {}) => emit('debug', msg, meta),
    info: (msg: string, meta: Record<string, unknown> = {}) => emit('info', msg, meta),
    warn: (msg: string, meta: Record<string, unknown> = {}) => emit('warn', msg, meta),
    error: (msg: string, meta: Record<string, unknown> = {}) => emit('error', msg, meta),
};
