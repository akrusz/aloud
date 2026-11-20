/**
 * The age range the app store shares for this account, as a tier
 * (dev-docs/age-tier.md). aloud never asks anyone's age: the store's signal is
 * the only source, read in the phone apps alone (AgeSignalsPlugin.java /
 * .swift). Web and desktop never ask and are always 'adult'.
 *
 * Only the tier is kept, under one KV key. The range, its bounds and the tier
 * are never logged, sent, or put where the bug report can read them (diag and
 * the error log). Not knowing (an error, a timeout, an old OS) falls back to the
 * tier stored on an earlier launch, else 'adult', so a known under-13 account
 * stays blocked offline.
 */

import type { KvStorage } from '../../src/platform/storage.js';
import { capacitorPlatform } from './is-desktop.js';
import { sharedKv } from './state.js';
import { showSuccessToast } from './toast.js';
import { diag } from './diag.js';
import { t } from './i18n.js';

export type AgeTier = 'adult' | 'teen' | 'child' | 'pendingConsent' | 'deniedConsent';
export type BlockingTier = Extract<AgeTier, 'child' | 'pendingConsent' | 'deniedConsent'>;

const TIERS: readonly AgeTier[] = ['adult', 'teen', 'child', 'pendingConsent', 'deniedConsent'];

/**
 * Whether the native check may ask where the law doesn't make the store share
 * (Play's in-app prompt, Apple's sheet outside a regulated region). Off: there
 * it takes only the paths that never prompt, so nobody is asked for something
 * no law requires.
 */
export const ASK_WHERE_OPTIONAL = false;

/** How long a first launch, with nothing stored, waits for the store before
 *  going on with what is known. */
export const FIRST_CHECK_WAIT_MS = 2500;

export type AgeSignalsStatus = 'shared' | 'notShared' | 'verificationRequired' | 'notRequired' | 'unavailable';

/** What the native `AgeSignals.check` resolves. Bounds are inclusive. */
export interface AgeReading {
    status: AgeSignalsStatus;
    ageLower?: number | null;
    ageUpper?: number | null;
    consent?: 'approved' | 'pending' | 'declined' | null;
    detail?: string;
}

const STATUSES: readonly string[] = ['shared', 'notShared', 'verificationRequired', 'notRequired', 'unavailable'];

