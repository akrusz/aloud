/**
 * Resume-context construction for continuing a saved session.
 *
 * Continuing a session replays prior turns into the model's context. For a long
 * session that's expensive — the whole transcript is re-sent against a cold
 * prompt cache (no warm anchor survives across a save/reload), billed at full
 * input. Summary-based resume seeds the model from the stored recap + the last
 * few exchanges instead, so continuity costs a few cents rather than a full
 * re-prime. The UI still renders the entire prior transcript; this only governs
 * what the model receives.
 */

import type { SessionState } from './session.js';

/** Only compress when the prior session is longer than this many messages — a
 *  short one replays whole for almost nothing. */
export const RESUME_COMPRESS_OVER = 12;
/** When compressing, keep this many of the most recent messages verbatim (the
 *  live thread); everything earlier is represented by the recap. */
export const RESUME_RECENT_KEEP = 6;

export interface ResumeMessage {
    role: 'user' | 'assistant';
    content: string;
}

/**
 * Build the context fed to the model when continuing `prior`. With
 * `useSummary` on (the default setting) and a long enough prior session that
 * carries a recap (`prior.notes`), returns the recap + the last
 * RESUME_RECENT_KEEP messages. Otherwise (short session, no recap, or the
 * setting off) returns the full transcript.
 */
export function buildResumeContext(prior: SessionState, useSummary: boolean): ResumeMessage[] {
    const exchanges: ResumeMessage[] = prior.exchanges.map((e) => ({
        role: e.role,
        content: e.content,
    }));
    const recap = prior.notes?.trim() ?? '';
    if (!useSummary || !recap || exchanges.length <= RESUME_COMPRESS_OVER) {
        return exchanges;
    }
    return [
        { role: 'assistant', content: `[Continuing from a previous session. Recap: ${recap}]` },
        ...exchanges.slice(-RESUME_RECENT_KEEP),
    ];
}
