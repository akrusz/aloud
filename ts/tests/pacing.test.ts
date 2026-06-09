import { describe, it, expect, beforeEach } from 'vitest';

import {
    ConversationState,
    PacingController,
    TurnDecision,
    defaultPacingConfig,
} from '../src/facilitation/pacing.js';
import { createFakeClock } from '../src/clock.js';

function makeController(opts?: { config?: Parameters<typeof PacingController['prototype']['constructor']>[0]['config'] }) {
    const fake = createFakeClock(1_000_000);
    const controller = new PacingController({
        clock: fake.clock,
        ...(opts?.config !== undefined && { config: opts.config }),
    });
    return { controller, fake };
}

describe('PacingController — state transitions', () => {
    let controller: PacingController;

    beforeEach(() => {
        controller = makeController().controller;
    });

    it('starts in IDLE', () => {
        expect(controller.state).toBe(ConversationState.Idle);
    });

    it('startSession transitions to LISTENING', () => {
        controller.startSession();
        expect(controller.state).toBe(ConversationState.Listening);
    });

    it('endSession returns to IDLE', () => {
        controller.startSession();
        controller.endSession();
        expect(controller.state).toBe(ConversationState.Idle);
    });

    it('onSpeechEnd transitions to PROCESSING', () => {
        controller.startSession();
        controller.onSpeechEnd();
        expect(controller.state).toBe(ConversationState.Processing);
    });

    it('onSpeechStart returns to LISTENING', () => {
        controller.startSession();
        controller.onSpeechEnd();
        controller.onSpeechStart();
        expect(controller.state).toBe(ConversationState.Listening);
    });

    it('onResponseStart → RESPONDING; onResponseEnd → LISTENING', () => {
        controller.startSession();
        controller.onResponseStart();
        expect(controller.state).toBe(ConversationState.Responding);
        controller.onResponseEnd();
        expect(controller.state).toBe(ConversationState.Listening);
    });

    it('enterSilenceMode → SILENT_HOLD; exitSilenceMode → LISTENING', () => {
        controller.startSession();
        controller.enterSilenceMode();
        expect(controller.state).toBe(ConversationState.SilentHold);
        expect(controller.isInSilenceMode()).toBe(true);
        controller.exitSilenceMode();
        expect(controller.state).toBe(ConversationState.Listening);
        expect(controller.isInSilenceMode()).toBe(false);
    });
});

describe('PacingController — shouldRespond timing', () => {
    it('responds when silence exceeds response delay', () => {
        const { controller, fake } = makeController({
            config: { responseDelayMs: 2000 },
        });
        controller.startSession();
        controller.onSpeechEnd();
        fake.tick(3); // 3s of silence past speech end
        expect(controller.shouldRespond()).toBe(TurnDecision.Respond);
    });

    it('waits while silence is shorter than response delay', () => {
        const { controller, fake } = makeController({
            config: { responseDelayMs: 5000 },
        });
        controller.startSession();
        controller.onSpeechEnd();
        fake.tick(1);
        expect(controller.shouldRespond()).toBe(TurnDecision.Wait);
    });

    it('emits CHECK_IN after extended silence with no recent speech', () => {
        const { controller, fake } = makeController({
            config: { silenceCheckinSec: 10, silenceCheckinsEnabled: true },
        });
        controller.startSession();
        controller._setHasSpoken(true);
        fake.tick(11); // past silenceCheckinSec
        expect(controller.shouldRespond()).toBe(TurnDecision.CheckIn);
    });

    it('does not check in if disabled', () => {
        const { controller, fake } = makeController({
            config: { silenceCheckinSec: 10, silenceCheckinsEnabled: false },
        });
        controller.startSession();
        controller._setHasSpoken(true);
        fake.tick(100);
        expect(controller.shouldRespond()).toBe(TurnDecision.Wait);
    });

    it('does not check in before the meditator has spoken at all', () => {
        const { controller, fake } = makeController({
            config: { silenceCheckinSec: 10 },
        });
        controller.startSession();
        fake.tick(100);
        expect(controller.shouldRespond()).toBe(TurnDecision.Wait);
    });

    it('returns HOLD while in silence mode regardless of timing', () => {
        const { controller, fake } = makeController();
        controller.startSession();
        controller.enterSilenceMode();
        fake.tick(600);
        expect(controller.shouldRespond()).toBe(TurnDecision.Hold);
    });
});

describe('PacingController — transcription', () => {
    it('always returns RESPOND for a transcription', () => {
        const { controller } = makeController();
        controller.startSession();
        controller.onSpeechEnd();
        expect(controller.onTranscription('I notice warmth')).toBe(TurnDecision.Respond);
    });

    it('auto-exits silence mode when transcription arrives', () => {
        const { controller } = makeController();
        controller.startSession();
        controller.enterSilenceMode();
        expect(controller.isInSilenceMode()).toBe(true);
        controller.onTranscription("I'm ready");
        expect(controller.isInSilenceMode()).toBe(false);
        expect(controller.state).toBe(ConversationState.Listening);
    });
});

describe('PacingConfig defaults', () => {
    it('exposes the full set of facilitation + VAD knobs with sensible defaults', () => {
        expect(defaultPacingConfig).toEqual({
            responseDelayMs: 2000,
            silenceCheckinSec: 300,
            silenceCheckinsEnabled: true,
            silenceModeEnabled: true,
            silenceBaseMs: 3000,
            silenceMaxMs: 5000,
            silenceRampRate: 0.25,
            minSpeechDurationMs: 500,
        });
    });

    it('accepts a partial config override (other fields fall back to defaults)', () => {
        const { controller } = makeController({
            config: { silenceModeEnabled: false, silenceCheckinsEnabled: false },
        });
        expect(controller.config.silenceModeEnabled).toBe(false);
        expect(controller.config.silenceCheckinsEnabled).toBe(false);
        expect(controller.config.responseDelayMs).toBe(defaultPacingConfig.responseDelayMs);
        expect(controller.config.silenceBaseMs).toBe(defaultPacingConfig.silenceBaseMs);
    });
});
