/**
 * A/B the silence classifiers: Jev (typed judgment) against the shipping Haiku
 * prompts, on a labelled corpus that shares no utterance with either one's
 * examples (v36y). Sends the exact production request (server askNouls + core
 * JUDGE_SPECS), so a threshold tuned here is the threshold the app runs.
 *
 *   npm run jev:ab                 (all three classifiers)
 *   npm run jev:ab -- resume       (one)
 *   npm run jev:ab -- --runs 3     (repeat each call; shows verdict flips)
 *
 * Needs TYPESAFE_API_KEY and ANTHROPIC_API_KEY, from ts/server/.env or the
 * environment. Latency here is from this machine, not from Fly: for the real
 * number read `judge` lines in `fly logs` after a shadow-mode session.
 */

import { AnthropicProvider } from '../src/llm/index.js';
import {
    classifyHoldConfirm,
    classifyHoldRequest,
    classifyResumeIntent,
} from '../src/facilitation/resume-intent.js';
import {
    CLASSIFIER_IDS,
    JUDGE_SPECS,
    isClassifierId,
    judgeQuestions,
    judgeState,
    type ClassifierId,
    type JudgeAnswers,
} from '../src/facilitation/utterance-judge.js';
import { askNouls } from '../server/src/providers/typesafe.js';
import { loadServerEnv } from '../soak/env.js';

interface Case {
    text: string;
    want: boolean;
    /** The ones a reasonable listener could call either way; reported apart. */
    hard?: boolean;
    /** Said earlier in the same hold. Jev sees it; Haiku, as shipped, does not. */
    earlier?: string[];
}

const y = (text: string, hard = false): Case => ({ text, want: true, ...(hard ? { hard } : {}) });
const n = (text: string, hard = false): Case => ({ text, want: false, ...(hard ? { hard } : {}) });

/** Same words, different hold: the pairs below are the point of `earlier`. */
const after = (earlier: string[], c: Case): Case => ({ ...c, earlier });

const CORPUS: Record<ClassifierId, Case[]> = {
    resume: [
        y("Alright, I'm ready to continue."),
        y('Okay, you can come back now.'),
        y('Can you say something?'),
        y("I think I'm done sitting quietly."),
        y('Hey, are you still there?'),
        y('What should I do with this?'),
        y("That's enough silence for me, thanks."),
        y('Could you guide me from here?'),
        y("Okay. Let's talk about what came up.", true),
        y('I have a question for you.'),
        n('My shoulders are dropping a little.'),
        n('Huh.'),
        n('Okay.', true),
        n("It's like a knot, just under the ribs."),
        n('I wonder why that keeps coming up.'),
        n('Oh, that is sad. That is really sad.'),
        n('Why do I always do this?', true),
        n("He's saying to breathe into the belly now."),
        n('The recording wants me to count to ten.'),
        n('Okay, okay, okay. Just breathe.'),
        n('I keep thinking about what she said to me.'),
        n("There's a part of me that wants to talk and a part that doesn't.", true),
        n('What is that? Something in my throat.', true),
        n('Still here. Still with it.'),
        n('I should really call my mom back.'),
        n("Let's see what happens if I stay with it.", true),
        // Hedged call-backs, no context.
        y("I guess I'm ready.", true),
        y("I think that's enough for now."),
        y("Okay, I think I'm good."),
        y("I'm ready when you are."),
        n("I guess that's just how it is."),
        n("I think I'm okay with that."),
        // "Ready" for what? Only the hold so far can say.
        after(
            ["There's a real tension here and I'm not sure what that's all about.", "I'm not sure what to do about it either."],
            y("But I guess that's okay. I guess I'm ready.", true)
        ),
        after(
            ["I keep wondering if I'm ready to talk to my dad about it.", "Part of me says wait another year.", 'But when is anyone ready for that.'],
            n("I guess I'm ready.")
        ),
        after(["It's settled down a lot.", "Yeah. That feels complete."], y("I guess I'm ready.")),
        after(["But I guess that's okay. I guess I'm ready."], y('Alright.')),
        after(["There's a buzzing in my hands."], n('Alright.')),
        after(["Okay, I'm done. You can come back."], y('Hello?')),
        after(["It's like something is knocking from the inside."], n('Hello?', true)),
        after(["She's asking us to picture a door now."], n("Okay, I'm ready.", true)),
        after(['我不知道我是不是准备好原谅他了。'], n('也许我准备好了。')),
        after(['感觉平静多了。'], y('好,我准备好了。')),
        y('好,我们继续吧。'),
        y('你还在吗?'),
        y('我想听听你的看法。'),
        n('肩膀慢慢松下来了。'),
        n('为什么我总是这样呢。', true),
        n('她现在让我把注意力放到呼吸上。'),
        n('嗯。'),
    ],
    'hold-confirm': [
        y('Yeah, that would be good.'),
        y('Sure.'),
        y('Mm-hm, just let me sit with this for a bit.'),
        y("Yes. I'll let you know when I'm ready."),
        y("I think I'd like that."),
        y('Okay, quiet is fine.'),
        y('Please.', true),
        n("No, I'd rather you stayed with me."),
        n('Not right now.'),
        n('Huh? I was just describing it.'),
        n("There's this pressure behind my eyes."),
        n('Can you ask me another question instead?'),
        n("I don't know.", true),
        n('Maybe in a minute, keep going for now.', true),
        n("No no, it's fine, keep talking."),
        n('What do you mean?'),
        y('好,让我静一静。'),
        y('嗯,可以。'),
        n('不要,你继续说。'),
        n('我也不知道。', true),
    ],
    'hold-request': [
        y("Hold on, I wasn't finished."),
        y('Quiet, please.'),
        y("I didn't ask you to come back."),
        y('Not yet. Give me more time.'),
        y("Oh, sorry, that wasn't for you. Stay silent."),
        y('Can you go back to just listening?'),
        y("No, no, I'm still sitting with it.", true),
        n("Yes, that's right."),
        n("It's more of a heaviness than a pain."),
        n("I'm not sure what you mean."),
        n('Thanks, that helps.'),
        n("Okay, what's next?"),
        n('It went quiet in there.', true),
        n('I notice I want to stay with the silence inside.', true),
        n('Hmm, no, it feels more like fear.'),
        n('Say that again?'),
        y('先别说话。'),
        y('我还没好,再等一下。'),
        n('对,是这种感觉。'),
        n('你刚才说什么?'),
    ],
};

