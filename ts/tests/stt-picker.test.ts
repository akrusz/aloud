/**
 * STT choice resolution + mode-aware options.
 *
 * Two gates shape the options: isWebSpeechSupported() (false in Node, so
 * 'web-speech' is never offered here) and isTauri() (gates the on-device
 * Whisper option — mocked below so we can assert both the desktop and browser
 * branches deterministically). The module's other is-desktop exports are kept
 * real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ui/src/is-desktop.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../ui/src/is-desktop.js')>();
    return { ...actual, isTauri: vi.fn(() => false) };
});

import {
    sttEngineOptions,
    defaultSttChoice,
    resolveSttChoice,
} from '../ui/src/adapters/stt-picker.js';
import { isTauri } from '../ui/src/is-desktop.js';

const isTauriMock = vi.mocked(isTauri);

beforeEach(() => isTauriMock.mockReturnValue(false)); // default: a browser

describe('sttEngineOptions — browser (non-Tauri; no Web Speech in Node)', () => {
    it('local mode offers only the hosted option — no on-device Whisper in a browser', () => {
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['aloud']);
    });
    it('web mode offers only the hosted option', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud']);
    });
});

describe('sttEngineOptions — desktop (Tauri)', () => {
    beforeEach(() => isTauriMock.mockReturnValue(true));
    it('local mode offers Whisper then the hosted option', () => {
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['whisper', 'aloud']);
    });
    it('web mode still hides Whisper (local-only)', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud']);
    });
});

describe('defaultSttChoice = first option in flow order', () => {
    it('browser local mode defaults to the hosted option', () => {
        expect(defaultSttChoice(false)).toBe('aloud');
    });
    it('desktop local mode defaults to Whisper', () => {
        isTauriMock.mockReturnValue(true);
        expect(defaultSttChoice(false)).toBe('whisper');
    });
    it('web mode defaults to the hosted option', () => {
        expect(defaultSttChoice(true)).toBe('aloud');
    });
});

describe('resolveSttChoice', () => {
    it('uses the flow default when nothing is stored', () => {
        expect(resolveSttChoice(null, false)).toBe('aloud'); // browser
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice(null, false)).toBe('whisper'); // desktop
    });
    it('honors a stored pick that is offered in this mode', () => {
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice('aloud', false)).toBe('aloud');
    });
    it('falls back to the default when the stored pick is not offered here', () => {
        // Whisper carried into web mode → hosted default.
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice('whisper', true)).toBe('aloud');
        // Whisper stored but viewed in a browser (not offered) → hosted default.
        isTauriMock.mockReturnValue(false);
        expect(resolveSttChoice('whisper', false)).toBe('aloud');
    });
});
