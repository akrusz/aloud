/**
 * Casting rules for the soak harness.
 *
 * The load-bearing tests here are the two that hold the DEFAULTS and every
 * BATTERY to "no collisions": a preset is what gets run without thinking, so a
 * preset must never be the thing that quietly contaminates a scoreboard. An
 * explicit override may still collide - that path is warned, not blocked.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { BATTERIES, DEFAULT_ROLES } from '../soak/batteries.js';
import { describeRoles, findRoleCollisions, resolveRoles } from '../soak/roles.js';
import { buildReportMd, tierOfRunDir, type RunMeta } from '../soak/report.js';
import { diffAgainstBaseline } from '../soak/baseline.js';
import { runChecks } from '../soak/checks.js';
import type { SessionReport, SessionRunResult } from '../soak/types.js';

beforeAll(() => {
    // Provider construction validates a key is present; the tests never call out.
    for (const v of [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'GROQ_API_KEY',
        'OPENROUTER_API_KEY',
        'VENICE_API_KEY',
    ]) {
        process.env[v] ??= 'test-key';
    }
});

describe('role collisions', () => {
    it('the shipped defaults cast nobody twice', () => {
        expect(findRoleCollisions(resolveRoles(DEFAULT_ROLES))).toEqual([]);
    });

    it.each(BATTERIES.map((b) => [b.id, b] as const))(
        'battery %s casts nobody twice',
        (_id, battery) => {
            expect(findRoleCollisions(resolveRoles(battery.roles))).toEqual([]);
        }
    );

    it('catches a judge scoring its own transcripts', () => {
        const collisions = findRoleCollisions(
            resolveRoles({ ...DEFAULT_ROLES, judge: DEFAULT_ROLES.facilitators[0] as string })
        );
        expect(collisions.map((c) => c.id)).toEqual(['judge-is-facilitator']);
    });

    it('compares resolved models, not spec strings', () => {
        // "anthropic" and its explicit default model are the same casting.
        const collisions = findRoleCollisions(
            resolveRoles({ ...DEFAULT_ROLES, judge: 'anthropic:claude-sonnet-5' })
        );
        expect(collisions).toHaveLength(1);
        expect(collisions[0]?.model).toBe('claude-sonnet-5');
    });

    it('catches a simulated meditator sharing the facilitator model', () => {
        const collisions = findRoleCollisions(
            resolveRoles({ ...DEFAULT_ROLES, user: 'anthropic:claude-sonnet-5' })
        );
        expect(collisions.map((c) => c.id)).toEqual(['meditator-is-facilitator']);
    });

    it('flags one facilitator in a comparison run, not the whole field', () => {
        const collisions = findRoleCollisions(
            resolveRoles({
                ...DEFAULT_ROLES,
                facilitators: ['anthropic', 'groq'],
                judge: 'groq',
            })
        );
        expect(collisions).toHaveLength(1);
        expect(collisions[0]?.detail).toMatch(/one of the facilitators/);
    });

    it('does not flag classifiers sharing the facilitator model, which is what the app does', () => {
        const collisions = findRoleCollisions(
            resolveRoles({ ...DEFAULT_ROLES, utility: 'anthropic:claude-sonnet-5' })
        );
        expect(collisions).toEqual([]);
    });

    it('names every role, so a score is never read without its cast', () => {
        const described = describeRoles(resolveRoles(DEFAULT_ROLES));
        expect(described).toMatch(/facilitator /);
        expect(described).toMatch(/meditator /);
        expect(described).toMatch(/classifiers /);
        expect(described).toMatch(/judge /);
    });
});

describe('empty spoken turns', () => {
    /** A transcript whose only assistant reply scrubbed down to nothing. */
    const silentTurn = (raw: string): SessionRunResult =>
        ({
            scenario: { id: 'baseline', title: 't' },
            runIndex: 0,
            startedAt: '2026-08-21T00:00:00.000Z',
            facilitatorModel: 'm',
            fakeDurationSec: 60,
            transcript: [{ at: 1, role: 'assistant', kind: 'reply', text: '', raw }],
            events: [],
            calls: [],
            endedBy: 'duration',
            finalState: { silenceMode: false, awaitingHoldConfirm: false },
        }) as unknown as SessionRunResult;

    it('fails a turn that said nothing because the reply was only control tokens', () => {
        // A signal-only reply leaves raw non-empty, so the empty-completion
        // guard misses it and the meditator is answered with silence.
        const findings = runChecks(silentTurn('[WAIT:8m]'));
        const empty = findings.find((f) => f.id === 'empty-spoken-turn');
        expect(empty?.level).toBe('fail');
        expect(empty?.detail).toContain('[WAIT:8m]');
    });

    it('fails a bare [HOLD], which strands the shall-I-be-quiet handshake', () => {
        expect(runChecks(silentTurn('[HOLD]')).find((f) => f.id === 'empty-spoken-turn')?.level).toBe(
            'fail'
        );
    });
});

