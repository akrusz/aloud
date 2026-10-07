/**
 * TypeSafe's Jev under the user's OWN key, for a desktop sit that keeps its
 * words off aloud cloud (voice-commands.ts). TypeSafe answers no browser origin
 * (CORS), so the request goes through the shell's fixed relay (/app/v1/judge,
 * src-tauri server.rs): desktop only. The key rides in x-provider-key and the
 * shell stores nothing.
 */

import type { JudgeAnswers, JudgeId } from '../../../src/facilitation/index.js';
import { jevRequest, judgeSpec, noulAnswers } from '../../../src/facilitation/index.js';
import { appUrl } from '../app-base.js';
import { RemoteJudge } from './cloud-judge.js';

export class OwnKeyJudge extends RemoteJudge {
    constructor(
        private readonly apiKey: string,
        options: { fetchImpl?: typeof fetch; now?: () => number } = {}
    ) {
        super(options);
    }

    protected async request(
        classifier: JudgeId,
        text: string,
        earlier: string[],
        signal: AbortSignal
    ): Promise<JudgeAnswers> {
        const res = await this.fetchImpl(appUrl('/judge'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-provider-key': this.apiKey },
            body: JSON.stringify(jevRequest(classifier, text, { earlier })),
            signal,
        });
        if (!res.ok) throw new Error(`judge returned ${res.status}`);
        return noulAnswers(Object.keys(judgeSpec(classifier).asks), await res.json());
    }
}
