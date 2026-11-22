import { describe, expect, it } from 'vitest';
import type { BeginMode, Quality, SetupFocus, Verbosity } from '../src/facilitation/index.js';
import { parseSetupCommand, setupOutcomeLines } from '../src/facilitation/index.js';
import { applySetupAction, applySetupActions, type SetupForm } from '../ui/src/setup-actions.js';

/** A setup form with no screen behind it. */
function form(start: Partial<{ mode: BeginMode; locked: boolean }> = {}) {
    const state = {
        mode: start.mode ?? ('exploration' as BeginMode),
        timer: null as number | null,
        clockShown: true,
        clockMode: 'elapsed' as 'elapsed' | 'wall',
        focuses: ['body_sensations', 'emotions'] as SetupFocus[],
        qualities: [] as Quality[],
        guidance: 3,
        verbosity: 'medium' as Verbosity,
        intention: '',
        requests: '',
        checkins: true,
    };
    const f: SetupForm = {
        mode: () => state.mode,
        selectMode: (mode) => {
            if (start.locked && mode !== state.mode) return false;
            state.mode = mode;
            return true;
        },
        setTimer: (minutes) => (state.timer = Math.max(1, Math.min(180, minutes))),
        clearTimer: () => void (state.timer = null),
        setClockVisible: (show) => void (state.clockShown = show),
        setClockMode: (mode) => {
            state.clockMode = mode;
            state.clockShown = true;
        },
        focuses: () => state.focuses,
        setFocuses: (list) => void (state.focuses = list),
        qualities: () => state.qualities,
        setQualities: (list) => void (state.qualities = list),
        guidance: () => state.guidance,
        setGuidance: (level) => void (state.guidance = level),
        verbosity: () => state.verbosity,
        setVerbosity: (value) => void (state.verbosity = value),
        setIntention: (text) => void (state.intention = text),
        specialRequests: () => state.requests,
        setSpecialRequests: (text) => void (state.requests = text),
        setCheckins: (on) => void (state.checkins = on),
    };
    return { f, state };
}

