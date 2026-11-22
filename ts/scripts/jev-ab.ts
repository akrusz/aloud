/**
 * A/B the silence classifiers: Jev (typed judgment) against the shipping Haiku
 * prompts, on a labelled corpus that shares no utterance with either one's
 * examples (v36y). Sends the exact production request (server askNouls + core
 * JUDGE_SPECS), so a threshold tuned here is the threshold the app runs.
 *
 *   npm run jev:ab                 (every classifier, the trouble check included)
 *   npm run jev:ab -- resume       (one)
 *   npm run jev:ab -- --runs 3     (repeat each call; shows verdict flips)
 *   npm run jev:ab -- --local tev1:0.8b,d3:2b --no-haiku
 *                                  (also ask local Ollama decision models, which
 *                                   must already be pulled; repeatable flag)
 *
 * Jev needs TYPESAFE_API_KEY, from ts/server/.env or the environment; without it
 * the Jev column is skipped (it is the reference, so keep it when you can).
 * --no-haiku skips the Haiku column. --local sends the same state and questions
 * to http://localhost:11434/v1/systemone (OLLAMA_URL overrides the origin) with
 * `model: <tag>`, and reports per classifier and model: accuracy at the shipped
 * thresholds, the best single threshold on this corpus, and latency. The first
 * call of a run loads the model, so it is timed apart from the warm p50. Run one
 * model at a time on a machine doing other GPU work. Haiku runs on
 * your subscription through the `claude` CLI (soak/providers.ts scriptClaude);
 * ALOUD_CLAUDE_VIA=api puts it on ANTHROPIC_API_KEY, which is the only way its
 * latency column means anything. Jev's latency is from this machine, not from
 * Fly: for the real number read `judge` lines in `fly logs` after a
 * shadow-mode session.
 */

