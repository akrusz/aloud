/**
 * The setup screen's judge tier where no judge may be asked: a session set to
 * a local model (Ollama), signed out or not opted in. The same place in the
 * order as setup-command-specs.ts, after the on-device parser has missed, and
 * the same job: natural phrasing outside the parser's grammar ("could we try
 * noting this time around?").
 *
 * One call to the model the session will use, answered as a short list from a
 * closed set of changes, which the provider holds it to (`format`). The shape
 * is the whole trick with a small model. Asked to fill in a form with every
 * setting as a field, qwen3.5:4b filled in all of them (0 of 23 held-out
 * requests exact, 3s a call); asked for the list, 22 of 23 at 0.9s
 * (2026-11-14, `npm run setup:local`). It is switched off all the same: the
 * same model then changed a setting on half the room and television lines it
 * was read (ui setup-local-reader.ts READS_SETUP). Jev's 28 yes/no asks have no local
 * equivalent worth the wait: the decision models tried in that shape took
 * 0.1 to 1.3s for a single ask (bead meditation-pal-4qvo).
 *
 * Never a way to begin: a line with begin or start in it is not sent
 * (mightBeSetupRequest), and a "begin" in the answer empties it.
 */

import type { LLMProvider } from '../llm/base.js';
import type { BeginMode } from './begin-command.js';
import type { Quality } from './prompts.js';
import type { SetupAction, SetupFocus } from './setup-command.js';
import { mightBeSetupRequest, namesGuidanceOrResponses, sessionMinutes } from './setup-command-specs.js';

const MODES: Record<string, BeginMode> = { exploration: 'exploration', noting: 'noting', felt_sense: 'felt_sense' };
const VIBES: Record<string, Quality> = {
    playful: 'playful', compassionate: 'compassionate', loving: 'loving', spacious: 'spacious', effortless: 'effortless', feeling_good: 'feeling_good',
};
const FOCUSES: Record<string, SetupFocus> = { body: 'body_sensations', emotions: 'emotions', parts: 'inner_parts' };
const VALUES = [...Object.keys(VIBES), ...Object.keys(FOCUSES)];

/** Everything the model may answer with. */
export const LOCAL_SETUP_CHANGES: readonly string[] = [
    'none', 'begin',
    ...Object.keys(MODES).map((m) => `mode:${m}`),
    ...VALUES.map((v) => `add:${v}`),
    ...VALUES.map((v) => `remove:${v}`),
    'only',
    'guidance:more', 'guidance:less', 'responses:shorter', 'responses:longer',
    'timer:set', 'timer:none', 'clock:hide', 'clock:show',
    'intention:set', 'voices:open',
    'checkins:on', 'checkins:off', 'mic:off', 'help',
];

/** The JSON schema the answer is held to. */
export const LOCAL_SETUP_FORMAT = {
    type: 'object',
    properties: { changes: { type: 'array', items: { enum: LOCAL_SETUP_CHANGES } } },
    required: ['changes'],
} as const;

export const LOCAL_SETUP_SYSTEM_PROMPT = `You read one line that a speech recognizer heard on a meditation app's setup screen, before a session starts. Most lines are talk in the room or on a television and ask nothing of the app. A few are requests to the app to change its setup.

Answer with the list of changes the line asks the app to make, and only those: usually one, never one the line does not mention. If the line is not clearly a request to the app about one of these settings, answer ["none"]. A remark, a description, a question to another person or an instruction to someone else is not a request, whatever words it uses. A request to begin or start the session is ["begin"].

The changes:
- mode:exploration, mode:noting, mode:felt_sense: switch the kind of session.
- add:X or remove:X, where X is a vibe (playful, compassionate, loving, spacious, effortless, feeling_good) or a focus (body, emotions, parts).
- only: with add:X, when the request says to keep just that and drop the others.
- guidance:more or guidance:less: how much the facilitator leads or directs.
- responses:shorter or responses:longer: how much the facilitator says each time.
- timer:set when a session length is asked for; timer:none for no time limit.
- clock:hide or clock:show: whether the clock is on screen during the session.
- intention:set: wanting to set an intention for the session, without saying what it is.
- voices:open: wanting to choose or change the voice the app speaks in.
- checkins:on or checkins:off: the facilitator checking in when the meditator goes quiet.
- mic:off: stop listening. help: what can be said here.`;

