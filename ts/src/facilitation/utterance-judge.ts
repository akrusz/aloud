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
 * a question. Two things that measurement taught, both on `resume`:
 * - Atomic questions beat one compound one. "Addressing the facilitator AND
 *   asking it to speak" scored "I think I'm done sitting quietly" at 0.25, since
 *   it is only one of the two; "either/or" in a single question still left
 *   hedged call-backs ("I guess I'm ready") under 0.5. Asked separately, each
 *   gets its own examples and its own threshold, and a yes on either is a yes.
 * - A high threshold is not caution. Think-out-loud scores under 0.3 on both
 *   asks, so raising the bar "to be safe" only misses call-backs (0.85 missed a
 *   third of them and bought no fewer false resumes).
 *
 * Hosted sessions only. BYOK, Ollama and the desktop-local path have no server
 * to hold the key and keep the LLM classifier.
 */

import { COMMAND_SPECS } from './voice-command-specs.js';

export type ClassifierId = 'resume' | 'hold-confirm' | 'hold-request';

export const CLASSIFIER_IDS: readonly ClassifierId[] = ['resume', 'hold-confirm', 'hold-request'];

export function isClassifierId(v: unknown): v is ClassifierId {
    return typeof v === 'string' && (CLASSIFIER_IDS as readonly string[]).includes(v);
}

/**
 * Everything /cloud/v1/judge will answer: the three silence classifiers, which
 * have an LLM twin to fall back on, plus the voice-command pair
 * (voice-command.ts), which have none - no judge, no voice commands.
 */
export type JudgeId = ClassifierId | 'command' | 'command-gate' | 'end-confirm';

