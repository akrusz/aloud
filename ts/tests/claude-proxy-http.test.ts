/**
 * ClaudeProxyHttpProvider — the browser-facing wrapper that POSTs to the Rust
 * shell's /app/v1/llm/claude_proxy/complete. Two behaviors matter here:
 *
 * - Abort propagation: a torn-down/superseded turn must cancel its request, so
 *   the Rust `claude` child is reaped (kill_on_drop) instead of running to its
 *   90s cap and voicing a stale answer into a later session (the ghost voice).
 * - Bounded retry: the local CLI cold-starts each turn and intermittently
 *   stalls, so each attempt has a deadline and we retry a couple of times before
 *   giving up with a marker the session view turns into a gentle apology.
 */

import { describe, it, expect } from 'vitest';
import { ClaudeProxyHttpProvider, CLAUDE_PROXY_STALLED } from '../ui/src/adapters/claude-proxy-http.js';

function jsonResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => '',
    } as unknown as Response;
}

const HI = [{ role: 'user' as const, content: 'hi' }];

describe('ClaudeProxyHttpProvider', () => {
    it('returns the completion on a successful first attempt', async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            return jsonResponse(200, { text: 'hello', finish_reason: 'end_turn', tokens_used: 5 });
        }) as unknown as typeof fetch;
        const provider = new ClaudeProxyHttpProvider({ fetchImpl, endpointUrl: 'http://x' });
        const out = await provider.complete(HI);
        expect(out.text).toBe('hello');
        expect(calls).toBe(1);
    });

    it('aborts the in-flight fetch when the caller aborts, and does not retry', async () => {
        const ac = new AbortController();
        let fetchSignal: AbortSignal | undefined;
        let calls = 0;
        const fetchImpl = (async (_url: string, init?: RequestInit) => {
            calls++;
            fetchSignal = init?.signal ?? undefined;
            ac.abort(); // caller cancels mid-flight
            throw new DOMException('Aborted', 'AbortError');
        }) as unknown as typeof fetch;
        const provider = new ClaudeProxyHttpProvider({ fetchImpl, endpointUrl: 'http://x' });
        await expect(provider.complete(HI, { signal: ac.signal })).rejects.toThrow();
        // The caller's abort chained into the per-attempt signal handed to fetch.
        expect(fetchSignal?.aborted).toBe(true);
        // A real cancel is not retried.
        expect(calls).toBe(1);
    });

    it('retries a failed attempt and succeeds on the next', async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            return calls === 1
                ? jsonResponse(500, { error: 'boom' })
                : jsonResponse(200, { text: 'recovered' });
        }) as unknown as typeof fetch;
        const provider = new ClaudeProxyHttpProvider({ fetchImpl, endpointUrl: 'http://x' });
        const out = await provider.complete(HI);
        expect(out.text).toBe('recovered');
        expect(calls).toBe(2);
    });

    it('throws a stall-marked error once every attempt fails', async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            return jsonResponse(500, { error: 'nope' });
        }) as unknown as typeof fetch;
        const provider = new ClaudeProxyHttpProvider({ fetchImpl, endpointUrl: 'http://x' });
        await expect(provider.complete(HI)).rejects.toThrow(new RegExp(CLAUDE_PROXY_STALLED));
        expect(calls).toBe(3); // MAX_ATTEMPTS
    });

    it('surfaces a 503 (CLI unavailable) immediately without retrying', async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            return jsonResponse(503, { error: 'claude CLI not found' });
        }) as unknown as typeof fetch;
        const provider = new ClaudeProxyHttpProvider({ fetchImpl, endpointUrl: 'http://x' });
        await expect(provider.complete(HI)).rejects.toThrow(/claude CLI not found/);
        expect(calls).toBe(1);
    });
});
