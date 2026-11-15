/**
 * The judge's tier for setup-screen requests (core setup-command-specs.ts),
 * for the setup view to call when parseSetupCommand returns null.
 *
 * It asks only where an in-session voice command would be heard by the judge
 * (voice-commands.ts voiceCommandsAccess): aloud cloud, an own TypeSafe key on
 * desktop (through the shell relay, nothing via aloud cloud), or the opt-in
 * with an account. Anywhere else nothing is sent.
 *
 * Where no judge may be asked and the session is set to a local model, the
 * request goes to that model instead (`local`, setup-local-reader.ts): the
 * same tier, on the device. Never both: a judge that was asked and found
 * nothing has answered.
 *
 * It never raises a sign-in from the setup screen: aloud cloud and the opt-in
 * need a token already stored (canReachJudge) before anything is sent, and
 * CloudJudge only throws without one.
 */

import type { JudgeAnswers, JudgeContext, JudgeId, SetupAction, UtteranceJudge } from '../../src/facilitation/index.js';
import { judgeSetupCommand, mightBeSetupRequest } from '../../src/facilitation/index.js';
import { CloudJudge } from './adapters/cloud-judge.js';
import { OwnKeyJudge } from './adapters/own-key-judge.js';
import { ownJudgeKey } from './api-keys.js';
import { getJevClassifierMode } from './dev-mode.js';
import { canReachJudge, voiceCommandsAccess } from './voice-commands.js';

export type SetupJudgeRoute = 'cloud' | 'own-key';

export interface SetupJudgeOptions {
    /** The provider picked on the setup screen, read at each call (`setup.provider`). */
    provider: () => string;
    /** AppSettings.voiceCommandsViaCloud, read at each call. */
    optedIn: () => boolean;
    /** The rest default to the app's own; tests pass fakes. */
    ownKey?: () => Promise<string | null>;
    canReach?: () => Promise<boolean>;
    /** The developer override that turns the judge off on aloud cloud. */
    hostedOff?: () => boolean;
    makeJudge?: (route: SetupJudgeRoute, key: string | null) => UtteranceJudge;
    /** Routes that refused a setup id; shared by every setup screen on the page. */
    refused?: Set<string>;
    /** Asked in the judge's place where there is no judge to ask. */
    local?: (text: string) => Promise<SetupAction[] | null>;
}

/**
 * A route that answered 4xx: a server from before the setup ids, or a token it
 * no longer takes. Neither gets better by asking again, and a setup screen
 * hears something every few seconds, so the route is left alone until the
 * page reloads. Module-level so a remounted setup screen doesn't ask again.
 */
const REFUSED = new Set<string>();

/** CloudJudge and OwnKeyJudge throw `judge returned <status>`. A timeout or a
 *  rate limit is not a refusal: RemoteJudge's backoff handles those. */
function isRefusal(err: unknown): boolean {
    const status = Number(/judge returned (\d{3})/.exec(String(err))?.[1]);
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function createSetupJudge(options: SetupJudgeOptions): (text: string) => Promise<SetupAction[] | null> {
    const {
        provider,
        optedIn,
        ownKey = ownJudgeKey,
        canReach = canReachJudge,
        hostedOff = () => getJevClassifierMode() === 'off',
        makeJudge = (route, key) => (route === 'own-key' && key ? new OwnKeyJudge(key) : new CloudJudge()),
        refused = REFUSED,
        local,
    } = options;
    // One judge per route, so its failure backoff carries across utterances.
    let current: { id: string; judge: UtteranceJudge } | null = null;

    return async (text) => {
        if (!mightBeSetupRequest(text)) return null;
        try {
            const key = await ownKey();
            // The account question is canReach's below, asked for aloud cloud
            // too: a cloud pick with no stored token must stay silent.
            const access = voiceCommandsAccess({
                provider: provider(),
                ownKey: key !== null,
                optedIn: optedIn(),
                signedIn: true,
            });
            if (access === 'off') return local ? await local(text) : null;
            if (access === 'hosted' && hostedOff()) return null;
            const route: SetupJudgeRoute = access === 'own-key' ? 'own-key' : 'cloud';
            if (route === 'cloud' && !(await canReach())) return null;

            const id = route === 'own-key' ? `own-key:${key}` : 'cloud';
            if (refused.has(id)) return null;
            if (current?.id !== id) current = { id, judge: makeJudge(route, key) };
            const { judge } = current;
            const watched: UtteranceJudge = {
                judge(classifier: JudgeId, utterance: string, context?: JudgeContext): Promise<JudgeAnswers> {
                    return judge.judge(classifier, utterance, context).catch((err: unknown) => {
                        if (isRefusal(err)) refused.add(id);
                        throw err;
                    });
                },
            };
            return await judgeSetupCommand(watched, text);
        } catch {
            return null;
        }
    };
}
