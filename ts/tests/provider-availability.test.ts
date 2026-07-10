import { describe, it, expect, beforeAll } from 'vitest';
import type { Capabilities } from '../ui/src/capabilities.js';

// settings.ts constructs a LocalStorageKv at import; give it a minimal stub so
// the module loads under Node, then import it dynamically.
let mod: typeof import('../ui/src/settings.js');
beforeAll(async () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: () => null,
        length: 0,
    } as Storage;
    mod = await import('../ui/src/settings.js');
});

const caps = (over: Partial<Capabilities>): Capabilities => ({
    flask: false,
    cloud: false,
    ollama: false,
    ...over,
});

describe('isProviderAvailable', () => {
    it('always offers BYOK providers (no capability requirement)', () => {
        const byok = mod.ALL_PROVIDERS.find((p) => p.value === 'openai')!;
        expect(mod.isProviderAvailable(byok, caps({}))).toBe(true);
    });

    it('local mode (desktop): removes nothing — even with no capability reachable', () => {
        // Runtime readiness is shown via the ✘/✱ markers (provider-markers.ts),
        // so the menu keeps every provider in local mode. caps all-false stands
        // in for "Ollama not running, cloud offline, CLI not logged in".
        const get = (v: string) => mod.ALL_PROVIDERS.find((p) => p.value === v)!;
        for (const v of ['aloud', 'ollama', 'claude_proxy', 'openai', 'anthropic']) {
            expect(mod.isProviderAvailable(get(v), caps({}))).toBe(true);
        }
    });

    it('web mode: aloud is always offered, reachable or not (status shown separately)', () => {
        // aloud cloud scales to zero when idle; hiding it while cold would make
        // the whole hosted app vanish mid-wake. It's always listed; the model
        // picker + Begin gate communicate whether it's reachable right now.
        const get = (v: string) => mod.ALL_PROVIDERS.find((p) => p.value === v)!;
        expect(mod.isProviderAvailable(get('aloud'), caps({ cloud: true }), { webMode: true })).toBe(true);
        expect(mod.isProviderAvailable(get('aloud'), caps({}), { webMode: true })).toBe(true);
    });

    it('in local mode, BYOK shows by default', () => {
        const byok = mod.ALL_PROVIDERS.find((p) => p.value === 'anthropic')!;
        expect(mod.isProviderAvailable(byok, caps({}), { webMode: false })).toBe(true);
    });

    it('in web mode, BYOK is hidden unless explicitly enabled', () => {
        const byok = mod.ALL_PROVIDERS.find((p) => p.value === 'anthropic')!;
        expect(mod.isProviderAvailable(byok, caps({ cloud: true }), { webMode: true })).toBe(false);
        expect(
            mod.isProviderAvailable(byok, caps({ cloud: true }), { webMode: true, allowByok: true })
        ).toBe(true);
    });

    it('web mode hides local providers even when a local daemon IS reachable', () => {
        // A forced-web dev session (or the hosted site) must not surface a stray
        // local Ollama / Flask the capability probe happened to find.
        const localUp = caps({ cloud: true, ollama: true, flask: true });
        expect(mod.isProviderAvailable(mod.ALL_PROVIDERS.find((p) => p.value === 'ollama')!, localUp, { webMode: true })).toBe(false);
        expect(mod.isProviderAvailable(mod.ALL_PROVIDERS.find((p) => p.value === 'claude_proxy')!, localUp, { webMode: true })).toBe(false);
        // ...but local mode still shows them.
        expect(mod.isProviderAvailable(mod.ALL_PROVIDERS.find((p) => p.value === 'ollama')!, localUp, { webMode: false })).toBe(true);
    });

    it('web mode (BYOK off): shows aloud only; (BYOK on): adds the key providers', () => {
        const caps0 = caps({ cloud: true });
        const off = mod.ALL_PROVIDERS.filter((p) =>
            mod.isProviderAvailable(p, caps0, { webMode: true })
        ).map((p) => p.value);
        expect(off).toEqual(['aloud']); // Ollama/claude_proxy need local; BYOK hidden

        const on = mod.ALL_PROVIDERS.filter((p) =>
            mod.isProviderAvailable(p, caps0, { webMode: true, allowByok: true })
        ).map((p) => p.value);
        expect(on).toContain('aloud');
        expect(on).toContain('anthropic');
        expect(on).not.toContain('ollama');
        expect(on).not.toContain('claude_proxy');
    });
});

describe('resolveSetupProvider', () => {
    // The shared default is the desktop-only 'ollama'; a fresh web browser must
    // never keep it, or the model picker shows a nonsensical "Install Ollama".
    it('web mode: coerces the local-only default to the reachable aloud cloud', () => {
        expect(
            mod.resolveSetupProvider('ollama', caps({ cloud: true }), { webMode: true })
        ).toBe('aloud');
    });

    it('web mode: keeps an already-web-valid provider unchanged', () => {
        expect(
            mod.resolveSetupProvider('aloud', caps({ cloud: true }), { webMode: true })
        ).toBe('aloud');
        expect(
            mod.resolveSetupProvider('anthropic', caps({ cloud: true }), {
                webMode: true,
                allowByok: true,
            })
        ).toBe('anthropic');
    });

    it('web mode with cloud down (BYOK off): still resolves to aloud, never ollama', () => {
        // aloud is always offered on web, so even with cloud unreachable it's the
        // available option. The desktop-only 'ollama' default must never survive
        // into web mode (its picker shows a nonsensical "Install Ollama").
        expect(mod.resolveSetupProvider('ollama', caps({}), { webMode: true })).toBe('aloud');
    });

    it('local mode: returns the seeded provider unchanged (markers show readiness)', () => {
        expect(mod.resolveSetupProvider('ollama', caps({}), { webMode: false })).toBe('ollama');
    });
});
