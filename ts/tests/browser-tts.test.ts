import { describe, it, expect, vi, afterEach } from 'vitest';

import { BrowserTtsEngine } from '../ui/src/adapters/browser-tts.js';

/** Minimal SpeechSynthesisUtterance stand-in that captures the event handlers
 *  BrowserTtsEngine wires, so a test can fire onend / onerror by hand. */
class FakeUtterance {
    text: string;
    rate = 1;
    pitch = 1;
    voice: unknown = null;
    lang = '';
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    constructor(text: string) {
        this.text = text;
    }
}

function stubSpeechSynthesis(): { spoken: FakeUtterance[] } {
    const spoken: FakeUtterance[] = [];
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', {
        speak: (u: FakeUtterance) => spoken.push(u),
        cancel: () => {},
        resume: () => {},
        getVoices: () => [],
    });
    return { spoken };
}

afterEach(() => vi.unstubAllGlobals());

describe('BrowserTtsEngine.speak error handling', () => {
    it('rejects on a genuine synthesis error (the silent-preview bug)', async () => {
        const { spoken } = stubSpeechSynthesis();
        const engine = new BrowserTtsEngine();
        const p = engine.speak('hello');
        spoken.at(-1)!.onerror!({ error: 'synthesis-failed' });
        await expect(p).rejects.toThrow(/synthesis-failed/);
    });

    it('resolves quietly on interrupted/canceled (our own cancel churn)', async () => {
        const { spoken } = stubSpeechSynthesis();
        const engine = new BrowserTtsEngine();
        for (const code of ['interrupted', 'canceled']) {
            const p = engine.speak('hello');
            spoken.at(-1)!.onerror!({ error: code });
            await expect(p).resolves.toBeUndefined();
        }
    });

    it('resolves on normal end', async () => {
        const { spoken } = stubSpeechSynthesis();
        const engine = new BrowserTtsEngine();
        const p = engine.speak('hello');
        spoken.at(-1)!.onend!();
        await expect(p).resolves.toBeUndefined();
    });
});
