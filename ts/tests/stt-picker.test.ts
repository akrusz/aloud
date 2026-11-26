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
    hostedSttDefault,
    resolveSttChoice,
    sttBackendForChoice,
    sttLangTag,
    sttSettingKey,
    sttChoiceForMode,
    cloudSttCreditsPerHour,
    setCloudSttCreditsPerHour,
    setupHostedChoice,
    sttModelForChoice,
} from '../ui/src/adapters/stt-picker.js';
import type { HostedSttChoice, SttEngineChoice } from '../ui/src/app-settings.js';
import { isTauri, isCapacitor } from '../ui/src/is-desktop.js';
import { setUiLang } from '../ui/src/i18n.js';

const isTauriMock = vi.mocked(isTauri);
const isCapacitorMock = vi.mocked(isCapacitor);

beforeEach(() => {
    isTauriMock.mockReturnValue(false); // default: a browser
    isCapacitorMock.mockReturnValue(false);
});

describe('sttEngineOptions — browser (non-Tauri; no Web Speech in Node)', () => {
    it('local mode offers only the hosted option — no on-device Whisper in a browser', () => {
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['aloud-gpt-transcribe']);
    });
    it('web mode offers only the hosted option', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe']);
    });
});

describe('sttEngineOptions — desktop (Tauri)', () => {
    beforeEach(() => isTauriMock.mockReturnValue(true));
    it('local mode offers Whisper then the hosted option', () => {
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['whisper', 'aloud-gpt-transcribe']);
    });
    it('web mode still hides Whisper (local-only)', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe']);
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
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['web-speech', 'aloud-gpt-transcribe']);
    });
    it('hides web-speech under Tauri even though the WKWebView exposes the API', () => {
        // Recognition silently never returns results in the embedded webview —
        // offering it gives a pulsing mic that can't transcribe.
        isTauriMock.mockReturnValue(true);
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['whisper', 'aloud-gpt-transcribe']);
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
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe']);
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
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe']);
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
        ]);
    });
});

describe('sttEngineOptions — native mobile (Capacitor)', () => {
    // The native app always runs in web mode. aloud cloud leads and is the
    // default, the platform recognizer follows; the flaky WebView web-speech is
    // not offered.
    beforeEach(() => isCapacitorMock.mockReturnValue(true));

    it('offers aloud cloud first, then the built-in recognizer', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe', 'capacitor']);
    });

    // No privacy promise: it's the PLATFORM's recognizer and Android's routes to
    // Google ("private" went in 580e049, "On-device" after it; sn1w tracks
    // earning it back).
    it('labels it for what it is, with no on-device or privacy claim', () => {
        const label = sttEngineOptions(true).find((o) => o.value === 'capacitor')!.label;
        expect(label).toBe('Built-in transcription');
        expect(label.toLowerCase()).not.toMatch(/private|on-device|local/);
    });
    it('defaults to aloud cloud', () => {
        expect(defaultSttChoice(true)).toBe('aloud-gpt-transcribe');
    });
    it('does not offer web-speech even if the WebView exposes it', () => {
        (globalThis as unknown as { window: unknown }).window = {
            webkitSpeechRecognition: class {},
        };
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe', 'capacitor']);
        delete (globalThis as unknown as { window?: unknown }).window;
    });
    describe('sparse-speech modes (noting)', () => {
        // Noting hears one-word labels and no facilitator, and the store
        // listings promise it works with no account, so the free recognizer
        // leads there and the pick is stored apart (sttSettingKey, keyed on
        // ModeSpec.sparseSpeech so a future talky mode lands with exploration).
        it('offers the built-in recognizer first, then aloud cloud', () => {
            expect(sttEngineOptions(true, 'noting').map((o) => o.value)).toEqual([
                'capacitor',
                'aloud-gpt-transcribe',
            ]);
            expect(defaultSttChoice(true, 'noting')).toBe('capacitor');
        });
        it('keeps a separate pick from the facilitated modes', () => {
            expect(sttSettingKey('noting')).toBe('sparseSttEngine');
            expect(sttSettingKey('exploration')).toBe('sttEngine');
            expect(sttSettingKey('felt_sense')).toBe('sttEngine');
            const settings = { sttEngine: 'aloud-gpt-transcribe' as const, sparseSttEngine: null };
            expect(sttChoiceForMode(settings, true, 'noting')).toBe('capacitor');
            expect(sttChoiceForMode(settings, true, 'exploration')).toBe('aloud-gpt-transcribe');
            expect(
                sttChoiceForMode({ sttEngine: null, sparseSttEngine: 'aloud-gpt-transcribe' }, true, 'noting')
            ).toBe('aloud-gpt-transcribe');
        });
        it('is the same list as the other modes off the phone', () => {
            isCapacitorMock.mockReturnValue(false);
            expect(sttEngineOptions(true, 'noting').map((o) => o.value)).toEqual(['aloud-gpt-transcribe']);
        });
    });

    it('resolveSttChoice honors a stored on-device pick', () => {
        expect(resolveSttChoice('capacitor', true)).toBe('capacitor');
    });
    it("maps the 'capacitor' choice to the capacitor backend (non-continuous)", () => {
        expect(sttBackendForChoice('capacitor')).toBe('capacitor');
    });
});