describe('applySetupAction', () => {
    it('changes the mode and reports the one now on screen', () => {
        const { f, state } = form();
        expect(applySetupAction(f, { kind: 'mode', mode: 'noting' })).toEqual({ kind: 'mode', mode: 'noting' });
        expect(state.mode).toBe('noting');
    });

    it('says so when a continuation holds the mode', () => {
        const { f, state } = form({ locked: true });
        expect(applySetupAction(f, { kind: 'mode', mode: 'noting' })).toEqual({ kind: 'unavailable' });
        expect(state.mode).toBe('exploration');
    });

    it('reports the timer as clamped', () => {
        const { f } = form();
        expect(applySetupAction(f, { kind: 'length', minutes: 500 })).toEqual({ kind: 'length', minutes: 180 });
        expect(applySetupAction(f, { kind: 'no-timer' })).toEqual({ kind: 'no-timer' });
    });

    it('adds and removes without doubling', () => {
        const { f, state } = form();
        applySetupAction(f, { kind: 'quality', quality: 'playful', on: true });
        applySetupAction(f, { kind: 'quality', quality: 'playful', on: true });
        expect(state.qualities).toEqual(['playful']);
        applySetupAction(f, { kind: 'focus', focus: 'body_sensations', on: false });
        expect(state.focuses).toEqual(['emotions']);
        expect(applySetupAction(f, { kind: 'clear', group: 'focus' })).toEqual({ kind: 'cleared', group: 'focus' });
        expect(state.focuses).toEqual([]);
    });

    it('flips a toggle by what the form holds, and says which way it went', () => {
        const { f, state } = form();
        expect(applySetupAction(f, { kind: 'quality', quality: 'playful', on: 'toggle' })).toEqual({
            kind: 'quality',
            quality: 'playful',
            on: true,
        });
        expect(applySetupAction(f, { kind: 'quality', quality: 'playful', on: 'toggle' })).toEqual({
            kind: 'quality',
            quality: 'playful',
            on: false,
        });
        expect(state.qualities).toEqual([]);
        expect(applySetupAction(f, { kind: 'focus', focus: 'emotions', on: 'toggle' })).toEqual({
            kind: 'focus',
            focus: 'emotions',
            on: false,
        });
        expect(state.focuses).toEqual(['body_sensations']);
        expect(applySetupAction(form({ mode: 'noting' }).f, { kind: 'focus', focus: 'emotions', on: 'toggle' })).toEqual({
            kind: 'elsewhere',
            mode: 'exploration',
        });
    });

    it('steps the guidance and stops at the ends', () => {
        const { f, state } = form();
        expect(applySetupAction(f, { kind: 'guidance', to: 'up' })).toEqual({ kind: 'guidance', level: 4 });
        applySetupAction(f, { kind: 'guidance', to: 'up' });
        expect(applySetupAction(f, { kind: 'guidance', to: 'up' })).toEqual({ kind: 'guidance', level: 5 });
        expect(applySetupAction(f, { kind: 'guidance', to: 1 })).toEqual({ kind: 'guidance', level: 1 });
        expect(applySetupAction(f, { kind: 'guidance', to: 'down' })).toEqual({ kind: 'guidance', level: 1 });
        expect(state.guidance).toBe(1);
    });

    it('steps how much is said', () => {
        const { f } = form();
        expect(applySetupAction(f, { kind: 'verbosity', to: 'down' })).toEqual({ kind: 'verbosity', value: 'low' });
        expect(applySetupAction(f, { kind: 'verbosity', to: 'down' })).toEqual({ kind: 'verbosity', value: 'low' });
        expect(applySetupAction(f, { kind: 'verbosity', to: 'high' })).toEqual({ kind: 'verbosity', value: 'high' });
    });

    it('leaves a setting alone under a mode that has no such thing, and says whose it is', () => {
        const { f, state } = form({ mode: 'felt_sense' });
        expect(applySetupAction(f, { kind: 'quality', quality: 'playful', on: true })).toEqual({
            kind: 'elsewhere',
            mode: 'exploration',
        });
        expect(state.qualities).toEqual([]);
        expect(applySetupAction(f, { kind: 'checkins', on: false })).toEqual({ kind: 'checkins', on: false });

        const noting = form({ mode: 'noting' });
        expect(applySetupAction(noting.f, { kind: 'intention', text: 'rest' })).toEqual({ kind: 'elsewhere', mode: null });
        expect(applySetupAction(noting.f, { kind: 'checkins', on: true })).toEqual({ kind: 'elsewhere', mode: 'felt_sense' });
        expect(applySetupAction(noting.f, { kind: 'length', minutes: 10 })).toEqual({ kind: 'length', minutes: 10 });
    });

    it('sets and clears the intention of the mode on screen', () => {
        const { f, state } = form();
        expect(applySetupAction(f, { kind: 'intention', text: 'to rest' })).toEqual({ kind: 'intention', set: true });
        expect(state.intention).toBe('to rest');
        expect(applySetupAction(f, { kind: 'intention', text: '' })).toEqual({ kind: 'intention', set: false });
    });

    it('hides the clock and leaves a timer running, or turns the whole thing off', () => {
        const { f, state } = form();
        applySetupAction(f, { kind: 'length', minutes: 20 });
        expect(applySetupAction(f, { kind: 'clock', show: false })).toEqual({ kind: 'clock', show: false });
        expect(state).toMatchObject({ clockShown: false, timer: 20 });
        expect(applySetupAction(f, { kind: 'clock', show: true })).toEqual({ kind: 'clock', show: true });
        expect(applySetupAction(f, { kind: 'clock', show: false, timerOff: true })).toEqual({ kind: 'clock', show: false, off: true });
        expect(state).toMatchObject({ clockShown: false, timer: null });
        expect(applySetupAction(f, { kind: 'clock-mode', mode: 'wall' })).toEqual({ kind: 'clock-mode', mode: 'wall' });
        expect(state).toMatchObject({ clockShown: true, clockMode: 'wall' });
    });

    it('asks for an intention without changing one, and only where there is a field for it', () => {
        const { f, state } = form();
        applySetupAction(f, { kind: 'intention', text: 'to rest' });
        expect(applySetupAction(f, { kind: 'intention-ask' })).toEqual({ kind: 'intention-ask' });
        expect(state.intention).toBe('to rest');
        expect(applySetupAction(form({ mode: 'noting' }).f, { kind: 'intention-ask' })).toEqual({ kind: 'elsewhere', mode: null });
    });

    it('adds a special request on a line of its own, keeps what was there, and clears', () => {
        const { f, state } = form();
        state.requests = 'No bells.\n';
        expect(applySetupAction(f, { kind: 'special-request', text: 'keep it slow' })).toEqual({
            kind: 'special-request',
            added: true,
        });
        expect(state.requests).toBe('No bells.\nkeep it slow');
        applySetupAction(f, { kind: 'special-request', text: 'Keep it slow' });
        expect(state.requests).toBe('No bells.\nkeep it slow');
        expect(applySetupAction(f, { kind: 'special-request-ask' })).toEqual({ kind: 'special-request-ask' });
        expect(applySetupAction(f, { kind: 'special-request', text: '' })).toEqual({ kind: 'special-request', added: false });
        expect(state.requests).toBe('');
        applySetupAction(f, { kind: 'special-request', text: 'keep it slow' });
        expect(state.requests).toBe('keep it slow');
    });

    it('takes special requests under Exploration only, where the field is', () => {
        for (const mode of ['noting', 'felt_sense'] as const) {
            const { f, state } = form({ mode });
            expect(applySetupAction(f, { kind: 'special-request', text: 'slow' })).toEqual({ kind: 'elsewhere', mode: 'exploration' });
            expect(applySetupAction(f, { kind: 'special-request-ask' })).toEqual({ kind: 'elsewhere', mode: 'exploration' });
            expect(state.requests).toBe('');
        }
    });

    it('hands the mic requests back untouched', () => {
        const { f } = form();
        expect(applySetupAction(f, { kind: 'stop-listening' })).toEqual({ kind: 'stop-listening' });
        expect(applySetupAction(f, { kind: 'help' })).toEqual({ kind: 'help' });
    });
});

