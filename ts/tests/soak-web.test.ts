/**
 * Offline coverage for the tier-2 (browser) soak harness. No Chrome, no audio:
 * a fake driver stands in for the page's tap and a silent voice for the
 * meditator's mouth, so the loop's turn-taking, the spoken/heard pairing, and
 * the audio checks are pinned without owning the machine's speakers.
 */

import { describe, expect, it } from 'vitest';

import { runWebSoakSession } from '../soak/browser/orchestrator.js';
import { runAudioChecks } from '../soak/browser/checks.js';
import { configForScenario, getWebScenarios } from '../soak/browser/scenarios.js';
import { wordErrorRate } from '../soak/browser/wer.js';
import type { WebScenario, WebSessionRunResult } from '../soak/browser/types.js';
import type { SessionDriver } from '../soak/browser/driver.js';
import type { SimVoice } from '../soak/browser/voice.js';
import type { SimAction, SimUser, SimView } from '../soak/sim-user.js';
import type { SoakTapState } from '../ui/src/soak-tap.js';

const SCENARIO: WebScenario = {
    id: 'test',
    title: 'test',
    persona: { id: 'p', description: 'a test meditator' },
    modeId: 'exploration',
    realMinutes: 10,
    maxWaitSec: 0,
    fakeMinutes: 10,
    maxUserTurns: 3,
};

/**
 * Stands in for the page. Every "spoken" line is fed back as a recognizer final
 * (optionally mangled or swallowed) plus a facilitator reply, which is what the
 * real app does over the tap.
 */
class FakeDriver implements Pick<SessionDriver, 'readTap' | 'isEnded' | 'close'> {
    readonly tap: SoakTapState = {
        startedAt: Date.now(),
        turns: [{ at: 0, role: 'assistant', kind: 'opener', text: 'Welcome. Settle in.' }],
        events: [],
        calls: [],
        flags: {
            silenceMode: false,
            awaitingHoldConfirm: false,
            speaking: false,
            busy: false,
            muted: false,
            ended: false,
        },
    };
    /** Maps a spoken line to what the recognizer produces; null = nothing. */
    mishear: (said: string) => string | null = (said) => said;
    /** Drop the next capture as TTS echo instead of hearing it. */
    dropAsEcho = false;
    private clock = 1;

    /** Called by the fake voice: the app "hears" and answers. */
    hear(said: string): void {
        this.clock += 1;
        if (this.dropAsEcho) {
            this.tap.events.push({ at: this.clock, kind: 'audio', detail: 'echo-dropped', data: { text: said } });
            return;
        }
        const heard = this.mishear(said);
        if (heard === null) return;
        this.tap.events.push({ at: this.clock, kind: 'stt', detail: 'final', data: { text: heard } });
        this.tap.turns.push({ at: this.clock, role: 'user', kind: 'user', text: heard });
        this.clock += 1;
        this.tap.turns.push({ at: this.clock, role: 'assistant', kind: 'reply', text: `I hear you.` });
    }

    async readTap(): Promise<SoakTapState> {
        return JSON.parse(JSON.stringify(this.tap)) as SoakTapState;
    }
    async isEnded(): Promise<boolean> {
        return this.tap.flags.ended;
    }
    async close(): Promise<void> {}
}

class FakeVoice implements SimVoice {
    readonly id = 'fake';
    constructor(private readonly driver: FakeDriver) {}
    async speak(text: string): Promise<void> {
        this.driver.hear(text);
    }
    async close(): Promise<void> {}
}

/** Says each scripted line once, then ends. */
class ScriptedSimUser implements SimUser {
    private i = 0;
    constructor(private readonly lines: string[]) {}
    async nextAction(_view: SimView): Promise<SimAction> {
        const text = this.lines[this.i++] ?? null;
        return { waitSec: 0, text, end: text === null, raw: text ?? 'END' };
    }
}

