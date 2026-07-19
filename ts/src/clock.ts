/**
 * Injectable clock, so timing logic is testable without vi.useFakeTimers.
 * Returns seconds (not milliseconds) since the Unix epoch.
 */
export type Clock = () => number;

export const realClock: Clock = () => Date.now() / 1000;

/** Controllable clock for tests: starts at `start`, advances via `tick(seconds)`. */
export function createFakeClock(start = 0): {
    clock: Clock;
    set: (t: number) => void;
    tick: (seconds: number) => void;
} {
    let now = start;
    return {
        clock: () => now,
        set: (t: number) => { now = t; },
        tick: (seconds: number) => { now += seconds; },
    };
}
