/**
 * generateSessionSummary — the recap used for history labels and cheap resume.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateSessionSummary, type GenerateSummaryOptions } from '../src/facilitation/summary.js';
import { buildResumeContext } from '../src/facilitation/resume.js';
import { STEPPING_OUT_NOTE } from '../src/facilitation/prompts.js';
import { emptyUsage, type Exchange, type SessionState } from '../src/facilitation/session.js';
import type { CompletionOptions, CompletionResult, LLMProvider, Message } from '../src/llm/index.js';

function fakeProvider(text: string): { provider: LLMProvider; calls: Array<{ messages: Message[]; options: CompletionOptions }> } {
    const calls: Array<{ messages: Message[]; options: CompletionOptions }> = [];
    const provider: LLMProvider = {
        model: 'fake',
        async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
            calls.push({ messages, options });
            return {
                text,
                finishReason: 'end_turn',
                tokensUsed: 10,
                inputTokens: 8,
                outputTokens: 2,
                cacheReadTokens: null,
                cacheCreationTokens: null,
            };
        },
    };
    return { provider, calls };
}

const EN: GenerateSummaryOptions = { language: 'en' };
const ZH: GenerateSummaryOptions = { language: 'zh-CN' };

/** The one request the summary sent. */
async function request(
    log: Parameters<typeof generateSessionSummary>[1],
    options: GenerateSummaryOptions = EN
): Promise<{ system: string; messages: Message[]; content: string; transcript: string }> {
    const { provider, calls } = fakeProvider('a note');
    await generateSessionSummary(provider, log, options);
    expect(calls).toHaveLength(1);
    const { messages, options: sent } = calls[0]!;
    const content = messages[0]!.content;
    const transcript = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(content)?.[1] ?? '';
    return { system: sent.system ?? '', messages, content, transcript };
}

