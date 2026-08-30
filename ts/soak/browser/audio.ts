/**
 * Virtual audio routing for tier 2 (macOS).
 *
 * The sim user's voice has to arrive at the app as microphone input, and
 * Chrome's --use-file-for-fake-audio-capture only replays one fixed WAV, so the
 * workable route is a loopback device: BlackHole becomes both the default
 * OUTPUT (where `say` plays) and the default INPUT (what Chrome captures).
 *
 * A consequence worth stating plainly: the app then also hears its own TTS,
 * because that plays out of the same default output. That is deliberate - it is
 * the real acoustic situation a speaker-and-mic user is in, and it puts the echo
 * guard and barge-in under test rather than around it. It also means a run OWNS
 * the machine's audio: nothing else should be playing.
 *
 * The previous defaults are captured at start and restored on the way out,
 * including on Ctrl-C, so an aborted run doesn't leave the Mac deaf.
 *
 * The driver itself gets the same treatment. BlackHole is here for the soak
 * harness and nothing else, but while its HAL plug-in is loaded it stays a
 * candidate default input that CoreAudio falls back to whenever the real mic
 * goes away - so between runs it drifts into being the machine's microphone. A
 * run therefore loads the driver on the way in and parks it again on the way
 * out (scripts/blackhole-driver.sh), and only ever puts back what it moved: a
 * driver that was already loaded when the run started is left loaded.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

const DRIVER_SCRIPT = fileURLToPath(new URL('../../../scripts/blackhole-driver.sh', import.meta.url));

export const LOOPBACK_DEVICE = 'BlackHole 2ch';

type Direction = 'input' | 'output';

async function switchAudio(args: string[]): Promise<string> {
    try {
        const { stdout } = await exec('SwitchAudioSource', args);
        return stdout.trim();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/ENOENT/.test(message)) {
            throw new Error(
                'SwitchAudioSource not found. Install it with `brew install switchaudio-osx` (see dev-docs/soak-harness.md).'
            );
        }
        throw err;
    }
}

async function current(direction: Direction): Promise<string> {
    return switchAudio(['-c', '-t', direction]);
}

async function setDevice(direction: Direction, name: string): Promise<void> {
    await switchAudio(['-s', name, '-t', direction]);
}

async function list(direction: Direction): Promise<string[]> {
    return (await switchAudio(['-a', '-t', direction])).split('\n').map((l) => l.trim()).filter(Boolean);
}

async function driverStatus(): Promise<'loaded' | 'parked' | 'missing' | 'unknown'> {
    try {
        const { stdout } = await exec(DRIVER_SCRIPT, ['status']);
        const s = stdout.trim();
        return s === 'loaded' || s === 'parked' || s === 'missing' ? s : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Move the driver in or out of the HAL directory. Needs root: `sudo -n` first
 * (a warm timestamp, or a privileged copy of the script - see the sudo note in
 * dev-docs/soak-harness.md), then an interactive prompt unless there's no TTY or
 * the caller can't take one. The signal path can't: a password prompt landing in
 * the middle of a Ctrl-C is worse than leaving the driver loaded.
 */
async function moveDriver(cmd: 'park' | 'unpark', interactive: boolean): Promise<void> {
    // Always try the silent path first: it succeeds off a warm sudo timestamp,
    // and it's the whole story for anyone who installed a privileged copy.
    try {
        await exec('sudo', ['-n', DRIVER_SCRIPT, cmd]);
        return;
    } catch (err) {
        if (!interactive || !process.stdin.isTTY) throw err;
    }
    console.log(`soak: ${cmd}ing the BlackHole audio driver needs sudo.`);
    await new Promise<void>((resolve, reject) => {
        const child = spawn('sudo', [DRIVER_SCRIPT, cmd], { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`${DRIVER_SCRIPT} ${cmd} exited ${code}`))
        );
    });
}

