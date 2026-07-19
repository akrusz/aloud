/**
 * Noting meditation — engine pieces.
 *
 * Noting is a meditation style where participants take turns briefly
 * naming present-moment experience with 1–2 word labels ("warmth",
 * "thinking", "belly tension"). The circle rotates through human and
 * AI participants; LLM-driven participants generate their labels via
 * a separate prompt that's distinct from the main facilitation system
 * prompt.
 *
 * This module holds the prompts and label generation only; the circle
 * orchestrator (setup, turn rotation, sound cues, mute pause) lives in
 * the ui/ tree.
 */

import type { LLMProvider, Message } from '../llm/index.js';
import type { LlmUsage } from './session.js';
import { stripThinkTags } from './strip-think-tags.js';

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

export const NOTING_SYSTEM_PROMPT = `You're part of a noting meditation circle.

In this practice, participants take turns briefly naming what they notice in their present-moment experience — usually one or two words like "warmth", "thinking", "tingling", "belly tension". Then the next person does the same.

Response style:
- Almost always one or two words. Rarely, a slightly longer phrase when something vivid or unusual arises.
- Warm and casual
- Never use emojis
- Avoid filler sounds like "mmm", "hmmm", "ahh"

You are having a real-time voice conversation. Respond naturally as you would speak.
`;

export const NOTING_OPENER_PROMPT =
    'Generate a short introduction with the same meaning as the following: ' +
    `"On your turn, just say one or two words that describe something in your awareness. Let's begin."`;

export const NOTING_CHECK_IN_PROMPTS: readonly string[] = [
    'Still here with you.',
    'Just keep noting whatever comes up.',
    "I'm here.",
    "What's arising now?",
    'Still with you.',
    'No rush.',
];

export const NOTING_LABEL_SYSTEM_PROMPT = `You are a real person sitting in a noting meditation circle. When it's your turn, generate a noting label naming a sensory or mental experience you are noticing right now.

Almost always one word. Sometimes two words when the experience has a natural qualifier (like "cool air" or "belly tension"). Rarely, a short phrase if something vivid or interesting arises — the way a real person might subtly stretch the format when a sensation is too rich for one word. But default to brevity.

You have a continuous inner life. Your physical and mental state evolves gradually and naturally from moment to moment. You don't jump from pain to comfort or from agitation to bliss between rounds. If you noticed "tightness" last time, you might notice it shifting, softening, or still lingering — or your attention might drift to something nearby. Let your experience unfold naturally, the way it does for a real human body and mind.

Examples: warmth, thinking, sounds, tightness, calm, itching, planning, joy, breath, restlessness, cool air, heaviness, smiling, birds, pressure, floating, gratitude, distraction, belly tension.

Output ONLY the label. No punctuation, no quotes, no explanation.
`;

export const NOTING_LABEL_CONTEXT = `

The circle has noted so far: {context}
`;

export const NOTING_LABEL_AVOID_SELF_REPEAT = `

Your own previous labels in this circle were: {own_labels}

Try not to repeat words from your own list — your inner experience keeps moving, so your labels should keep moving too. Reach for a fresh word each turn. Echoing what someone else just said is fine when it resonates.
`;

export const NOTING_LABEL_REACTIVE_LOW = `You are mostly in your own experience, but occasionally something another person says is noticeable — the way "smiling" might be contagious, or hearing someone note "sirens" might make you notice sound too. Only let their words influence you when something is truly salient or resonant. Most of the time, stay with your own unfolding experience.

Output ONLY your label.
`;

export const NOTING_LABEL_REACTIVE_HIGH = `You're a sociable, attentive meditator. The group's notes frequently draw your attention — hearing someone say "warmth" makes you check in with your own body temperature, or "planning" might make you notice your own mental chatter. You naturally pick up threads from others, offer contrasts, or follow emotional currents in the group. Let the circle's energy shape where your attention goes.

Output ONLY your label.
`;

