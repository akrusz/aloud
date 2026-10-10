/**
 * URL params in ui/src/dev-mode.ts: the check-in HUD's, adopted for the tab at
 * boot because the HUD is decided at session mount, after the router has
 * stripped the query (read at that point, ?debug=checkin never took); and the
 * Developer section's field for typing them where there is no URL bar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    adoptCheckinDebugParam,
    isCheckinDebugOn,
    setCheckinDebug,
    typedUrlParams,
} from '../ui/src/dev-mode.js';

function stubStorage(name: 'sessionStorage' | 'localStorage'): void {
    const store = new Map<string, string>();
    vi.stubGlobal(name, {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
}
const visit = (search: string): void => vi.stubGlobal('location', { search });

beforeEach(() => {
    stubStorage('sessionStorage');
    stubStorage('localStorage');
});
afterEach(() => vi.unstubAllGlobals());

describe('?debug=checkin', () => {
    it('outlives the query it arrived in, for the tab', () => {
        for (const value of ['checkin', '1', 'pacing']) {
            stubStorage('sessionStorage');
            visit(`?debug=${value}`);
            adoptCheckinDebugParam();
            visit(''); // the router's replaceState, then a session mounts
            adoptCheckinDebugParam();
            expect(isCheckinDebugOn(), value).toBe(true);
        }
    });

    it('is dropped by ?debug=off, leaving the Settings toggle alone', () => {
        visit('?debug=checkin');
        adoptCheckinDebugParam();
        visit('?debug=off');
        adoptCheckinDebugParam();
        expect(isCheckinDebugOn()).toBe(false);

        setCheckinDebug(true);
        adoptCheckinDebugParam();
        expect(isCheckinDebugOn()).toBe(true);
    });

    it('ignores a value it does not know', () => {
        visit('?debug=banana');
        adoptCheckinDebugParam();
        expect(isCheckinDebugOn()).toBe(false);
    });
});

describe('typedUrlParams', () => {
    it('reads a query with or without its ?', () => {
        expect(typedUrlParams('mode=web&dev')).toBe('mode=web&dev');
        expect(typedUrlParams('  ?mode=web&dev ')).toBe('mode=web&dev');
    });

    it('takes the query off a pasted URL', () => {
        expect(typedUrlParams('http://localhost:4649/?mode=web&dev')).toBe('mode=web&dev');
        expect(typedUrlParams('http://localhost:4649/settings?sim=network#top')).toBe('sim=network');
    });

    it('is empty, a plain reload, when nothing usable was typed', () => {
        expect(typedUrlParams('')).toBe('');
        expect(typedUrlParams('?')).toBe('');
        expect(typedUrlParams('http://localhost:4649/')).toBe('');
    });

    it('drops stray joiners', () => {
        expect(typedUrlParams('&dev&')).toBe('dev');
    });
});