/** Poll until the device shows up in (or drops out of) CoreAudio's list. */
async function waitForDevice(name: string, present: boolean, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // coreaudiod is restarting under us; a failed list is a retry, not an error.
        const listed = await list('input').catch(() => null);
        if (listed && listed.includes(name) === present) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 250));
    }
}

export interface AudioRouting {
    /** Put the default input and output back. Safe to call twice. */
    restore(): Promise<void>;
    /**
     * Park the driver again, if this run is the thing that loaded it. Separate
     * from `restore` and called last, after the reports are on disk: it's the
     * step that can want a password, and a run you walked away from shouldn't
     * hold its results hostage to a prompt. Safe to call twice.
     * `interactive: false` (the signal path) prints the command instead of
     * prompting.
     */
    parkDriver(opts?: { interactive?: boolean }): Promise<void>;
}

export interface RoutingOptions {
    /** Park the driver again on restore if this run loaded it. Default true. */
    park?: boolean;
}

/**
 * Point both default devices at the loopback device, returning a restore
 * handle. Throws with an actionable message when BlackHole isn't installed -
 * the cask needs a reboot before CoreAudio lists it.
 */
export async function routeThroughLoopback(
    deviceName = LOOPBACK_DEVICE,
    options: RoutingOptions = {}
): Promise<AudioRouting> {
    let parkOnRestore = false;
    let [inputs, outputs] = await Promise.all([list('input'), list('output')]);

    if (!inputs.includes(deviceName) || !outputs.includes(deviceName)) {
        if (deviceName === LOOPBACK_DEVICE && (await driverStatus()) === 'parked') {
            console.log('soak: loading the BlackHole audio driver for this run.');
            await moveDriver('unpark', true);
            if (!(await waitForDevice(deviceName, true))) {
                throw new Error(
                    `Loaded the BlackHole driver but "${deviceName}" never appeared. ` +
                        'Check `scripts/blackhole-driver.sh status` and the Sound pane.'
                );
            }
            parkOnRestore = options.park !== false;
            if (parkOnRestore) console.log('soak: it gets parked again when the run finishes.');
            [inputs, outputs] = await Promise.all([list('input'), list('output')]);
        }
    }

    if (!inputs.includes(deviceName) || !outputs.includes(deviceName)) {
        throw new Error(
            `"${deviceName}" is not an available audio device.\n` +
                'Install it with `brew install --cask blackhole-2ch` and RESTART the Mac - CoreAudio ' +
                "doesn't list the driver until then.\n" +
                `Inputs seen: ${inputs.join(', ') || '(none)'}`
        );
    }

    const previous = {
        input: await current('input'),
        output: await current('output'),
    };
    await setDevice('output', deviceName);
    await setDevice('input', deviceName);

    let restored = false;
    const restore = async (): Promise<void> => {
        if (restored) return;
        restored = true;
        // Best-effort, and both directions attempted even if one fails: leaving
        // the machine on a silent loopback device is worse than a stack trace.
        for (const direction of ['output', 'input'] as const) {
            try {
                await setDevice(direction, previous[direction]);
            } catch (err) {
                console.error(
                    `soak: could not restore default ${direction} to "${previous[direction]}" - set it in System Settings → Sound.`,
                    err
                );
            }
        }
    };

    // Devices first, driver second: parking while BlackHole is still the default
    // leaves CoreAudio to pick the replacement, and it picks badly.
    let parked = false;
    const parkDriver = async ({ interactive = true } = {}): Promise<void> => {
        if (!parkOnRestore || parked) return;
        parked = true;
        try {
            await moveDriver('park', interactive);
        } catch {
            console.error(
                'soak: the BlackHole driver is still loaded, so it will keep offering itself as a ' +
                    'default mic. Park it with `npm run soak:audio -- park`.'
            );
        }
    };

    const onSignal = (): void => {
        void restore()
            .then(() => parkDriver({ interactive: false }))
            .then(() => process.exit(130));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    return { restore, parkDriver };
}