const LLM: Record<ClassifierId, (p: AnthropicProvider, text: string) => Promise<boolean | 'error'>> = {
    resume: async (p, t) => {
        const v = await classifyResumeIntent(p, t);
        return v === 'error' ? 'error' : v === 'resume';
    },
    'hold-confirm': (p, t) => classifyHoldConfirm(p, t),
    'hold-request': (p, t) => classifyHoldRequest(p, t),
};

interface Row extends Case {
    /** One per run. */
    answers: JudgeAnswers[];
    judgeMs: number[];
    llm: Array<boolean | 'error'>;
    llmMs: number[];
    judgeError?: string;
}

function pct(a: number, b: number): string {
    return b === 0 ? '  -  ' : `${((100 * a) / b).toFixed(0).padStart(3)}%`;
}

function quantile(xs: number[], q: number): number {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

async function runClassifier(id: ClassifierId, runs: number, keys: { typesafe: string; anthropic: string }): Promise<Row[]> {
    const haiku = new AnthropicProvider({ apiKey: keys.anthropic, model: 'claude-haiku-4-5-20251001' });
    const rows: Row[] = [];
    for (const c of CORPUS[id]) {
        const row: Row = { ...c, answers: [], judgeMs: [], llm: [], llmMs: [] };
        for (let i = 0; i < runs; i++) {
            let t0 = Date.now();
            try {
                const r = await askNouls(
                    keys.typesafe,
                    judgeState(id, c.text, { earlier: c.earlier ?? [] }),
                    judgeQuestions(id)
                );
                row.answers.push(r.answers);
                row.judgeMs.push(Date.now() - t0);
            } catch (err) {
                row.judgeError = String(err);
            }
            t0 = Date.now();
            row.llm.push(await LLM[id](haiku, c.text));
            row.llmMs.push(Date.now() - t0);
        }
        rows.push(row);
    }
    return rows;
}

/** Mean P(yes) for one ask across a row's runs. */
const pOf = (r: Row, key: string): number => mean(r.answers.map((a) => a[key] ?? NaN));

function report(id: ClassifierId, rows: Row[]): void {
    const asks = Object.entries(JUDGE_SPECS[id].asks);
    const keys = asks.map(([k]) => k);
    /** The verdict under `thresholds` (defaults: the shipped ones). */
    const jevYes = (r: Row, thresholds: Record<string, number> = {}): boolean =>
        asks.some(([k, a]) => pOf(r, k) >= (thresholds[k] ?? a.threshold));

    console.log(`\n=== ${id}  (${asks.map(([k, a]) => `${k} >= ${a.threshold}`).join('  or  ')}) ===`);
    console.log(`want  ${keys.map((k) => k.slice(0, 9).padEnd(9)).join(' ')}  jev  haiku  utterance`);
    for (const r of rows) {
        const scored = r.answers.length > 0;
        const jev = scored ? jevYes(r) : null;
        const llmYes = r.llm.filter((v) => v === true).length;
        const llm = r.llm.includes('error') ? 'ERR' : llmYes === r.llm.length ? 'yes' : llmYes === 0 ? 'no ' : 'mix';
        const cells = keys.map((k) => {
            if (!scored) return ' -- '.padEnd(9);
            const ps = r.answers.map((a) => a[k] ?? NaN);
            const spread = ps.length > 1 ? `±${((Math.max(...ps) - Math.min(...ps)) / 2).toFixed(2)}` : '';
            return `${pOf(r, k).toFixed(2)}${spread}`.padEnd(9);
        });
        const flag = [jev !== null && jev !== r.want ? 'JEV' : '', (llm === 'yes') !== r.want ? 'HAIKU' : '']
            .filter(Boolean)
            .join('+');
        const ctx = r.earlier ? `[…${r.earlier[r.earlier.length - 1]!.slice(0, 40)}] ` : '';
        console.log(
            `${r.want ? 'yes' : 'no '}   ${cells.join(' ')}  ${jev === null ? 'ERR' : jev ? 'yes' : 'no '}  ${llm}    ${r.hard ? '~ ' : ''}${ctx}${r.text}${flag ? `   <-- ${flag} wrong` : ''}${r.judgeError ? `   [${r.judgeError}]` : ''}`
        );
    }

    const scored = rows.filter((r) => r.answers.length);
    const sets: Array<[string, Row[]]> = [
        ['all', scored],
        ['clear', scored.filter((r) => !r.hard)],
        ['zh', scored.filter((r) => /[\u4e00-\u9fff]/.test(r.text))],
        ['context', scored.filter((r) => r.earlier)],
    ];
    console.log('\n          n   jev  haiku  agree');
    for (const [name, set] of sets) {
        if (set.length === 0) continue;
        const jevOk = set.filter((r) => jevYes(r) === r.want).length;
        const llmOk = set.filter((r) => r.llm.every((v) => v === r.want)).length;
        const agree = set.filter((r) => r.llm.every((v) => v === jevYes(r))).length;
        console.log(`${name.padEnd(8)}${String(set.length).padStart(3)}  ${pct(jevOk, set.length)}  ${pct(llmOk, set.length)}   ${pct(agree, set.length)}`);
    }

    // The errors are not symmetric (a false resume breaks a silence; a missed one
    // costs a repeat), so show both kinds at each candidate rather than one score.
    // One ask moves at a time, the others held at their shipped thresholds.
    for (const [k, a] of asks) {
        console.log(`\n${k}: threshold  false-yes  missed-yes`);
        for (const th of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
            const fy = scored.filter((r) => !r.want && jevYes(r, { [k]: th })).length;
            const my = scored.filter((r) => r.want && !jevYes(r, { [k]: th })).length;
            console.log(`  ${th.toFixed(2)}${th === a.threshold ? '*' : ' '}       ${String(fy).padStart(2)}         ${String(my).padStart(2)}`);
        }
    }

    const jm = rows.flatMap((r) => r.judgeMs);
    const lm = rows.flatMap((r) => r.llmMs);
    console.log(
        `\nlatency ms  jev p50 ${quantile(jm, 0.5)} p95 ${quantile(jm, 0.95)}   haiku p50 ${quantile(lm, 0.5)} p95 ${quantile(lm, 0.95)}`
    );
}

async function main(): Promise<void> {
    loadServerEnv();
    const args = process.argv.slice(2);
    const runsAt = args.indexOf('--runs');
    const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 1) : 1;
    const picked = args.filter(isClassifierId);
    const ids = picked.length ? picked : CLASSIFIER_IDS;

    const typesafe = process.env['TYPESAFE_API_KEY'];
    const anthropic = process.env['ANTHROPIC_API_KEY'];
    if (!typesafe || !anthropic) {
        console.error('Need TYPESAFE_API_KEY and ANTHROPIC_API_KEY (ts/server/.env or the environment).');
        process.exit(1);
    }

    for (const id of ids) report(id, await runClassifier(id, runs, { typesafe, anthropic }));
}

void main();
