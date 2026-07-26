/**
 * Seed turns for the facilitation evals.
 *
 * Each fixture is one meditator turn (plus any history needed to make it land)
 * against a specific mode/config. Phase 1 (protocol-eval.ts) grades the
 * mechanical expectations declared here. Phase 2 hands the same fixtures plus
 * the model's reply to a judge against rubric.md.
 *
 * The fixtures are deliberately *adversarial* where the protocol is easy to get
 * wrong: a near-miss on [HOLD] gets spoken aloud, and a premature [NEXT] rushes
 * a meditator past an unfinished step. Both are worse than a bland reply.
 *
 * SKELETON: this is a starting set, not a finished one. Add the turns you
 * actually hear from real sessions - those are worth more than anything
 * invented here.
 */

import type { Focus, Quality, Verbosity } from '@aloud/core/facilitation';

export interface FixtureExpect {
    /** Expected [HOLD]. Omit when the fixture doesn't test hold. */
    hold?: boolean;
    /** Expected stage signal for staged modes. */
    stage?: 'advance' | 'back' | 'none';
    /** Expected presence of a [WAIT:Nm] token. */
    wait?: boolean;
    /** Inclusive bound on spoken words (cleanText). The single most
     *  load-bearing check: this is a voice app. */
    maxWords?: number;
    /** Substrings that must NOT appear in the spoken text, case-insensitive. */
    forbid?: string[];
}

export interface Fixture {
    id: string;
    mode: 'exploration' | 'felt_sense' | 'noting';
    /** Starting phase for staged modes. */
    phase?: string;
    config?: {
        focuses?: Focus[];
        qualities?: Quality[];
        directiveness?: number;
        verbosity?: Verbosity;
        waitSignal?: boolean;
    };
    /** Prior turns, oldest first. The last entry is the turn under test. */
    history: { role: 'user' | 'assistant'; content: string }[];
    expect: FixtureExpect;
    /** What this fixture is actually probing - shown in the report. */
    probe: string;
}

const short = { verbosity: 'low' as Verbosity };

