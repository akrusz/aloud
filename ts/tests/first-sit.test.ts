/**
 * The first sit's one-off setup (ui/src/first-sit.ts): it borrows what the
 * setup view resolved for the platform and nothing the form holds, and it
 * leaves the setup it was built from alone - that one is what gets saved.
 */
import { describe, it, expect } from 'vitest';

import { firstSitSetup } from '../ui/src/first-sit.js';
import { defaultSetup, type SessionSetup } from '../ui/src/settings.js';

const edited: SessionSetup = {
    ...defaultSetup,
    meditationType: 'noting',
    intention: 'the job decision',
    intentionByMode: { felt_sense: 'the job decision' },
    focuses: ['inner_parts'],
    qualities: [],
    dirStep: 0,
    verbosity: 'high',
    customInstructions: 'say less',
    provider: 'aloud',
    model: 'anthropic/some-model',
    voice: 'aloud:Harper',
    ttsRate: 150,
    language: 'zh',
};

describe('firstSitSetup', () => {
    it('keeps the resolved provider, model, voice, rate and language', () => {
        const sit = firstSitSetup(edited);
        expect(sit).toMatchObject({
            provider: 'aloud',
            model: 'anthropic/some-model',
            voice: 'aloud:Harper',
            ttsRate: 150,
            language: 'zh',
        });
    });

    it('is a default exploration sit one guidance stop up, whatever the form held', () => {
        const sit = firstSitSetup(edited);
        expect(sit.firstSit).toBe(true);
        expect(sit.meditationType).toBe('exploration');
        expect(sit.intention).toBe('');
        expect(sit.customInstructions).toBe('');
        expect(sit.focuses).toEqual(defaultSetup.focuses);
        expect(sit.qualities).toEqual(defaultSetup.qualities);
        expect(sit.verbosity).toBe(defaultSetup.verbosity);
        expect(sit.dirStep).toBe(defaultSetup.dirStep + 1);
    });

    it('leaves the source setup, and the shared defaults, untouched', () => {
        const before = JSON.stringify(edited);
        const sit = firstSitSetup(edited);
        sit.focuses.push('open_awareness');
        expect(JSON.stringify(edited)).toBe(before);
        expect(edited.firstSit).toBeUndefined();
        expect(defaultSetup.focuses).not.toContain('open_awareness');
    });
});