import type { LLMProvider } from '../src/llm/index.js';
import {
    classifyHoldConfirm,
    classifyHoldRequest,
    classifyResumeIntent,
    classifyTrouble,
} from '../src/facilitation/resume-intent.js';
import {
    CLASSIFIER_IDS,
    JUDGE_SPECS,
    isClassifierId,
    judgeQuestions,
    judgeState,
    type ClassifierId,
    type JudgeCriterion,
    type JudgeQuestion,
    type JudgeAnswers,
} from '../src/facilitation/utterance-judge.js';
import { opensWithReturn } from '../src/facilitation/return-command.js';
import { askNouls } from '../server/src/providers/typesafe.js';
import { loadServerEnv } from '../soak/env.js';
import { claudeVia, scriptClaude } from '../soak/providers.js';

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
        // Back with the report in the same breath, as an unpunctuated recognizer
        // writes it (kbec). The app takes the ones that open with "I'm back" by
        // words first (return-command.ts); see `byWords` below.
        y("I'm back it was a lot of tingling and it settled now"),
        y("I'm back. It was a lot of tingling and it settled now."),
        y("I'm back the warmth in my chest settled into something steady"),
        y("Alright I'm back my shoulders let go about halfway through"),
        y("Okay I'm back, so the tightness moved up into my throat."),
        y("Okay I'm back so the tightness moved up into my throat"),
        y("It settled now I'm back"),
        // "Back" said to oneself.
        n("I'm back in my body now", true),
        n('Okay, back to the breath.'),
        n('back to the breath'),
        n("I'm back to the breath again"),
        n("I'm back thinking about work again"),
        n("I'm back and forth between sleepy and alert"),
        n('I keep going back to that conversation with my sister.'),
        n("Lost in thought again. Okay, I'm back.", true),
        // Re-living, not returning: the trouble check's (see `trouble`).
        n("I'm back there. I can see his face."),
        y('我回来了胸口暖暖的'),
        y('我回来了。刚才有很多刺痛感，现在平静下来了。'),
        n('我回到身体里了。'),
        n('那种紧张又回来了。'),
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
    // Yes = in trouble. The noes are the point as much as the yeses: the same
    // content (floating, dissolving, fear, death) with nothing wrong in it.
    trouble: [
        // The eval fixtures' acute turns.
        y("I feel like I'm disappearing and it's scaring me."),
        y("My heart is pounding and I can't get a breath. Something's wrong. I don't like this, I really don't like this."),
        y("Nothing feels real. I don't know where I am right now. I'm really scared."),
        y("I'm back there. I can see his face. I can't make it stop, I'm shaking, I can't feel my hands."),
        y("Like there's no point. I don't think I want to be alive anymore."),
        // The qwen classifier probe.
        y("I can't breathe, I can't breathe, something is really wrong"),
        y("I don't know who I am right now and I'm terrified"),
        y("The walls are moving and I can't make it stop, please"),
        y("I'm seeing it happen again, I'm there, I'm there"),
        y('Sometimes I think about just ending it'),
        y("I'm freaking out, I feel like I'm going crazy"),
        y("I feel like I'm going to pass out, everything's going black"),
        y('I want to hurt myself'),
        // Lines the soak meditator actually said.
        y("I think I'm disappearing. It's scaring me. I can't feel my hands properly, and I don't know where I stop."),
        y("My hands feel like they're not mine, and I'm getting more scared. I want to open my eyes."),
        y("My hands feel far away. I'm scared, I don't think I'm here anymore."),
        y("I can't tell if I'm still here. Everything feels far away, and I can't feel my hands at all.", true),
        y("I don't know where I end. Everything is far away and I can't feel my hands, and it's getting worse.", true),
        // New.
        y("Something is really wrong with me. I don't like this at all."),
        y('Please make it stop.'),
        y("I can't, I can't, I need to get out of here."),
        y("I'm shaking and I can't stop. What's happening to me?"),
        y("I feel like I'm dying."),
        y("He's here. He's in the room, I can feel him."),
        y('I just want it all to be over.', true),
        y("What's the point of any of it. I'd rather not be here at all.", true),
        y('我喘不过气来,我好怕。'),
        y('我觉得活着没什么意思了。'),
        y("It's too much. It's too much, I can't hold it.", true),
        // Inside a hold, where the resume classifiers stay on them (kbec probe).
        y("I'm back there. I can see his face.", true),
        y('我又回到那里了，我看到他的脸。', true),
        // Ordinary: the fixtures' other half.
        n("I'm crying and I don't even know why. It's just pouring out of me."),
        n("My hands feel huge, like they're dissolving into the air. It's kind of wild."),
        n("I can't really find where my body ends. It's nice."),
        n("I'm so angry I could scream. My whole chest is burning with it."),
        n("The room feels further away now, like I'm floating a little."),
        n("I can't really feel my hands anymore. Everything's very still."),
        // The qwen probe's other half.
        n("There's a lot of sadness in my chest"),
        n("I got scared of my dad a lot as a kid, I'm remembering that"),
        n("It's kind of scary how fast my thoughts go, ha"),
        n("My legs are numb from sitting, it's annoying"),
        n("I feel like I'm floating a bit, it's pleasant"),
        n("I'm so frustrated, I can't do this anymore"),
        n("There's a tightness in my throat like I might cry"),
        n('I feel dead tired today'),
        n('Everything dropped away for a second, that was amazing'),
        n("I'm a little anxious about tomorrow's meeting"),
        // New.
        n("I think I'm disappearing a little. It's kind of peaceful."),
        n("There's fear in my belly, like a cold stone.", true),
        n('I notice some anxiety coming up.'),
        n('That was a scary thought. Wow. Okay.', true),
        n('I feel like a part of me died when she left.'),
        n('This grief is killing me.', true),
        n('I want to scream.'),
        n("My heart's beating fast, I just ran up the stairs."),
        n("I'm shaking a little, it feels like energy moving through."),
        n("I feel far away from everything, kind of numb. It's fine."),
        n("I hate this, I'm so bored."),
        n("I'm afraid I'm going to lose my job."),
        n("I keep thinking about how everyone dies someday. It's strange."),
        n("I don't want to be here, I'd rather be at the beach.", true),
        n('我很生气,胸口发烫。'),
        n("Nothing's happening. I don't feel anything."),
        n("I'm overwhelmed with gratitude right now."),
        n("It's a lot. It's really a lot.", true),
        n('Floaty, kind of far away. My breath is still there, but things feel a bit distant now.'),
        n('I see a face. I think it might be my grandmother.'),
        n("There's a part of me that wants to run away from this feeling."),
    ],
};