// ---- Report shape ------------------------------------------------------

function report(over: Partial<{
    scenario: string;
    model: string;
    fails: string[];
    judge: number;
    wince: Array<{ quote: string; why: string }>;
}> = {}): SessionReport {
    const fails = over.fails ?? [];
    return {
        result: {
            scenario: { id: over.scenario ?? 'baseline', title: 'A test scenario' },
            runIndex: 0,
            startedAt: '2026-08-21T00:00:00.000Z',
            facilitatorModel: over.model ?? 'model-a',
            fakeDurationSec: 600,
            transcript: [
                { at: 0, role: 'assistant', kind: 'opener', text: 'Settle in.' },
                { at: 30, role: 'user', kind: 'user', text: 'My shoulders are tight.' },
            ],
            events: [],
            calls: [],
            endedBy: 'duration',
            finalState: { silenceMode: false, awaitingHoldConfirm: false },
        },
        findings: [
            ...fails.map((id) => ({ id, level: 'fail' as const, detail: `${id} happened` })),
            { id: 'latency', level: 'info' as const, detail: 'p50 900ms' },
        ],
        judge: {
            overall: over.judge ?? 8,
            dimensions: { responsiveness: 8, tone: 7, brevity: 9 },
            winceMoments: over.wince ?? [],
            notes: 'Held together.',
        },
    } as unknown as SessionReport;
}

const META: RunMeta = {
    startedAt: '2026-08-21T00:00:00.000Z',
    tier: 'headless',
    cast: {
        facilitators: [{ spec: 'anthropic', model: 'model-a' }],
        user: { spec: 'anthropic:haiku', model: 'haiku' },
        utility: { spec: 'anthropic:haiku', model: 'haiku' },
        judge: { spec: 'openai:gpt-5.5', model: 'gpt-5.5' },
    },
    collisions: [],
    wallClockMs: 60_000,
};

