/**
 * What a fixture sends: the system prompt and the session log, built by the
 * real PromptBuilder + StagedModeController rather than a fixture-local copy.
 * An eval whose prompt drifts from the shipped prompt measures nothing.
 *
 * promptHashFor() fingerprints both, so a result measured against an older
 * prompt can be flagged as stale once the prompts change (report.ts).
 *
 * A prompt variant (protocol-eval.ts --variant) is a paragraph appended to the
 * shipped system prompt, to measure a wording before it goes into src/.
 */

import { createHash } from 'node:crypto';

import { PromptBuilder, StagedModeController, getMode } from '../src/facilitation/index.js';
import type { Message } from '../src/llm/index.js';
import type { Fixture } from './fixtures.js';

/** `note`: a variant's text, appended as the system prompt's last paragraph. */
export function systemPromptFor(fx: Fixture, note?: string): string {
    const mode = getMode(fx.mode);
    let stageSection: string | undefined;
    if (mode?.phases) {
        stageSection = new StagedModeController(mode, fx.phase).promptSection();
    }
    const options = { ...(mode && { mode }), ...(fx.config && { config: fx.config }) };
    const shipped = new PromptBuilder(options).buildSystemPrompt(stageSection);
    return note ? `${shipped}\n\n${note}` : shipped;
}

/** The fixture's history as a session log. A staged fixture's phase travels as
 *  a system note, as in a live session; placed after the first user turn, as if
 *  the phase has been in force for the whole excerpt. */
export function messagesFor(fx: Fixture): Message[] {
    const messages: Message[] = fx.history.map((h) => ({ role: h.role, content: h.content }));
    const mode = getMode(fx.mode);
    if (mode?.phases) {
        const note = new StagedModeController(mode, fx.phase).phaseNote();
        const firstUser = messages.findIndex((m) => m.role === 'user');
        messages.splice(firstUser + 1, 0, { role: 'system', content: note });
    }
    return messages;
}

/** 12 hex characters of sha256 over the system prompt and the messages. */
export function promptHash(system: string, messages: readonly Message[]): string {
    return createHash('sha256')
        .update(JSON.stringify({ system, messages }))
        .digest('hex')
        .slice(0, 12);
}

export function promptHashFor(fx: Fixture, note?: string): string {
    return promptHash(systemPromptFor(fx, note), messagesFor(fx));
}
