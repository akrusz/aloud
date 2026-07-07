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
 *
 * The recap itself is always generated at session end (it's the history label
 * too, and cheap — Haiku). This module only decides whether to *use* it in
 * place of the full transcript on resume, and that's gated purely on size: a
 * short or medium session replays whole (more faithful, and negligible cost);
 * only a genuinely large transcript is worth compressing to the recap.
 */

import type { SessionState } from './session.js';

/**
 * Only compress when the prior transcript exceeds this many characters of
 * conversation text. Measured in raw text (not turn count) because that's what
 * actually drives the reload cost — one long facilitator turn can outweigh a
 * dozen short exchanges. Set high on purpose: replaying in full is faithful and
 * nearly free until a session gets genuinely large, so compression is reserved
 * for the long-session / continue-repeatedly case it exists to serve. Roughly
 * ~2k tokens of transcript. Tune here — it's the single knob.
 */
export const RESUME_COMPRESS_CHARS = 10000;
/** When compressing, keep this many of the most recent messages verbatim (the
 *  live thread); everything earlier is represented by the recap. */
export const RESUME_RECENT_KEEP = 6;

export interface ResumeMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ResumeContextOptions {
    /** Display name of the model that facilitated the PRIOR session (from
     *  `SessionState.model`). When it differs from the model now taking over,
     *  a short note is prepended so the new facilitator knows who came before. */
    priorModelLabel?: string;
    /** Display name of the model facilitating THIS (resumed) session. Compared
     *  against `priorModelLabel` to decide whether to add the hand-off note. */
    currentModelLabel?: string;
}

/** Total characters of conversation text across all exchanges. */
function transcriptChars(exchanges: ResumeMessage[]): number {
    return exchanges.reduce((n, e) => n + e.content.length, 0);
}

/**
 * Build the context fed to the model when continuing `prior`. With
 * `useSummary` on (the default setting), a stored recap, and a prior transcript
 * larger than RESUME_COMPRESS_CHARS, returns the recap + the last
 * RESUME_RECENT_KEEP messages. Otherwise (short/medium session, no recap, or the
 * setting off) returns the full transcript.
 *
 * Independently of compression, when a *different* model is picking the session
 * up (`opts.priorModelLabel` differs from `opts.currentModelLabel`), a brief
 * hand-off note is added so the new facilitator knows who ran the earlier part.
 */
export function buildResumeContext(
    prior: SessionState,
    useSummary: boolean,
    opts: ResumeContextOptions = {}
): ResumeMessage[] {
    const exchanges: ResumeMessage[] = prior.exchanges.map((e) => ({
        role: e.role,
        content: e.content,
    }));
    const recap = prior.notes?.trim() ?? '';
    const compress = useSummary && !!recap && transcriptChars(exchanges) > RESUME_COMPRESS_CHARS;

    const priorLabel = opts.priorModelLabel?.trim() ?? '';
    const currentLabel = opts.currentModelLabel?.trim() ?? '';
    const handedOff = priorLabel !== '' && priorLabel !== currentLabel;

    if (compress) {
        const who = handedOff ? ` facilitated by ${priorLabel}` : '';
        return [
            {
                role: 'assistant',
                content: `[Continuing from a previous session${who}. Recap: ${recap}]`,
            },
            ...exchanges.slice(-RESUME_RECENT_KEEP),
        ];
    }

    if (handedOff) {
        return [
            {
                role: 'assistant',
                content: `[Continuing a session that was previously facilitated by ${priorLabel}.]`,
            },
            ...exchanges,
        ];
    }
    return exchanges;
}