describe('report ordering', () => {
    it('leads with the verdict and puts scores far above the transcript', () => {
        const md = buildReportMd(META, [report({ fails: ['residual-token'] })]);
        expect(md).toMatch(/^# Soak report/);
        expect(md).toMatch(/## ❌ 1 check failure in 1 of 1 session/);
        const scores = md.indexOf('## Scores');
        const detail = md.indexOf('## Session detail');
        const transcript = md.indexOf('My shoulders are tight');
        expect(scores).toBeGreaterThan(0);
        expect(scores).toBeLessThan(detail);
        expect(detail).toBeLessThan(transcript);
    });

    it('says so plainly when nothing failed', () => {
        const md = buildReportMd(META, [report()]);
        expect(md).toMatch(/## ✅ 1 session, no check failures/);
        expect(md).not.toMatch(/## Failures and warnings/);
    });

    it('names the whole cast in the header', () => {
        const md = buildReportMd(META, [report()]);
        const header = md.slice(0, md.indexOf('## Scores'));
        for (const model of ['model-a', 'haiku', 'gpt-5.5']) {
            expect(header).toContain(model);
        }
    });

    it('stamps a casting collision next to the scores, not in a footnote', () => {
        const meta: RunMeta = {
            ...META,
            collisions: [
                { id: 'judge-is-facilitator', model: 'model-a', detail: 'the judge is the facilitator' },
            ],
        };
        const md = buildReportMd(meta, [report()]);
        const caveat = md.indexOf('Casting caveat');
        expect(caveat).toBeGreaterThan(0);
        expect(caveat).toBeLessThan(md.indexOf('## Scores'));
    });

    it('groups one broken thing seen in four sessions into one row', () => {
        const reports = ['baseline', 'silence', 'quiet', 'timer-hold'].map((scenario) =>
            report({ scenario, fails: ['residual-token'] })
        );
        const md = buildReportMd(META, reports);
        const section = md.slice(md.indexOf('## Failures and warnings'), md.indexOf('## Session detail'));
        expect(section.match(/`residual-token`/g)).toHaveLength(1);
        expect(section).toContain('×4');
    });

    it('surfaces wince quotes above the session detail', () => {
        const md = buildReportMd(META, [
            report({ wince: [{ quote: 'You are doing great!', why: 'greeting-card praise' }] }),
        ]);
        const wince = md.indexOf('You are doing great!');
        expect(wince).toBeGreaterThan(0);
        expect(wince).toBeLessThan(md.indexOf('## Session detail'));
    });

    it('ranks the comparison table best-first when several models ran', () => {
        const md = buildReportMd(
            { ...META, cast: { ...META.cast, facilitators: [
                { spec: 'a', model: 'model-a' },
                { spec: 'b', model: 'model-b' },
            ] } },
            [report({ model: 'model-a', judge: 4 }), report({ model: 'model-b', judge: 9 })]
        );
        const table = md.slice(md.indexOf('## Facilitator comparison'), md.indexOf('## Scores'));
        expect(table.indexOf('model-b')).toBeLessThan(table.indexOf('model-a'));
    });
});

describe('baseline tier guard', () => {
    it('reads a tier off the directory name for runs predating the field', () => {
        expect(tierOfRunDir('/x/soak-runs/web-2026-08-21T01-17-03')).toBe('browser');
        expect(tierOfRunDir('/x/soak-runs/2026-08-21T01-17-03')).toBe('headless');
        // An explicit tier always wins over the naming guess.
        expect(tierOfRunDir('/x/soak-runs/web-anything', { tier: 'headless' })).toBe('headless');
    });

    it('warns loudly when the baseline came from the other harness', () => {
        // The two matrices share scenario ids, so a cross-tier diff looks
        // perfectly plausible and means nothing.
        const md = buildReportMd(
            { ...META, baselineDir: '/x/soak-runs/web-2026-08-21T01-17-03' },
            [report()],
            undefined,
            diffAgainstBaseline([report()], [report()])
        );
        expect(md).toContain('Different harness');
    });

    it('says nothing about tiers when the baseline matches', () => {
        const md = buildReportMd(
            { ...META, baselineDir: '/x/soak-runs/2026-08-20T01-17-03' },
            [report()],
            undefined,
            diffAgainstBaseline([report()], [report()])
        );
        expect(md).not.toContain('Different harness');
    });
});

describe('baseline diff', () => {
    it('calls out a check that newly fails', () => {
        const diff = diffAgainstBaseline([report({ fails: ['residual-token'] })], [report()]);
        expect(diff.newFails).toEqual([{ cell: 'baseline · model-a', checkId: 'residual-token' }]);
        expect(diff.fixedFails).toEqual([]);
    });

    it('credits a check that stopped failing', () => {
        const diff = diffAgainstBaseline([report()], [report({ fails: ['residual-token'] })]);
        expect(diff.fixedFails).toEqual([{ cell: 'baseline · model-a', checkId: 'residual-token' }]);
    });

    it('hides judge movement inside the noise floor and shows a real drop', () => {
        // A full point moved between two runs of identical code, so a 1.0
        // threshold would cry regression at nothing (see JUDGE_DELTA_MIN).
        expect(diffAgainstBaseline([report({ judge: 8 })], [report({ judge: 9 })]).judgeMoves).toEqual([]);
        const real = diffAgainstBaseline([report({ judge: 5 })], [report({ judge: 8 })]);
        expect(real.judgeMoves).toEqual([{ cell: 'baseline · model-a', before: 8, after: 5 }]);
    });

    it('averages a cell over its repeats rather than comparing session to session', () => {
        const now = [report({ judge: 4 }), report({ judge: 6 })];
        const diff = diffAgainstBaseline(now, [report({ judge: 8 })]);
        expect(diff.judgeAfter).toBe(5);
        expect(diff.judgeBefore).toBe(8);
    });

    it('reports cells it could not compare instead of silently dropping them', () => {
        const diff = diffAgainstBaseline([report({ scenario: 'silence' })], [report({ scenario: 'baseline' })]);
        expect(diff.compared).toBe(0);
        expect(diff.onlyNow).toEqual(['silence · model-a']);
        expect(diff.onlyBefore).toEqual(['baseline · model-a']);
    });

    it('separates the same scenario run under different facilitators', () => {
        const diff = diffAgainstBaseline(
            [report({ model: 'model-a' }), report({ model: 'model-b' })],
            [report({ model: 'model-a' }), report({ model: 'model-b' })]
        );
        expect(diff.compared).toBe(2);
    });
});
