import { describe, it, expect, vi } from 'vitest';

import { sendWithNetworkRetry, type NetworkRetryOptions } from '../ui/src/net-retry.js';

/**
 * Riding out a dropped connection on the hosted hops (net-retry.ts): re-send
 * on a rejected fetch or a 502 inside the budget, nothing else, and wait for
 * the network while the device says it's offline.
 */

/** A fake clock the injected wait advances, so budgets run instantly. */
function harness(over: Partial<NetworkRetryOptions> = {}) {
    let t = 0;
    const waits: number[] = [];
    const opts: NetworkRetryOptions = {
        budgetMs: 10_000,
        now: () => t,
        offline: () => false,
        wait: async (ms) => {
            waits.push(ms);
            t += ms;
        },
        ...over,
    };
    return { opts, waits, advance: (ms: number) => (t += ms) };
}

const dropped = (): TypeError => new TypeError('Failed to fetch');
const ok = (): Response => new Response('ok', { status: 200 });

describe('sendWithNetworkRetry', () => {
    it('returns the first answer when nothing fails', async () => {
        const send = vi.fn(async () => ok());
        const { opts, waits } = harness();
        const res = await sendWithNetworkRetry(send, opts);
        expect(res.status).toBe(200);
        expect(send).toHaveBeenCalledTimes(1);
        expect(waits).toEqual([]);
    });

    it('re-sends after a dropped connection and returns the recovery', async () => {
        const send = vi.fn().mockRejectedValueOnce(dropped()).mockResolvedValueOnce(ok());
        const onRetry = vi.fn();
        const { opts } = harness({ onRetry });
        const res = await sendWithNetworkRetry(send, opts);
        expect(res.status).toBe(200);
        expect(send).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenCalledWith(1, 'Failed to fetch');
    });

    it('re-sends a 502 (charged nothing) and returns the recovery', async () => {
        const send = vi
            .fn()
            .mockResolvedValueOnce(new Response('upstream', { status: 502 }))
            .mockResolvedValueOnce(ok());
        const { opts } = harness();
        const res = await sendWithNetworkRetry(send, opts);
        expect(res.status).toBe(200);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it.each([400, 401, 402, 429, 500, 503])('hands back a %i without re-sending', async (status) => {
        const send = vi.fn(async () => new Response('no', { status }));
        const { opts } = harness();
        const res = await sendWithNetworkRetry(send, opts);
        expect(res.status).toBe(status);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('does not re-send after its own timeout or any non-network error', async () => {
        const send = vi.fn(async () => {
            throw new Error('aloud cloud transcription timed out.');
        });
        const { opts } = harness();
        await expect(sendWithNetworkRetry(send, opts)).rejects.toThrow('timed out');
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('backs off 0.5s, 1s, 2s, 4s, 4s… and gives up with the last error once the budget is spent', async () => {
        const send = vi.fn(async () => {
            throw dropped();
        });
        const { opts, waits } = harness({ budgetMs: 10_000 });
        await expect(sendWithNetworkRetry(send, opts)).rejects.toBeInstanceOf(TypeError);
        expect(waits).toEqual([500, 1000, 2000, 4000, 2500]);
        expect(send).toHaveBeenCalledTimes(6);
    });

    it('hands back the last 502 once the budget is spent', async () => {
        const send = vi.fn(async () => new Response('upstream', { status: 502 }));
        const { opts } = harness({ budgetMs: 1000 });
        const res = await sendWithNetworkRetry(send, opts);
        expect(res.status).toBe(502);
        expect(await res.text()).toBe('upstream');
    });

    it('counts the re-sends themselves against the budget', async () => {
        const h = harness({ budgetMs: 5000 });
        const send = vi
            .fn()
            .mockRejectedValueOnce(dropped())
            .mockImplementationOnce(async () => {
                h.advance(6000); // a slow failure eats the rest of the budget
                throw dropped();
            });
        await expect(sendWithNetworkRetry(send, h.opts)).rejects.toBeInstanceOf(TypeError);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('never re-sends with a zero budget', async () => {
        const send = vi.fn(async () => {
            throw dropped();
        });
        const { opts } = harness({ budgetMs: 0 });
        await expect(sendWithNetworkRetry(send, opts)).rejects.toBeInstanceOf(TypeError);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('waits out the rest of the budget for the network while the device is offline', async () => {
        let offline = true;
        const send = vi
            .fn()
            .mockRejectedValueOnce(dropped())
            .mockImplementationOnce(async () => ok());
        const { opts, waits } = harness({
            budgetMs: 30_000,
            offline: () => offline,
            wait: async (ms) => {
                waits.push(ms);
                offline = false; // the 'online' event ends the wait
            },
        });
        const res = await sendWithNetworkRetry(send, opts);
        expect(res.status).toBe(200);
        expect(waits).toEqual([30_000]);
    });

    it('stops at once when aborted, with the abort reason', async () => {
        const ac = new AbortController();
        const send = vi.fn(async () => {
            throw dropped();
        });
        const { opts } = harness({
            signal: ac.signal,
            wait: async (_ms, signal) => {
                ac.abort(new Error('superseded'));
                if (signal?.aborted) throw signal.reason;
            },
        });
        await expect(sendWithNetworkRetry(send, opts)).rejects.toThrow('superseded');
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('default wait: a real abort ends the backoff without waiting it out', async () => {
        const ac = new AbortController();
        const send = vi.fn(async () => {
            throw dropped();
        });
        setTimeout(() => ac.abort(new Error('torn down')), 10);
        const started = Date.now();
        await expect(
            sendWithNetworkRetry(send, { budgetMs: 10_000, signal: ac.signal, offline: () => false })
        ).rejects.toThrow('torn down');
        expect(Date.now() - started).toBeLessThan(400);
    });
});
