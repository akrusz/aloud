/**
 * STT choice resolution + mode-aware options.
 *
 * Two gates shape the options: isWebSpeechSupported() (false in Node, so
 * 'web-speech' is never offered here) and isTauri() (gates the on-device
 * Whisper option — mocked below so we can assert both the desktop and browser
 * branches deterministically). The module's other is-desktop exports are kept
 * real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../ui/src/is-desktop.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../ui/src/is-desktop.js')>();
    return { ...actual, isTauri: vi.fn(() => false), isCapacitor: vi.fn(() => false) };
});

import {
    sttEngineOptions,
    defaultSttChoice,
    resolveSttChoice,
    sttBackendForChoice,
} from '../ui/src/adapters/stt-picker.js';
import { isTauri, isCapacitor } from '../ui/src/is-desktop.js';

const isTauriMock = vi.mocked(isTauri);
const isCapacitorMock = vi.mocked(isCapacitor);

beforeEach(() => {
    isTauriMock.mockReturnValue(false); // default: a browser
    isCapacitorMock.mockReturnValue(false);
});

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

describe('sttEngineOptions — Web Speech gating', () => {
    // Simulate an environment whose webview exposes webkitSpeechRecognition
    // (as the macOS WKWebView does) so isWebSpeechSupported() returns true.
    beforeEach(() => {
        (globalThis as unknown as { window: unknown }).window = {
            webkitSpeechRecognition: class {},
        };
    });
    afterEach(() => {
        delete (globalThis as unknown as { window?: unknown }).window;
    });

    it('offers web-speech in a browser that exposes the API', () => {
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['web-speech', 'aloud']);
    });
    it('hides web-speech under Tauri even though the WKWebView exposes the API', () => {
        // Recognition silently never returns results in the embedded webview —
        // offering it gives a pulsing mic that can't transcribe.
        isTauriMock.mockReturnValue(true);
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['whisper', 'aloud']);
    });
    it('a web-speech pick stored before the Tauri gate resolves to the desktop default', () => {
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice('web-speech', false)).toBe('whisper');
    });
});

describe('sttEngineOptions — native mobile (Capacitor)', () => {
    // The native app always runs in web mode. On-device (private) leads and
    // becomes the default; the flaky WebView web-speech is not offered.
    beforeEach(() => isCapacitorMock.mockReturnValue(true));

    it('offers On-device (private) first, then aloud cloud', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['capacitor', 'aloud']);
    });
    it('defaults to the native on-device recognizer', () => {
        expect(defaultSttChoice(true)).toBe('capacitor');
    });
    it('does not offer web-speech even if the WebView exposes it', () => {
        (globalThis as unknown as { window: unknown }).window = {
            webkitSpeechRecognition: class {},
        };
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['capacitor', 'aloud']);
        delete (globalThis as unknown as { window?: unknown }).window;
    });
    it('resolveSttChoice honors a stored on-device pick', () => {
        expect(resolveSttChoice('capacitor', true)).toBe('capacitor');
    });
    it("maps the 'capacitor' choice to the capacitor backend (non-continuous)", () => {
        expect(sttBackendForChoice('capacitor')).toBe('capacitor');
    });
});

describe('resolveSttChoice', () => {
    it('uses the flow default when nothing is stored', () => {
        expect(resolveSttChoice(null, false)).toBe('aloud'); // browser
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice(null, false)).toBe('whisper'); // desktop
    });
    it('a capacitor pick outside the native app falls back to the mode default', () => {
        // Stored 'capacitor' but not in the native app (isCapacitor=false) → not
        // offered → hosted default, never a dead native plugin.
        expect(resolveSttChoice('capacitor', true)).toBe('aloud');
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
