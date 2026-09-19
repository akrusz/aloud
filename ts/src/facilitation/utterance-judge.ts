/**
 * Typed-judgment fast path for the silence classifiers (v36y).
 *
 * resume-intent.ts asks an LLM for YES/NO and parses a word. A judgment model
 * (TypeSafe's Jev) answers the same question as a calibrated probability in
 * ~140ms against Haiku's ~500. The questions live here, beside the prompts they
 * mirror, so the pair gets tuned together; aloud cloud imports them and the
 * client only ever names a classifier, so /cloud/v1/judge can't be driven as an
 * open Jev proxy.
 *
 * Thresholds come from `npm run jev:ab`, not intuition - rerun it after touching
 * a question. On `resume` think-out-loud scores under 0.2 and a real call back
 * over 0.55, so 0.5 sits in the gap; raising it "to be safe" only misses call
 * backs (0.85 missed a third of them and bought no fewer false resumes). The
 * wording matters more than the number: asking whether they are addressing the
 * facilitator AND asking it to speak scored "I think I'm done sitting quietly"
 * at 0.25, because it is only one of the two.
 *
 * Hosted sessions only. BYOK, Ollama and the desktop-local path have no server
 * to hold the key and keep the LLM classifier.
 */

export type ClassifierId = 'resume' | 'hold-confirm' | 'hold-request';

export const CLASSIFIER_IDS: readonly ClassifierId[] = ['resume', 'hold-confirm', 'hold-request'];

export function isClassifierId(v: unknown): v is ClassifierId {
    return typeof v === 'string' && (CLASSIFIER_IDS as readonly string[]).includes(v);
}

/** One side of a noul question, in the contrastive shape Jev's guide asks for. */
export interface JudgeCriterion {
    what: string;
    not_for?: string;
    examples: string[];
}

export interface JudgeQuestion {
    type: 'noul';
    instructions: { question: string; inspect: string; focus: string };
    criteria: { true: JudgeCriterion; false: JudgeCriterion };
}

export interface JudgeSpec {
    /** What the app knows and the model doesn't; rides in `state.situation`. */
    situation: string;
    question: JudgeQuestion;
    /** P(yes) at or above this reads as yes. */
    threshold: number;
}

/**
 * Examples are the ones in the matching *_SYSTEM_PROMPT (prompts.ts), zh anchors
 * included. "Let's keep going" is a yes for `resume` and a no for
 * `hold-request` on purpose: same words, opposite sides of the silence.
 */