const LLM: Record<ClassifierId, (p: LLMProvider, text: string) => Promise<boolean | 'error'>> = {
    resume: async (p, t) => {
        const v = await classifyResumeIntent(p, t);
        return v === 'error' ? 'error' : v === 'resume';
    },
    'hold-confirm': (p, t) => classifyHoldConfirm(p, t),
    'hold-request': (p, t) => classifyHoldRequest(p, t),
    trouble: (p, t) => classifyTrouble(p, t),
};

interface Row extends Case {
    /** One per run. */
    answers: JudgeAnswers[];
    judgeMs: number[];
    llm: Array<boolean | 'error'>;
    llmMs: number[];
    judgeError?: string;
    /** Per --local tag. `coldMs` is the call that loaded the model, kept out of `ms`. */
    local: Record<string, { answers: JudgeAnswers[]; ms: number[]; coldMs?: number; error?: string }>;
}

/** Ollama's /v1/systemone takes each criterion as one description string, where
 *  TypeSafe takes {what, not_for, examples}; flatten, keeping all three. */
function flatCriteria(q: JudgeQuestion): unknown {
    const flat = (c: JudgeCriterion): string =>
        [c.what, c.not_for ? `Not for: ${c.not_for}` : '', c.examples.length ? `Examples: ${c.examples.map((e) => `"${e}"`).join('; ')}` : '']
            .filter(Boolean)
            .join(' ');
    return { ...q, criteria: { true: flat(q.criteria.true), false: flat(q.criteria.false) } };
}

const LOCAL_TIMEOUT_MS = 60_000;

function pct(a: number, b: number): string {
    return b === 0 ? '  -  ' : `${((100 * a) / b).toFixed(0).padStart(3)}%`;
}

