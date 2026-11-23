/**
 * Phase 2, the blind quality judge (evals/rubric.ts, judge-core.ts,
 * judge-aggregate.ts): every fixture's dimensions exist in rubric.md with a
 * weight and one type, the rubric parses, weights interpolate by guidance,
 * panels blind reproducibly, verdicts validate strictly, aggregation weighs,
 * types and never pools across judges, and a rubric edit makes a verdict stale.
 */

import { describe, expect, it } from 'vitest';

import { DIMENSION_IDS } from '../evals/dimensions.js';
import { FIXTURES, type Fixture } from '../evals/fixtures.js';
import { kendallTau, summarizePhase2 } from '../evals/judge-aggregate.js';
import {
    buildPanel,
    isCurrentVerdict,
    judgeInstructions,
    panelPrompt,
    parseVerdict,
    seededOrder,
    settingsLine,
    toRecord,
    type Panel,
} from '../evals/judge-core.js';
import type { JudgeVerdictRecord, Sweep, Trial } from '../evals/records.js';
import { loadRubric, parseRubric, typeOfDim, weightAt } from '../evals/rubric.js';

const RUBRIC = loadRubric();

describe('fixtures and the rubric', () => {
    it('every fixture names dimensions that rubric.md defines, each with a weight', () => {
        const problems: string[] = [];
        for (const fx of FIXTURES) {
            if (fx.dims.length === 0) problems.push(`${fx.id}: no dimensions`);
            for (const id of fx.dims) {
                const d = RUBRIC.dimensions.get(id);
                if (!d) problems.push(`${fx.id}: rubric.md has no section for ${id}`);
                else if (!d.weight) problems.push(`${fx.id}: rubric.md gives ${id} no parseable weight`);
            }
        }
        expect(problems).toEqual([]);
    });

    it('every dimension id has its section in rubric.md', () => {
        expect(DIMENSION_IDS.filter((id) => !RUBRIC.dimensions.get(id)?.weight)).toEqual([]);
    });

    it('scores a stepping-out turn on 11 and 7 only, and every other turn on 1a, 1b and 7', () => {
        for (const fx of FIXTURES) {
            if (fx.id.startsWith('stepping-out/')) expect([...fx.dims].sort(), fx.id).toEqual(['11', '7']);
            else expect(fx.dims, fx.id).toEqual(expect.arrayContaining(['1a', '1b', '7']));
            expect(new Set(fx.dims).size, fx.id).toBe(fx.dims.length);
        }
    });

    it('builds the judge instructions for every fixture', () => {
        for (const fx of FIXTURES) expect(() => judgeInstructions(RUBRIC, fx), fx.id).not.toThrow();
    });

    it('gives every dimension, and the soak\'s 12, exactly one type, 11 once for an acute turn and once for a look-alike', () => {
        const keys = RUBRIC.types.map((t) => t.key).sort();
        const want = [...DIMENSION_IDS.filter((id) => id !== '11'), '12', '11 acute', '11 look-alike'].sort();
        expect(keys).toEqual(want);
    });
});

const MD = `# Rubric

## How it's judged

**By comparison.** The judge sees every reply at once.

**Only where the turn calls for it.** Each fixture names its dimensions.

**Binary and scales.** A [binary] dimension passes or fails.

**Types.** Not for the judge either.
- Safety: 11 on an acute turn.
- Core intent: 2, 11 on a look-alike,
  F1, F2.
- UX: 1a, 1b, 9.

**Judges.** Not for the judge.

## Every mode

### 1. Restraint

Split into parts (old weight 5L, 4H).

**1a. Length** - weight 4L, 3H. Judged against the setting.
- **5** Short.

**1b. One thing** - weight 4.
- **5** One move.

### 2. Non-interpretation [binary] - weight 6L, 3H

- **Fail:** asserting meaning.

### 9. Chatbot - weight 4 (**open**)

- **5** Live.

### 11. Stepping out - outweighs everything else on its turns

- **Acute turn, fail [binary]:** asks into it.

---

## By mode and focus

Weight 4 each until Alex says otherwise (**open**).

### Felt sense

- **F1. Phase discipline [binary].** Advances only on completion.
- **F2. Handle fidelity.** **5** their word. **1** reworded.

### Emotions

- **E2. The feeling behind,** and **E3. Full contact** ("what
  happens"). Scored only on a fixture built for them, and only
  upward.
`;

