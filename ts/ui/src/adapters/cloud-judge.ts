/**
 * aloud cloud's typed-judgment endpoint (/cloud/v1/judge) as an UtteranceJudge:
 * the silence classifiers' fast path wherever the judge is on (voice-commands.ts;
 * core utterance-judge.ts). Any failure rejects and the caller falls back to the LLM
 * classifier, so there is no retry here - not even the 401 re-sign-in the LLM
 * adapter does, since the fallback call right behind this one does it anyway.
 */

import type { JudgeAnswers, JudgeContext, JudgeId, UtteranceJudge } from '../../../src/facilitation/index.js';
import { clampEarlier } from '../../../src/facilitation/index.js';
import { ensureCloudToken } from '../cloud-auth.js';
import { cloudUrl } from '../cloud-base.js';
import { getCloudSessionId } from '../cloud-session.js';
import { withTimeout } from '../net-timeout.js';

const ENDPOINT = '/judge';

// The server gives TypeSafe 1.2s; this adds the hop to the server on a poor
// connection. The wait is dead air before the fallback starts, so keep it tight.
const JUDGE_TIMEOUT_MS = 2000;

/**
 * Every failure is a round trip the meditator waits through before the LLM
 * fallback even starts, so an outage - or a server with no TypeSafe key - must
 * not cost one per utterance. After this many failures in a row the judge sits
 * out a cooldown that doubles each time it fails again, and any success clears
 * it. Never off for good: a blip early in a long sit shouldn't cost the rest of
 * it the better classifier.
 */
const FAILURES_BEFORE_BACKOFF = 2;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export class CloudJudge implements UtteranceJudge {
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private failures = 0;
    private skipUntil = 0;

    constructor(options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.now = options.now ?? Date.now;
    }

    async judge(classifier: JudgeId, text: string, context: JudgeContext = {}): Promise<JudgeAnswers> {
        if (this.now() < this.skipUntil) throw new Error('judge backing off');
        // A local sit can run with no network at all; don't spend the timeout
        // finding that out. Not counted as a failure, so coming back online
        // is not met with a backoff.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline');
        const ac = new AbortController();
        const earlier = clampEarlier(context.earlier);
        try {
            const answers = await withTimeout(
                this.request(classifier, text, earlier, ac.signal),
                JUDGE_TIMEOUT_MS,
                'judge timed out'
            );
            this.failures = 0;
            return answers;
        } catch (err) {
            this.failures++;
            const over = this.failures - FAILURES_BEFORE_BACKOFF;
            if (over >= 0) this.skipUntil = this.now() + Math.min(BACKOFF_BASE_MS * 2 ** over, BACKOFF_MAX_MS);
            throw err;
        } finally {
            ac.abort();
        }
    }

    /** Fire-and-forget at session start: the first call down a cold path (this
     *  client's connection, a just-restarted server) is the slow one, ~1s against
     *  a usual ~160ms, so spend it before anyone is waiting.
     *  Outside judge() on purpose - a cold miss here must not count toward the
     *  backoff. */
    warm(): void {
        const ac = new AbortController();
        void withTimeout(this.request('command', 'hello', [], ac.signal), JUDGE_TIMEOUT_MS * 2, 'warm timed out')
            .catch(() => undefined)
            .finally(() => ac.abort());
    }

    private async request(
        classifier: JudgeId,
        text: string,
        earlier: string[],
        signal: AbortSignal
    ): Promise<JudgeAnswers> {
        const token = await ensureCloudToken();
        const sessionId = getCloudSessionId();
        const res = await this.fetchImpl(cloudUrl(ENDPOINT), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({
                classifier,
                text,
                ...(earlier.length ? { earlier } : {}),
                ...(sessionId ? { sessionId } : {}),
            }),
            signal,
        });
        if (!res.ok) throw new Error(`judge returned ${res.status}`);
        // Shape only; core judgeVerdict rejects a missing or non-numeric ask.
        const data = (await res.json()) as { answers?: JudgeAnswers };
        if (!data.answers || typeof data.answers !== 'object') throw new Error('judge returned no answers');
        return data.answers;
    }
}