describe('generateSessionSummary', () => {
    // A transcript with enough user turns to clear the short-session floor.
    const realSession: Message[] = [
        { role: 'assistant', content: 'welcome' },
        { role: 'user', content: 'i keep noticing tension in my chest' },
        { role: 'assistant', content: 'stay with it' },
        { role: 'user', content: 'it softened a little' },
    ];

    describe('the request', () => {
        it('is one user message under a note-writer system prompt: the transcript, then the instruction', async () => {
            const { system, messages, content, transcript } = await request(realSession);
            expect(system).toContain('notes on finished meditation sessions');
            expect(messages).toHaveLength(1);
            expect(messages[0]!.role).toBe('user');
            expect(content.startsWith('<transcript>\n')).toBe(true);
            expect(transcript).toBe(
                'Facilitator: welcome\n\n' +
                    'Meditator: i keep noticing tension in my chest\n\n' +
                    'Facilitator: stay with it\n\n' +
                    'Meditator: it softened a little'
            );
            const instruction = content.slice(content.indexOf('</transcript>') + '</transcript>'.length).trim();
            expect(instruction.startsWith('The session in the transcript above has ended.')).toBe(true);
            expect(instruction).toContain('Call them "the meditator"');
            // A 中文 note stays Chinese only when told (GPT-6 Luna).
            expect(instruction).toContain("Write it in the session's language.");
            // No sender to vouch for and no role to leave: the request is its own.
            expect(content).not.toContain('from the app');
            expect(content).not.toContain('step out');
        });

        it('labels the speakers and names the meditator in the session language', async () => {
            const { content, transcript } = await request(realSession, ZH);
            expect(transcript).toContain('引导者: welcome');
            expect(transcript).toContain('冥想者: it softened a little');
            expect(transcript).not.toMatch(/Facilitator|Meditator/);
            expect(content).toContain('Call them "冥想者"');
            expect(content).not.toContain('Call them "the meditator"');
        });

        it('keeps one system prompt for every session, whatever its language', async () => {
            const en = await request(realSession, EN);
            const zh = await request(realSession, ZH);
            expect(zh.system).toBe(en.system);
        });

        it('leaves out control entries and strips turn signals from the facilitator', async () => {
            const log: Array<Pick<Exchange, 'role' | 'content' | 'kind'>> = [
                { role: 'user', content: 'Generate a brief, natural opening for this meditation session.', kind: 'opener' },
                { role: 'system', content: 'Stage note (from the app, not the meditator; never mention it aloud): stage 1 of 6', kind: 'phase' },
                { role: 'assistant', content: "[WAIT:2m] Whenever you're ready." },
                { role: 'user', content: 'my chest is tight' },
                { role: 'system', content: STEPPING_OUT_NOTE, kind: 'trouble' },
                { role: 'system', content: 'Setting change (from the app, not the meditator)', kind: 'setting' },
                { role: 'assistant', content: '[NEXT] What is that tightness like? [HOLD]' },
                { role: 'user', content: '[Check-in: the meditator has been quiet for about a minute.]', kind: 'event' },
                { role: 'assistant', content: 'Still here.' },
                // Saved before `kind` existed: an event turn known only by its prefix.
                { role: 'user', content: '[Timer: the 10 minutes the meditator set are complete.]' },
                { role: 'assistant', content: 'The ten minutes are up.' },
                { role: 'user', content: 'thank you' },
                { role: 'assistant', content: 'Okay.\n\n[HOLD] Would you like me to be quiet for a bit?' },
            ];
            const { transcript } = await request(log);
            // One line a turn, so a reply's second paragraph can't read as a
            // line nobody said.
            expect(transcript).toBe(
                "Facilitator: Whenever you're ready.\n\n" +
                    'Meditator: my chest is tight\n\n' +
                    'Facilitator: What is that tightness like?\n\n' +
                    'Facilitator: Still here.\n\n' +
                    'Facilitator: The ten minutes are up.\n\n' +
                    'Meditator: thank you\n\n' +
                    'Facilitator: Okay. Would you like me to be quiet for a bit?'
            );
        });

        it("keeps a continued session's recap seed, so the note covers the earlier part", async () => {
            // A long session, resumed from its recap plus the last few turns.
            const turns: Exchange[] = [];
            for (let i = 0; i < 40; i++) {
                turns.push({ role: 'user', content: `earlier words ${i} `.repeat(30), timestamp: 0 });
                turns.push({ role: 'assistant', content: `earlier reply ${i}`, timestamp: 0 });
            }
            const prior: SessionState = {
                sessionId: 's',
                startTime: 0,
                endTime: 1,
                exchanges: turns,
                notes: 'The meditator explored a heaviness in the chest.',
                notesAreRecap: true,
                usage: emptyUsage(),
            };
            const seeded = buildResumeContext(prior, true);
            const log = [...seeded, { role: 'user' as const, content: 'back again' }, { role: 'assistant' as const, content: 'Welcome back.' }];
            const { transcript } = await request(log);
            const lines = transcript.split('\n\n');
            expect(lines[0]).toBe('[Continuing from a previous session. Recap: The meditator explored a heaviness in the chest.]');
            expect(lines.slice(-2)).toEqual(['Meditator: back again', 'Facilitator: Welcome back.']);
        });

        it("leaves a noting circle's other participants out", async () => {
            const log: Array<Pick<Exchange, 'role' | 'content' | 'name'>> = [
                { role: 'assistant', content: 'Note what you notice.', name: 'Facilitator' },
                { role: 'user', content: 'warmth', name: 'You' },
                { role: 'assistant', content: 'tension', name: 'Harper' },
                { role: 'user', content: 'breath', name: 'You' },
            ];
            const { transcript } = await request(log);
            expect(transcript).toBe(
                'Facilitator: Note what you notice.\n\nMeditator: warmth\n\nMeditator: breath'
            );
        });

        it("tells a noting circle's note-writer what the circle was, in the session language", async () => {
            const plain = await request(realSession);
            const en = await request(realSession, { ...EN, noting: true });
            expect(en.content.startsWith('This session was a noting circle, ')).toBe(true);
            expect(en.content.endsWith(plain.content)).toBe(true);
            expect(en.content).toContain('other voices are left out of the transcript');
            const zh = await request(realSession, { ...ZH, noting: true });
            expect(zh.content.startsWith('这次是一个标记圈')).toBe(true);
            expect(zh.content).toContain('冥想者');
            expect(zh.content).not.toMatch(/noting circle|Meditator/);
        });

        it('sends an ordinary session exactly the transcript and the instruction', async () => {
            const { content } = await request(realSession);
            expect(content).toBe(
                '<transcript>\n' +
                    'Facilitator: welcome\n\n' +
                    'Meditator: i keep noticing tension in my chest\n\n' +
                    'Facilitator: stay with it\n\n' +
                    'Meditator: it softened a little\n' +
                    '</transcript>\n\n' +
                    'The session in the transcript above has ended. Write the private note on it for the ' +
                    "meditator's history log - what was explored, where it ended up, and any thread left open " +
                    'to pick up later. 2-3 sentences (about 40-60 words), neutral, in the third person. Call ' +
                    'them "the meditator" and do not guess a gender; use "they" only where a pronoun cannot be ' +
                    'avoided. Output only the note: no preamble, no questions, no facilitation. Write it in ' +
                    "the session's language."
            );
            expect((await request(realSession, { ...EN, noting: false })).content).toBe(content);
        });
    });

    it('skips the LLM call for a barely-started session (below the user-turn floor)', async () => {
        const { provider, calls } = fakeProvider('should not be called');
        // One stray opener + a single short reply: nothing to recap.
        const out = await generateSessionSummary(
            provider,
            [
                { role: 'assistant', content: 'what brings you here?' },
                { role: 'user', content: 'a dog was barking' },
                { role: 'user', content: '[Check-in: the meditator has been quiet.]', kind: 'event' },
            ],
            EN
        );
        expect(out).toBe('');
        expect(calls).toHaveLength(0);
    });

    it('returns the note and reports its usage', async () => {
        const { provider } = fakeProvider('We explored the breath; left the chest open to revisit.');
        const onUsage = vi.fn();
        const out = await generateSessionSummary(provider, realSession, { ...EN, onUsage });
        expect(out).toBe('We explored the breath; left the chest open to revisit.');
        expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ tokensIn: 8, tokensOut: 2 }));
    });

    it('returns empty string when the provider throws (never bubbles)', async () => {
        const provider: LLMProvider = {
            model: 'fake',
            complete: vi.fn(async () => {
                throw new Error('boom');
            }),
        };
        expect(await generateSessionSummary(provider, realSession, EN)).toBe('');
    });

    // Models sometimes announce the recap despite "output only the recap".
    // Measured on gpt-5-nano; the label would otherwise show in the history list.
    describe('leading meta-label', () => {
        const BODY = 'Explored an unnamed heaviness in the chest; left unresolved.';

        it.each([
            'Brief recap: ',
            'Recap: ',
            'Summary: ',
            'Session summary: ',
            'Note to self: ',
            '**Recap:** ',
            'RECAP: ',
        ])('strips %j', async (label) => {
            const { provider } = fakeProvider(label + BODY);
            expect(await generateSessionSummary(provider, realSession, EN)).toBe(BODY);
        });

        // The guard that keeps the rule safe: it matches a closed vocabulary,
        // not "any word before a colon", so real recap prose survives intact.
        it.each([
            'Today: heaviness in the chest, left unnamed.',
            'One thread stayed open: the heaviness never resolved.',
            'She said it plainly: it is not sadness.',
            'Recapturing the thread: the chest stayed heavy.',
        ])('leaves %j alone', async (text) => {
            const { provider } = fakeProvider(text);
            expect(await generateSessionSummary(provider, realSession, EN)).toBe(text);
        });
    });
});
