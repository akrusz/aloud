/**
 * The prompt-cache invariant (meditation-pal-8qai): every request a sit makes
 * begins byte-for-byte with the one before it, so each turn reads the prefix
 * from cache instead of re-billing it. A feature that edits the system prompt
 * mid-sit, drops a one-shot message it sent, or rewrites an earlier entry
 * fails here instead of on the invoice.
 *
 * Drives the soak orchestrator (the live wiring, on a fake clock) against a
 * real AnthropicProvider whose fetch records each request body.
 */

import { describe, expect, it } from 'vitest';

import { AnthropicProvider } from '../src/llm/anthropic.js';
import type { CompletionResult, LLMProvider, Message } from '../src/llm/index.js';
import { runSoakSession } from '../soak/orchestrator.js';
import type { SimAction, SimUser, SimView } from '../soak/sim-user.js';
import type { Scenario } from '../soak/types.js';
import { isSyntheticEventTurn } from '../src/facilitation/index.js';

interface WireMessage {
    role: string;
    content: string | Array<{ type: string; text: string; cache_control?: unknown }>;
}

interface WireBody {
    system?: Array<{ type: string; text: string }>;
    messages: WireMessage[];
}

/** A message as the cache sees its content: cache_control markers move turn
 *  to turn by design, and a one-block array is the same text as a string. */
function plain(m: WireMessage): { role: string; text: string } {
    return {
        role: m.role,
        text: typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join(''),
    };
}

function startsWith<T>(whole: readonly T[], prefix: readonly T[]): boolean {
    if (prefix.length > whole.length) return false;
    return prefix.every((p, i) => JSON.stringify(p) === JSON.stringify(whole[i]));
}

function lastSpokenText(body: WireBody): string {
    for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = plain(body.messages[i]!);
        if (m.role === 'user' && !m.text.startsWith('<system-reminder>')) return m.text;
    }
    return '';
}

/** A facilitator on the real Anthropic request builder, replying from a
 *  script: event turns get their own replies, everything else takes the next
 *  scripted turn. */
function recordingFacilitator(model: string, script: {
    turns: string[];
    checkins: string[];
}): { provider: LLMProvider; bodies: WireBody[] } {
    const bodies: WireBody[] = [];
    const turns = [...script.turns];
    const checkins = [...script.checkins];
    const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(init!.body as string) as WireBody;
        bodies.push(body);
        const last = lastSpokenText(body);
        const text = last.startsWith('[Check-in:')
            ? (checkins.shift() ?? '[PASS]')
            : last.startsWith('[Timer:')
              ? 'Our time is nearly done.'
              : (turns.shift() ?? 'Mm. Stay with that.');
        return new Response(
            JSON.stringify({
                content: [{ type: 'text', text }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        );
    };
    const provider = new AnthropicProvider({ apiKey: 'k', model, fetchImpl: fetchImpl as typeof fetch });
    return { provider, bodies };
}

const utilityStub: LLMProvider = {
    model: 'utility-stub',
    async complete(messages: Message[]): Promise<CompletionResult> {
        const text = messages[messages.length - 1]?.content ?? '';
        return {
            text: /\b(yes|yeah|ready|continue|back)\b/i.test(text) ? 'YES' : 'NO',
            finishReason: 'stop',
            tokensUsed: null,
        };
    },
};

class ScriptedSimUser implements SimUser {
    private readonly actions: SimAction[];
    constructor(actions: Array<Partial<SimAction> & { waitSec: number }>) {
        this.actions = actions.map((a) => ({ text: null, end: false, raw: '', ...a }));
    }
    async nextAction(_view: SimView): Promise<SimAction> {
        return this.actions.shift() ?? { waitSec: 600, text: null, end: true, raw: '' };
    }
}

const scenario: Scenario = {
    id: 'cache-prefix',
    title: 'cache prefix invariant',
    persona: { id: 'p', description: 'test' },
    modeId: 'felt_sense',
    timerMin: 20,
    fakeMinutes: 30,
};

async function runSit(model: string): Promise<WireBody[]> {
    const { provider, bodies } = recordingFacilitator(model, {
        turns: [
            'Welcome. Let yourself arrive.',
            '[NEXT] Now sense the whole of it in the body.',
            'Mm. Take your time with that.',
            '[NEXT] Is there a word that fits?',
            '[BACK] Let us go back to sensing it as a whole.',
            '[NEXT] See if a word comes now.',
        ],
        // The first check-in passes (never logged), the second speaks.
        checkins: ['[PASS]', 'I am still here with you.'],
    });
    const sim = new ScriptedSimUser([
        { waitSec: 20, text: 'I feel a bit scattered' },
        { waitSec: 30, text: 'there is something heavy in my chest' },
        { waitSec: 30, text: 'it is sort of grey' },
        // A long quiet: check-ins fire (one pass, one spoken).
        { waitSec: 400, text: 'hmm, heavy, maybe stuck' },
        { waitSec: 20, text: 'no that is not quite it' },
        { waitSec: 30, text: 'stuck, yes' },
        { waitSec: 30, end: true },
    ]);
    const result = await runSoakSession({ scenario, facilitator: provider, utility: utilityStub, simUser: sim });
    expect(result.error).toBeUndefined();
    return bodies;
}

describe.each(['claude-fable-5-1', 'claude-sonnet-5'])('prompt-cache prefix invariant (%s)', (model) => {
    it('every request extends the one before it, with one frozen system prompt', async () => {
        const bodies = await runSit(model);
        expect(bodies.length).toBeGreaterThan(6);

        const system = JSON.stringify(bodies[0]!.system);
        for (const b of bodies) expect(JSON.stringify(b.system)).toBe(system);

        for (let i = 1; i < bodies.length; i++) {
            const prev = bodies[i - 1]!.messages.map(plain);
            const next = bodies[i]!.messages.map(plain);
            if (startsWith(next, prev)) continue;
            // The one allowed break: the previous request was a check-in or
            // timer event whose reply was never spoken ([PASS]), so the event
            // was never logged. Everything before it must still hold.
            const prevLast = prev[prev.length - 1]!;
            expect(isSyntheticEventTurn(prevLast.text), `request ${i} broke the prefix`).toBe(true);
            expect(startsWith(next, prev.slice(0, -1)), `request ${i} broke the prefix`).toBe(true);
        }
    });

    it('carries phase moves as notes in the log, never on a cache breakpoint', async () => {
        const bodies = await runSit(model);
        const last = bodies[bodies.length - 1]!;
        const notes = last.messages.map(plain).filter((m) => m.text.includes('Stage note'));
        // The opening phase plus the four moves.
        expect(notes.length).toBe(5);
        const expectedRole = model === 'claude-fable-5-1' ? 'system' : 'user';
        // The last note may still be waiting on its reply; the ones before it
        // sit between a user turn and an assistant turn.
        for (const n of notes.slice(0, -1)) expect(n.role).toBe(expectedRole);
        for (const b of bodies) {
            for (const m of b.messages) {
                if (m.role !== 'system') continue;
                expect(typeof m.content).toBe('string');
            }
        }
        // The first request is the opener: its instruction, then the phase.
        const first = bodies[0]!.messages.map(plain);
        expect(first[0]!.role).toBe('user');
        expect(first[1]!.text).toContain('stage 1 of');
    });
});
