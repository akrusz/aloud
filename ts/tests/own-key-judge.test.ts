import { describe, it, expect } from 'vitest';

import { OwnKeyJudge } from '../ui/src/adapters/own-key-judge.js';
import { JEV_MODEL, JUDGE_SPECS, judgeVerdict } from '../src/facilitation/index.js';

function judgeWith(body: unknown, status = 200) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: String(url),
            headers: init?.headers as Record<string, string>,
            body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { judge: new OwnKeyJudge('ts-key', { fetchImpl }), calls };
}

describe('OwnKeyJudge', () => {
    it('sends the same TypeSafe request the server builds, through the shell relay', async () => {
        const asks = Object.keys(JUDGE_SPECS.resume.asks);
        const answers = Object.fromEntries(asks.map((k) => [k, { type: 'noul', noul: 0.9 }]));
        const { judge, calls } = judgeWith({ model: 'jev-1', answers });

        const got = await judge.judge('resume', "Okay, I'm back.", { earlier: ['It settled.'] });

        expect(judgeVerdict('resume', got)).toBe('yes');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toMatch(/\/app\/v1\/judge$/);
        // The key goes to the local shell only, never in the body.
        expect(calls[0]!.headers['x-provider-key']).toBe('ts-key');
        expect(JSON.stringify(calls[0]!.body)).not.toContain('ts-key');
        expect(calls[0]!.body['model']).toBe(JEV_MODEL);
        expect(Object.keys(calls[0]!.body['questions'] as object)).toEqual(asks);
        expect(calls[0]!.body['state']).toMatchObject({
            utterance: "Okay, I'm back.",
            earlier_in_this_silence: ['It settled.'],
        });
    });

    it('rejects a partial answer and an upstream failure, so the LLM classifier takes over', async () => {
        await expect(judgeWith({ answers: {} }).judge.judge('hold-confirm', 'Sure.')).rejects.toThrow(/no noul answer/);
        await expect(judgeWith({ error: 'bad key' }, 502).judge.judge('hold-confirm', 'Sure.')).rejects.toThrow(/502/);
    });
});