async function run(
    driver: FakeDriver,
    lines: string[],
    scenario: WebScenario = SCENARIO
): Promise<WebSessionRunResult> {
    return runWebSoakSession({
        scenario,
        driver: driver as unknown as SessionDriver,
        voice: new FakeVoice(driver),
        simUser: new ScriptedSimUser(lines),
        facilitatorModel: 'fake-model',
        sttEngine: 'web-speech',
        // The fake driver answers instantly; real-audio waits would just be
        // the test sleeping.
        timing: { pollMs: 5, heardTimeoutMs: 60, turnBoundarySettleMs: 5, turnBoundaryMaxMs: 500 },
    });
}

describe('wordErrorRate', () => {
    it('is zero for an exact match, ignoring case and punctuation', () => {
        expect(wordErrorRate('My shoulders feel tight.', 'my shoulders feel tight')).toBe(0);
    });

    it('forgives contraction expansion, which speech does not encode', () => {
        expect(wordErrorRate("I'm feeling calmer", 'I am feeling calmer')).toBe(0);
    });

    it('scales with the number of wrong words', () => {
        expect(wordErrorRate('my shoulders feel tight', 'my shoulders feel light')).toBeCloseTo(0.25);
    });

    it('caps at 1 for a completely different transcription', () => {
        expect(wordErrorRate('breathing slowly', 'the quick brown fox jumped over')).toBe(1);
    });
});

describe('configForScenario', () => {
    const opts = { provider: 'anthropic', model: 'claude-x', sttEngine: 'web-speech' };

    it('maps guidance 0-10 onto the setup panel five-stop slider', () => {
        const at1 = configForScenario({ ...SCENARIO, directiveness: 1 }, opts);
        const at7 = configForScenario({ ...SCENARIO, directiveness: 7 }, opts);
        expect(at1.setup.dirStep).toBe(0);
        expect(at7.setup.dirStep).toBe(3);
    });

    it('arms the session timer only when the scenario sets one', () => {
        expect(configForScenario(SCENARIO, opts).appSettings.sessionClockMode).toBe('elapsed');
        const timed = configForScenario({ ...SCENARIO, timerMin: 5, endSessionOnTimer: true }, opts);
        expect(timed.appSettings.sessionClockMode).toBe('timer');
        expect(timed.appSettings.sessionTimerMin).toBe(5);
        expect(timed.appSettings.endSessionOnTimer).toBe(true);
    });

    it('disables the idle auto-quit, which would fire inside a scenario silence', () => {
        expect(configForScenario(SCENARIO, opts).appSettings.autoQuitAfterSilence).toBe(false);
    });

    it('covers every shipped scenario without throwing', () => {
        for (const s of getWebScenarios('all')) {
            expect(configForScenario(s, opts).setup.meditationType).toBe(s.modeId);
        }
    });
});

