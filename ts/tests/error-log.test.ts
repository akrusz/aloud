/**
 * error-log - the rolling page-error buffer behind the bug-report "Recent
 * errors" block: capture via the window listeners, truncation, consecutive
 * dedup, and the size cap. Node env, so `window` is stubbed to hand back the
 * registered listeners; the console taps ride along (they keep delegating to
 * the real console, so other tests are unaffected).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { installErrorLog, recentErrors } from '../ui/src/error-log.js';

type Listener = (e: never) => void;
const listeners = new Map<string, Listener>();

beforeAll(() => {
    (globalThis as { window?: unknown }).window = {
        addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    };
    installErrorLog();
});

function fireRejection(reason: unknown): void {
    listeners.get('unhandledrejection')!({ reason } as never);
}

describe('error-log', () => {
    it('captures window errors with a short location', () => {
        listeners.get('error')!({
            message: 'boom',
            filename: 'https://aloud.rest/assets/app-abc123.js',
            lineno: 42,
        } as never);
        expect(recentErrors().at(-1)).toBe('error: boom (app-abc123.js:42)');
    });

    it('captures rejections, stringifying Error and non-Error reasons', () => {
        fireRejection(new Error('ort session create failed'));
        fireRejection({ code: 7 });
        expect(recentErrors().slice(-2)).toEqual([
            'unhandledrejection: ort session create failed',
            'unhandledrejection: {"code":7}',
        ]);
    });

    it('collapses immediate repeats and truncates long lines', () => {
        const before = recentErrors(100).length;
        fireRejection('same');
        fireRejection('same');
        expect(recentErrors(100).length).toBe(before + 1);

        fireRejection('x'.repeat(500));
        expect(recentErrors().at(-1)!.length).toBeLessThan(240);
    });

    it('drops the oldest entries past the cap', () => {
        for (let i = 0; i < 30; i++) fireRejection(`e${i}`);
        const all = recentErrors(100);
        expect(all.length).toBe(20);
        expect(all.at(-1)).toBe('unhandledrejection: e29');
        expect(recentErrors().length).toBe(8);
    });
});
