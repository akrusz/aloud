/**
 * The blocking "update" screen for a build older than aloud cloud's minimum
 * for its platform (decideUpdateBlock in client-version.ts, the screen in
 * views/update-block.ts). Decided at load, before the first view mounts, and
 * again at Begin from the minimum read at load (no request), since an app can
 * stay open for days.
 *
 * Never blocks without a minimum: no config (offline, a fully local build), or
 * none for this platform.
 */

import { detectCapabilities } from './capabilities.js';
import { checkDesktopUpdate } from './desktop-updater.js';
import {
    clientPlatform,
    decideUpdateBlock,
    isBelowMinimum,
    minimumFor,
    runningVersion,
    type UpdateGateInput,
} from './client-version.js';
import { getSimOutdated, simulatedGateInput } from './dev-sim.js';
import { primeAudioPlayback } from './audio-unlock.js';
import { closeIfActive as closeGuideIfActive } from './tour/index-guide.js';
import { mountUpdateBlockView } from './views/update-block.js';

function liveInput(): UpdateGateInput {
    const platform = clientPlatform();
    return { platform, running: runningVersion(), minimum: minimumFor(platform), checkDesktopUpdate };
}

/** Boot's check (app.ts bootApp): true when the update screen is now the page. */
export async function blockIfOutdatedAtBoot(root: HTMLElement): Promise<boolean> {
    const sim = getSimOutdated();
    let input: UpdateGateInput;
    if (sim) {
        input = simulatedGateInput(sim, clientPlatform(), runningVersion());
    } else {
        // Fetches the config; setup awaits the same probe before its first
        // render anyway.
        await detectCapabilities();
        input = liveInput();
    }
    const block = await decideUpdateBlock(input);
    if (block) mountUpdateBlockView(root, block);
    return block !== null;
}

/**
 * Begin's check (app.ts goSession, goNotingSession), from the minimum read at
 * load. Null, synchronously, unless this build is below it, so the Begin
 * click's gesture still reaches the mic check unspent. Otherwise resolves true
 * once the update screen is up, false when the session may go ahead (a desktop
 * update not out yet).
 *
 * The setup screen has already stopped its listener and speaker by then
 * (beginFromSetup), and lets go of the mic it held for the session once this
 * start is turned back.
 */
export function updateBlockAtBegin(root: HTMLElement): Promise<boolean> | null {
    const input = liveInput();
    if (input.platform === 'web' || !isBelowMinimum(input.running, input.minimum)) return null;
    // The updater's await spends the gesture, and with no update the session
    // starts after it: unlock playback while the click still counts.
    primeAudioPlayback();
    return decideUpdateBlock(input).then((block) => {
        if (!block) return false;
        // Its overlay lives on <body>, outside the root the screen replaces.
        closeGuideIfActive();
        mountUpdateBlockView(root, block);
        return true;
    });
}
