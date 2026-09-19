import { describe, it, expect, beforeEach } from 'vitest';

import { CloudJudge } from '../ui/src/adapters/cloud-judge.js';
import { setCloudAuthBackend } from '../ui/src/cloud-auth.js';
import type { KvStorage } from '../src/platform/storage.js';

class MemoryKv implements KvStorage {
    private m = new Map<string, string>();
    async get(k: string) {
        return this.m.get(k) ?? null;
    }
    async set(k: string, v: string) {
        this.m.set(k, v);
    }
    async delete(k: string) {
        this.m.delete(k);
    }
    async keys() {
        return [...this.m.keys()];
    }
    async clear() {
        this.m.clear();
    }
}

let up: boolean;
let calls: Array<Record<string, unknown>>;
let clock: number;

const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return up
        ? new Response(JSON.stringify({ answers: { addressed: 0.1, done: 0.8 }, model: 'jev', latencyMs: 100 }))
        : new Response('{}', { status: 502 });
}) as typeof fetch;

const judge = (): CloudJudge => new CloudJudge({ fetchImpl, now: () => clock });

beforeEach(async () => {
    const kv = new MemoryKv();
    await kv.set('server:token', 'tok');
    setCloudAuthBackend(kv);
    up = true;
    calls = [];
    clock = 1_000_000;
});

describe('CloudJudge', () => {
    it('posts the classifier, utterance and the clamped hold so far', async () => {
        const earlier = Array.from({ length: 9 }, (_, i) => `u${i}`);
        expect(await judge().judge('resume', 'Alright.', { earlier })).toEqual({ addressed: 0.1, done: 0.8 });
        expect(calls[0]).toMatchObject({ classifier: 'resume', text: 'Alright.', earlier: earlier.slice(-6) });
        await judge().judge('hold-confirm', 'Yes.');
        expect(calls[1]).not.toHaveProperty('earlier');
    });

    it('backs off after two straight failures, doubling, without calling out', async () => {
        const j = judge();
        up = false;
        await expect(j.judge('resume', 'x')).rejects.toThrow('502');
        await expect(j.judge('resume', 'x')).rejects.toThrow('502');
        expect(calls).toHaveLength(2);

        await expect(j.judge('resume', 'x')).rejects.toThrow('backing off');
        clock += 29_000;
        await expect(j.judge('resume', 'x')).rejects.toThrow('backing off');
        expect(calls).toHaveLength(2);

        // Cooldown over: one probe; it fails, so the next wait is twice as long.
        clock += 2_000;
        await expect(j.judge('resume', 'x')).rejects.toThrow('502');
        expect(calls).toHaveLength(3);
        clock += 31_000;
        await expect(j.judge('resume', 'x')).rejects.toThrow('backing off');
        clock += 30_000;
        await expect(j.judge('resume', 'x')).rejects.toThrow('502');
        expect(calls).toHaveLength(4);
    });

    it('comes back on the first success and forgets the streak', async () => {
        const j = judge();
        up = false;
        await j.judge('resume', 'x').catch(() => {});
        await j.judge('resume', 'x').catch(() => {});
        clock += 31_000;
        up = true;
        expect(await j.judge('resume', 'x')).toEqual({ addressed: 0.1, done: 0.8 });
        up = false;
        await expect(j.judge('resume', 'x')).rejects.toThrow('502');
        // One failure after a success is not a streak yet.
        up = true;
        expect(await j.judge('resume', 'x')).toEqual({ addressed: 0.1, done: 0.8 });
    });
});

describe('CloudJudge offline', () => {
    it('rejects without a request and without counting toward the backoff', async () => {
        const online = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
        const j = judge();
        try {
            for (let i = 0; i < 5; i++) await expect(j.judge('resume', 'ok')).rejects.toThrow('offline');
        } finally {
            if (online) Object.defineProperty(globalThis, 'navigator', online);
            else delete (globalThis as { navigator?: unknown }).navigator;
        }
        expect(calls).toHaveLength(0);
        // Back online: straight through, no cooldown to wait out.
        await expect(j.judge('resume', 'ok')).resolves.toBeTruthy();
    });
});