export const JUDGE_SPECS: Readonly<Record<ClassifierId, JudgeSpec>> = {
    resume: {
        situation:
            'The meditator asked their meditation facilitator to stay silent. They are now ' +
            'thinking out loud, and the facilitator stays quiet unless clearly called back.',
        question: {
            type: 'noul',
            instructions: {
                question:
                    'Is the meditator calling the facilitator back, either by speaking to it directly ' +
                    'or by saying they are finished with the silence?',
                inspect: '`utterance`',
                focus:
                    'Who the words are for. Describing experience, narrating, wondering, reacting or ' +
                    'working something out aloud is not a call back, however substantive or ' +
                    'conversational it sounds.',
            },
            criteria: {
                true: {
                    what:
                        'Anything said TO the facilitator (a question, request or greeting aimed at it), ' +
                        'or a plain statement that they are done with the quiet and ready to go on.',
                    examples: [
                        "Okay, I'm back.",
                        "Let's keep going.",
                        'You can talk now.',
                        'What do you think about that?',
                        "I'd like to pick up where we left off.",
                        '好了,我回来了。',
                        '你可以说话了。',
                        '你觉得刚才那个怎么样?',
                    ],
                },
                false: {
                    what:
                        'Thinking out loud: sensations, feelings, insights, reactions. Also narrating ' +
                        'another recording, practice or teacher they are following.',
                    not_for: 'A direct question or request aimed at the facilitator.',
                    examples: [
                        "There's a warmth in my chest.",
                        'Hm. Interesting.',
                        "I think there's something about not wanting to be seen.",
                        'Part of me wants to run away from this feeling.',
                        "Okay, so now she's telling me to scan down my body.",
                        "That's interesting, it moved when I looked at it.",
                        '胸口有一种暖暖的感觉。',
                        '有点意思,我一看它就动了。',
                    ],
                },
            },
        },
        threshold: 0.5,
    },
    'hold-confirm': {
        situation:
            'The meditation facilitator just asked the meditator whether they would like it to be ' +
            'quiet for a while. This is their reply.',
        question: {
            type: 'noul',
            instructions: {
                question: 'Is the meditator agreeing to the silence?',
                inspect: '`utterance`',
                focus: 'Whether they want quiet now, not whether they sound agreeable in general.',
            },
            criteria: {
                true: {
                    what: 'A clear yes to being left in quiet.',
                    examples: ['Yes, please.', 'Some quiet would be nice.', '好的,安静一会儿吧。'],
                },
                false: {
                    what: 'Declining, carrying on talking about their experience, or confusion at the offer.',
                    examples: [
                        'No, keep talking to me.',
                        'What? No, I was just thinking out loud.',
                        '不用,继续陪我说话。',
                    ],
                },
            },
        },
        threshold: 0.7,
    },
    'hold-request': {
        situation:
            'The meditation facilitator has just started speaking again after a period of silence ' +
            'the meditator had asked for. This is the next thing the meditator says.',
        question: {
            type: 'noul',
            instructions: {
                question: 'Is the meditator asking the facilitator to go back to being quiet?',
                inspect: '`utterance`',
                focus:
                    'A request for silence, including saying the facilitator spoke by mistake: that it ' +
                    'misread them and they were not calling it back.',
            },
            criteria: {
                true: {
                    what: 'A clear request for silence, or telling the facilitator they were not talking to it.',
                    examples: [
                        'No, stay quiet.',
                        "Please, I wasn't done - keep holding the silence.",
                        'Shh, not yet.',
                        "Sorry, I wasn't talking to you.",
                        '别说话,再安静一会儿。',
                        '不好意思,我不是在跟你说话。',
                    ],
                },
                false: {
                    what: 'Describing their experience, answering the facilitator, or carrying on the session.',
                    not_for: 'Any wish for the facilitator to stop talking.',
                    examples: [
                        "There's a tightness in my chest.",
                        "Yes, that's exactly it.",
                        'Sorry, what was that?',
                        "Let's keep going.",
                        'I was just thinking out loud.',
                        '嗯,就是这样。',
                    ],
                },
            },
        },
        threshold: 0.7,
    },
};

/** The request `state` for one utterance. */
export function judgeState(id: ClassifierId, utterance: string): { situation: string; utterance: string } {
    return { situation: JUDGE_SPECS[id].situation, utterance };
}

/**
 * Answers one classifier with P(yes) in 0..1. Rejects on any failure; the
 * caller falls back to the LLM classifier, so an implementation should fail
 * fast rather than retry.
 */
export interface UtteranceJudge {
    judge(id: ClassifierId, utterance: string): Promise<number>;
}

/**
 * - `decide` - the judge's probability is the verdict; the LLM runs only if the
 *              judge fails.
 * - `shadow` - the LLM decides as before and the judge runs alongside, for
 *              measuring agreement without changing a session.
 */
export type JudgeMode = 'decide' | 'shadow';

/** One classification, as reported to `onJudged`. Absent sides didn't run. */
export interface JudgeReport {
    classifier: ClassifierId;
    mode: JudgeMode;
    threshold: number;
    /** The verdict the session acted on. */
    verdict: 'yes' | 'no' | 'error';
    judge?: { p: number; verdict: 'yes' | 'no'; latencyMs: number } | { error: string; latencyMs: number };
    llm?: { verdict: 'yes' | 'no' | 'error'; latencyMs: number };
}