describe('hosted STT', () => {
    it('badges the hosted entry with its rate, and only it', () => {
        const opts = sttEngineOptions(true);
        const badgeOf = (v: string) => opts.find((o) => o.value === v)!.label.match(/\((.*)\)/)?.[1];
        expect(badgeOf('aloud-gpt-transcribe')).toMatch(/☁$/);
        // Free engines carry no badge at all.
        expect(opts.find((o) => o.value === 'whisper')?.label ?? '').not.toContain('☁');
    });
    it('maps every hosted choice to the continuous PCM backend', () => {
        for (const c of ['aloud-gpt-transcribe', 'aloud-hybrid', 'aloud-parakeet', 'aloud-grok'] as const) {
            expect(sttBackendForChoice(c)).toBe('server-whisper');
        }
    });
    it("drops a stored 'aloud' pick from before gpt-transcribe replaced it", () => {
        // The retired gpt-4o-transcribe choice (meditation-pal-vazw). No
        // migration: it is simply no longer offered, so it resolves to default.
        expect(resolveSttChoice('aloud' as SttEngineChoice, true)).toBe('aloud-gpt-transcribe');
    });
    it('resolveSttChoice honors a stored gpt-transcribe pick in every mode', () => {
        expect(resolveSttChoice('aloud-gpt-transcribe', true)).toBe('aloud-gpt-transcribe');
        expect(resolveSttChoice('aloud-gpt-transcribe', false)).toBe('aloud-gpt-transcribe');
    });
});

describe('hosted STT by language', () => {
    afterEach(() => setUiLang('en'));

    it('offers GPT in English, GPT and Grok in Chinese', () => {
        expect(sttEngineOptions(true, 'exploration', 'en').map((o) => o.value)).toEqual(['aloud-gpt-transcribe']);
        expect(sttEngineOptions(true, 'exploration', 'zh').map((o) => o.value)).toEqual([
            'aloud-gpt-transcribe',
            'aloud-grok',
        ]);
    });
    it('follows the language setting when none is passed', () => {
        setUiLang('zh');
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud-gpt-transcribe', 'aloud-grok']);
    });
    it('labels each by its model, with its rate', () => {
        const label = (lang: 'en' | 'zh', v: string) =>
            sttEngineOptions(true, 'exploration', lang).find((o) => o.value === v)!.label;
        expect(label('en', 'aloud-gpt-transcribe')).toMatch(/^GPT .*☁/);
        expect(label('zh', 'aloud-grok')).toMatch(/^Grok .*☁/);
    });
    it('defaults aloud cloud to GPT in English and in Chinese', () => {
        // Browser and phone, where aloud cloud leads; desktop's flow default
        // stays local Whisper, but its hosted default follows the language too.
        for (const phone of [false, true]) {
            isCapacitorMock.mockReturnValue(phone);
            setUiLang('en');
            expect(defaultSttChoice(true)).toBe('aloud-gpt-transcribe');
            setUiLang('zh');
            expect(defaultSttChoice(true)).toBe('aloud-gpt-transcribe');
        }
        isCapacitorMock.mockReturnValue(false);
        isTauriMock.mockReturnValue(true);
        setUiLang('en');
        expect(defaultSttChoice(false)).toBe('whisper');
        expect(hostedSttDefault(false)).toBe('aloud-gpt-transcribe');
        setUiLang('zh');
        expect(defaultSttChoice(false)).toBe('whisper');
        expect(hostedSttDefault(false)).toBe('aloud-gpt-transcribe');
    });
    it("keeps a hosted pick the language drops on aloud cloud, on the language's default, not the local default", () => {
        isTauriMock.mockReturnValue(true); // desktop: the flow default would be Whisper
        setUiLang('zh');
        expect(resolveSttChoice('aloud-hybrid', false)).toBe('aloud-gpt-transcribe');
        setUiLang('en');
        expect(resolveSttChoice('aloud-grok', false)).toBe('aloud-gpt-transcribe');
    });
});