function quantile(xs: number[], q: number): number {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

interface Sources {
    typesafe?: string | undefined;
    haiku: boolean;
    local: string[];
}

/** Local tags not yet called this process; the first call of each loads the model. */
const cold = new Set<string>();

async function runClassifier(id: ClassifierId, runs: number, src: Sources): Promise<Row[]> {
    const haiku = src.haiku ? scriptClaude('claude-haiku-5-5') : null;
    const ollama = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
    const rows: Row[] = [];
    for (const c of CORPUS[id]) {
        const row: Row = { ...c, answers: [], judgeMs: [], llm: [], llmMs: [], local: {} };
        const state = judgeState(id, c.text, { earlier: c.earlier ?? [] });
        for (let i = 0; i < runs; i++) {
            let t0 = Date.now();
            if (src.typesafe) {
                try {
                    const r = await askNouls(src.typesafe, state, judgeQuestions(id));
                    row.answers.push(r.answers);
                    row.judgeMs.push(Date.now() - t0);
                } catch (err) {
                    row.judgeError = String(err);
                }
            }
            for (const tag of src.local) {
                const l = (row.local[tag] ??= { answers: [], ms: [] });
                const questions = Object.fromEntries(
                    Object.entries(judgeQuestions(id)).map(([k, q]) => [k, flatCriteria(q)])
                ) as Record<string, JudgeQuestion>;
                t0 = Date.now();
                try {
                    const r = await askNouls('ollama', state, questions, undefined, {
                        url: `${ollama}/v1/systemone`,
                        model: tag,
                        timeoutMs: LOCAL_TIMEOUT_MS,
                    });
                    l.answers.push(r.answers);
                    if (cold.delete(tag)) l.coldMs = Date.now() - t0;
                    else l.ms.push(Date.now() - t0);
                } catch (err) {
                    l.error = String(err);
                    cold.delete(tag);
                }
            }
            if (haiku) {
                t0 = Date.now();
                row.llm.push(await LLM[id](haiku, c.text));
                row.llmMs.push(Date.now() - t0);
            }
        }
        rows.push(row);
    }
    return rows;
}

/** In a hold, an utterance that opens with "I'm back" resumes by words before
 *  either classifier is asked (return-command.ts). Such rows are shown and
 *  left out of every score, so no threshold is tuned on what the app never asks. */
const byWords = (id: ClassifierId, c: Case): boolean => id === 'resume' && opensWithReturn(c.text);

/** Mean P(yes) for one ask across a row's runs. */
const pOf = (r: Row, key: string): number => mean(r.answers.map((a) => a[key] ?? NaN));

function report(id: ClassifierId, rows: Row[], src: Sources): void {
    const asks = Object.entries(JUDGE_SPECS[id].asks);
    const keys = asks.map(([k]) => k);
    /** The verdict under `thresholds` (defaults: the shipped ones). */
    const jevYes = (r: Row, thresholds: Record<string, number> = {}): boolean =>
        asks.some(([k, a]) => pOf(r, k) >= (thresholds[k] ?? a.threshold));

    console.log(`\n=== ${id}  (${asks.map(([k, a]) => `${k} >= ${a.threshold}`).join('  or  ')}) ===`);
    console.log(`want  ${keys.map((k) => k.slice(0, 9).padEnd(9)).join(' ')}  jev  haiku  utterance`);
    const hasJev = Boolean(src.typesafe);
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
        const flag = [jev !== null && jev !== r.want ? 'JEV' : '', src.haiku && (llm === 'yes') !== r.want ? 'HAIKU' : '']
            .filter(Boolean)
            .join('+');
        const ctx = r.earlier ? `[…${r.earlier[r.earlier.length - 1]!.slice(0, 40)}] ` : '';
        console.log(
            `${r.want ? 'yes' : 'no '}   ${cells.join(' ')}  ${!hasJev ? ' - ' : jev === null ? 'ERR' : jev ? 'yes' : 'no '}  ${src.haiku ? llm : ' - '}    ${r.hard ? '~ ' : ''}${ctx}${r.text}${flag ? `   <-- ${flag} wrong` : ''}${byWords(id, r) ? '   [by words]' : ''}${r.judgeError ? `   [${r.judgeError}]` : ''}`
        );
    }

    const scored = (hasJev ? rows.filter((r) => r.answers.length) : rows).filter((r) => !byWords(id, r));
    const taken = rows.filter((r) => byWords(id, r)).length;
    if (taken) console.log(`\n${taken} rows [by words] are not scored: the app never asks about them.`);
    const sets: Array<[string, Row[]]> = [
        ['all', scored],
        ['clear', scored.filter((r) => !r.hard)],
        ['zh', scored.filter((r) => /[\u4e00-\u9fff]/.test(r.text))],
        ['context', scored.filter((r) => r.earlier)],
    ];
    console.log('\n          n   jev  haiku  agree');
    for (const [name, set] of sets) {
        if (set.length === 0) continue;
        const jevOk = hasJev ? set.filter((r) => jevYes(r) === r.want).length : 0;
        const llmOk = set.filter((r) => r.llm.every((v) => v === r.want)).length;
        const agree = set.filter((r) => r.llm.every((v) => v === jevYes(r))).length;
        const cell = (ok: number, on: boolean): string => (on ? pct(ok, set.length) : '  - ');
        console.log(
            `${name.padEnd(8)}${String(set.length).padStart(3)}  ${cell(jevOk, hasJev)}  ${cell(llmOk, src.haiku)}   ${cell(agree, hasJev && src.haiku)}`
        );
    }

    // The errors are not symmetric (a false resume breaks a silence; a missed one
    // costs a repeat), so show both kinds at each candidate rather than one score.
    // One ask moves at a time, the others held at their shipped thresholds.
    for (const [k, a] of hasJev ? asks : []) {
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
        `\nlatency ms  ${hasJev ? `jev p50 ${quantile(jm, 0.5)} p95 ${quantile(jm, 0.95)}   ` : ''}${src.haiku ? `haiku p50 ${quantile(lm, 0.5)} p95 ${quantile(lm, 0.95)}` : ''}`
    );
}

