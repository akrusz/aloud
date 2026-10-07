/**
 * The first sit: what "Try right now" on the first-run welcome card starts
 * (tour/index-guide.ts). An exploration session on the stock form, tuned for
 * someone who has never done this:
 *
 * - the facilitator opens by explaining the format (buildOpenerPrompt),
 * - guidance sits a notch up and silences get checked on sooner, since a
 *   quiet newcomer is more likely unsure than settled,
 * - a short timer gives the sit an end to agree to.
 *
 * All of it is for that one session. Nothing here reaches the saved setup or
 * Settings, so whatever the meditator configures afterwards starts clean.
 */

import { defaultSetup, type SessionSetup } from './settings.js';

/** The welcome card promises this number, and the facilitator lands it in
 *  voice (the sit stays open afterwards, as with any timer). */
export const FIRST_SIT_TIMER_MIN = 5;

/** Default smart check-in wait. Well under the 90s the guidance stop below
 *  would give, above the 30s floor (CHECKIN_INTERVAL_MIN_SEC). */
export const FIRST_SIT_CHECKIN_WAIT_SEC = 45;

/** "Somewhat directing": suggests where to look without leading the sit. */
const FIRST_SIT_DIR_STEP = 3;

/**
 * The setup a first sit runs on. Provider, model, voice and language come from
 * `current`, which the setup view has already resolved for this platform;
 * everything the form would have asked about is reset to its default, so a
 * half-edited form from an earlier visit doesn't shape it.
 */
export function firstSitSetup(current: SessionSetup): SessionSetup {
    return {
        ...current,
        meditationType: 'exploration',
        intention: '',
        focuses: [...defaultSetup.focuses],
        qualities: [...defaultSetup.qualities],
        dirStep: FIRST_SIT_DIR_STEP,
        verbosity: defaultSetup.verbosity,
        customInstructions: '',
        firstSit: true,
    };
}
