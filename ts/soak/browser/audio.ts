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
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

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

export interface AudioRouting {
    /** Undo the routing and restore what the user had. Safe to call twice. */
    restore(): Promise<void>;
}

/**
 * Point both default devices at the loopback device, returning a restore
 * handle. Throws with an actionable message when BlackHole isn't installed -
 * the cask needs a reboot before CoreAudio lists it.
 */
export async function routeThroughLoopback(deviceName = LOOPBACK_DEVICE): Promise<AudioRouting> {
    const [inputs, outputs] = await Promise.all([list('input'), list('output')]);
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

    const onSignal = (): void => {
        void restore().then(() => process.exit(130));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    return { restore };
}