export function isAgeTier(value: unknown): value is AgeTier {
    return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

export function isBlockingTier(tier: AgeTier): tier is BlockingTier {
    return tier === 'child' || tier === 'pendingConsent' || tier === 'deniedConsent';
}

const bound = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The tier a store reading means, or null where it says nothing (no reading, an
 * error, Play asking for verification). A minor not known to be under 13,
 * including a range that straddles 13, is 'teen'; only a teen's parental
 * consent is read.
 */
export function tierFromReading(reading: AgeReading | null | undefined): AgeTier | null {
    if (!reading || reading.status === 'unavailable' || reading.status === 'verificationRequired') return null;
    if (reading.status !== 'shared') return 'adult';
    const lower = bound(reading.ageLower);
    const upper = bound(reading.ageUpper);
    if (upper !== null && upper <= 12) return 'child';
    if ((lower !== null && lower >= 18) || (lower === null && upper === null)) return 'adult';
    if (reading.consent === 'pending') return 'pendingConsent';
    if (reading.consent === 'declined') return 'deniedConsent';
    return 'teen';
}

interface AgeSignalsPlugin {
    check(options: { askWhereOptional: boolean }): Promise<Partial<AgeReading>>;
}

// Never `await` or resolve a promise with this: a Capacitor plugin proxy
// answers every property read, `then` included (screen-dim.ts).
let plugin: AgeSignalsPlugin | null = null;

/** Null off the phone apps and wherever the native check fails outright. */
export async function readAgeSignals(): Promise<AgeReading | null> {
    try {
        if (capacitorPlatform() === 'web') return null;
        plugin ??= (await import('@capacitor/core')).registerPlugin<AgeSignalsPlugin>('AgeSignals');
        const reading = await plugin.check({ askWhereOptional: ASK_WHERE_OPTIONAL });
        if (typeof reading.status !== 'string' || !STATUSES.includes(reading.status)) return null;
        return reading as AgeReading;
    } catch {
        return null;
    }
}

const TIER_KEY = 'ageTier';
// Holds '1' and nothing else.
const VERIFY_NOTICE_KEY = 'storeVerifyNoticeShown';

export interface AgeGateDeps {
    platform: () => 'ios' | 'android' | 'web';
    read: () => Promise<AgeReading | null>;
    kv: Pick<KvStorage, 'get' | 'set'>;
    reload: () => void;
    /** Runs `recheck` each time the app comes back to the foreground. */
    onForeground: (recheck: () => void) => void;
    notify: (message: string) => void;
    firstWaitMs?: number;
}

export interface AgeGate {
    /** The tier to boot with. `onBlockedChange` is for a later check that
     *  moves between two blocking tiers, which needs no reload. */
    boot(onBlockedChange?: (tier: BlockingTier) => void): Promise<AgeTier>;
    /** What is on screen. */
    tier(): AgeTier;
}

export function createAgeGate(deps: AgeGateDeps): AgeGate {
    let shown: AgeTier = 'adult';
    let inFlight: Promise<void> | null = null;
    let onBlockedChange: ((tier: BlockingTier) => void) | undefined;

    const noticeOnce = async (): Promise<void> => {
        try {
            if (await deps.kv.get(VERIFY_NOTICE_KEY)) return;
            await deps.kv.set(VERIFY_NOTICE_KEY, '1');
        } catch {
            return;
        }
        deps.notify(t('Google Play needs to confirm your age. You can do that in the Play Store app.'));
    };

    const check = async (): Promise<AgeTier | null> => {
        const reading = await deps.read().catch(() => null);
        if (reading?.status === 'verificationRequired') void noticeOnce();
        if (reading?.status === 'unavailable') diag('[age-check] unavailable', reading.detail ?? '');
        return tierFromReading(reading);
    };

    const store = async (tier: AgeTier): Promise<boolean> => {
        try {
            await deps.kv.set(TIER_KEY, tier);
            return true;
        } catch {
            return false;
        }
    };

    const apply = async (fresh: AgeTier | null): Promise<void> => {
        if (fresh === null) return;
        const stored = await store(fresh);
        if (isBlockingTier(fresh) !== isBlockingTier(shown)) {
            // The reloaded boot starts from the stored tier, which is what
            // keeps this from looping; unstored, it would come back to this.
            if (stored) deps.reload();
            return;
        }
        if (fresh === shown) return;
        shown = fresh;
        if (isBlockingTier(fresh)) onBlockedChange?.(fresh);
    };

    const run = (fresh: Promise<AgeTier | null>): Promise<void> => {
        inFlight = fresh.then(apply).finally(() => {
            inFlight = null;
        });
        return inFlight;
    };

    // One check at a time: on iOS a check can hold a system sheet open.
    const recheck = (): void => {
        if (!inFlight) void run(check());
    };

    return {
        async boot(onChange) {
            onBlockedChange = onChange;
            if (deps.platform() === 'web') return shown;
            let stored: AgeTier | null = null;
            try {
                const value = await deps.kv.get(TIER_KEY);
                stored = isAgeTier(value) ? value : null;
            } catch {
                stored = null;
            }
            const fresh = check();
            if (stored) {
                shown = stored;
            } else {
                const wait = new Promise<null>((resolve) =>
                    setTimeout(() => resolve(null), deps.firstWaitMs ?? FIRST_CHECK_WAIT_MS)
                );
                shown = (await Promise.race([fresh, wait])) ?? 'adult';
            }
            void run(fresh);
            if (isBlockingTier(shown)) deps.onForeground(recheck);
            return shown;
        },
        tier: () => shown,
    };
}

let devOverride: AgeTier | null = null;
let gate: AgeGate | null = null;

/**
 * Dev builds: `?age=child` (or teen, pendingConsent, deniedConsent) boots as
 * that tier, to see the screens in a browser. Adopted at boot with the other
 * dev params (main.ts). This load only: it never touches the stored tier, and
 * it comes off the URL here, since a blocked boot never reaches the router
 * that strips the rest.
 */
export function adoptAgeParam(): void {
    if (!import.meta.env.DEV) return;
    try {
        const url = new URL(window.location.href);
        const value = url.searchParams.get('age');
        if (value === null) return;
        if (isAgeTier(value)) devOverride = value;
        url.searchParams.delete('age');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
        /* no URL to read */
    }
}

/** The tier on screen: 'adult' until boot knows better. */
export function getAgeTier(): AgeTier {
    return gate?.tier() ?? devOverride ?? 'adult';
}

/** Boot's one call (app.ts bootApp). */
export async function bootAgeTier(onBlockedChange?: (tier: BlockingTier) => void): Promise<AgeTier> {
    if (import.meta.env.DEV && devOverride) return devOverride;
    gate = createAgeGate({
        platform: capacitorPlatform,
        read: readAgeSignals,
        kv: sharedKv,
        reload: () => location.reload(),
        onForeground: (recheck) =>
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') recheck();
            }),
        notify: showSuccessToast,
    });
    return gate.boot(onBlockedChange);
}
