/**
 * Whether the phone's volume is off or nearly off, where the app can find out:
 * the iOS and Android apps (OutputVolumePlugin.swift / .java). A browser page
 * can't read the system volume, and the desktop shell doesn't yet
 * (meditation-pal-zojq).
 *
 * A session looks as it starts and says so in a banner (mountVolumeNotice).
 * Then, and not on the setup screen: on Android the stream a session plays on
 * is only settled once its mic is open (media, or the call stream under an
 * echo-cancelled capture: MainActivity.java), and a phone's setup screen is
 * silent unless asked to speak. Never a gate: a low setting is a guess about
 * the room, and a dead mic is the only thing that makes a session impossible.
 */

import { capacitorPlatform } from './is-desktop.js';
import { t } from './i18n.js';

export interface VolumeReading {
    /** 0 at the stream's lowest step, 1 at its highest. */
    level: number;
    /** Silent outright. Android's call stream bottoms out above this. */
    muted: boolean;
    headphones: boolean;
}

export type VolumeProblem = 'off' | 'low';

/** Two steps up from the bottom on an iPhone (16 steps) and on Android's
 *  usual media stream (15): a voice from the speaker is lost in a quiet room. */
export const LOW_VOLUME = 0.15;
const POLL_MS = 2000;
/** How long a session keeps looking, and keeps a "very low" banner up. Long
 *  enough for the mic to open and the first line to be spoken. */
export const WATCH_MS = 60_000;

interface OutputVolumePlugin {
    level(): Promise<Partial<VolumeReading>>;
}

// Never `await` or resolve a promise with this: a Capacitor plugin proxy
// answers every property read, `then` included (screen-dim.ts).
let plugin: OutputVolumePlugin | null = null;

/** Null wherever the volume can't be read. */
export async function readOutputVolume(): Promise<VolumeReading | null> {
    try {
        if (capacitorPlatform() === 'web') return null;
        plugin ??= (await import('@capacitor/core')).registerPlugin<OutputVolumePlugin>('OutputVolume');
        const reading = await plugin.level();
        if (typeof reading.level !== 'number') return null;
        return { level: reading.level, muted: reading.muted === true, headphones: reading.headphones === true };
    } catch {
        return null;
    }
}

export function volumeProblem(reading: VolumeReading | null): VolumeProblem | null {
    if (!reading) return null;
    if (reading.muted) return 'off';
    // In headphones a low setting is often the comfortable one.
    if (!reading.headphones && reading.level <= LOW_VOLUME) return 'low';
    return null;
}

export function describeVolumeProblem(problem: VolumeProblem): string {
    return problem === 'off' ? t('The volume is off.') : t('The volume is very low.');
}

/** The banner's element, as much of it as this needs. */
export interface VolumeNoticeEl {
    textContent: string | null;
    classList: { toggle(cls: string, force: boolean): unknown };
}

/**
 * Keep `el` saying what is wrong with the volume for the start of a session.
 * "Off" stays until it is turned up; "very low" is a hint, and goes when the
 * watch ends. `wanted` is whether the session speaks at all (its TTS toggle).
 * Returns the stop.
 */
export function mountVolumeNotice(
    el: VolumeNoticeEl | null,
    opts: { wanted?: () => boolean; read?: () => Promise<VolumeReading | null> } = {}
): () => void {
    if (!el) return () => {};
    const read = opts.read ?? readOutputVolume;
    const startedAt = Date.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const look = async (): Promise<void> => {
        const reading = await read();
        // Nothing to read here (a browser, the desktop app): done for good.
        if (stopped || reading === null) return;
        const watching = Date.now() - startedAt < WATCH_MS;
        const found = opts.wanted?.() === false ? null : volumeProblem(reading);
        const problem = found === 'low' && !watching ? null : found;
        el.textContent = problem ? describeVolumeProblem(problem) : '';
        el.classList.toggle('hidden', !problem);
        if (watching || problem) timer = setTimeout(() => void look(), POLL_MS);
    };
    void look();

    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