describe('a request, start to finish', () => {
    const said = (text: string, f: SetupForm): string[] =>
        setupOutcomeLines(applySetupActions(f, parseSetupCommand(text) ?? []), 'en').map((line) => line.text);

    it('replaces the vibes and says only what is on now', () => {
        const { f, state } = form();
        state.qualities = ['playful', 'loving'];
        expect(said('change the vibe to spacious', f)).toEqual(['Spacious is on.']);
        expect(state.qualities).toEqual(['spacious']);
    });

    it('a mode switched to in the same breath decides where the rest lands', () => {
        const { f, state } = form({ mode: 'noting' });
        expect(said('exploration and playful', f)).toEqual(['Okay, exploration mode.', 'Playful is on.']);
        expect(state.qualities).toEqual(['playful']);
    });

    it('switches the mode first, wherever it was said, so the rest lands in it', () => {
        const { f, state } = form({ mode: 'noting' });
        expect(said('playful exploration', f)).toEqual(['Okay, exploration mode.', 'Playful is on.']);
        expect(state.qualities).toEqual(['playful']);
    });

    it('flips a vibe or a focus said by its name alone, and says which way', () => {
        const { f, state } = form();
        expect(said('Playful.', f)).toEqual(['Playful is on.']);
        expect(said('Playful.', f)).toEqual(['Playful is off.']);
        expect(said('Body.', f)).toEqual(['Body focus is off.']);
        expect(said('add playful', f)).toEqual(['Playful is on.']);
        expect(said('add playful', f)).toEqual(['Playful is on.']);
        expect(said('remove emotions', f)).toEqual(['Emotions focus is off.']);
        expect(said('remove emotions', f)).toEqual(['Emotions focus is off.']);
        expect(state).toMatchObject({ qualities: ['playful'], focuses: [] });
    });

    it('asks for a special request, and says when one is added or cleared', () => {
        const { f, state } = form();
        expect(said('special requests', f)).toEqual(["What's your request?"]);
        expect(said('special request: keep it slow', f)).toEqual(['Added your request.']);
        expect(said('clear my special requests', f)).toEqual(['Special requests are cleared.']);
        expect(state.requests).toBe('');
    });

    it('says an odd length exactly, for a voice that can', () => {
        const { f } = form();
        expect(said('twenty five minutes', f)).toEqual(['Timer set for 25 minutes.']);
        expect(said('twenty minutes', f)).toEqual(['Timer set for twenty minutes.']);
    });
});
