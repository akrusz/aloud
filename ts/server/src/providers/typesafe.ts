/**
 * TypeSafe "system one" client: typed questions over a state, answered as
 * calibrated probabilities (https://docs.typesafe.ai/api). Only the noul
 * (yes/no) shape is used here; routes/judge.ts owns which questions get asked.
 * Questions in one request run in parallel upstream, so several cost one round
 * trip.
 */

import type { JudgeQuestion } from '@aloud/core/facilitation';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export const JEV_MODEL = 'jev-latest';

/** $42 per billion input tokens; output is free (docs.typesafe.ai/models). */
export const JEV_USD_PER_INPUT_TOKEN = 42 / 1e9;

/**
 * A healthy call is ~150ms (p95 ~300). The meditator is waiting on the verdict
 * and every caller has somewhere to go without it (the LLM classifier, or "not a
 * command"), so a slow judge has to lose quickly: 4x the p95, then give up.
 */
const JEV_TIMEOUT_MS = 1200;

export interface NoulResult {
    /** P(yes), 0..1, per question key. */
    answers: Record<string, number>;
    /** The concrete version behind the alias, e.g. "jev-1.13.0". */
    model: string;
    inputTokens: number;
}

interface SystemOneResponse {
    model?: string;
    answers?: Record<string, { type?: string; noul?: number }>;
    usage?: { input_tokens?: number; output_tokens?: number };
}

/** Ask a set of noul questions about one state. Throws on any non-200,
 *  timeout, or a missing/malformed answer; no retry - see JEV_TIMEOUT_MS. */
export async function askNouls(
    apiKey: string,
    state: unknown,
    questions: Record<string, JudgeQuestion>,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<NoulResult> {
    const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ state, model: JEV_MODEL, questions }),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!res.ok) {
        // 422 bodies name the offending field, which is the only way to debug a
        // question shape the API rejects. They describe our question, not the
        // utterance, so they're safe to log.
        const detail = await res.text().catch(() => '');
        throw new Error(`typesafe ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as SystemOneResponse;
    const answers: Record<string, number> = {};
    for (const key of Object.keys(questions)) {
        const p = data.answers?.[key]?.noul;
        if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
            throw new Error(`typesafe: no noul answer for ${key}`);
        }
        answers[key] = p;
    }
    return { answers, model: data.model ?? JEV_MODEL, inputTokens: data.usage?.input_tokens ?? 0 };
}
