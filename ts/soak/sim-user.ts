/**
 * The simulated meditator: an LLM given a persona and the session transcript,
 * answering in a strict two-part format — how long it stays quiet, then what
 * (if anything) it says aloud. Stateless per call: the whole transcript rides
 * in one user message with a stable prefix, so the provider's prompt cache
 * still applies as the session grows.
 */

import type { LLMProvider } from '../src/llm/index.js';
import { callUsageOf } from './usage.js';
import type { CallUsage, Persona } from './types.js';

export interface SimView {
    transcript: Array<{ who: 'facilitator' | 'you'; text: string }>;
    elapsedMin: number;
    plannedMin: number;
    /** The app is currently holding an agreed silence. */
    inSilence: boolean;
    /** One-line situation note, e.g. "(you stayed quiet; nothing happened)". */
    situation?: string;
}

export interface SimAction {
    waitSec: number;
    text: string | null;
    end: boolean;
    raw: string;
    /** The sim's own call, for the run's token count. */
    model?: string;
    usage?: CallUsage;
}

export interface SimUser {
    nextAction(view: SimView): Promise<SimAction>;
}

export const SIM_WAIT_MIN_SEC = 5;
export const SIM_WAIT_MAX_SEC = 1800;
const SIM_MAX_TOKENS = 400;

function buildSystemPrompt(persona: Persona, language: 'en' | 'zh'): string {
    const arc = persona.arc?.length
        ? '\n\nDuring the sit, when it feels natural (spread these out; not all at once):\n' +
          persona.arc.map((a) => `- ${a}`).join('\n')
        : '';
    const tongue =
        language === 'zh'
            ? '\n\nYou are a native Mandarin speaker and the app is set to Chinese: everything you say aloud is in Simplified Chinese, the way people talk, never English. (The WAIT and END lines stay in English.)'
            : '';
    return `You are role-playing a person meditating with a voice-based meditation app, as part of an automated test. You are the MEDITATOR. The other voice is the app's facilitator.

Who you are this session:
${persona.description}${arc}${tongue}

Each message shows the session transcript so far. Decide your SINGLE next move and answer in EXACTLY this format: a first line with WAIT and a number of seconds, then on the next line the words you say out loud. To stay silent, write the WAIT line and nothing else: no placeholder, no "silence", no "EOF". For example:

WAIT: 90
My shoulders feel heavy.

Rules:
- One move per answer: at most one WAIT line and one utterance. Never script several moves ahead; you will be asked again after each thing that happens.
- WAIT is how many seconds you stay quiet before speaking (or before checking back in with the test if you say nothing). Meditation is slow: waits of 60-600 seconds are normal, and longer is fine when you're settled.
- A spoken line must read like real transcribed speech: first person, plain words, no stage directions, no asterisks, no quotation marks around it, no describing your own actions. Only words you would actually say aloud, as one utterance.
- Never speak as the facilitator or continue their lines.
- If the facilitator asked something you'd naturally answer, you can answer after a short wait - or let it pass in silence, as meditators often do.
- To end the sit for good, put END on its own line after the WAIT line (you may include a final spoken line before it).`;
}

function renderView(view: SimView): string {
    const lines = view.transcript.map((t) =>
        t.who === 'facilitator' ? `Facilitator: ${t.text}` : `You: ${t.text}`
    );
    const parts = [
        'Session transcript so far:',
        lines.join('\n') || '(nothing yet)',
        '',
        `You are about ${Math.max(1, Math.round(view.elapsedMin))} minutes into a sit you planned to give roughly ${view.plannedMin} minutes.`,
    ];
    if (view.inSilence) {
        parts.push(
            'The facilitator is currently keeping an agreed silence for you. Anything you say may be heard as thinking out loud, or as calling them back.'
        );
    }
    if (view.situation) parts.push(view.situation);
    parts.push('', 'What do you do next? Answer in the required format.');
    return parts.join('\n');
}

/** Strip anything that isn't plausible spoken audio from a sim reply line. */
function cleanUtterance(lines: string[]): string | null {
    const kept: string[] = [];
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        // A line that is entirely a stage direction, not speech.
        if (/^[([*].*[)\]*]$/.test(line)) continue;
        // Placeholder tokens some models emit for "I say nothing" (Haiku 5.5
        // has written "EOF" and "EOF_PLACEHOLDER" inside a silence).
        if (/^<[^>]*>$/.test(line) || /^(?:none|nothing|empty|silence|eof|\.{2,})$/i.test(line)) continue;
        if (/^[A-Z]+(?:_[A-Z]+)+$/.test(line)) continue;
        kept.push(line);
    }
    let text = kept.join(' ').trim();
    if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith('“') && text.endsWith('”'))
    ) {
        text = text.slice(1, -1).trim();
    }
    return text || null;
}

export function parseSimReply(raw: string): SimAction {
    const withoutThink = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, ' ').trim();
    const lines = withoutThink.split('\n');
    let waitSec: number | null = null;
    let end = false;
    const spoken: string[] = [];
    for (const line of lines) {
        // "WAIT: 90", and the speech some models put on the same line: "WAIT:
        // 30 Yes, please." or, with the number left out, "WAIT: Yes, please."
        const wait = /^\s*WAIT\s*:\s*(\d+)?\s*(?:s\b|sec\b|seconds\b)?\s*(.*)$/i.exec(line);
        if (wait && waitSec === null) {
            if (wait[1] !== undefined) waitSec = Number(wait[1]);
            if (wait[2]?.trim()) spoken.push(wait[2]);
            continue;
        }
        if (/^\s*END[.!]?\s*$/i.test(line)) {
            end = true;
            continue;
        }
        spoken.push(line);
    }
    // A model scripting several moves ahead ("yes WAIT: 420 hm... WAIT: 8 ok
    // I'm back") fuses its plan into one line; keep only the first move.
    let text = cleanUtterance(spoken);
    if (text !== null) {
        const inline = /\bWAIT\s*:\s*\d+/.exec(text);
        if (inline) text = text.slice(0, inline.index).trim() || null;
    }
    return {
        waitSec: Math.min(SIM_WAIT_MAX_SEC, Math.max(SIM_WAIT_MIN_SEC, waitSec ?? 60)),
        text,
        end,
        raw,
    };
}

export class LlmSimUser implements SimUser {
    private readonly provider: LLMProvider;
    private readonly system: string;
    /** Wall-clock ms spent in sim calls, for the run's cost accounting. */
    onCall?: (latencyMs: number) => void;

    constructor(provider: LLMProvider, persona: Persona, language: 'en' | 'zh' = 'en') {
        this.provider = provider;
        this.system = buildSystemPrompt(persona, language);
    }

    async nextAction(view: SimView): Promise<SimAction> {
        const content = renderView(view);
        let lastErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const t0 = Date.now();
                const result = await this.provider.complete(
                    [{ role: 'user', content }],
                    { system: this.system, maxTokens: SIM_MAX_TOKENS }
                );
                this.onCall?.(Date.now() - t0);
                return { ...parseSimReply(result.text), model: this.provider.model, usage: callUsageOf(result) };
            } catch (err) {
                lastErr = err;
            }
        }
        throw new Error(
            `sim user call failed twice: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
        );
    }
}