export function isJudgeId(v: unknown): v is JudgeId {
    return isClassifierId(v) || v === 'command' || v === 'command-gate' || v === 'end-confirm';
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

export interface JudgeAsk {
    question: JudgeQuestion;
    /** P(yes) at or above this reads as yes. */
    threshold: number;
}

export interface JudgeSpec {
    /** What the app knows and the model doesn't; rides in `state.situation`. */
    situation: string;
    /** Sent together in one request and answered in parallel; the verdict is yes
     *  when ANY of them clears its own threshold (judgeVerdict). */
    asks: Readonly<Record<string, JudgeAsk>>;
}

/** P(yes) per ask, keyed like `JudgeSpec.asks`. */
export type JudgeAnswers = Record<string, number>;

const RESUME_STAY_EXAMPLES = [
    "There's a warmth in my chest.",
    'Hm. Interesting.',
    "I think there's something about not wanting to be seen.",
    'Part of me wants to run away from this feeling.',
    "Okay, so now she's telling me to scan down my body.",
    "That's interesting, it moved when I looked at it.",
    '胸口有一种暖暖的感觉。',
    '有点意思,我一看它就动了。',
];

/**
 * Between a classifier's asks, the examples cover every one in the matching
 * *_SYSTEM_PROMPT (prompts.ts), zh anchors included. "Let's keep going" is a yes for `resume` and a no for
 * `hold-request` on purpose: same words, opposite sides of the silence.
 */
const CLASSIFIER_SPECS: Readonly<Record<ClassifierId, JudgeSpec>> = {
    resume: {
        situation:
            'The meditator asked their meditation facilitator to stay silent. They are now ' +
            'thinking out loud, and the facilitator stays quiet unless clearly called back.',
        asks: {
            addressed: {
                question: {
                    type: 'noul',
                    instructions: {
                        question:
                            'Is `utterance` spoken TO the facilitator: a question, request or greeting aimed at it?',
                        inspect: '`utterance`',
                        focus:
                            'Who the words are for, not what they are about. Talking to oneself, to a ' +
                            'feeling, or along with another recording is not addressing the facilitator, ' +
                            'however conversational it sounds.',
                    },
                    criteria: {
                        true: {
                            what: 'A question, request, invitation or greeting aimed at the facilitator.',
                            examples: [
                                'You can talk now.',
                                'What do you think about that?',
                                '你可以说话了。',
                                '你觉得刚才那个怎么样?',
                            ],
                        },
                        false: {
                            what:
                                'Thinking out loud, rhetorical questions, and narrating another recording, ' +
                                'practice or teacher they are following.',
                            examples: RESUME_STAY_EXAMPLES,
                        },
                    },
                },
                threshold: 0.5,
            },
            done: {
                question: {
                    type: 'noul',
                    instructions: {
                        question:
                            'Is the meditator saying they are finished with the silence and ready to go on ' +
                            'with the session?',
                        inspect: '`utterance`',
                        focus:
                            'Tentative wording ("I guess", "I think") still counts when the thing they are ' +
                            'ready for is the session. Use `earlier_in_this_silence` to tell what "ready", ' +
                            '"done" or "enough" refers to: the session, or whatever they were just talking ' +
                            'about. A bare follow-up like "Alright." counts only when they already said they ' +
                            'were ready and nobody answered.',
                    },
                    criteria: {
                        true: {
                            what: 'Done with the quiet; ready to continue with the facilitator.',
                            examples: [
                                "Okay, I'm back.",
                                "Let's keep going.",
                                "I'd like to pick up where we left off.",
                                '好了,我回来了。',
                            ],
                        },
                        false: {
                            what:
                                'Still in it: sensations, feelings, insights, accepting a feeling, or being ' +
                                'ready for something in their life rather than for the session.',
                            examples: RESUME_STAY_EXAMPLES,
                        },
                    },
                },
                // Lower than `addressed`: hedged call-backs land around 0.45-0.6 here
                // and think-out-loud under 0.3, while a stray "Hello?" can reach
                // 0.48 on `addressed`.
                threshold: 0.4,
            },
        },
    },
    'hold-confirm': {
        situation:
            'The meditation facilitator just asked the meditator whether they would like it to be ' +
            'quiet for a while. This is their reply.',
        asks: {
            agrees: {
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
        },
    },
    'hold-request': {
        situation:
            'The meditation facilitator has just started speaking again after a period of silence ' +
            'the meditator had asked for. This is the next thing the meditator says.',
        asks: {
            asks_quiet: {
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
        },
    },
};

export function judgeSpec(id: JudgeId): JudgeSpec {
    return isClassifierId(id) ? CLASSIFIER_SPECS[id] : COMMAND_SPECS[id];
}

/** The silence classifiers' specs. Other ids go through judgeSpec(). */
export const JUDGE_SPECS = CLASSIFIER_SPECS;

/**
 * What the app knows around an utterance. Only `resume` uses it: a hold is the
 * one place several utterances pile up with no reply between them, and the last
 * one often only means something after the ones before ("Alright." after "I
 * guess I'm ready"; "I guess I'm ready" after wondering whether they're ready to
 * forgive someone). The LLM classifiers stay history-free on purpose.
 */
export interface JudgeContext {
    /** Earlier utterances from this same hold, oldest first. */
    earlier?: readonly string[];
}

/** Enough to disambiguate the latest utterance without burying it. */
export const JUDGE_MAX_EARLIER = 6;
export const JUDGE_MAX_EARLIER_CHARS = 1500;

/** The most recent utterances that fit both caps, oldest first. */
export function clampEarlier(earlier: readonly string[] | undefined): string[] {
    const out: string[] = [];
    let chars = 0;
    for (const raw of [...(earlier ?? [])].reverse()) {
        const text = raw.trim();
        if (!text) continue;
        if (out.length >= JUDGE_MAX_EARLIER || chars + text.length > JUDGE_MAX_EARLIER_CHARS) break;
        out.unshift(text);
        chars += text.length;
    }
    return out;
}

export interface JudgeState {
    situation: string;
    earlier_in_this_silence?: string[];
    utterance: string;
}

/** The request `state` for one utterance. */
export function judgeState(id: JudgeId, utterance: string, context: JudgeContext = {}): JudgeState {
    const earlier = id === 'resume' ? clampEarlier(context.earlier) : [];
    return {
        situation: judgeSpec(id).situation,
        ...(earlier.length ? { earlier_in_this_silence: earlier } : {}),
        utterance,
    };
}

/**
 * Yes when any ask clears its threshold. Throws on a missing or non-numeric
 * answer: a partial response is a judge failure (fall back to the LLM), not a no.
 */
export function judgeVerdict(id: JudgeId, answers: JudgeAnswers): 'yes' | 'no' {
    return judgeTop(id, answers) ? 'yes' : 'no';
}

/** The ask that cleared its threshold by the most probability, or null. Same
 *  throw-on-partial rule as judgeVerdict. */
export function judgeTop(id: JudgeId, answers: JudgeAnswers): string | null {
    let top: string | null = null;
    let topP = -1;
    for (const [key, ask] of Object.entries(judgeSpec(id).asks)) {
        const p = answers[key];
        if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error(`judge: no answer for ${id}.${key}`);
        if (p >= ask.threshold && p > topP) {
            top = key;
            topP = p;
        }
    }
    return top;
}

/** The `questions` map for one classifier's request. */
export function judgeQuestions(id: JudgeId): Record<string, JudgeQuestion> {
    return Object.fromEntries(Object.entries(judgeSpec(id).asks).map(([k, a]) => [k, a.question]));
}

/**
 * Answers one classifier's asks with P(yes) each. Rejects on any failure; the
 * caller falls back to the LLM classifier, so an implementation should fail
 * fast rather than retry.
 */
export interface UtteranceJudge {
    judge(id: JudgeId, utterance: string, context?: JudgeContext): Promise<JudgeAnswers>;
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
    /** The verdict the session acted on. */
    verdict: 'yes' | 'no' | 'error';
    judge?: { answers: JudgeAnswers; verdict: 'yes' | 'no'; latencyMs: number } | { error: string; latencyMs: number };
    llm?: { verdict: 'yes' | 'no' | 'error'; latencyMs: number };
}