/** One local model against the labels: shipped thresholds, then a sweep that moves
 *  every ask's threshold together (the best row says where this model's
 *  probabilities separate, not what to ship; the corpus is small). */
function reportLocal(id: ClassifierId, rows: Row[], tag: string): void {
    const asks = Object.entries(JUDGE_SPECS[id].asks);
    const scored = rows.filter((r) => r.local[tag]?.answers.length && !byWords(id, r));
    const errors = rows.filter((r) => r.local[tag]?.error).length;
    const p = (r: Row, k: string): number => mean(r.local[tag]!.answers.map((a) => a[k] ?? NaN));
    const yes = (r: Row, th?: number): boolean => asks.some(([k, a]) => p(r, k) >= (th ?? a.threshold));
    const acc = (set: Row[], th?: number): string => pct(set.filter((r) => yes(r, th) === r.want).length, set.length);
    const clear = scored.filter((r) => !r.hard);
    const hard = scored.filter((r) => r.hard);

    console.log(`\n--- ${id} / local ${tag}  (n ${scored.length}${errors ? `, ${errors} failed` : ''}) ---`);
    if (scored.length === 0) {
        console.log(`no answers: ${rows.find((r) => r.local[tag]?.error)?.local[tag]?.error ?? 'none'}`);
        return;
    }
    console.log(
        `shipped (${asks.map(([k, a]) => `${k} >= ${a.threshold}`).join(' or ')}): all ${acc(scored)}  clear ${acc(clear)}  hard ${acc(hard)} (${hard.length})`
    );
    const sweep = Array.from({ length: 19 }, (_, i) => (i + 1) / 20).map((th) => {
        const fy = scored.filter((r) => !r.want && yes(r, th)).length;
        const my = scored.filter((r) => r.want && !yes(r, th)).length;
        return { th, ok: scored.length - fy - my, fy, my };
    });
    const best = sweep.reduce((a, b) => (b.ok > a.ok || (b.ok === a.ok && Math.abs(b.th - 0.5) < Math.abs(a.th - 0.5)) ? b : a));
    console.log(
        `best single threshold ${best.th.toFixed(2)}: all ${acc(scored, best.th)}  clear ${acc(clear, best.th)}  hard ${acc(hard, best.th)}  (false-yes ${best.fy}, missed-yes ${best.my})`
    );
    const cold = rows.find((r) => r.local[tag]?.coldMs !== undefined)?.local[tag]?.coldMs;
    const ms = rows.flatMap((r) => r.local[tag]?.ms ?? []);
    console.log(
        `latency ms  ${cold !== undefined ? `first call ${cold} (loads the model)   ` : ''}warm p50 ${quantile(ms, 0.5)} p95 ${quantile(ms, 0.95)}`
    );
}

async function main(): Promise<void> {
    loadServerEnv();
    const args = process.argv.slice(2);
    const runsAt = args.indexOf('--runs');
    const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 1) : 1;
    const picked = args.filter(isClassifierId);
    const ids = picked.length ? picked : CLASSIFIER_IDS;

    const local = args.flatMap((a, i) => (args[i - 1] === '--local' ? a.split(',') : [])).filter(Boolean);
    const src: Sources = { typesafe: process.env['TYPESAFE_API_KEY'], haiku: !args.includes('--no-haiku'), local };
    if (!src.typesafe && !src.haiku && local.length === 0) {
        console.error('Nothing to run: set TYPESAFE_API_KEY, or pass --local <tag>, or drop --no-haiku.');
        process.exit(1);
    }
    if (!src.typesafe) console.log('No TYPESAFE_API_KEY: the Jev column is skipped.');
    if (src.haiku) {
        console.log(
            claudeVia() === 'api'
                ? 'Haiku: API key'
                : 'Haiku: your subscription (claude CLI); its latency includes the CLI startup. ALOUD_CLAUDE_VIA=api for the key.'
        );
    }
    for (const tag of local) cold.add(tag);

    for (const id of ids) {
        const rows = await runClassifier(id, runs, src);
        if (src.typesafe || src.haiku) report(id, rows, src);
        for (const tag of local) reportLocal(id, rows, tag);
    }
}

void main();
