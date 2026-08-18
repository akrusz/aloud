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
    sttLangTag,
    cloudSttCreditsPerHour,
    setCloudSttCreditsPerHour,
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
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['aloud-gpt-transcribe', 'aloud']);
    });
    it('web mode offers only the hosted option', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe', 'aloud']);
    });
});

describe('sttEngineOptions — desktop (Tauri)', () => {
    beforeEach(() => isTauriMock.mockReturnValue(true));
    it('local mode offers Whisper then the hosted option', () => {
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['whisper', 'aloud-gpt-transcribe', 'aloud']);
    });
    it('web mode still hides Whisper (local-only)', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe', 'aloud']);
    });
});

describe('defaultSttChoice = first option in flow order', () => {
    it('browser local mode defaults to the hosted option', () => {
        expect(defaultSttChoice(false)).toBe('aloud-gpt-transcribe');
    });
    it('desktop local mode defaults to Whisper', () => {
        isTauriMock.mockReturnValue(true);
        expect(defaultSttChoice(false)).toBe('whisper');
    });
    it('web mode defaults to the hosted option', () => {
        expect(defaultSttChoice(true)).toBe('aloud-gpt-transcribe');
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
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['web-speech', 'aloud-gpt-transcribe', 'aloud']);
    });
    it('hides web-speech under Tauri even though the WKWebView exposes the API', () => {
        // Recognition silently never returns results in the embedded webview —
        // offering it gives a pulsing mic that can't transcribe.
        isTauriMock.mockReturnValue(true);
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['whisper', 'aloud-gpt-transcribe', 'aloud']);
    });
    it('a web-speech pick stored before the Tauri gate resolves to the desktop default', () => {
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice('web-speech', false)).toBe('whisper');
    });
});

describe('sttEngineOptions — iOS/iPadOS (WebKit exposes the API, unusably)', () => {
    // iOS 14.5+ DOES expose webkitSpeechRecognition, but it needs Dictation on,
    // ignores `continuous`, and won't restart outside a user gesture, so the
    // listen loop only produced mic-error toasts (meditation-pal-j8k1).
    beforeEach(() => {
        (globalThis as unknown as { window: unknown }).window = {
            webkitSpeechRecognition: class {},
        };
        vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone' });
    });
    afterEach(() => {
        delete (globalThis as unknown as { window?: unknown }).window;
        vi.unstubAllGlobals();
    });

    it('does not offer web-speech on an iPhone', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe', 'aloud']);
    });
    it('defaults an iPhone to aloud cloud, not the browser recognizer', () => {
        expect(defaultSttChoice(true)).toBe('aloud-gpt-transcribe');
    });
    it('drops a web-speech pick stored before this gate', () => {
        expect(resolveSttChoice('web-speech', true)).toBe('aloud-gpt-transcribe');
    });
    it('also covers iPadOS desktop-mode Safari (MacIntel + touch)', () => {
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            platform: 'MacIntel',
            maxTouchPoints: 5,
        });
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe', 'aloud']);
    });
    it('leaves a real Mac (no touch) on the browser recognizer', () => {
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            platform: 'MacIntel',
            maxTouchPoints: 0,
        });
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual([
            'web-speech',
            'aloud-gpt-transcribe',
            'aloud',
        ]);
    });
});

describe('sttEngineOptions — native mobile (Capacitor)', () => {
    // The native app always runs in web mode. The platform recognizer leads and
    // becomes the default; the flaky WebView web-speech is not offered.
    beforeEach(() => isCapacitorMock.mockReturnValue(true));

    it('offers the built-in recognizer first, then aloud cloud', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['capacitor', 'aloud-gpt-transcribe', 'aloud']);
    });

    // No privacy promise: it's the PLATFORM's recognizer and Android's routes to
    // Google ("private" went in 580e049, "On-device" after it; sn1w tracks
    // earning it back).
    it('labels it for what it is, with no on-device or privacy claim', () => {
        const label = sttEngineOptions(true).find((o) => o.value === 'capacitor')!.label;
        expect(label).toBe('Built-in speech');
        expect(label.toLowerCase()).not.toMatch(/private|on-device|local/);
    });
    it('defaults to the native on-device recognizer', () => {
        expect(defaultSttChoice(true)).toBe('capacitor');
    });
    it('does not offer web-speech even if the WebView exposes it', () => {
        (globalThis as unknown as { window: unknown }).window = {
            webkitSpeechRecognition: class {},
        };
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['capacitor', 'aloud-gpt-transcribe', 'aloud']);
        delete (globalThis as unknown as { window?: unknown }).window;
    });
    it('resolveSttChoice honors a stored on-device pick', () => {
        expect(resolveSttChoice('capacitor', true)).toBe('capacitor');
    });
    it("maps the 'capacitor' choice to the capacitor backend (non-continuous)", () => {
        expect(sttBackendForChoice('capacitor')).toBe('capacitor');
    });
});

