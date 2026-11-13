/**
 * What an account has in flight right now, summed and admitted against a
 * ceiling. The ledger only learns what a call cost when it settles, so
 * anything decided from the balance alone is decided again, on the same
 * balance, by every call that arrives before the first one lands. Two things
 * are counted this way:
 *
 *   - deps.overdraft: how far the LLM turns in flight could run past their
 *     holds (pricing/meter.ts MAX_UNCOVERED_CREDITS);
 *   - deps.upfrontPending: STT/TTS calls that passed the balance gate and
 *     have not been debited yet (routes/upfront-charge.ts).
 *
 * In memory, like RateGuard: a restart forgets it, which only means the first
 * calls after one are admitted as if nothing were open. Multi-instance would
 * move it beside the rate limits.
 */

const NOOP = (): void => undefined;

export class InFlightSum {
    private readonly open = new Map<string, number>();

    /**
     * Add `amount` to the account's running sum if that keeps it at or under
     * `ceiling`. Returns the function that takes it back off (idempotent, call
     * it when the call settles or fails), or null when it does not fit.
     * Nothing to add always fits; an amount that is not a number never does.
     */
    tryAdd(accountId: string, amount: number, ceiling: number): (() => void) | null {
        if (!Number.isFinite(amount)) return null;
        if (amount <= 0) return NOOP;
        const current = this.open.get(accountId) ?? 0;
        if (current + amount > ceiling) return null;
        this.open.set(accountId, current + amount);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const left = (this.open.get(accountId) ?? 0) - amount;
            // Float residue from adds and removes in different orders is not
            // an open call.
            if (left > 1e-9) this.open.set(accountId, left);
            else this.open.delete(accountId);
        };
    }

    /** The account's current sum (tests, diagnostics). */
    openFor(accountId: string): number {
        return this.open.get(accountId) ?? 0;
    }
}
