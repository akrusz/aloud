/**
 * Scores the spoken-command asks (voice-command-specs.ts) against a labelled
 * corpus, through the exact production request (server askNouls + core specs +
 * resolveCommands). Rerun after touching an ask, an example or a threshold:
 * every ask shares one request, so an edit to one can move the others.
 *
 *   npm run jev:commands
 *
 * Needs TYPESAFE_API_KEY, from ts/server/.env or the environment. Prints each
 * miss, then the five thinnest margins on each side of the bar.
 */

import { judgeQuestions, judgeState } from '../src/facilitation/utterance-judge.js';
import { resolveCommands, type VoiceCommandId } from '../src/facilitation/voice-command.js';
import { COMMAND_GATE_ASK, COMMAND_GATE_BAR, COMMAND_SPECS } from '../src/facilitation/voice-command-specs.js';
import { askNouls } from '../server/src/providers/typesafe.js';
import { loadServerEnv } from '../soak/env.js';

type Case = [text: string, want: VoiceCommandId[]];

const CORPUS: Case[] = [
    // One command, plain and natural phrasings. None repeats an ask's examples.
    ['Could you wrap up the session?', ['end_session']],
    ["I think that's enough for today, let's finish.", ['end_session']],
    ['Finish up but throw this one away.', ['end_discard']],
    ["Let's end, and please keep a record of this one.", ['end_save']],
    ["You're talking too fast.", ['slower']],
    ['Could you slow your speech down a little?', ['slower']],
    ['Pick up the pace when you talk.', ['faster']],
    ['Give me a thirty minute timer.', ['set_timer']],
    ['Five more minutes.', ['set_timer']],
    ['Oh, can you cancel the timer?', ['cancel_timer']],
    ['Actually, never mind the timer.', ['cancel_timer']],
    ['How long do I have left?', ['time_check']],
    ['How long have I been sitting?', ['time_check']],
    ['Can you hide the clock?', ['hide_clock']],
    ["I don't want to see the timer.", ['hide_clock']],
    ['Put the clock back up.', ['show_clock']],
    ['What did you just say?', ['repeat']],
    ['One more time, please.', ['repeat']],
    ['You take forever to answer.', ['respond_sooner']],
    ["You keep jumping in before I'm done.", ['wait_longer']],
    ['Mute the microphone please.', ['mute']],
    ['Stop listening for a bit.', ['mute']],
    ['Turn off your voice.', ['mute_speaker']],
    ['Mute the speaker.', ['mute_speaker']],
    ['Turn the sound back on.', ['unmute_speaker']],
    ['Show me the orb.', ['show_orb']],
    ['Put the orb away please.', ['hide_orb']],
    ['Turn on the embers.', ['embers_on']],
    ['Embers off.', ['embers_off']],
    ['No more sparks please.', ['embers_off']],
    ['Go to dark mode.', ['dark_mode']],
    ['Light theme please.', ['light_mode']],
    ['Switch theme.', ['toggle_theme']],
    ['What commands do you understand?', ['help']],
    ['结束这次冥想吧。', ['end_session']],
    ['说话慢一点。', ['slower']],
    ['帮我定一个二十分钟的计时。', ['set_timer']],
    ['取消计时。', ['cancel_timer']],

    // Two at once.
    ['Hey, can you talk slower and show me the orb?', ['slower', 'show_orb']],
    ['Cancel the timer and speak a bit faster.', ['cancel_timer', 'faster']],
    ['Dark mode and mute the speaker please.', ['dark_mode', 'mute_speaker']],
    ['Hide the clock and turn off the embers.', ['hide_clock', 'embers_off']],

    // Meditation talk in a command's vocabulary.
    ["There's a glowing orb of light in my chest.", []],
    ['It feels like embers of an old fire in my belly.', []],
    ['I see a dark space behind my eyes.', []],
    ['Everything is getting lighter.', []],
    ['The light is fading now.', []],
    ['I feel muted, like my voice is turned off.', []],
    ["I can't hear my own inner voice.", []],
    ['I keep watching the clock in my mind.', []],
    ['Time feels like it has stopped.', []],
    ['My thoughts are racing faster and faster.', []],
    ['My breath is slowing down on its own.', []],
    ['I want this sadness to end.', []],
    ['Part of me wants to cancel everything and hide.', []],
    ['I keep repeating the same story to myself.', []],
    ['I notice I want to switch to a different feeling.', []],
    ['The sparks of anger are dying down.', []],
    ['我的呼吸慢下来了。', []],
    ['心里有一团暗暗的东西。', []],

    // Silence requests: [HOLD]'s business, not a speaker mute or a mic mute.
    ['Can you be quiet for a while?', []],
    ['Just listen for a bit.', []],
    ['Stop talking for a few minutes.', []],
    ['I need some silence.', []],
    // A question for the facilitator, not "repeat".
    ['Can you say more about that?', []],
];