describe('tier-2 orchestrator', () => {
    it('pairs each spoken line with what the app heard', async () => {
        const driver = new FakeDriver();
        const result = await run(driver, ['my shoulders feel tight']);
        expect(result.spoken).toHaveLength(1);
        expect(result.spoken[0]?.said).toBe('my shoulders feel tight');
        expect(result.spoken[0]?.heard).toBe('my shoulders feel tight');
        expect(result.spoken[0]?.wer).toBe(0);
        expect(result.endedBy).toBe('sim-end');
    });

    it('scores a mangled transcription against what was said', async () => {
        const driver = new FakeDriver();
        driver.mishear = () => 'my shoulder steel tight';
        const result = await run(driver, ['my shoulders feel tight']);
        expect(result.spoken[0]?.wer).toBeGreaterThan(0);
        expect(result.spoken[0]?.heard).toBe('my shoulder steel tight');
    });

    it('records an utterance the echo guard swallowed as the meditator being dropped', async () => {
        const driver = new FakeDriver();
        driver.dropAsEcho = true;
        const result = await run(driver, ['I think I want some quiet']);
        expect(result.spoken[0]?.echoDropped).toBe(true);
        expect(result.spoken[0]?.heard).toBeNull();
        const findings = runAudioChecks(result);
        expect(findings.find((f) => f.id === 'echo-guard-false-positive')?.level).toBe('fail');
    });

    it('stops at the scenario turn cap', async () => {
        const driver = new FakeDriver();
        const result = await run(driver, ['one', 'two', 'three', 'four', 'five']);
        expect(result.spoken).toHaveLength(3);
        expect(result.endedBy).toBe('turns');
    });

    it('stops the sit once the mute command takes, since the mic cannot come back', async () => {
        const driver = new FakeDriver();
        driver.mishear = (said) => {
            if (said === 'mute') driver.tap.flags.muted = true;
            return said;
        };
        const result = await run(driver, ['one', 'two', 'three'], {
            ...SCENARIO,
            muteAfterSec: 0,
        });
        expect(result.spoken).toHaveLength(1);
        expect(result.spoken[0]?.said).toBe('mute');
        expect(result.endedBy).toBe('sim-end');
        expect(result.events.some((e) => e.detail === 'mute-took')).toBe(true);
    });

    it('ends when the app tears the session down on its own', async () => {
        const driver = new FakeDriver();
        driver.tap.flags.ended = true;
        const result = await run(driver, ['hello']);
        expect(result.endedBy).toBe('app-ended');
    });

    it('carries the page transcript and events into the tier-1 result shape', async () => {
        const driver = new FakeDriver();
        const result = await run(driver, ['hello']);
        expect(result.transcript[0]?.kind).toBe('opener');
        expect(result.transcript.some((t) => t.role === 'user' && t.text === 'hello')).toBe(true);
        // Harness-side observations are merged in with the page's, in time order.
        expect(result.events.some((e) => e.kind === 'sim' && e.detail === 'action')).toBe(true);
        for (let i = 1; i < result.events.length; i++) {
            expect(result.events[i]?.at).toBeGreaterThanOrEqual(result.events[i - 1]?.at as number);
        }
    });
});

describe('runAudioChecks', () => {
    it('fails a session where most utterances were never heard', async () => {
        const driver = new FakeDriver();
        driver.mishear = () => null;
        const result = await run(driver, ['one', 'two', 'three']);
        const findings = runAudioChecks(result);
        expect(findings.find((f) => f.id === 'stt-miss-rate')?.level).toBe('fail');
    });

    it('fails a session where nothing was ever spoken', () => {
        const empty = {
            spoken: [],
            events: [],
            scenario: SCENARIO,
            voiceId: 'fake',
            sttEngine: 'web-speech',
        } as unknown as WebSessionRunResult;
        expect(runAudioChecks(empty).find((f) => f.id === 'no-utterances')?.level).toBe('fail');
    });

    it('fails when a scheduled mute command did not mute the mic', () => {
        const result = {
            spoken: [{ at: 1, said: 'mute', heard: 'mute', echoDropped: false, wer: 0, latencyMs: 10 }],
            events: [{ at: 2, kind: 'audio', detail: 'mute-missed' }],
            scenario: { ...SCENARIO, muteAfterSec: 1 },
            voiceId: 'fake',
            sttEngine: 'web-speech',
        } as unknown as WebSessionRunResult;
        expect(runAudioChecks(result).find((f) => f.id === 'mute-command')?.level).toBe('fail');
    });

    it('warns when an interrupt scenario never triggered barge-in', () => {
        const result = {
            spoken: [{ at: 1, said: 'wait', heard: 'wait', echoDropped: false, wer: 0, latencyMs: 10 }],
            events: [],
            scenario: { ...SCENARIO, interrupt: true },
            voiceId: 'fake',
            sttEngine: 'web-speech',
        } as unknown as WebSessionRunResult;
        expect(runAudioChecks(result).find((f) => f.id === 'barge-in')?.level).toBe('warn');
    });
});