export const NOTING_LABEL_REACTIVE_NONE = `Stay with your own unfolding experience. The other notes are just background — don't model your label after them.

Output ONLY your label.
`;

// ---------------------------------------------------------------------------
// Participant model
// ---------------------------------------------------------------------------

/** A non-AI fixed-phrase participant — speaks a single recorded short label. */
export interface SoundParticipant {
    type: 'sound';
    /** The sound's short name (matches a registered audio file). */
    sound: string;
}

/** An LLM-driven participant. */
export interface LlmParticipant {
    type: 'llm';
    /** Voice ID for TTS rendering. */
    voice: string;
    /** How much the participant is influenced by what others have noted. */
    reactive: ReactiveLevel;
}

export type Participant = SoundParticipant | LlmParticipant;
export type ReactiveLevel = 'none' | 'low' | 'high';

/** Static opener text used when an LLM-driven opener isn't desired. */
export const NOTING_STATIC_OPENER =
    'On your turn, just say one or two words that describe something in your awareness. ' +
    "Let's begin.";

// ---------------------------------------------------------------------------
// Label generation
// ---------------------------------------------------------------------------

export interface GenerateLabelOptions {
    /** All labels in the circle so far (any participant). */
    context?: readonly string[];
    /** This participant's own prior labels (anti-self-repeat hint). */
    ownLabels?: readonly string[];
    /** How reactive this participant is to others' notes. */
    reactive?: ReactiveLevel;
    /** Token cap for the label — labels are 1–3 words, so this is a tiny number. */
    maxTokens?: number;
    /**
     * Reports the off-transcript LLM usage for this label call so the caller
     * can fold it into session usage tracking. Fired only on a successful
     * completion.
     */
    onUsage?: (usage: LlmUsage) => void;
}

/**
 * Generate a single noting label for an LLM participant in a circle.
 *
 * Composes the system prompt from the participant's reactive level and
 * the circle's context, then asks the model for a 1–3 word label.
 * Returns a fallback ("breathing") if the LLM call fails or returns
 * nothing usable — keeps the turn loop running on transient errors.
 */
export async function generateNotingLabel(
    provider: LLMProvider,
    options: GenerateLabelOptions = {}
): Promise<string> {
    const {
        context = [],
        ownLabels = [],
        reactive = 'none',
        maxTokens = 20,
        onUsage,
    } = options;

    // Replacer functions, not replacement strings — a label containing `$`
    // would otherwise trigger String.replace's pattern expansion ($&, $', …).
    let system = NOTING_LABEL_SYSTEM_PROMPT;
    if (context.length > 0) {
        system += NOTING_LABEL_CONTEXT.replace('{context}', () => context.join(', '));
    }
    if (ownLabels.length > 0) {
        system += NOTING_LABEL_AVOID_SELF_REPEAT.replace(
            '{own_labels}',
            () => ownLabels.join(', ')
        );
    }
    system +=
        reactive === 'high'
            ? NOTING_LABEL_REACTIVE_HIGH
            : reactive === 'low'
              ? NOTING_LABEL_REACTIVE_LOW
              : NOTING_LABEL_REACTIVE_NONE;

    const messages: Message[] = [
        { role: 'user', content: 'Your turn. Say something you notice now, 1-2 words.' },
    ];

    try {
        const result = await provider.complete(messages, { system, maxTokens });
        onUsage?.({
            tokensIn: result.inputTokens ?? null,
            tokensOut: result.outputTokens ?? null,
            cacheRead: result.cacheReadTokens ?? null,
            cacheCreation: result.cacheCreationTokens ?? null,
        });
        const cleaned = stripThinkTags(result.text)
            .trim()
            .replace(/^["']+|["']+$/g, '') // strip surrounding quotes
            .replace(/[.!?,]+$/, '') // strip trailing punctuation
            .toLowerCase();
        return cleaned || 'breathing';
    } catch {
        return 'breathing';
    }
}
