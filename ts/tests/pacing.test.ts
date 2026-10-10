import { describe, it, expect } from 'vitest';

import {
    PacingController,
    TurnDecision,
    defaultPacingConfig,
    type PacingConfig,
} from '../src/facilitation/pacing.js';
import { createFakeClock } from '../src/clock.js';

function makeController(opts?: { config?: Partial<PacingConfig> }) {
    const fake = createFakeClock(1_000_000);
    const controller = new PacingController({
        clock: fake.clock,
        ...(opts?.config !== undefined && { config: opts.config }),
    });
    return { controller, fake };
}

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

    it('setCheckinInterval overrides the configured interval (sticky, clearable)', () => {
        const { controller, fake } = makeController({
            config: { silenceCheckinSec: 10, silenceCheckinsEnabled: true },
        });
        controller.startSession();
        controller._setHasSpoken(true);
        controller.setCheckinInterval(600);
        fake.tick(11); // past config, before override
        expect(controller.shouldRespond()).toBe(TurnDecision.Wait);
        fake.tick(590); // past override
        expect(controller.shouldRespond()).toBe(TurnDecision.CheckIn);
        controller.setCheckinInterval(null);
        expect(controller.getCheckinInterval()).toBe(10);
    });

    it('setCheckinInterval clamps to sane bounds', () => {
        const { controller } = makeController();
        controller.setCheckinInterval(5);
        expect(controller.getCheckinInterval()).toBe(30);
        controller.setCheckinInterval(999_999);
        expect(controller.getCheckinInterval()).toBe(3600);
    });

    it('getCheckinEtaSec counts down from the effective interval', () => {
        const { controller, fake } = makeController({
            config: { silenceCheckinSec: 100 },
        });
        controller.startSession();
        expect(controller.getCheckinEtaSec()).toBe(100);
        fake.tick(40);
        expect(controller.getCheckinEtaSec()).toBe(60);
        controller.setCheckinInterval(600);
        expect(controller.hasCheckinOverride()).toBe(true);
        expect(controller.getCheckinEtaSec()).toBe(560);
        fake.tick(1000);
        expect(controller.getCheckinEtaSec()).toBe(0);
    });

    it('startSession clears a check-in interval override', () => {
        const { controller } = makeController({
            config: { silenceCheckinSec: 10 },
        });
        controller.setCheckinInterval(600);
        controller.startSession();
        expect(controller.getCheckinInterval()).toBe(10);
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
    it('auto-exits silence mode when transcription arrives', () => {
        const { controller } = makeController();
        controller.startSession();
        controller.enterSilenceMode();
        expect(controller.shouldRespond()).toBe(TurnDecision.Hold);
        controller.onTranscription();
        expect(controller.shouldRespond()).not.toBe(TurnDecision.Hold);
    });
});

describe('PacingConfig defaults', () => {
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
