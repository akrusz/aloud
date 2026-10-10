import { describe, expect, it } from 'vitest';
import { FELT_SENSE_PHASES, FELT_SENSE_SYSTEM_PROMPT } from '../src/facilitation/felt-sense.js';
import {
    HOLD_SIGNAL_FRAGMENT,
    VOICE_STYLE_FRAGMENT,
} from '../src/facilitation/prompts.js';

describe('felt sense mode', () => {
    it('every phase is fully specified', () => {
        const ids = new Set<string>();
        for (const phase of FELT_SENSE_PHASES) {
            expect(ids.has(phase.id)).toBe(false);
            ids.add(phase.id);
            expect(phase.label.length).toBeGreaterThan(0);
            expect(phase.summary.length).toBeGreaterThan(0);
            expect(phase.prompt).toContain('Current stage');
        }
    });

    it('middle phases carry movement criteria; the ends are clamped by design', () => {
        // Every phase but the last explains when to advance.
        for (const phase of FELT_SENSE_PHASES.slice(0, -1)) {
            expect(phase.prompt).toContain('[NEXT]');
        }
        // Every phase but the first explains when to step back.
        for (const phase of FELT_SENSE_PHASES.slice(1)) {
            expect(phase.prompt).toContain('[BACK]');
        }
        // The close: receiving never advances.
        const receiving = FELT_SENSE_PHASES[FELT_SENSE_PHASES.length - 1]!;
        expect(receiving.prompt).toContain('no [NEXT]');
    });

    it('inherits the shared voice and the standard [HOLD] contract', () => {
        expect(FELT_SENSE_SYSTEM_PROMPT).toContain(VOICE_STYLE_FRAGMENT);
        expect(FELT_SENSE_SYSTEM_PROMPT).toContain(HOLD_SIGNAL_FRAGMENT);
    });
});
