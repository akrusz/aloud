/**
 * The prompt-cache keep-alive's timing (core keep-alive.ts), on a fake clock
 * and timer: when a ping goes, what it re-sends, and every way it stops.
 */
import { describe, expect, it } from 'vitest';

import {
    CacheKeepAlive,
    KEEP_ALIVE_INTERVAL_MS,
    KEEP_ALIVE_LATE_MS,
    KEEP_ALIVE_MAX_PINGS,
    type KeepAliveRequest,
} from '../src/llm/keep-alive.js';
import type { CompletionOptions, CompletionResult, Message } from '../src/llm/base.js';

const SEC = 1000;

/** A clock and a one-shot timer queue the test moves by hand. */
function fakeTime() {
    let now = 0;
    let nextId = 0;
    const pending = new Map<number, { at: number; callback: () => void }>();
    return {
        now: () => now,
        timer: {
            set(callback: () => void, delayMs: number): unknown {
                const id = nextId++;
                pending.set(id, { at: now + delayMs, callback });
                return id;
            },
            clear(handle: unknown): void {
                pending.delete(handle as number);
            },
        },
        pendingCount: () => pending.size,
        /** Move to `t` ms, running each timer that comes due on the way. */
        async to(t: number): Promise<void> {
            for (;;) {
                const due = [...pending.entries()]
                    .filter(([, p]) => p.at <= t)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                pending.delete(due[0]);
                now = Math.max(now, due[1].at);
                due[1].callback();
                await settle();
            }
            now = t;
            await settle();
        },
        /** Jump the clock without running timers (a throttled background tab). */
        jump(t: number): void {
            now = t;
        },
        async runDue(): Promise<void> {
            const due = [...pending.entries()].filter(([, p]) => p.at <= now);
            for (const [id, p] of due) {
                pending.delete(id);
                p.callback();
            }
            await settle();
        },
    };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

const warm: CompletionResult = { text: '', finishReason: 'max_tokens', tokensUsed: null, cacheReadTokens: 4000 };

function harness(answer: (call: number) => Promise<CompletionResult> = async () => warm) {
    const time = fakeTime();
    const pings: Array<{ at: number; messages: Message[]; options: CompletionOptions }> = [];
    const results: CompletionResult[] = [];
    const keepAlive = new CacheKeepAlive({
        ping: (messages, options) => {
            pings.push({ at: time.now(), messages, options });
            return answer(pings.length);
        },
        onPing: (r) => results.push(r),
        now: time.now,
        timer: time.timer,
    });
    return { time, pings, results, keepAlive };
}

function request(tag: string): KeepAliveRequest {
    return { messages: [{ role: 'user', content: tag }], options: { system: 'sys' } };
}

describe('CacheKeepAlive', () => {
    it('pings 270 s after the request STARTED, with what that request sent', async () => {
        const { time, pings, results, keepAlive } = harness();
        const ticket = keepAlive.begin();
        await time.to(12 * SEC); // the reply took 12 s
        ticket.end(request('turn 1'));
        await time.to(KEEP_ALIVE_INTERVAL_MS - 1);
        expect(pings).toHaveLength(0);
        await time.to(KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(1);
        expect(pings[0]!.at).toBe(KEEP_ALIVE_INTERVAL_MS);
        expect(pings[0]!.messages).toEqual([{ role: 'user', content: 'turn 1' }]);
        expect(pings[0]!.options).toEqual({ system: 'sys' });
        expect(results).toEqual([warm]);
    });

    it("re-arms from each ping's own start, not from when it answered", async () => {
        let release: (() => void) | null = null;
        const { time, pings, keepAlive } = harness(
            (n) => (n === 1 ? new Promise((r) => (release = () => r(warm))) : Promise.resolve(warm))
        );
        keepAlive.begin().end(request('turn'));
        await time.to(KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(1);
        await time.to(KEEP_ALIVE_INTERVAL_MS + 20 * SEC); // a slow answer
        release!();
        await settle();
        await time.to(2 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings.map((p) => p.at)).toEqual([KEEP_ALIVE_INTERVAL_MS, 2 * KEEP_ALIVE_INTERVAL_MS]);
    });

    it(`stops after ${KEEP_ALIVE_MAX_PINGS} pings in a row, until a real request`, async () => {
        const { time, pings, keepAlive } = harness();
        keepAlive.begin().end(request('turn'));
        await time.to(30 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(KEEP_ALIVE_MAX_PINGS);
        expect(time.pendingCount()).toBe(0);

        const start = time.now();
        keepAlive.begin().end(request('next turn'));
        await time.to(start + 30 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(2 * KEEP_ALIVE_MAX_PINGS);
        expect(pings[KEEP_ALIVE_MAX_PINGS]!.messages[0]!.content).toBe('next turn');
    });

    it('a real request resets the count and the clock', async () => {
        const { time, pings, keepAlive } = harness();
        keepAlive.begin().end(request('turn 1'));
        await time.to(5 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(5);

        const restart = 5 * KEEP_ALIVE_INTERVAL_MS + 100 * SEC;
        await time.to(restart);
        const ticket = keepAlive.begin();
        await time.to(restart + 10 * SEC);
        ticket.end(request('turn 2'));
        await time.to(restart + KEEP_ALIVE_INTERVAL_MS - 1);
        expect(pings).toHaveLength(5);
        await time.to(restart + (KEEP_ALIVE_MAX_PINGS + 5) * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(5 + KEEP_ALIVE_MAX_PINGS);
        expect(pings.slice(5).every((p) => p.messages[0]!.content === 'turn 2')).toBe(true);
    });

    it('never pings while a facilitation request is in flight', async () => {
        const { time, pings, keepAlive } = harness();
        keepAlive.begin().end(request('turn'));
        await time.to(260 * SEC);
        const checkin = keepAlive.begin(); // a check-in, say
        await time.to(285 * SEC);
        expect(pings).toHaveLength(0);
        // It passed, so its event never entered the log: the old request is
        // still the one to keep, and the overdue ping goes at once.
        checkin.end();
        await time.runDue();
        expect(pings.map((p) => p.at)).toEqual([285 * SEC]);
        expect(pings[0]!.messages[0]!.content).toBe('turn');
    });

    it('skips an overdue ping once the entry has lapsed, and waits for the next real request', async () => {
        const { time, pings, keepAlive } = harness();
        keepAlive.begin().end(request('turn'));
        const slow = keepAlive.begin();
        await time.to(KEEP_ALIVE_LATE_MS + 5 * SEC);
        slow.end(); // a failed turn, long after the entry went
        await time.runDue();
        expect(pings).toHaveLength(0);
        // A check-in that passes does not bring it back either.
        keepAlive.begin().end();
        await time.to(time.now() + 2 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(0);
        const start = time.now();
        keepAlive.begin().end(request('turn 2'));
        await time.to(start + KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(1);
    });

    it('a timer that fires late (throttled in the background) pings nothing and stays quiet', async () => {
        const { time, pings, keepAlive } = harness();
        keepAlive.begin().end(request('turn'));
        time.jump(KEEP_ALIVE_LATE_MS + 1);
        await time.runDue();
        expect(pings).toHaveLength(0);
        expect(time.pendingCount()).toBe(0);
        const start = time.now();
        keepAlive.begin().end(request('turn 2'));
        await time.to(start + KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(1);
    });

    it('a timer a little late but inside the window still pings', async () => {
        const { time, pings, keepAlive } = harness();
        keepAlive.begin().end(request('turn'));
        time.jump(KEEP_ALIVE_LATE_MS);
        await time.runDue();
        expect(pings).toHaveLength(1);
    });

    it('stops for good on a failed ping, even after later requests', async () => {
        const { time, pings, results, keepAlive } = harness(async () => {
            throw new Error('404');
        });
        keepAlive.begin().end(request('turn'));
        await time.to(KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(1);
        expect(results).toHaveLength(0);
        keepAlive.begin().end(request('turn 2'));
        await time.to(10 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(1);
    });

    it('stops for good when a ping read nothing from the cache', async () => {
        const cold: CompletionResult = { ...warm, cacheReadTokens: 0, cacheCreationTokens: 4000 };
        const { time, pings, results, keepAlive } = harness(async () => cold);
        keepAlive.begin().end(request('turn'));
        await time.to(KEEP_ALIVE_INTERVAL_MS);
        // Its cost still reaches the tally.
        expect(results).toEqual([cold]);
        keepAlive.begin().end(request('turn 2'));
        await time.to(10 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(1);
    });

    it('keeps going when the provider reports no token counts (aloud cloud)', async () => {
        const { time, pings, keepAlive } = harness(async () => ({ text: '', finishReason: 'max_tokens', tokensUsed: null }));
        keepAlive.begin().end(request('turn'));
        await time.to(3 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(3);
    });

    it('nothing after stop(), from a timer or a ticket', async () => {
        const { time, pings, keepAlive } = harness();
        const open = keepAlive.begin();
        keepAlive.begin().end(request('turn'));
        keepAlive.stop();
        open.end(request('late'));
        await time.to(10 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(0);
        expect(time.pendingCount()).toBe(0);
    });

    it('a request that settles while a ping is out does not set off a second ping', async () => {
        let release: (() => void) | null = null;
        const { time, pings, keepAlive } = harness(
            (n) => (n === 1 ? new Promise((r) => (release = () => r(warm))) : Promise.resolve(warm))
        );
        keepAlive.begin().end(request('turn'));
        await time.to(KEEP_ALIVE_INTERVAL_MS);
        const checkin = keepAlive.begin();
        await time.to(KEEP_ALIVE_INTERVAL_MS + 2 * SEC);
        checkin.end();
        await settle();
        expect(pings).toHaveLength(1);
        release!();
        await settle();
        await time.to(2 * KEEP_ALIVE_INTERVAL_MS - 1);
        expect(pings).toHaveLength(1);
        await time.to(2 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(2);
    });

    it('a real request during a ping takes over its clock', async () => {
        let release: (() => void) | null = null;
        const { time, pings, keepAlive } = harness(
            (n) => (n === 1 ? new Promise((r) => (release = () => r(warm))) : Promise.resolve(warm))
        );
        keepAlive.begin().end(request('turn 1'));
        await time.to(KEEP_ALIVE_INTERVAL_MS);
        const turnStart = KEEP_ALIVE_INTERVAL_MS + 1 * SEC;
        await time.to(turnStart);
        keepAlive.begin().end(request('turn 2'));
        release!();
        await settle();
        await time.to(turnStart + KEEP_ALIVE_INTERVAL_MS);
        expect(pings.map((p) => [p.at, p.messages[0]!.content])).toEqual([
            [KEEP_ALIVE_INTERVAL_MS, 'turn 1'],
            [turnStart + KEEP_ALIVE_INTERVAL_MS, 'turn 2'],
        ]);
    });

    it('a ticket counts once', async () => {
        const { time, pings, keepAlive } = harness();
        const ticket = keepAlive.begin();
        ticket.end(request('turn'));
        ticket.end();
        ticket.end(request('again'));
        await time.to(KEEP_ALIVE_INTERVAL_MS);
        expect(pings.map((p) => p.messages[0]!.content)).toEqual(['turn']);
    });

    it('nothing to keep before the first request', async () => {
        const { time, pings, keepAlive } = harness();
        keepAlive.begin().end();
        await time.to(10 * KEEP_ALIVE_INTERVAL_MS);
        expect(pings).toHaveLength(0);
    });
});
