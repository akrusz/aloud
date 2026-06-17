/**
 * Locks the ✘/✱ availability markers shared by the setup picker and the
 * settings Default Provider menu. The marker is what tells a user *why* a
 * provider can't run (no key vs not installed vs stopped), so a regression here
 * is silently misleading — assert the mapping directly.
 *
 * Note: the Ollama "running via direct probe" override reads capabilitiesSync(),
 * which is unset in the test env (ollama:false), so these cases exercise the
 * status-map + key-presence paths; the live-probe override is covered by the
 * setup/settings runtime checks.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// provider-markers imports settings.ts, which constructs a LocalStorageKv at
// import; give it a minimal stub so the module loads under Node.
let mod: typeof import('../ui/src/provider-markers.js');
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
    mod = await import('../ui/src/provider-markers.js');
});

describe('computeProviderMarker', () => {
    it('marks an API provider with no stored key as ✘ unavailable', () => {
        const m = mod.computeProviderMarker('openai', {}, { openai: false });
        expect(m.suffix).toBe(' ✘');
        expect(m.unavailable).toBe(true);
    });

    it('clears the marker once a key is present', () => {
        const m = mod.computeProviderMarker('openai', {}, { openai: true });
        expect(m.suffix).toBe('');
        expect(m.unavailable).toBe(false);
    });

    it('marks installed-but-not-running as ✱ and keeps it selectable', () => {
        // e.g. the desktop claude_proxy / a stopped daemon: present, not usable.
        const status = { claude_proxy: { available: false, installed: true } };
        const m = mod.computeProviderMarker('claude_proxy', status, {});
        expect(m.suffix).toBe(' ✱');
        expect(m.unavailable).toBe(false);
    });

    it('marks not-installed as ✘ unavailable', () => {
        const status = { claude_proxy: { available: false, installed: false } };
        const m = mod.computeProviderMarker('claude_proxy', status, {});
        expect(m.suffix).toBe(' ✘');
        expect(m.unavailable).toBe(true);
    });

    it('treats an available provider, or unknown status, as usable', () => {
        expect(mod.computeProviderMarker('venice', { venice: { available: true } }, {}).suffix).toBe('');
        // Probe failed → no status entry → never block on missing info.
        expect(mod.computeProviderMarker('venice', null, {}).suffix).toBe('');
    });
});

describe('stripMarker', () => {
    it('removes a trailing marker so labels re-annotate idempotently', () => {
        expect(mod.stripMarker('OpenAI ✘')).toBe('OpenAI');
        expect(mod.stripMarker('Ollama (Local) ✱')).toBe('Ollama (Local)');
        expect(mod.stripMarker('Anthropic')).toBe('Anthropic');
        // Only a trailing marker is stripped, not one mid-label.
        expect(mod.stripMarker('✘ weird ✘')).toBe('✘ weird');
    });
});
