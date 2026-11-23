/**
 * Phase 1 grading: the mechanical expectations a fixture declares (control
 * tokens, spoken length, forbidden strings) plus the universal leak checks.
 * Deterministic in the raw reply, so report.ts re-runs it over stored replies
 * and every sweep is judged by today's checks.
 */

import { parseTurnSignals } from '../src/facilitation/index.js';
import type { Fixture } from './fixtures.js';

export interface Check {
    name: string;
    pass: boolean;
    detail?: string;
}

export function wordCount(s: string): number {
    return s.trim().split(/\s+/).filter(Boolean).length;
}

export function grade(fx: Fixture, raw: string): { checks: Check[]; spoken: string } {
    const signals = parseTurnSignals(raw);
    const spoken = signals.cleanText;
    const checks: Check[] = [];
    const e = fx.expect;

    if (e.hold !== undefined) {
        checks.push({
            name: 'hold',
            pass: signals.hold === e.hold,
            detail: `expected ${e.hold}, got ${signals.hold}`,
        });
    }
    if (e.stage !== undefined) {
        checks.push({
            name: 'stage',
            pass: signals.stage === e.stage,
            detail: `expected ${e.stage}, got ${signals.stage}`,
        });
    }
    if (e.wait !== undefined) {
        const got = signals.waitSec !== null;
        checks.push({
            name: 'wait',
            pass: got === e.wait,
            detail: `expected token ${e.wait}, got ${signals.waitSec ?? 'none'}`,
        });
    }
    if (e.maxWords !== undefined) {
        const n = wordCount(spoken);
        checks.push({ name: 'brevity', pass: n <= e.maxWords, detail: `${n}/${e.maxWords} words` });
    }
    // Curly apostrophes as straight ones: OpenAI models write "I’ve", and the
    // lists are typed "i've".
    const lower = spoken.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");
    for (const bad of e.forbid ?? []) {
        checks.push({
            name: `forbid:${bad}`,
            pass: !lower.includes(bad.toLowerCase()),
        });
    }

    if (e.anyOf !== undefined) {
        checks.push({
            name: 'any-of',
            pass: e.anyOf.some((want) => lower.includes(want.toLowerCase())),
            detail: `none of: ${e.anyOf.join(' | ')}`,
        });
    }

    // Universal: a control token surviving into spoken text means it gets read
    // aloud. Always checked, regardless of what the fixture declares.
    checks.push({
        name: 'no-token-leak',
        pass: !/\[\s*(HOLD|NEXT|BACK|WAIT)/i.test(spoken),
        detail: 'control token survived into spoken text',
    });
    // A malformed token ("[", "[G RE P]") or a bracketed stage direction passes
    // the check above and is still read aloud. bonsai-2:27b scored 95% with
    // three of these before this check existed.
    checks.push({
        name: 'no-stray-bracket',
        pass: !/[[\]]/.test(spoken),
        detail: 'a bracket survived into spoken text',
    });

    return { checks, spoken };
}