/** `end_session` on "I want this to be over" (~0.64) is the known, accepted
 *  miss: ending is a question, never an act. Reported, not counted. */
const KNOWN: Case[] = [['I want this to be over.', []]];

loadServerEnv();
const key = process.env['TYPESAFE_API_KEY'];
if (!key) throw new Error('TYPESAFE_API_KEY not set');

const thresholds = COMMAND_SPECS.command.asks;
const questions = judgeQuestions('command');
const gateQuestions = judgeQuestions('command-gate');
let gateTokens = 0;
let gated = 0;
const gateScores: Margin[] = [];
let misses = 0;
let tokens = 0;
const latencies: number[] = [];
interface Margin {
    margin: number;
    text: string;
    id: string;
}
const hits: Margin[] = [];
const nearMisses: Margin[] = [];

async function ask(text: string, id: 'command' | 'command-gate' = 'command'): Promise<Record<string, number> | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const t0 = performance.now();
        try {
            const r = await askNouls(key!, judgeState(id, text), id === 'command' ? questions : gateQuestions);
            if (id === 'command') {
                latencies.push(performance.now() - t0);
                tokens = r.inputTokens;
            } else gateTokens = r.inputTokens;
            return r.answers;
        } catch {
            /* retry: a timeout says nothing about the ask */
        }
    }
    return null;
}

for (const [text, want] of [...CORPUS, ...KNOWN]) {
    const known = KNOWN.some(([t]) => t === text);
    // The gate first, as detectVoiceCommand does. Everything is still scored on
    // the full set, so the margins below don't depend on the gate's verdict.
    const pGate = (await ask(text, 'command-gate'))?.[COMMAND_GATE_ASK] ?? 1;
    const stopped = pGate < COMMAND_GATE_BAR;
    if (stopped) gated++;
    if (!known) {
        gateScores.push({
            margin: want.length > 0 ? pGate - COMMAND_GATE_BAR : COMMAND_GATE_BAR - pGate,
            text,
            id: `gate=${pGate.toFixed(2)}`,
        });
    }
    if (stopped && want.length > 0) {
        console.log(`GATED   ${text}  (gate=${pGate.toFixed(2)}, bar ${COMMAND_GATE_BAR})`);
        misses++;
        continue;
    }
    const answers = await ask(text);
    if (!answers) {
        console.log(`ERROR   ${text}`);
        misses++;
        continue;
    }
    const got = resolveCommands(answers);
    const ok = got.length === want.length && want.every((id) => got.includes(id));
    const END = ['end_session', 'end_discard', 'end_save'];
    const wantsEnd = want.some((id) => END.includes(id));
    for (const [id, p] of Object.entries(answers)) {
        // The end asks overlap by design (moreSpecific picks between them).
        if (wantsEnd && END.includes(id) && !want.includes(id as VoiceCommandId)) continue;
        const margin = want.includes(id as VoiceCommandId) ? p - thresholds[id]!.threshold : thresholds[id]!.threshold - p;
        if (!known) (want.includes(id as VoiceCommandId) ? hits : nearMisses).push({ margin, text, id: `${id}=${p.toFixed(2)}` });
    }
    if (!ok) {
        if (!known) misses++;
        const top = Object.entries(answers)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
            .join(' ');
        console.log(`${known ? 'KNOWN ' : 'MISS  '}  ${text}\n          want [${want.join(', ')}] got [${got.join(', ')}]  ${top}`);
    }
}

latencies.sort((a, b) => a - b);
const pct = (q: number): number => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0);
console.log(`\n${CORPUS.length - misses}/${CORPUS.length} correct   ${tokens} input tokens/call   p50 ${pct(0.5)}ms  p95 ${pct(0.95)}ms`);
const thinnest = (list: Margin[]): string =>
    list
        .sort((a, b) => a.margin - b.margin)
        .slice(0, 5)
        .map((m) => `  ${m.margin >= 0 ? '+' : ''}${m.margin.toFixed(2)}  ${m.id.padEnd(22)} "${m.text}"`)
        .join('\n');
const total = CORPUS.length + KNOWN.length;
console.log(
    `gate: ${gateTokens} tokens/call, stopped ${gated}/${total} before the full check; ` +
        `real commands closest to the gate's bar:\n${thinnest(gateScores.filter((g) => g.margin >= 0 && CORPUS.some(([t, w]) => t === g.text && w.length > 0)))}`
);
console.log(`\nweakest real commands (score minus bar):\n${thinnest(hits)}`);
console.log(`\nstrongest non-commands (bar minus score):\n${thinnest(nearMisses)}`);
process.exitCode = misses > 0 ? 1 : 0;
