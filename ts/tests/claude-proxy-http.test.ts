/**
 * ClaudeProxyHttpProvider — the browser-facing wrapper that POSTs to the Rust
 * shell's /app/v1/llm/claude_proxy/complete. The key behavior here is that it
 * forwards the turn's abort signal: without it, quitting a session never
 * cancels the in-flight request, the Rust `claude` child runs to its 90s cap,
 * and a stale answer plays into a later session (the cross-session ghost voice).
 */

import { describe, it, expect } from 'vitest';
import { ClaudeProxyHttpProvider } from '../ui/src/adapters/claude-proxy-http.js';

function fakeFetch(captured: { init?: RequestInit }): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
        captured.init = init;
        return {
            ok: true,
            status: 200,
            json: async () => ({ text: 'hi', finish_reason: 'end_turn', tokens_used: 5 }),
            text: async () => '',
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

describe('ClaudeProxyHttpProvider', () => {
    it('forwards the abort signal to fetch so a torn-down turn cancels', async () => {
        const captured: { init?: RequestInit } = {};
        const provider = new ClaudeProxyHttpProvider({
            fetchImpl: fakeFetch(captured),
            endpointUrl: 'http://x/complete',
        });
        const ac = new AbortController();
        await provider.complete([{ role: 'user', content: 'hi' }], { signal: ac.signal });
        expect(captured.init?.signal).toBe(ac.signal);
    });

    it('sends null (not undefined) when no signal is given', async () => {
        const captured: { init?: RequestInit } = {};
        const provider = new ClaudeProxyHttpProvider({
            fetchImpl: fakeFetch(captured),
            endpointUrl: 'http://x/complete',
        });
        const out = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(out.text).toBe('hi');
        expect(captured.init?.signal).toBeNull();
    });
});