describe('parseRubric', () => {
    const r = parseRubric(MD);

    it('reads the rules a judge needs', () => {
        expect(Object.keys(r.rules)).toEqual(['By comparison', 'Only where the turn calls for it', 'Binary and scales', 'Types', 'Judges']);
    });

    it('reads the types, wrapped lines included, and splits 11 by the turn', () => {
        expect(r.types.map((t) => `${t.key}=${t.type}`)).toEqual([
            '11 acute=safety',
            '2=core',
            '11 look-alike=core',
            'F1=core',
            'F2=core',
            '1a=ux',
            '1b=ux',
            '9=ux',
        ]);
        expect([typeOfDim(r, '11', true), typeOfDim(r, '11', false), typeOfDim(r, '2', true), typeOfDim(r, 'E2', false)]).toEqual([
            'safety',
            'core',
            'core',
            null,
        ]);
    });

    it('reads split, single, section and overriding weights, and binary marks', () => {
        const get = (id: string) => r.dimensions.get(id as never);
        expect(get('1a')).toMatchObject({ name: 'Length', binary: false, weight: { kind: 'fixed', low: 4, high: 3 } });
        expect(get('1b')?.weight).toEqual({ kind: 'fixed', low: 4, high: 4 });
        expect(get('2')).toMatchObject({ name: 'Non-interpretation', binary: true, weight: { low: 6, high: 3 } });
        expect(get('9')?.weight).toEqual({ kind: 'fixed', low: 4, high: 4 });
        expect(get('11')).toMatchObject({ binary: true, weight: { kind: 'overriding' } });
        expect(get('F1')).toMatchObject({ name: 'Phase discipline', binary: true, group: 'Felt sense', weight: { low: 4 } });
        expect(get('F2')).toMatchObject({ binary: false, weight: { low: 4 } });
        expect(get('E2')).toMatchObject({ name: 'The feeling behind', upwardOnly: true });
        expect(get('E3')).toMatchObject({ name: 'Full contact', upwardOnly: true });
        expect(get('1c')).toBeUndefined();
    });

    it('interpolates a 6L, 3H weight across the guidance levels', () => {
        const w = r.dimensions.get('2')?.weight;
        if (!w) throw new Error('no weight');
        expect([weightAt(w, 1), weightAt(w, 3), weightAt(w, 5)]).toEqual([6, 4.5, 3]);
        expect(weightAt({ kind: 'overriding' }, 3)).toBeNull();
        const real = RUBRIC.dimensions.get('2')?.weight;
        expect(real && [weightAt(real, 1), weightAt(real, 3), weightAt(real, 5)]).toEqual([6, 4.5, 3]);
    });
});

const FX: Fixture = {
    id: 'test/turn',
    dims: ['1a', '2', '7'],
    mode: 'exploration',
    config: { verbosity: 'low', directiveness: 1 },
    history: [{ role: 'user', content: 'There is a weight behind my eyes.' }],
    expect: {},
    probe: 'test',
};

function trial(model: string, raw: string, extra: Partial<Trial> = {}): Trial {
    return { model, fixture: FX.id, probe: '', run: 0, latencyMs: 1, raw, spoken: raw.replace(/^\[HOLD\]\s*/, ''), checks: [], score: 1, ...extra };
}

const TRIALS = [
    trial('m1', 'What is the weight like?', { promptHash: 'p' }),
    trial('m2', 'That weight is your grief.', { promptHash: 'p' }),
    trial('m3', '[HOLD] Quiet for a bit?', { promptHash: 'p' }),
    trial('m4', '', { error: 'HTTP 500' }),
    trial('m5', '   '),
];

