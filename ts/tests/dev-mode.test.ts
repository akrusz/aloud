/**
 * The check-in HUD's URL param (ui/src/dev-mode.ts). It is adopted for the tab
 * at boot because the HUD is decided at session mount, after the router has
 * stripped the query: read at that point, ?debug=checkin never took.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { adoptCheckinDebugParam, isCheckinDebugOn, setCheckinDebug } from '../ui/src/dev-mode.js';

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
    it('is off with no param and no toggle', () => {
        visit('');
        adoptCheckinDebugParam();
        expect(isCheckinDebugOn()).toBe(false);
    });

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