/** Long enough for five changes; a list that runs past it was not a request. */
const LOCAL_SETUP_MAX_TOKENS = 60;

/**
 * The actions a list of changes amounts to, or null. Pure. The same reading
 * as resolveSetupAnswers gives the judge's scores: nothing at all beside a
 * "begin" or a "none", one mode or no mode, a length only with minutes in the
 * text, opposites cancel, and guidance and response length are kept apart by
 * the word that names one.
 */
export function resolveLocalSetupChanges(changes: unknown, text: string): SetupAction[] | null {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 6) return null;
    const list = changes.filter((c): c is string => typeof c === 'string' && LOCAL_SETUP_CHANGES.includes(c));
    if (list.length !== changes.length) return null;
    const has = (change: string): boolean => list.includes(change);
    if (has('none') || has('begin')) return null;
    const actions: SetupAction[] = [];

    const modes = list.filter((c) => c.startsWith('mode:'));
    if (modes.length > 1) return null;
    if (modes.length === 1) actions.push({ kind: 'mode', mode: MODES[modes[0]!.slice(5)]! });

    const minutes = has('timer:set') ? sessionMinutes(text) : null;
    if (minutes !== null && !has('timer:none')) actions.push({ kind: 'length', minutes });
    if (has('timer:none') && minutes === null) actions.push({ kind: 'no-timer' });
    if (has('clock:hide') !== has('clock:show')) actions.push({ kind: 'clock', show: has('clock:show') });

    const added = list.filter((c) => c.startsWith('add:')).map((c) => c.slice(4));
    const removed = list.filter((c) => c.startsWith('remove:')).map((c) => c.slice(7));
    // Asked for and taken away in one breath: it could not tell.
    if (added.some((v) => removed.includes(v))) return null;
    const value = (v: string, on: boolean): SetupAction =>
        v in FOCUSES ? { kind: 'focus', focus: FOCUSES[v]!, on } : { kind: 'quality', quality: VIBES[v]!, on };
    if (has('only') && added.some((v) => v in FOCUSES)) actions.push({ kind: 'clear', group: 'focus' });
    if (has('only') && added.some((v) => v in VIBES)) actions.push({ kind: 'clear', group: 'quality' });
    for (const v of added) actions.push(value(v, true));
    for (const v of removed) actions.push(value(v, false));

    const named = namesGuidanceOrResponses(text);
    if (named !== 'responses' && has('guidance:more') !== has('guidance:less')) {
        actions.push({ kind: 'guidance', to: has('guidance:more') ? 'up' : 'down' });
    }
    if (named !== 'guidance' && has('responses:shorter') !== has('responses:longer')) {
        actions.push({ kind: 'verbosity', to: has('responses:longer') ? 'up' : 'down' });
    }
    if (has('intention:set')) actions.push({ kind: 'intention-ask' });
    if (has('voices:open')) actions.push({ kind: 'voice-picker' });
    if (has('checkins:on') !== has('checkins:off')) actions.push({ kind: 'checkins', on: has('checkins:on') });

    if (has('mic:off')) actions.push({ kind: 'stop-listening' });
    else if (has('help') && actions.length === 0) actions.push({ kind: 'help' });
    return actions.length > 0 ? actions : null;
}

/**
 * A local model's reading of a setup-screen utterance the parser missed, or
 * null. Never throws: a model that is down, slow to load or writes something
 * else has understood nothing, and the request only has to be said again.
 */
export async function readSetupLocally(
    provider: LLMProvider,
    text: string,
    options: { signal?: AbortSignal } = {}
): Promise<SetupAction[] | null> {
    const said = text.trim();
    if (!mightBeSetupRequest(said)) return null;
    try {
        const reply = await provider.complete([{ role: 'user', content: said }], {
            system: LOCAL_SETUP_SYSTEM_PROMPT,
            maxTokens: LOCAL_SETUP_MAX_TOKENS,
            format: LOCAL_SETUP_FORMAT,
            ...(options.signal && { signal: options.signal }),
        });
        const parsed = JSON.parse(reply.text) as { changes?: unknown };
        return resolveLocalSetupChanges(parsed.changes, said);
    } catch {
        return null;
    }
}