describe('Parakeet alone, no longer offered', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        setUiLang('en');
    });
    const devMode = (on: boolean) =>
        vi.stubGlobal('localStorage', { getItem: (k: string) => (on && k === 'aloud:devMode' ? '1' : null) });

    it('is in no list, in any language, mode or platform', () => {
        for (const lang of ['en', 'zh'] as const) {
            for (const [tauri, phone] of [
                [false, false],
                [true, false],
                [false, true],
            ] as const) {
                isTauriMock.mockReturnValue(tauri);
                isCapacitorMock.mockReturnValue(phone);
                for (const mode of ['exploration', 'noting'] as const) {
                    for (const web of [false, true]) {
                        const values = sttEngineOptions(web, mode, lang).map((o) => o.value);
                        expect(values).not.toContain('aloud-parakeet');
                    }
                }
            }
        }
    });
    it('is not listed even as the pick in force', () => {
        expect(sttEngineOptions(true, 'exploration', 'en', 'aloud-parakeet').map((o) => o.value)).toEqual([
            'aloud-gpt-transcribe',
        ]);
    });
    it('runs a stored pick as Hybrid in English with developer mode off, never a local default', () => {
        devMode(false);
        expect(resolveSttChoice('aloud-parakeet', true)).toBe('aloud-hybrid');
        isTauriMock.mockReturnValue(true); // desktop: the flow default is Whisper
        expect(resolveSttChoice('aloud-parakeet', false)).toBe('aloud-hybrid');
        isTauriMock.mockReturnValue(false);
        isCapacitorMock.mockReturnValue(true);
        expect(sttChoiceForMode({ sttEngine: 'aloud-parakeet', sparseSttEngine: null }, true, 'exploration')).toBe(
            'aloud-hybrid'
        );
        expect(sttChoiceForMode({ sttEngine: null, sparseSttEngine: 'aloud-parakeet' }, true, 'noting')).toBe(
            'aloud-hybrid'
        );
    });
    it('keeps that Hybrid in the options as the pick in force, and Hybrid off everyone else\'s', () => {
        devMode(false);
        const inForce = resolveSttChoice('aloud-parakeet', true);
        expect(sttEngineOptions(true, 'exploration', 'en', inForce).map((o) => o.value)).toEqual([
            'aloud-gpt-transcribe',
            'aloud-hybrid',
        ]);
        expect(sttEngineOptions(true, 'exploration', 'en', resolveSttChoice(null, true)).map((o) => o.value)).toEqual([
            'aloud-gpt-transcribe',
        ]);
    });
    it('records Hybrid and its two models in the run record', () => {
        devMode(false);
        const ran = resolveSttChoice('aloud-parakeet', true);
        expect(ran).toBe('aloud-hybrid');
        expect(sttModelForChoice(ran, 'base')).toBe('gpt-transcribe<=3s,moondream/parakeet-ultra');
    });
    it('resolves a stored pick to GPT in Chinese, where Hybrid is not offered', () => {
        for (const on of [false, true]) {
            devMode(on);
            setUiLang('zh');
            expect(resolveSttChoice('aloud-parakeet', true)).toBe('aloud-gpt-transcribe');
            isTauriMock.mockReturnValue(true);
            expect(resolveSttChoice('aloud-parakeet', false)).toBe('aloud-gpt-transcribe');
            isTauriMock.mockReturnValue(false);
        }
    });
    it('leaves someone with no pick on GPT, developer mode or not', () => {
        for (const on of [false, true]) {
            devMode(on);
            expect(resolveSttChoice(null, true)).toBe('aloud-gpt-transcribe');
            expect(sttChoiceForMode({ sttEngine: null, sparseSttEngine: null }, true, 'exploration')).toBe(
                'aloud-gpt-transcribe'
            );
        }
    });
    it('is heard on GPT on the setup screen, in the tour too', () => {
        for (const touring of [false, true]) {
            const built = resolveSttChoice('aloud-parakeet', true) as HostedSttChoice;
            expect(setupHostedChoice(built, 'aloud-parakeet', touring, 'en')).toBe('aloud-gpt-transcribe');
        }
    });
});

