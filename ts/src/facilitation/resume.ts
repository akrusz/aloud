/**
 * Resume-context construction for continuing a saved session.
 *
 * Resuming replays prior turns into the model's context, which for a long
 * session means re-sending the whole transcript against a cold prompt cache (no
 * warm anchor survives a save/reload) at full input price. Summary-based resume
 * seeds from the stored recap plus the last few exchanges instead. The UI still
 * renders the entire prior transcript; this governs only what the model gets.
 *
 * The recap is always generated at session end anyway (it doubles as the history
 * label, and Haiku is cheap). This module only decides whether to use it instead
 * of the full transcript, gated purely on size: short and medium sessions replay
 * whole, since that's more faithful and nearly free.
 */

import type { SessionState } from './session.js';

/**
 * Compress only above this many characters of conversation text (~2k tokens).
 * Measured in raw text, not turn count, because text drives the reload cost -
 * one long facilitator turn can outweigh a dozen short exchanges. Set high so
 * compression is reserved for the long-session / continue-repeatedly case.
 * The single tuning knob.
 */
export const RESUME_COMPRESS_CHARS = 10000;
/** When compressing, keep this many recent messages verbatim (the live thread);
 *  everything earlier is represented by the recap. */
export const RESUME_RECENT_KEEP = 6;

export interface ResumeMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ResumeContextOptions {
    /** Model that facilitated the PRIOR session (`SessionState.model`). If it
     *  differs from the current one, a hand-off note is prepended. */
    priorModelLabel?: string;
    /** Model facilitating THIS resumed session. */
    currentModelLabel?: string;
}

/** Total characters of conversation text across all exchanges. */
function transcriptChars(exchanges: ResumeMessage[]): number {
    return exchanges.reduce((n, e) => n + e.content.length, 0);
}

/**
 * Build the context fed to the model when continuing `prior`. With `useSummary`
 * on (the default), a stored recap, and a transcript over RESUME_COMPRESS_CHARS,
 * returns the recap plus the last RESUME_RECENT_KEEP messages; otherwise the
 * full transcript.
 *
 * Independently, when a different model is picking the session up, a brief
 * hand-off note is added so it knows who ran the earlier part.
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
