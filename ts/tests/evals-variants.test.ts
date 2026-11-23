/**
 * Prompt variants in the eval (protocol-eval.ts --variant): the note is the
 * system prompt's last paragraph, changes the prompt hash, and is filed under
 * its own model id beside the baseline.
 */

import { describe, expect, it } from 'vitest';

import { FIXTURES } from '../evals/fixtures.js';
import { promptHashFor, systemPromptFor } from '../evals/prompt.js';
import { baseModelId, modelFileName, parseRunFile, RUN_KIND } from '../evals/records.js';

const fx = FIXTURES.find((f) => f.id === 'conduct/care-about-me')!;
const NOTE = 'About yourself: you can be honest about what you are.';

describe('prompt variants', () => {
    it('appends the note as the last paragraph and leaves the shipped prompt otherwise unchanged', () => {
        const shipped = systemPromptFor(fx);
        expect(systemPromptFor(fx, NOTE)).toBe(`${shipped}\n\n${NOTE}`);
        expect(systemPromptFor(fx, undefined)).toBe(shipped);
    });

    it('hashes the changed prompt, and the same note to the same hash', () => {
        expect(promptHashFor(fx, NOTE)).not.toBe(promptHashFor(fx));
        expect(promptHashFor(fx, NOTE)).toBe(promptHashFor(fx, NOTE));
        expect(promptHashFor(fx, `${NOTE} More.`)).not.toBe(promptHashFor(fx, NOTE));
    });

    it('files a variant under <model>+<name>, and finds the roster id under it', () => {
        expect(modelFileName('gpt-6-luna+honest1')).toBe('gpt-6-luna+honest1.json');
        expect(modelFileName('moonshotai/kimi-k2')).toBe('moonshotai_kimi-k2.json');
        expect(baseModelId('gpt-6-luna+honest1')).toBe('gpt-6-luna');
        expect(baseModelId('gpt-6-luna')).toBe('gpt-6-luna');
    });

    it('reads the variant back from the run metadata', () => {
        const meta = {
            startedAt: '2026-11-23T00:00:00.000Z',
            finishedAt: '2026-11-23T00:01:00.000Z',
            gitSha: null,
            gitDirty: null,
            claudeVia: 'subscription',
            runs: 1,
            fixtures: [fx.id],
            models: ['gpt-6-luna+honest1'],
            variant: { name: 'honest1', text: NOTE },
        };
        const trial = { model: 'gpt-6-luna+honest1', fixture: fx.id, description: '', run: 0, latencyMs: 1, raw: 'x', spoken: 'x', checks: [], score: 1 };
        const parsed = parseRunFile({ kind: RUN_KIND, version: 1, meta, trials: [trial] });
        expect(parsed?.meta?.variant).toEqual({ name: 'honest1', text: NOTE });
        expect(parsed?.trials[0]?.model).toBe('gpt-6-luna+honest1');
    });
});
