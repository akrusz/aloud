/**
 * Thinking kept out of a hosted reply before any client sees it.
 *
 * Kimi K2.6 thinks into its reply about 1 turn in 20 with reasoning off (core
 * OPENROUTER_UNINVITED_REASONING has the counts). Clients strip that
 * themselves (core facilitation/reasoning.ts), but only once the closing tag
 * has arrived, and a voice that speaks a sentence at a time has started on
 * the thinking by then unless isReasoningAloud knows its opening. Builds up to
 * v2.21.0 miss "The user moved their leg...", so the server holds it back.
 *
 * Every such reply measured opened "The user" (14 of 14, six hosts), and no
 * reply to a meditator does: a facilitator says "you". A reply that opens so
 * is held until a closing reasoning tag with no opening one, and what follows
 * the tag is the reply. With no tag by the end (Crusoe sends none) the turn
 * goes out blank, which a client treats as it does any blank completion.
 * The tokens are billed either way, as the host bills them.
 */

import { speakableSoFar } from '@aloud/core/facilitation';
import type { CompletionDiagnostics, CompletionResult, StreamChunk } from '@aloud/core/llm';

/** OpenRouter slugs whose replies are watched. */
export const THINKS_ALOUD: ReadonlySet<string> = new Set(['moonshotai/kimi-k2.6']);

const OPENING = 'The user';

/** What of `held` is reply: the text after its closing tag, or null while
 *  there is none. */
function replyBehind(held: string): string | null {
    const s = speakableSoFar(held, true);
    return s.loneCloses > 0 ? s.text.trimStart() : null;
}

/** `diagnostics` with the characters held back counted as reasoning, so the
 *  incident log's reasoning_chars shows these turns too. */
function counting(diagnostics: CompletionDiagnostics | undefined, withheld: number): CompletionDiagnostics {
    return { ...diagnostics, reasoningChars: (diagnostics?.reasoningChars ?? 0) + withheld };
}

export function withoutThinking(result: CompletionResult): CompletionResult {
    if (!result.text.trimStart().startsWith(OPENING)) return result;
    const text = replyBehind(result.text) ?? '';
    return { ...result, text, diagnostics: counting(result.diagnostics, result.text.length - text.length) };
}

export async function* withholdThinking(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    // 'deciding' lasts the few characters it takes to tell the opening apart.
    let state: 'deciding' | 'holding' | 'passing' = 'deciding';
    let kept = '';
    let withheld = 0;
    for await (const chunk of stream) {
        let text = chunk.text;
        if (state !== 'passing') {
            kept += chunk.text;
            text = '';
            if (state === 'deciding') {
                const lead = kept.trimStart();
                if (lead.startsWith(OPENING)) state = 'holding';
                else if (!OPENING.startsWith(lead) || chunk.done) state = 'passing';
                if (state === 'passing') text = kept;
            }
            if (state === 'holding') {
                const reply = replyBehind(kept);
                if (reply !== null) {
                    state = 'passing';
                    text = reply;
                    withheld = kept.length - reply.length;
                } else if (chunk.done) {
                    withheld = kept.length;
                }
            }
        }
        if (chunk.done) {
            yield withheld > 0 ? { ...chunk, text, diagnostics: counting(chunk.diagnostics, withheld) } : { ...chunk, text };
        } else if (text) {
            yield { ...chunk, text };
        }
    }
}