describe('Hybrid: GPT for short passes, Parakeet for long ones', () => {
    const devMode = (on: boolean) =>
        vi.stubGlobal('localStorage', { getItem: (k: string) => (on && k === 'aloud:devMode' ? '1' : null) });
    afterEach(() => {
        vi.unstubAllGlobals();
        setUiLang('en');
    });

    it('is listed after GPT with developer mode on, in English only', () => {
        devMode(true);
        expect(sttEngineOptions(true, 'exploration', 'en').map((o) => o.value)).toEqual([
            'aloud-gpt-transcribe',
            'aloud-hybrid',
        ]);
        expect(sttEngineOptions(true, 'exploration', 'zh').map((o) => o.value)).toEqual([
            'aloud-gpt-transcribe',
            'aloud-grok',
        ]);
        expect(sttEngineOptions(true, 'exploration', 'en').find((o) => o.value === 'aloud-hybrid')!.label).toMatch(
            /^Hybrid .*☁/
        );
        // Never the default.
        expect(defaultSttChoice(true)).toBe('aloud-gpt-transcribe');
        expect(hostedSttDefault(true)).toBe('aloud-gpt-transcribe');
    });
    it('is not listed with developer mode off', () => {
        devMode(false);
        expect(sttEngineOptions(true, 'exploration', 'en').map((o) => o.value)).toEqual(['aloud-gpt-transcribe']);
    });
    it('keeps a stored pick working with developer mode turned off, listed only as the pick in force', () => {
        devMode(false);
        expect(resolveSttChoice('aloud-hybrid', true)).toBe('aloud-hybrid');
        expect(sttChoiceForMode({ sttEngine: 'aloud-hybrid', sparseSttEngine: null }, true, 'exploration')).toBe(
            'aloud-hybrid'
        );
        expect(sttEngineOptions(true, 'exploration', 'en', 'aloud-hybrid').map((o) => o.value)).toEqual([
            'aloud-gpt-transcribe',
            'aloud-hybrid',
        ]);
    });
    it('drops to GPT in a Chinese session', () => {
        devMode(true);
        setUiLang('zh');
        expect(resolveSttChoice('aloud-hybrid', true)).toBe('aloud-gpt-transcribe');
    });
    it('is heard on GPT on the setup screen, in the tour and out of it', () => {
        for (const touring of [false, true]) {
            expect(setupHostedChoice('aloud-hybrid', 'aloud-hybrid', touring, 'en')).toBe('aloud-gpt-transcribe');
        }
        // Picked during a tour that began on GPT.
        expect(setupHostedChoice('aloud-gpt-transcribe', 'aloud-hybrid', true, 'en')).toBe('aloud-gpt-transcribe');
    });
    it("shows Parakeet's published rate, which is already the mix, and nothing of GPT's on top", () => {
        setCloudSttCreditsPerHour(1.01, { 'gpt-transcribe': 1.01, 'moondream/parakeet-ultra': 0.31 });
        expect(cloudSttCreditsPerHour('aloud-hybrid')).toBe(0.31);
        setCloudSttCreditsPerHour(2, { 'gpt-transcribe': 2, 'moondream/parakeet-ultra': 1 });
        expect(cloudSttCreditsPerHour('aloud-hybrid')).toBe(1);
    });
    it('shows, before the server rates arrive, the seed the server will publish (estimateStt)', async () => {
        vi.resetModules();
        const fresh = await import('../ui/src/adapters/stt-picker.js');
        expect(fresh.cloudSttCreditsPerHour('aloud-hybrid')).toBe(0.31);
    });
    it('renders its badge in the picker', () => {
        devMode(true);
        setCloudSttCreditsPerHour(1.01, { 'gpt-transcribe': 1.01, 'moondream/parakeet-ultra': 0.31 });
        expect(sttEngineOptions(true, 'exploration', 'en').find((o) => o.value === 'aloud-hybrid')!.label).toBe(
            'Hybrid (<1☁)'
        );
    });
    it('names both models and the cut in the run record', () => {
        expect(sttModelForChoice('aloud-hybrid', 'base')).toBe('gpt-transcribe<=3s,moondream/parakeet-ultra');
        expect(sttModelForChoice('aloud-gpt-transcribe', 'base')).toBe('gpt-transcribe');
        expect(sttModelForChoice('whisper', 'base')).toBe('base');
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
        expect(resolveSttChoice('whisper', false)).toBe('whisper');
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
        expect(cloudSttCreditsPerHour('aloud-gpt-transcribe')).toBeGreaterThan(0);
        expect(cloudSttCreditsPerHour('whisper')).toBe(0);
        expect(cloudSttCreditsPerHour('web-speech')).toBe(0);
        expect(cloudSttCreditsPerHour('capacitor')).toBe(0);
    });

    it('adopts the server rate from /me/models over the built-in seed', () => {
        setCloudSttCreditsPerHour(0.42);
        expect(cloudSttCreditsPerHour('aloud-gpt-transcribe')).toBe(0.42);
    });

    it('adopts a rate per hosted model, keyed by the model each choice sends', () => {
        setCloudSttCreditsPerHour(1.9, {
            'gpt-transcribe': 1.8,
            'moondream/parakeet-ultra': 0.4,
            'x-ai/grok-stt-2.0': 0.7,
        });
        expect(cloudSttCreditsPerHour('aloud-gpt-transcribe')).toBe(1.8);
        expect(cloudSttCreditsPerHour('aloud-parakeet')).toBe(0.4);
        expect(cloudSttCreditsPerHour('aloud-grok')).toBe(0.7);
        expect(cloudSttCreditsPerHour('aloud-hybrid')).toBe(0.4);
    });

    it("takes an older server's single rate for GPT alone", () => {
        setCloudSttCreditsPerHour(0.4, { 'moondream/parakeet-ultra': 0.3 });
        setCloudSttCreditsPerHour(0.5);
        expect(cloudSttCreditsPerHour('aloud-gpt-transcribe')).toBe(0.5);
        expect(cloudSttCreditsPerHour('aloud-parakeet')).toBe(0.3);
    });

    it('keeps the last good rate when the server sends nothing usable', () => {
        // An older server, a trimmed payload, or a zero must never make a paid
        // leg read as free.
        setCloudSttCreditsPerHour(0.42);
        for (const bad of [undefined, null, 0, -1, NaN]) {
            setCloudSttCreditsPerHour(bad);
            expect(cloudSttCreditsPerHour('aloud-gpt-transcribe')).toBe(0.42);
        }
    });
});

