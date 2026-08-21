/**
 * Structured event tap for the tier-2 soak harness (dev-docs/soak-harness.md).
 *
 * Tier 1 runs the engine headless and can read its own state directly. Tier 2
 * drives the REAL UI through a virtual microphone, so the only way to know what
 * happened - which route an utterance took, whether a hold was entered, what the
 * recognizer actually heard versus what was spoken at it - is for the view to
 * say so. The DOM transcript can't: it shows clean text and nothing about holds,
 * classifiers, echo drops, or timer events.
 *
 * The records mirror tier 1's shapes (soak/types.ts) exactly, so `runChecks`,
 * `judgeSession`, and the report writer work on a browser session unchanged.
 *
 * SECURITY / cost: gated on `import.meta.env.DEV` AND an explicit `?soak=1`, so
 * a release bundle has no tap and a normal dev session pays nothing for one.
 * Same rule as dev-sim.ts. Every helper below is a no-op when disarmed - call
 * sites don't guard, they just call.
 */

import type { LlmCallStat, SoakEvent, TurnKind, TurnRecord } from '../../soak/types.js';

/** Re-exported so call sites in the view name a turn's kind without reaching
 *  into the harness directory themselves. */
export type { TurnKind };

/** What the Playwright driver reads out of the page. Arrays only grow. */
export interface SoakTapState {
    /** Wall-clock ms at arm, so the driver can align its own log. */
    startedAt: number;
    turns: TurnRecord[];
    events: SoakEvent[];
    calls: LlmCallStat[];
    /** Live view flags the driver polls to decide when it's safe to speak. */
    flags: {
        silenceMode: boolean;
        awaitingHoldConfirm: boolean;
        speaking: boolean;
        busy: boolean;
        muted: boolean;
        ended: boolean;
        phase?: string;
    };
}

declare global {
    interface Window {
        __aloudSoak?: SoakTapState;
    }
}

/**
 * Read at module load, NOT at arm time: the SPA router replaceState()s the query
 * string away on the first route change, so by the time the session view mounts
 * `?soak=1` is long gone. Same reason app-mode.ts snapshots its overrides here.
 */
const SOAK_PARAM = ((): boolean => {
    try {
        return new URLSearchParams(location.search).has('soak');
    } catch {
        return false;
    }
})();

let state: SoakTapState | null = null;

/** True once armed. Cheap enough to call in hot paths. */
export function isSoakTapArmed(): boolean {
    return state !== null;
}

/**
 * Arm the tap for this session. Call once at session mount; a second call is
 * ignored so a resumed view doesn't reset the driver's timeline mid-run.
 */
export function armSoakTap(): void {
    // The DEV check stays inline and first: that's what lets the bundler fold
    // this whole body away, so a release build carries no tap at all.
    if (!import.meta.env.DEV || !SOAK_PARAM || state) return;
    state = {
        startedAt: Date.now(),
        turns: [],
        events: [],
        calls: [],
        flags: {
            silenceMode: false,
            awaitingHoldConfirm: false,
            speaking: false,
            busy: false,
            muted: false,
            ended: false,
        },
    };
    window.__aloudSoak = state;
}

/** Seconds since arm, the `at` base both tiers use. */
function at(): number {
    return state ? (Date.now() - state.startedAt) / 1000 : 0;
}

export function tapTurn(
    role: TurnRecord['role'],
    kind: TurnKind,
    text: string,
    extra: Partial<TurnRecord> = {}
): void {
    if (!state) return;
    state.turns.push({
        at: at(),
        role,
        kind,
        text,
        ...(state.flags.silenceMode ? { duringHold: true } : {}),
        ...extra,
    });
}

export function tapEvent(
    kind: SoakEvent['kind'],
    detail: string,
    data?: Record<string, unknown>
): void {
    if (!state) return;
    state.events.push({ at: at(), ...(data !== undefined ? { data } : {}), kind, detail });
}

export function tapCall(kind: string, latencyMs: number): void {
    if (!state) return;
    state.calls.push({ kind, latencyMs });
}

export function tapFlags(patch: Partial<SoakTapState['flags']>): void {
    if (!state) return;
    Object.assign(state.flags, patch);
}

/**
 * Time an LLM-ish call into the tap's latency profile. Returns the promise
 * unchanged (including rejections), so it can wrap a call in place.
 */
export async function tapTimed<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    if (!state) return fn();
    const t0 = Date.now();
    try {
        return await fn();
    } finally {
        tapCall(kind, Date.now() - t0);
    }
}
