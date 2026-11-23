/**
 * The session note: the history label and the seed for a cheap resume
 * (resume.ts), hence a couple of sentences, not a few words.
 *
 * A note-writer of its own writes it, not the facilitator: the session goes in
 * one user message as a transcript, under SUMMARY_SYSTEM_PROMPT. Asked inside
 * the live conversation, under the facilitation prompt, Haiku 5.5 declined
 * ("I'm the facilitator, not a logging tool") and after a safety disclosure
 * wrote a crisis-line paragraph that was saved as the note
 * (dev-docs/prompt-writing.md, practice 8).
 */

import type { LLMProvider, Message } from '../llm/index.js';
import type { SessionLanguage } from './language.js';
import { scrubControlTokens } from './modes.js';
import { isControlExchange, llmUsageOf, type ExchangeKind, type LlmUsage } from './session.js';
import { stripThinkTags } from './strip-think-tags.js';

/** The same for every session: what is particular to one (its language)
 *  goes in the user message. */
const SUMMARY_SYSTEM_PROMPT =
    'You write short notes on finished meditation sessions for the private history log of a ' +
    'meditation app. In these sessions the meditator speaks aloud about what they notice in the ' +
    'moment, and a facilitator answers by voice, mostly with brief questions about present ' +
    'experience. You are given the transcript of one session, and you reply with only the note. ' +
    "Don't assume a posture: the meditator may be lying down or walking, so call it a session or " +
    'a meditation, not a sit.';

/**
 * Alex's wording (dev-docs/prompt-writing.md, "Whose words"). `{meditator}` is
 * the transcript's own label for them: told "the meditator" in a 中文 session,
 * GPT-6 Luna let English into the note.
 */
const SUMMARY_USER_PROMPT =
    'The session in the transcript above has ended. Write the private note on it for the ' +
    "meditator's history log - what was explored, where it ended up, and any thread left open " +
    'to pick up later. 2-3 sentences (about 40-60 words), neutral, in the third person. Call ' +
    'them "{meditator}" and do not guess a gender; use "they" only where a pronoun cannot be ' +
    'avoided. Output only the note: no preamble, no questions, no facilitation. Write it in ' +
    "the session's language.";

const SPEAKERS: Record<SessionLanguage, { facilitator: string; meditator: string; callThem: string }> = {
    en: { facilitator: 'Facilitator', meditator: 'Meditator', callThem: 'the meditator' },
    'zh-CN': { facilitator: '引导者', meditator: '冥想者', callThem: '冥想者' },
};

/** The facilitator's own `Exchange.name` in a noting circle. Every other
 *  participant's line carries the participant's name and is left out of the
 *  transcript: given them, both models credited their words to the meditator
 *  (8 of 8), and a label saying whose they were still left some. */
const NOTING_FACILITATOR_NAME = 'Facilitator';

/** Above a noting circle's transcript, which holds only the meditator's lines
 *  and the facilitator's. */
const NOTING_CIRCLE_NOTE: Record<SessionLanguage, string> = {
    en:
        'This session was a noting circle, in which the Meditator says a word or two at a time for ' +
        "what they notice. The circle's other voices are left out of the transcript.",
    'zh-CN': '这次是一个标记圈，冥想者每次用一两个词说出自己注意到的东西。圈中的其他声音没有放进文字记录。',
};

/**
 * Don't spend an LLM call recapping a session that barely started. Below this
 * the caller falls back to the intention (or ""). Counts user turns, not total
 * messages, so the facilitator's opener alone never clears the bar.
 */
const MIN_USER_TURNS_FOR_SUMMARY = 2;

/**
 * A leading meta-label the model sometimes writes despite "output only the
 * recap" (measured on gpt-5-nano: "Brief recap: The meditator explored..."). It
 * goes verbatim into the history label, so strip it.
 *
 * Deliberately a CLOSED vocabulary rather than "any short prefix before a
 * colon": a recap legitimately opens "Today: heaviness in the chest", and a
 * general rule would eat it. Nothing here can appear at the start of a real
 * recap, since the model is writing the note, not announcing it.
 */
const RECAP_LABEL_RE = /^\**\s*(?:brief |short |session )?(?:recap|summary|note to self)\s*\**\s*:\s*\**\s*/i;

export interface GenerateSummaryOptions {
    /** The session's language (SessionState.language, through
     *  sessionLanguageOf): the transcript's speaker labels and what the note
     *  calls the meditator. */
    language: SessionLanguage;
    /** A noting circle (noting-session.ts): says whose lines the note is about. */
    noting?: boolean;
    /** Override the max-tokens hint. Defaults to room for ~2-3 sentences. */
    maxTokens?: number;
    /**
     * Reports this call's off-transcript usage for session usage tracking.
     * Fired only on success; a failed summary made no billable completion.
     */
    onUsage?: (usage: LlmUsage) => void;
}

type SummaryEntry = { role: 'user' | 'assistant' | 'system'; content: string; kind?: ExchangeKind; name?: string };

/**
 * The spoken turns, one per line under their speaker. Of the control entries
 * only resume scaffolding stays, as it was sent: a continued session's recap
 * is the only record the log keeps of the earlier part.
 */
function renderTranscript(entries: ReadonlyArray<SummaryEntry>, language: SessionLanguage): string {
    const speakers = SPEAKERS[language];
    const oneLine = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ');
    const lines: string[] = [];
    for (const e of entries) {
        if (e.kind === 'context') {
            lines.push(oneLine(e.content));
        } else if (isControlExchange(e)) {
            continue;
        } else if (e.role === 'assistant') {
            if (e.name && e.name !== NOTING_FACILITATOR_NAME) continue;
            const text = oneLine(scrubControlTokens(e.content));
            if (text) lines.push(`${speakers.facilitator}: ${text}`);
        } else {
            lines.push(`${speakers.meditator}: ${oneLine(e.content)}`);
        }
    }
    return `<transcript>\n${lines.join('\n\n')}\n</transcript>`;
}

/** The note request: the transcript, then the instruction, so consecutive
 *  recaps of one session share a prefix. */
function summaryRequest(entries: ReadonlyArray<SummaryEntry>, options: GenerateSummaryOptions): Message[] {
    const instruction = SUMMARY_USER_PROMPT.replace('{meditator}', SPEAKERS[options.language].callThem);
    const body = `${renderTranscript(entries, options.language)}\n\n${instruction}`;
    const content = options.noting ? `${NOTING_CIRCLE_NOTE[options.language]}\n\n${body}` : body;
    return [{ role: 'user', content }];
}

/**
 * Generate a short summary for a finished session. Returns "" when the LLM
 * gives nothing usable; never throws, so callers need no try/catch.
 */
export async function generateSessionSummary(
    provider: LLMProvider,
    messages: ReadonlyArray<SummaryEntry>,
    options: GenerateSummaryOptions
): Promise<string> {
    const userTurns = messages.filter((m) => m.role === 'user' && !isControlExchange(m)).length;
    if (userTurns < MIN_USER_TURNS_FOR_SUMMARY) return '';

    try {
        const result = await provider.complete(summaryRequest(messages, options), {
            system: SUMMARY_SYSTEM_PROMPT,
            maxTokens: options.maxTokens ?? 200,
        });
        options.onUsage?.(llmUsageOf(result));
        return stripThinkTags(result.text).trim().replace(RECAP_LABEL_RE, '');
    } catch (err) {
        // A failed recap falls back to the intention/label, indistinguishable
        // from a short-session skip. Surface why.
        console.warn('[summary] generation failed:', err);
        return '';
    }
}