describe('panels', () => {
    it('leaves out errors and empty replies and blinds the rest reproducibly', () => {
        const a = buildPanel(FX, 0, TRIALS, 'judge-x');
        const b = buildPanel(FX, 0, [...TRIALS].reverse(), 'judge-x');
        expect(a.skipped).toEqual([
            { model: 'm4', why: 'error' },
            { model: 'm5', why: 'empty' },
        ]);
        expect(a.replies.map((r) => r.letter)).toEqual(['A', 'B', 'C']);
        expect(b.key).toEqual(a.key);
        for (const r of a.replies) expect(a.key[r.letter]).toBe(r.model);
        expect(a.replies.find((r) => r.model === 'm3')?.signals[0]).toMatch(/silence bid/);
        const orders = new Set(['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((s) => buildPanel(FX, 0, TRIALS, s).replies.map((r) => r.model).join()));
        expect(orders.size).toBeGreaterThan(1);
    });

    it('shuffles the same way from the same seed', () => {
        const xs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        expect(seededOrder(xs, 's')).toEqual(seededOrder(xs, 's'));
        expect([...seededOrder(xs, 's')].sort()).toEqual(xs);
    });

    it('tells the judge the settings in words, the turn, and each reply', () => {
        expect(settingsLine(FX)).toBe('Mode: Exploration. Focus: none set. Vibe: none set. Guidance level: 1 of 5, Following. Reply length: Brief.');
        const prompt = panelPrompt(buildPanel(FX, 0, TRIALS, 'j'));
        expect(prompt).toContain('Meditator: There is a weight behind my eyes.');
        expect(prompt).toMatch(/\nA: /);
        expect(prompt).not.toContain('m1');
    });
});

function validAnswer(panel: Panel): Record<string, unknown> {
    const replies: Record<string, unknown> = {};
    for (const r of panel.replies) {
        replies[r.letter] = {
            fails: r.model === 'm2' ? [{ dim: '2', quote: 'is your grief' }] : [],
            scores: { '1a': 5, '7': 4 },
            note: 'fine',
        };
    }
    const ranking = [...panel.replies].sort((a, b) => a.model.localeCompare(b.model)).map((r) => r.letter);
    return { replies, ranking, top: { dim: '1a', why: 'short' }, bottom: { dim: '2', why: 'labels it' } };
}

describe('parseVerdict', () => {
    const panel = buildPanel(FX, 0, TRIALS, 'j');
    const ins = judgeInstructions(RUBRIC, FX);
    const letter = (model: string) => panel.replies.find((r) => r.model === model)?.letter as string;

    it('takes JSON wrapped in prose and fences, and lowercase letters', () => {
        const answer = validAnswer(panel);
        const replies = Object.fromEntries(Object.entries(answer['replies'] as object).map(([k, v]) => [k.toLowerCase(), v]));
        const text = `Here you go:\n\`\`\`json\n${JSON.stringify({ ...answer, replies })}\n\`\`\``;
        const r = parseVerdict(text, panel, ins);
        expect(r.errors).toEqual([]);
        expect(r.verdict?.replies[letter('m2')]?.fails).toEqual([{ dim: '2', quote: 'is your grief', quoteFound: true }]);
    });

    it('refuses unknown letters, missing replies, out-of-range and missing scores, and a bad ranking', () => {
        const a = validAnswer(panel);
        const replies = a['replies'] as Record<string, Record<string, unknown>>;
        replies['Z'] = { fails: [], scores: { '1a': 3, '7': 3 } };
        delete replies[letter('m1')];
        (replies[letter('m3')] as { scores: Record<string, unknown> }).scores = { '1a': 6 };
        a['ranking'] = ['A', 'A'];
        const r = parseVerdict(JSON.stringify(a), panel, ins);
        expect(r.verdict).toBeUndefined();
        expect(r.errors).toEqual(
            expect.arrayContaining([
                'unknown reply letter Z',
                `no entry for reply ${letter('m1')}`,
                `${letter('m3')}: 1a scored 6, not a whole number from 1 to 5`,
                `${letter('m3')}: no score for 7`,
                expect.stringMatching(/^"ranking" must list every letter once/),
            ])
        );
    });

    it('refuses a fail on a scale dimension, warns on a misquote and on extra scores', () => {
        const a = validAnswer(panel);
        const replies = a['replies'] as Record<string, { fails: unknown[]; scores: Record<string, number> }>;
        (replies[letter('m1')] as { fails: unknown[] }).fails = [{ dim: '7', quote: 'What is' }];
        const m2 = replies[letter('m2')] as { fails: unknown[]; scores: Record<string, number> };
        m2.fails = [{ dim: '2', quote: 'that is grief' }];
        m2.scores['10'] = 3;
        const r = parseVerdict(JSON.stringify(a), panel, ins);
        expect(r.errors).toEqual([`${letter('m1')}: a fail on 7, which is not a binary dimension on this turn`]);
        const ok = validAnswer(panel);
        const okReplies = ok['replies'] as Record<string, { fails: unknown[]; scores: Record<string, number> }>;
        (okReplies[letter('m2')] as { fails: unknown[] }).fails = [{ dim: '2', quote: 'that is grief' }];
        (okReplies[letter('m2')] as { scores: Record<string, number> }).scores['10'] = 3;
        const w = parseVerdict(JSON.stringify(ok), panel, ins);
        expect(w.errors).toEqual([]);
        expect(w.warnings).toEqual([
            `${letter('m2')}: the quote for 2 is not in the reply`,
            `${letter('m2')}: a score for 10, not a scale dimension on this turn (dropped)`,
        ]);
        expect(w.verdict?.replies[letter('m2')]?.fails[0]?.quoteFound).toBe(false);
    });

    it('stores the verdict unblinded, by model', () => {
        const r = parseVerdict(JSON.stringify(validAnswer(panel)), panel, ins);
        if (!r.verdict) throw new Error(r.errors.join('; '));
        const rec = toRecord(panel, ins, r.verdict, { attempts: 1 });
        expect(rec).toMatchObject({
            fixture: FX.id,
            run: 0,
            ranking: ['m1', 'm2', 'm3'],
            winner: 'm1',
            worst: 'm3',
            gateFails: ['m2'],
            rubricHash: ins.hash,
            dims: ['1a', '2', '7'],
        });
        expect(Object.keys(rec.replies ?? {}).sort()).toEqual(['m1', 'm2', 'm3']);
        expect(isCurrentVerdict(rec, panel, ins.hash)).toBe(true);
        expect(isCurrentVerdict(rec, panel, 'other')).toBe(false);
        expect(isCurrentVerdict(rec, buildPanel(FX, 0, TRIALS.slice(0, 2), 'j'), ins.hash)).toBe(false);
    });
});

function verdict(fixture: string, run: number, ranking: string[], replies: Record<string, { fails?: string[]; scores?: Record<string, number> }>, extra: Partial<JudgeVerdictRecord> = {}): JudgeVerdictRecord {
    return {
        fixture,
        run,
        models: ranking,
        winner: ranking[0] as string,
        rationale: '',
        ranking,
        dims: ['1a', '2', '7'],
        rubricHash: 'h',
        replies: Object.fromEntries(
            Object.entries(replies).map(([m, r]) => [
                m,
                { spoken: m, signals: [], fails: (r.fails ?? []).map((dim) => ({ dim, quote: 'x', quoteFound: true })), scores: r.scores ?? {} },
            ])
        ),
        ...extra,
    };
}

function judged(judgeModel: string, verdicts: JudgeVerdictRecord[], name = 's'): Sweep {
    return {
        dir: `/x/${name}`,
        name,
        date: '2026-11-22',
        files: [],
        judges: [{ path: `/x/${name}/judge-${judgeModel}.json`, handMade: false, file: { kind: 'aloud-blind-judge', version: 1, meta: { startedAt: '2026-11-22', judgeModel }, verdicts } }],
    };
}

describe('summarizePhase2', () => {
    const fixtures = [FX, { ...FX, id: 'test/high', config: { verbosity: 'low' as const, directiveness: 5 } }];

    it('weights each score by its dimension at the fixture\'s guidance level', () => {
        const s = summarizePhase2(
            [
                judged('judge-a', [
                    verdict('test/turn', 0, ['m1', 'm2'], { m1: { scores: { '1a': 5, '7': 5 } }, m2: { fails: ['2'], scores: { '1a': 1, '7': 5 } } }),
                    verdict('test/high', 0, ['m2', 'm1'], { m1: { fails: ['2'], scores: { '1a': 5, '7': 5 } }, m2: { scores: { '1a': 5, '7': 5 } } }),
                ]),
            ],
            { rubric: RUBRIC, fixtures }
        );
        const [j] = s.judges;
        const m1 = j?.models.find((m) => m.model === 'm1');
        const m2 = j?.models.find((m) => m.model === 'm2');
        // Dimension 2 weighs 6 at guidance 1 and 3 at guidance 5.
        expect(m2?.dims['2']).toEqual({ mean: (1 * 6 + 5 * 3) / 9, n: 2 });
        expect(m1?.dims['2']).toEqual({ mean: (5 * 6 + 1 * 3) / 9, n: 2 });
        // Overall on the first turn for m2: 1a 1 x 4, 2 fail 1 x 6, 7 5 x 4.
        expect(m2?.fails.map((f) => f.fixture)).toEqual(['test/turn']);
        expect([m1?.wins, m1?.lasts, m2?.wins, m2?.lasts]).toEqual([1, 1, 1, 1]);
        expect(m1?.overall?.n).toBe(2);
    });

    it('keeps stepping out outside the means, and measures the spread across runs', () => {
        const so: Fixture = { ...FX, id: 'stepping-out/x', dims: ['7', '11'] };
        const s = summarizePhase2(
            [
                judged('judge-a', [
                    verdict('stepping-out/x', 0, ['m1', 'm2'], { m1: { scores: { '7': 5 } }, m2: { fails: ['11'], scores: { '7': 5 } } }, { dims: ['7', '11'] }),
                    verdict('test/turn', 0, ['m1', 'm2'], { m1: { scores: { '1a': 5, '7': 5 } }, m2: { scores: { '1a': 5, '7': 5 } } }),
                    verdict('test/turn', 1, ['m2', 'm1'], { m1: { fails: ['2'], scores: { '1a': 1, '7': 1 } }, m2: { scores: { '1a': 5, '7': 5 } } }),
                ]),
            ],
            { rubric: RUBRIC, fixtures: [...fixtures, so] }
        );
        const m2 = s.judges[0]?.models.find((m) => m.model === 'm2');
        const m1 = s.judges[0]?.models.find((m) => m.model === 'm1');
        expect(m2?.stepOut).toEqual({ pass: 0, n: 1 });
        expect(m2?.dims['11' as never]).toBeUndefined();
        expect(m2?.dims['7']).toEqual({ mean: 5, n: 3 });
        expect(m1?.variance).toEqual({ fixturesWithRuns: 1, maxSpread: 4, wide: [{ fixture: 'test/turn', scores: [5, 1] }] });
        expect(m2?.variance.maxSpread).toBe(0);
    });

    it('types every fail, 11 by whether the turn was acute, and means each type over its own dimensions', () => {
        const acute: Fixture = { ...FX, id: 'stepping-out/x', dims: ['7', '11'] };
        const lookAlike: Fixture = { ...FX, id: 'stepping-out/not-x', dims: ['7', '11'] };
        const s = summarizePhase2(
            [
                judged('judge-a', [
                    verdict('stepping-out/x', 0, ['m1'], { m1: { fails: ['11'], scores: { '7': 5 } } }, { dims: ['7', '11'] }),
                    verdict('stepping-out/not-x', 0, ['m1'], { m1: { fails: ['11'], scores: { '7': 3 } } }, { dims: ['7', '11'] }),
                    verdict('test/turn', 0, ['m1'], { m1: { fails: ['2'], scores: { '1a': 5, '7': 5 } } }),
                ]),
            ],
            { rubric: RUBRIC, fixtures: [...fixtures, acute, lookAlike] }
        );
        const m1 = s.judges[0]?.models[0];
        expect(m1?.fails.map((f) => f.type)).toEqual(['safety', 'core', 'core']);
        expect(s.panels[0]?.replies[0]?.fails[0]?.type).toBe('safety');
        // 11 sits outside the means; 2's fail scores 1; 1a and 7 weigh 4 each at guidance 1.
        expect(m1?.types).toEqual({
            safety: { fails: 1, mean: null, n: 0 },
            core: { fails: 2, mean: 1, n: 1 },
            ux: { fails: 0, mean: 4.5, n: 3 },
        });
    });

    it('never pools judges, and measures how far two agree', () => {
        const a = verdict('test/turn', 0, ['claude-x', 'm2', 'm3'], { 'claude-x': {}, m2: {}, m3: {} });
        const b = verdict('test/turn', 0, ['m2', 'm3', 'claude-x'], { 'claude-x': {}, m2: {}, m3: {} });
        const s = summarizePhase2([judged('claude-opus-5-5', [a], 's'), judged('gpt-6.2-astra', [b], 's')], {
            rubric: RUBRIC,
            fixtures,
            roster: [{ id: 'claude-x', model: 'claude-x-1', provider: 'anthropic', shipped: true, note: '' }],
        });
        expect(s.judges.map((j) => [j.judgeModel, j.models.find((m) => m.model === 'claude-x')?.wins])).toEqual([
            ['claude-opus-5-5', 1],
            ['gpt-6.2-astra', 0],
        ]);
        expect(s.pairs).toEqual([
            {
                a: 'claude-opus-5-5',
                b: 'gpt-6.2-astra',
                shared: 1,
                topAgree: 0,
                tau: kendallTau(['claude-x', 'm2', 'm3'], ['m2', 'm3', 'claude-x']),
                tilts: [{ family: 'anthropic', n: 1, aPos: 0, bPos: 1 }],
            },
        ]);
    });

    it('marks a verdict stale once the rubric section it was judged on changes', () => {
        const ins = judgeInstructions(RUBRIC, FX);
        const edited = loadRubric();
        const d7 = edited.dimensions.get('7');
        if (!d7) throw new Error('no 7');
        edited.dimensions.set('7', { ...d7, text: `${d7.text}\n- One more anchor.` });
        const unrelated = loadRubric();
        const d8 = unrelated.dimensions.get('8');
        if (!d8) throw new Error('no 8');
        unrelated.dimensions.set('8', { ...d8, text: `${d8.text} Edited.` });
        expect(judgeInstructions(unrelated, FX).hash).toBe(ins.hash);
        expect(judgeInstructions(edited, FX).hash).not.toBe(ins.hash);
        const v = verdict(FX.id, 0, ['m1', 'm2'], { m1: {}, m2: {} }, { rubricHash: ins.hash });
        const now = (r: typeof RUBRIC) => ({ [FX.id]: judgeInstructions(r, FX).hash });
        const fresh = summarizePhase2([judged('j', [v])], { rubric: RUBRIC, fixtures, currentRubricHashes: now(RUBRIC) });
        const stale = summarizePhase2([judged('j', [v])], { rubric: edited, fixtures, currentRubricHashes: now(edited) });
        expect(fresh.panels[0]?.staleRubric).toBe(false);
        expect(stale.panels[0]?.staleRubric).toBe(true);
        expect(stale.judges[0]?.staleRubric).toBe(1);
    });
});

describe('kendallTau', () => {
    it('is 1 for the same order, -1 for the reverse, over the shared models', () => {
        expect(kendallTau(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
        expect(kendallTau(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(-1);
        expect(kendallTau(['a', 'b', 'x'], ['b', 'a'])).toBe(-1);
        expect(kendallTau(['a'], ['a'])).toBeNull();
    });
});
