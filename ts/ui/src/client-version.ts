/**
 * Which build this is, and the oldest one aloud cloud still serves. The server
 * publishes a minimum per platform on GET /cloud/v1/config
 * (ts/server/src/min-client-version.ts); capabilities.ts adopts it with the
 * rest of that config, once per app load. update-gate.ts acts on it.
 *
 * The build also names itself to the server once per load, on the first
 * signed-in GET /cloud/v1/me (cloud-auth.ts fetchMe), for the admin accounts
 * list.
 */

import { isTauri, capacitorPlatform } from './is-desktop.js';
import type { DesktopUpdate } from './desktop-updater.js';

/** Mirrors the server's ClientPlatform (contract.ts). */
export type ClientPlatform = 'desktop' | 'android' | 'ios' | 'web';
/** The platforms with a minimum. The hosted web app is always the last
 *  release, so it has none. */
export type MinVersionPlatform = Exclude<ClientPlatform, 'web'>;

export function clientPlatform(): ClientPlatform {
    if (isTauri()) return 'desktop';
    const native = capacitorPlatform();
    return native === 'web' ? 'web' : native;
}

/** The running build's version: '' where none was baked in (the unit tests,
 *  which have no vite define). */
export function runningVersion(): string {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
}

/** "2.20.1", or a pre-release such as "2.21.0-rc.1". */
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(-[0-9A-Za-z.]{1,16})?$/;

/**
 * Below zero, zero or above zero as `a` is older than, the same as or newer
 * than `b`; null when either isn't a version. A pre-release sits below its
 * release; two pre-releases of one version compare equal.
 */
export function compareVersions(a: string, b: string): number | null {
    const x = VERSION.exec(a);
    const y = VERSION.exec(b);
    if (!x || !y) return null;
    for (const i of [1, 2, 3]) {
        const diff = Number(x[i]) - Number(y[i]);
        if (diff !== 0) return diff;
    }
    return (x[4] ? 0 : 1) - (y[4] ? 0 : 1);
}

/**
 * Whether `running` is older than `minimum`. False whenever it can't be told:
 * no minimum, '0.0.0', or either side not a version. Nothing is ever blocked
 * on a guess.
 */
export function isBelowMinimum(running: string, minimum: string | null | undefined): boolean {
    if (!minimum) return false;
    const order = compareVersions(running, minimum);
    return order !== null && order < 0;
}

let minimums: Partial<Record<MinVersionPlatform, string>> = {};

/** Adopt the config's `minClientVersion`. Anything not shaped like a version is
 *  dropped, so a malformed field can only mean no minimum. */
export function setMinClientVersions(raw: unknown): void {
    const next: Partial<Record<MinVersionPlatform, string>> = {};
    if (raw && typeof raw === 'object') {
        for (const platform of ['desktop', 'android', 'ios'] as const) {
            const value = (raw as Record<string, unknown>)[platform];
            if (typeof value === 'string' && VERSION.test(value)) next[platform] = value;
        }
    }
    minimums = next;
}

/** The minimum read at load for a platform, or null for none (the web, no
 *  config, a field an older server didn't send). */
export function minimumFor(platform: ClientPlatform): string | null {
    if (platform === 'web') return null;
    return minimums[platform] ?? null;
}

export type UpdateBlock =
    | { platform: 'desktop'; minimum: string; update: DesktopUpdate }
    | { platform: 'android' | 'ios'; minimum: string };

export interface UpdateGateInput {
    platform: ClientPlatform;
    running: string;
    minimum: string | null;
    checkDesktopUpdate: () => Promise<DesktopUpdate | null>;
}

/**
 * The update screen to show (update-gate.ts), or null to carry on. Desktop
 * needs the updater to offer a version at or above the minimum: the server
 * deploys minutes before a release's desktop bundles exist, and a screen with
 * nothing to install would strand people. The updater is asked only when the
 * build is below the minimum.
 */
export async function decideUpdateBlock(input: UpdateGateInput): Promise<UpdateBlock | null> {
    const { platform, running, minimum } = input;
    if (platform === 'web' || minimum === null || !isBelowMinimum(running, minimum)) return null;
    if (platform !== 'desktop') return { platform, minimum };
    const update = await input.checkDesktopUpdate();
    if (!update || isBelowMinimum(update.version, minimum)) return null;
    return { platform, minimum, update };
}

let reported = false;

/** The query that names this build on the first GET /cloud/v1/me of a load,
 *  '' once that call has gone through (or with no version to name). */
export function clientReportQuery(): string {
    const version = runningVersion();
    if (reported || !version) return '';
    return `?${new URLSearchParams({ v: version, platform: clientPlatform() }).toString()}`;
}

/** The server has the build: later calls this load go without the query. */
export function noteClientReported(): void {
    reported = true;
}
