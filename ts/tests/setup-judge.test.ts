import { describe, expect, it } from 'vitest';
import {
    SETUP_GATE_ASK,
    SETUP_SPECS,
    type JudgeAnswers,
    type JudgeId,
    type UtteranceJudge,
} from '../src/facilitation/index.js';
import { createSetupJudge, type SetupJudgeOptions, type SetupJudgeRoute } from '../ui/src/setup-judge.js';

const SPACIOUS = [{ kind: 'quality', quality: 'spacious', on: true }];

function setAnswers(): JudgeAnswers {
    const out: JudgeAnswers = Object.fromEntries(Object.keys(SETUP_SPECS['setup-command'].asks).map((k) => [k, 0]));
    out['vibe_spacious'] = 0.97;
    return out;
}

/** A setup screen's surroundings, every one a fake that counts its calls. */
function world({ fail, ...over }: Partial<SetupJudgeOptions> & { fail?: () => Error | null } = {}) {
    const made: Array<[SetupJudgeRoute, string | null]> = [];
    const asked: JudgeId[] = [];
    let reachChecks = 0;
    const judge: UtteranceJudge = {
        async judge(id) {
            asked.push(id);
            const err = fail?.();
            if (err) throw err;
            return id === 'setup-gate' ? { [SETUP_GATE_ASK]: 0.9 } : setAnswers();
        },
    };
    const options: SetupJudgeOptions = {
        provider: () => 'anthropic',
        optedIn: () => false,
        ownKey: async () => null,
        canReach: async () => {
            reachChecks++;
            return true;
        },
        hostedOff: () => false,
        makeJudge: (route, key) => {
            made.push([route, key]);
            return judge;
        },
        refused: new Set(),
        ...over,
    };
    return { ask: createSetupJudge(options), made, asked, reachChecks: () => reachChecks };
}

const REQUEST = 'Could you make it a bit more spacious in there?';

describe('createSetupJudge: who it asks', () => {
    it('asks nothing anywhere for a BYOK or local setup that has not opted in', async () => {
        const w = world({ provider: () => 'ollama' });
        expect(await w.ask(REQUEST)).toBeNull();
        expect(w.made).toEqual([]);
        expect(w.reachChecks()).toBe(0);
    });

    it('asks aloud cloud on an aloud cloud setup, opt-in or not', async () => {
        const w = world({ provider: () => 'aloud' });
        expect(await w.ask(REQUEST)).toEqual(SPACIOUS);
        expect(w.made).toEqual([['cloud', null]]);
        expect(w.asked).toEqual(['setup-gate', 'setup-command']);
    });

    it('never raises a sign-in: with no stored token, nothing is sent', async () => {
        for (const over of [{ provider: () => 'aloud' }, { optedIn: () => true }]) {
            const w = world({ ...over, canReach: async () => false });
            expect(await w.ask(REQUEST)).toBeNull();
            expect(w.made).toEqual([]);
        }
    });

    it('asks aloud cloud for an opted-in BYOK setup with an account', async () => {
        const w = world({ optedIn: () => true });
        expect(await w.ask(REQUEST)).toEqual(SPACIOUS);
        expect(w.made).toEqual([['cloud', null]]);
    });

    it('runs on an own TypeSafe key ahead of the opt-in, with no account needed', async () => {
        const w = world({ provider: () => 'ollama', optedIn: () => true, ownKey: async () => 'ts-key', canReach: async () => false });
        expect(await w.ask(REQUEST)).toEqual(SPACIOUS);
        expect(w.made).toEqual([['own-key', 'ts-key']]);
    });

    it('stays off on aloud cloud under the developer override', async () => {
        const w = world({ provider: () => 'aloud', hostedOff: () => true });
        expect(await w.ask(REQUEST)).toBeNull();
        expect(w.made).toEqual([]);
    });

    it('reads the provider and opt-in at each call, and keeps one judge per route', async () => {
        let provider = 'anthropic';
        const w = world({ provider: () => provider });
        expect(await w.ask(REQUEST)).toBeNull();
        provider = 'aloud';
        await w.ask(REQUEST);
        await w.ask(REQUEST);
        expect(w.made).toEqual([['cloud', null]]);
    });

    it('sends neither a begin nor a lone word', async () => {
        const w = world({ provider: () => 'aloud' });
        expect(await w.ask("Let's begin a spacious one.")).toBeNull();
        expect(await w.ask('Spacious.')).toBeNull();
        expect(w.asked).toEqual([]);
    });
});

describe('createSetupJudge: a server that refuses', () => {
    it('stops asking a route that answered 4xx, for every setup screen sharing the page', async () => {
        const refused = new Set<string>();
        const first = world({ provider: () => 'aloud', refused, fail: () => new Error('judge returned 400') });
        expect(await first.ask(REQUEST)).toBeNull();
        expect(await first.ask(REQUEST)).toBeNull();
        expect(first.asked).toEqual(['setup-gate']);
        // A remounted setup screen on the same page.
        const second = world({ provider: () => 'aloud', refused });
        expect(await second.ask(REQUEST)).toBeNull();
        expect(second.asked).toEqual([]);
    });

    it('keeps asking after an outage, a timeout or a rate limit: those pass', async () => {
        let failure: Error | null = new Error('judge returned 502');
        const w = world({ provider: () => 'aloud', fail: () => failure });
        expect(await w.ask(REQUEST)).toBeNull();
        failure = new Error('judge returned 429');
        expect(await w.ask(REQUEST)).toBeNull();
        failure = new Error('judge timed out');
        expect(await w.ask(REQUEST)).toBeNull();
        failure = null;
        expect(await w.ask(REQUEST)).toEqual(SPACIOUS);
    });

    it('refuses per route: an own key still runs after aloud cloud said no', async () => {
        const refused = new Set<string>(['cloud']);
        const w = world({ provider: () => 'ollama', ownKey: async () => 'ts-key', refused });
        expect(await w.ask(REQUEST)).toEqual(SPACIOUS);
    });
});
