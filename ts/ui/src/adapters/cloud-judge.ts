/**
 * aloud cloud's typed-judgment endpoint (/cloud/v1/judge) as an UtteranceJudge:
 * the silence classifiers' fast path on hosted sessions (core
 * utterance-judge.ts). Any failure rejects and the caller falls back to the LLM
 * classifier, so there is no retry here - not even the 401 re-sign-in the LLM
 * adapter does, since the fallback call right behind this one does it anyway.
 */

import type { ClassifierId, UtteranceJudge } from '../../../src/facilitation/index.js';
import { ensureCloudToken } from '../cloud-auth.js';
import { cloudUrl } from '../cloud-base.js';
import { getCloudSessionId } from '../cloud-session.js';
import { withTimeout } from '../net-timeout.js';

const ENDPOINT = '/judge';

// The server gives TypeSafe 2.5s; this covers that plus the hop to Fly.
const JUDGE_TIMEOUT_MS = 4000;

export class CloudJudge implements UtteranceJudge {
    private readonly fetchImpl: typeof fetch;

    constructor(options: { fetchImpl?: typeof fetch } = {}) {
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    async judge(classifier: ClassifierId, text: string): Promise<number> {
        const ac = new AbortController();
        try {
            return await withTimeout(this.request(classifier, text, ac.signal), JUDGE_TIMEOUT_MS, 'judge timed out');
        } finally {
            ac.abort();
        }
    }

    private async request(classifier: ClassifierId, text: string, signal: AbortSignal): Promise<number> {
        const token = await ensureCloudToken();
        const sessionId = getCloudSessionId();
        const res = await this.fetchImpl(cloudUrl(ENDPOINT), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ classifier, text, ...(sessionId ? { sessionId } : {}) }),
            signal,
        });
        if (!res.ok) throw new Error(`judge returned ${res.status}`);
        const data = (await res.json()) as { p?: unknown };
        if (typeof data.p !== 'number') throw new Error('judge returned no probability');
        return data.p;
    }
}
