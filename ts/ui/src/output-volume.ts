/**
 * Whether the phone's volume is off or nearly off, where the app can find out:
 * the iOS and Android apps (OutputVolumePlugin.swift / .java). A browser page
 * can't read the system volume, and the desktop shell doesn't yet
 * (meditation-pal-zojq).
 *
 * A session says so in a banner (mountVolumeNotice), and the setup screen
 * doesn't: a phone's setup screen is silent unless asked to speak. "Very low"
 * is judged once, as the session loads: once its mic is open, which on
 * Android settles the stream it plays on (the call stream under an
 * echo-cancelled capture, MainActivity.java), and which happens before
 * anything audible. A level turned down after that is the meditator's own
 * choice. "Off" is watched for through the start and stays up until the
 * volume comes up. Never a gate: a low setting is a guess about the room, and
 * a dead mic is the only thing that makes a session impossible.
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

/** One step up from the bottom on an iPhone (16 steps) and on Android's media
 *  stream (15), and only the bottom step of Android's call stream (9 on the
 *  phone it was set on, where one step up is 0.125 and already fine). */
export const LOW_VOLUME = 0.1;
const POLL_MS = 2000;
/** How long a session keeps looking for the volume off. */
export const WATCH_MS = 60_000;
/** How long after the session's mic opens "very low" is judged: a beat for
 *  Android to have moved the app to the call stream. */
export const LOW_JUDGED_AFTER_MS = 1000;
/** How long "very low" stays up once it shows: a hint, read in a glance. */
export const LOW_SHOWN_MS = 10_000;

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
 * "Off" is looked for through WATCH_MS and stays until it is turned up. "Very
 * low" is one reading, LOW_JUDGED_AFTER_MS after `micOpen` settles (the
 * session's mic open; at once where there is none): when it is low, up for
 * LOW_SHOWN_MS or until the volume comes up, and never shown later. `wanted`
 * is whether the session speaks at all (its TTS toggle). Returns the stop.
 */
export function mountVolumeNotice(
    el: VolumeNoticeEl | null,
    opts: {
        wanted?: () => boolean;
        read?: () => Promise<VolumeReading | null>;
        micOpen?: Promise<unknown>;
    } = {}
): () => void {
    if (!el) return () => {};
    const read = opts.read ?? readOutputVolume;
    const startedAt = Date.now();
    let stopped = false;
    // Nothing to read here (a browser, the desktop app): done for good.
    let unreadable = false;
    let off = false;
    let low = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, run: () => void): void => {
        if (stopped) return;
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!stopped) run();
        }, ms);
        timers.add(timer);
    };
    const show = (): void => {
        const problem = off ? 'off' : low ? 'low' : null;
        el.textContent = problem ? describeVolumeProblem(problem) : '';
        el.classList.toggle('hidden', !problem);
    };
    const problemNow = async (): Promise<VolumeProblem | null> => {
        const reading = await read();
        if (reading === null) unreadable = true;
        return opts.wanted?.() === false ? null : volumeProblem(reading);
    };

    const watchOff = async (): Promise<void> => {
        const problem = await problemNow();
        if (stopped || unreadable) return;
        off = problem === 'off';
        // Turned up while "very low" shows: it goes.
        if (problem !== 'low') low = false;
        show();
        if (off || low || Date.now() - startedAt < WATCH_MS) later(POLL_MS, () => void watchOff());
    };
    void watchOff();

    void Promise.resolve(opts.micOpen)
        .catch(() => undefined)
        .then(() =>
            later(LOW_JUDGED_AFTER_MS, () => {
                if (unreadable) return;
                void problemNow().then((problem) => {
                    if (stopped || problem !== 'low') return;
                    low = true;
                    show();
                    later(LOW_SHOWN_MS, () => {
                        low = false;
                        show();
                    });
                });
            })
        );

    return () => {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
    };
}
