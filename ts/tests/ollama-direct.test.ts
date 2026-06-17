import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    probeOllamaDirect,
    fetchOllamaModelsDirect,
    fetchOllamaVersionDirect,
} from '../ui/src/ollama-direct.js';

// Map of URL substring -> Response factory. Anything unmatched throws (mimics
// an unreachable daemon, which is exactly one of the cases under test).
type Routes = Record<string, () => Response>;
const realFetch = globalThis.fetch;

function stubFetch(routes: Routes): void {
    globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        for (const key of Object.keys(routes)) {
            if (u.includes(key)) return routes[key]!();
        }
        throw new TypeError(`fetch failed: ${u}`);
    }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
    // Default: daemon up, version 0.24.0, two pulled models.
    stubFetch({
        '/ollama/api/version': () => json({ version: '0.24.0' }),
        '/ollama/api/tags': () =>
            json({
                models: [
                    { name: 'gemma4:26b', model: 'gemma4:26b' },
                    { name: 'qwen3.5:4b', model: 'qwen3.5:4b' },
                ],
            }),
    });
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('fetchOllamaModelsDirect', () => {
    it('extracts model names from /ollama/api/tags', async () => {
        expect(await fetchOllamaModelsDirect()).toEqual(['gemma4:26b', 'qwen3.5:4b']);
    });

    it('falls back to the `model` field and drops empty names', async () => {
        stubFetch({
            '/ollama/api/tags': () =>
                json({ models: [{ model: 'only-model-field' }, { name: '' }, {}] }),
        });
        expect(await fetchOllamaModelsDirect()).toEqual(['only-model-field']);
    });

    it('returns [] when the daemon is unreachable', async () => {
        stubFetch({}); // every fetch throws
        expect(await fetchOllamaModelsDirect()).toEqual([]);
    });

    it('returns [] on a non-OK response', async () => {
        stubFetch({ '/ollama/api/tags': () => json({}, 500) });
        expect(await fetchOllamaModelsDirect()).toEqual([]);
    });
});

describe('fetchOllamaVersionDirect', () => {
    it('returns the version string', async () => {
        expect(await fetchOllamaVersionDirect()).toBe('0.24.0');
    });

    it('returns null when unreachable', async () => {
        stubFetch({});
        expect(await fetchOllamaVersionDirect()).toBeNull();
    });
});

describe('probeOllamaDirect', () => {
    it('reports installed with version + models when the daemon is up', async () => {
        expect(await probeOllamaDirect()).toEqual({
            installed: true,
            version: '0.24.0',
            models: ['gemma4:26b', 'qwen3.5:4b'],
        });
    });

    it('reports installed when tags exist even if version 404s', async () => {
        stubFetch({
            '/ollama/api/version': () => json({}, 404),
            '/ollama/api/tags': () => json({ models: [{ name: 'gemma4:26b' }] }),
        });
        const probe = await probeOllamaDirect();
        expect(probe.installed).toBe(true);
        expect(probe.version).toBeNull();
        expect(probe.models).toEqual(['gemma4:26b']);
    });

    it('reports not-installed when the daemon is unreachable', async () => {
        stubFetch({});
        expect(await probeOllamaDirect()).toEqual({
            installed: false,
            version: null,
            models: [],
        });
    });
});