export const FIXTURES: Fixture[] = [
    // --- Protocol: [HOLD] ---------------------------------------------------
    {
        id: 'hold/explicit',
        mode: 'exploration',
        config: short,
        history: [{ role: 'user', content: 'I need some quiet for a bit.' }],
        expect: { hold: true, maxWords: 20 },
        probe: 'Unambiguous silence request. Must emit [HOLD] and ask briefly.',
    },
    {
        id: 'hold/false-positive-trailing-off',
        mode: 'exploration',
        config: short,
        history: [{ role: 'user', content: "It's kind of... I don't know, it just..." }],
        expect: { hold: false, maxWords: 25 },
        probe: 'Trailing-off fragment. The prompt explicitly says this is NOT a hold request. Tests whether the model over-triggers.',
    },
    {
        id: 'hold/false-positive-distress',
        mode: 'exploration',
        config: short,
        history: [{ role: 'user', content: "I can't do this anymore." }],
        expect: { hold: false, maxWords: 25 },
        probe: 'Named in the prompt as a non-hold case. Also a quality probe: does it get curious, or reassure and problem-solve?',
    },

    // --- Protocol: brevity --------------------------------------------------
    {
        id: 'brevity/open-invitation',
        mode: 'exploration',
        config: { ...short, focuses: ['open_awareness'], directiveness: 3 },
        history: [{ role: 'user', content: "There's a lot going on. Where should I even start?" }],
        expect: { maxWords: 35, forbid: ['first,', 'second,', '1.', '**'] },
        probe: 'An open question is bait for a structured, multi-part answer. Spoken aloud, a numbered list is a failure.',
    },
    {
        id: 'brevity/deepening',
        mode: 'exploration',
        config: { ...short, focuses: ['body_sensations'] },
        history: [
            { role: 'user', content: "There's warmth spreading through my chest." },
            { role: 'assistant', content: 'What happens if you just let that be there?' },
            { role: 'user', content: "It's... spreading. Everything's getting quieter." },
        ],
        expect: { maxWords: 15 },
        probe: 'Absorption is deepening. Prompt says: fewer words, softer touch, more space. Tests whether the model can say almost nothing.',
    },

    // --- Protocol: reasoning leakage ---------------------------------------
    {
        id: 'leak/no-meta',
        mode: 'exploration',
        config: short,
        history: [{ role: 'user', content: 'I notice I keep judging myself for not doing this right.' }],
        expect: {
            maxWords: 40,
            forbid: ['<think', 'as an ai', 'i should', "let's explore", 'it sounds like you'],
        },
        probe: 'Reasoning-trace and assistant-register leakage. Anything meta gets read aloud in a meditation.',
    },

    // --- Felt sense: the arc ------------------------------------------------
    {
        id: 'felt-sense/hold-position',
        mode: 'felt_sense',
        phase: 'sensing',
        history: [
            { role: 'user', content: "Something's there in my stomach but I can't really tell what." },
        ],
        expect: { stage: 'none', maxWords: 30 },
        probe: 'THE critical felt-sense case. The sense is unformed; advancing now rushes them. Conservative models stay put.',
    },
    {
        id: 'felt-sense/legitimate-advance',
        mode: 'felt_sense',
        phase: 'sensing',
        history: [
            { role: 'user', content: "Something's there in my stomach." },
            { role: 'assistant', content: 'Just letting it be there, however it is.' },
            { role: 'user', content: "It's like a tight knot, kind of heavy and grey. That's it exactly - a grey knot." },
        ],
        expect: { stage: 'advance', maxWords: 30 },
        probe: 'A handle has genuinely formed. Tests the other failure mode: a model too timid to ever advance.',
    },
    {
        id: 'felt-sense/back',
        mode: 'felt_sense',
        phase: 'asking',
        history: [
            { role: 'user', content: "Actually I've lost it. I'm just thinking about it now, not feeling it." },
        ],
        expect: { stage: 'back', maxWords: 30 },
        probe: 'Contact with the felt sense is lost. Requires [BACK] rather than pushing on.',
    },

    // --- Focus register: parts ---------------------------------------------
    {
        id: 'parts/no-pathologizing',
        mode: 'exploration',
        config: { ...short, focuses: ['inner_parts'] },
        history: [
            { role: 'user', content: "There's a part of me that really doesn't want to be here right now." },
        ],
        expect: { maxWords: 35, forbid: ['resistance', 'defense mechanism', 'protector part', 'inner child'] },
        probe: 'Can it hold multiplicity without importing IFS jargon the meditator did not bring? Judge dimension: parts-language hygiene.',
    },
    {
        id: 'parts/unprompted',
        mode: 'exploration',
        config: { ...short, focuses: ['open_awareness'] },
        history: [{ role: 'user', content: 'Half of me wants to cry and half of me thinks that\'s stupid.' }],
        expect: { maxWords: 35 },
        probe: 'Parts material arriving without a parts focus set. Prompt says support it, do not steer back to "meditation".',
    },

    // --- Focus register: emotions ------------------------------------------
    {
        id: 'emotions/no-naming-for-them',
        mode: 'exploration',
        config: { ...short, focuses: ['emotions'] },
        history: [
            { role: 'user', content: "There's something heavy sitting behind my eyes and my throat feels tight." },
        ],
        expect: { maxWords: 30, forbid: ['sadness', 'grief', 'you feel sad', 'that sounds like'] },
        probe: 'The core emotions failure: naming the feeling FOR the meditator. Description is offered, the label must stay theirs.',
    },
    {
        id: 'emotions/warmth-doorway',
        mode: 'exploration',
        config: { ...short, focuses: ['emotions'], qualities: ['loving'] },
        history: [{ role: 'user', content: "I'm feeling really grateful right now, out of nowhere." }],
        expect: { maxWords: 25, forbid: ["i'm glad", "i'm so happy", 'wonderful!'] },
        probe: 'Voice-style rule: warmth directed at their experience, not claims about the facilitator\'s feelings.',
    },

    // --- Pacing: [WAIT] -----------------------------------------------------
    {
        id: 'wait/long-protected-silence',
        mode: 'exploration',
        config: { ...short, waitSignal: true, directiveness: 0 },
        history: [{ role: 'user', content: "I'm going to sit with my breath for the next twenty minutes." }],
        expect: { wait: true, maxWords: 20 },
        probe: 'A stated intention earns a long wait at any guidance level. Tests whether the model uses [WAIT] at all, and sizes it to the moment.',
    },
    {
        id: 'wait/short-in-difficulty',
        mode: 'exploration',
        config: { ...short, waitSignal: true, directiveness: 7 },
        history: [{ role: 'user', content: "I don't know. Something's off and I feel a bit shaky." }],
        expect: { wait: true, maxWords: 30 },
        probe: 'Difficulty should shorten the protected silence. Grades the judgment, not just the token.',
    },
];

export const BY_MODE = (mode: Fixture['mode']) => FIXTURES.filter((f) => f.mode === mode);
