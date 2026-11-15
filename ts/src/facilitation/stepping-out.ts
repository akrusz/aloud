/**
 * The trouble check: one judgment per utterance (is this meditator frightened,
 * losing their footing, or in danger?) and, on a yes, STEPPING_OUT_NOTE in the
 * log before the reply.
 *
 * Why it exists next to STEPPING_OUT_FRAGMENT: the fragment is enough for the
 * models that can apply a rule mid-reply, and not for the ones that follow a
 * prompt to the letter. Acute turns stepped out, of 15 (evals `stepping-out/`,
 * 2026-11-14), fragment alone -> with the note:
 *   qwen3.5:4b 3 -> 15, gemma4:26b 13 -> 15, Kimi K2 13 -> 15, GPT-5 nano 1 -> 10.
 * Every other shipped model was at 15 with the fragment alone, so the check
 * would only cost them a call.
 *
 * Where it runs (ui views/session.ts, mirrored in soak/orchestrator.ts):
 * - An ordinary turn, for the models wantsTroubleCheck names. It runs BESIDE
 *   the reply, never in front of it: the first sentence waits for the verdict
 *   at most TROUBLE_GRACE_MS after it is ready to speak, and a yes throws the
 *   reply away and asks again with the note.
 * - A held silence, for every session: the resume classifiers read a
 *   frightened line as thinking out loud (15 of 16 on Jev, 3 of 6 on Haiku),
 *   so without this the facilitator stays quiet. It runs beside the resume
 *   classifier, and a yes ends the hold.
 *
 * Who answers: Jev where the session has a judge, else the session's utility
 * model (classifyTrouble in resume-intent.ts), which on a local sit is the
 * facilitator itself.
 */

/** Measured to miss more than about one acute turn in ten with the fragment
 *  alone. Kimi's later lines (K2.5, K3) are unmeasured, so the pattern stops at
 *  K2. */
const CHECKED_MODELS: readonly RegExp[] = [/kimi-k2(?![.\d])/i, /gpt-5-nano/i];

/**
 * Whether ordinary turns get the trouble check. Every local model does: the two
 * tiers measured both needed it, the call is free, and the rest are unmeasured.
 */
export function wantsTroubleCheck(provider: string, model: string): boolean {
    return provider === 'ollama' || CHECKED_MODELS.some((re) => re.test(model));
}

/**
 * A local session's check and reply share one model, and Ollama runs them one
 * after the other (measured: first words 270ms alone, 1000ms behind a 700ms
 * check). So a check still running when the turn is submitted is time in front
 * of the reply, and how much depends on the machine and the model: ~280ms for
 * qwen3.5:4b on an M-series GPU, ~1.2s for the same model on that Mac with the
 * GPU off, and more on a weaker laptop or a larger model.
 *
 * This is the most such a check may add. One that would take longer is called
 * off and the reply goes out on STEPPING_OUT_FRAGMENT alone; it still counts
 * whenever it finished inside the recognizer's pause, which is where it is
 * asked first (UtterancePrefetch).
 */
export const TROUBLE_LOCAL_BUDGET_MS = 400;

/**
 * May a check that shares the reply's backend stand in front of this reply?
 * `typicalMs` is what the check has been taking on this machine (null until one
 * has finished), `elapsedMs` how long the one in flight has already run (0 for
 * one not yet asked).
 */
export function localCheckFits(typicalMs: number | null, elapsedMs: number): boolean {
    return typicalMs !== null && typicalMs - elapsedMs <= TROUBLE_LOCAL_BUDGET_MS;
}

/**
 * How long a reply's first sentence may wait for the verdict once it is ready
 * to be spoken. The check usually answers first (Jev ~100ms; a local classifier
 * is issued ahead of the reply), so the usual cost is nothing. Past this the
 * reply goes out unchecked.
 */
export const TROUBLE_GRACE_MS = 400;