describe('setupHostedChoice: the hosted model setup listening asks for', () => {
    afterEach(() => setUiLang('en'));

    /** What a listener built for this stored pick asks for, in or out of the tour. */
    function heard(stored: SttEngineChoice | null, touring: boolean, lang: 'en' | 'zh' = 'en'): SttEngineChoice {
        setUiLang(lang);
        const built = resolveSttChoice(stored, true);
        return setupHostedChoice(built as HostedSttChoice, stored, touring, lang);
    }

    it('hears the tour on GPT for someone who never picked, in English', () => {
        expect(heard(null, true)).toBe('aloud-gpt-transcribe');
    });
    it('is on the default once the tour is over', () => {
        expect(heard(null, false)).toBe('aloud-gpt-transcribe');
    });
    it('keeps a stored pick in the tour', () => {
        expect(heard('aloud-gpt-transcribe', true)).toBe('aloud-gpt-transcribe');
        expect(heard('aloud-gpt-transcribe', false)).toBe('aloud-gpt-transcribe');
    });
    it('changes nothing in 中文, where the default is GPT already', () => {
        expect(heard(null, true, 'zh')).toBe('aloud-gpt-transcribe');
        expect(heard(null, false, 'zh')).toBe('aloud-gpt-transcribe');
        expect(heard('aloud-grok', true, 'zh')).toBe('aloud-grok');
        // A Hybrid pick 中文 drops is on the language's default.
        expect(heard('aloud-hybrid', true, 'zh')).toBe('aloud-gpt-transcribe');
    });
    it('takes a hosted pick made during the tour at once, on the same listener', () => {
        expect(setupHostedChoice('aloud-gpt-transcribe', 'aloud-grok', true, 'zh')).toBe('aloud-grok');
        expect(setupHostedChoice('aloud-grok', 'aloud-gpt-transcribe', true, 'zh')).toBe('aloud-gpt-transcribe');
        expect(setupHostedChoice('aloud-grok', null, true, 'zh')).toBe('aloud-gpt-transcribe');
    });
    it('stays on the listener for another kind of pick made during the tour, which waits for its end', () => {
        // The tour keeps one recognizer (views/setup.ts tourChoice); the pick
        // is still a pick, so the tour is no longer heard on GPT.
        for (const stored of ['capacitor', 'whisper', 'web-speech'] as const) {
            expect(setupHostedChoice('aloud-grok', stored, true, 'zh')).toBe('aloud-grok');
        }
    });
    it('is never asked where the unpicked default is not hosted', () => {
        // Desktop: local Whisper. A phone's noting: the built-in recognizer.
        // Neither builds a hosted engine, so nothing asks for a model.
        isTauriMock.mockReturnValue(true);
        expect(resolveSttChoice(null, false)).toBe('whisper');
        isTauriMock.mockReturnValue(false);
        isCapacitorMock.mockReturnValue(true);
        expect(resolveSttChoice(null, true, 'noting')).toBe('capacitor');
    });
});