describe('hosted STT options — the two cloud models', () => {
    it('shows the same rate badge on both hosted entries, and only those', () => {
        // Both bill the same leg at the same profile, so the badge must match;
        // the exact number tracks the measured STT profile and moves with it.
        const opts = sttEngineOptions(true);
        const badgeOf = (v: string) => opts.find((o) => o.value === v)!.label.match(/\((.*)\)/)?.[1];
        expect(badgeOf('aloud')).toMatch(/☁️$/);
        expect(badgeOf('aloud-gpt-transcribe')).toBe(badgeOf('aloud'));
        // Free engines carry no badge at all.
        expect(opts.find((o) => o.value === 'whisper')?.label ?? '').not.toContain('☁️');
    });
    it('maps the new hosted choice to the continuous PCM backend, like classic', () => {
        expect(sttBackendForChoice('aloud-gpt-transcribe')).toBe('server-whisper');
    });
    it('resolveSttChoice honors a stored gpt-transcribe pick in every mode', () => {
        expect(resolveSttChoice('aloud-gpt-transcribe', true)).toBe('aloud-gpt-transcribe');
        expect(resolveSttChoice('aloud-gpt-transcribe', false)).toBe('aloud-gpt-transcribe');
    });
});

describe('resolveSttChoice', () => {
    it('uses the flow default when nothing is stored', () => {
        expect(resolveSttChoice(null, false)).toBe('aloud-gpt-transcribe'); // browser
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice(null, false)).toBe('whisper'); // desktop
    });
    it('a capacitor pick outside the native app falls back to the mode default', () => {
        // Stored 'capacitor' but not in the native app (isCapacitor=false) → not
        // offered → hosted default, never a dead native plugin.
        expect(resolveSttChoice('capacitor', true)).toBe('aloud-gpt-transcribe');
    });
    it('honors a stored pick that is offered in this mode', () => {
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice('aloud', false)).toBe('aloud');
    });
    it('falls back to the default when the stored pick is not offered here', () => {
        // Whisper carried into web mode → hosted default.
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice('whisper', true)).toBe('aloud-gpt-transcribe');
        // Whisper stored but viewed in a browser (not offered) → hosted default.
        isTauriMock.mockReturnValue(false);
        expect(resolveSttChoice('whisper', false)).toBe('aloud-gpt-transcribe');
    });
});

describe('sttLangTag - the Language setting as a recognizer BCP-47 tag', () => {
    it('expands a bare code with its likely region', () => {
        expect(sttLangTag('en')).toBe('en-US');
        expect(sttLangTag('es')).toBe('es-ES');
        expect(sttLangTag('ja')).toBe('ja-JP');
        expect(sttLangTag('zh')).toBe('zh-CN');
    });
    it('passes through what it cannot expand', () => {
        expect(sttLangTag('not a tag')).toBe('not a tag');
    });
});

describe('cloudSttCreditsPerHour - the hosted STT leg of the session estimate', () => {
    it('is a small nonzero rate for hosted choices and zero for free ones', () => {
        expect(cloudSttCreditsPerHour('aloud')).toBeGreaterThan(0);
        expect(cloudSttCreditsPerHour('aloud-gpt-transcribe')).toBe(
            cloudSttCreditsPerHour('aloud')
        );
        expect(cloudSttCreditsPerHour('whisper')).toBe(0);
        expect(cloudSttCreditsPerHour('web-speech')).toBe(0);
        expect(cloudSttCreditsPerHour('capacitor')).toBe(0);
    });

    it('adopts the server rate from /me/models over the built-in seed', () => {
        setCloudSttCreditsPerHour(0.42);
        expect(cloudSttCreditsPerHour('aloud')).toBe(0.42);
    });

    it('keeps the last good rate when the server sends nothing usable', () => {
        // An older server, a trimmed payload, or a zero must never make a paid
        // leg read as free.
        setCloudSttCreditsPerHour(0.42);
        for (const bad of [undefined, null, 0, -1, NaN]) {
            setCloudSttCreditsPerHour(bad);
            expect(cloudSttCreditsPerHour('aloud')).toBe(0.42);
        }
    });
});
