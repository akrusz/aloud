/**
 * Credit ledger operations on top of any CreditsStore. Pure-ish business
 * logic: balance is always derived by summing append-only entries, so it can
 * never drift from its history.
 *
 * Hold lifecycle (meditation-pal-8sj "pre-auth hold at session start"):
 *   placeHold(N)        -> appends a -N 'hold' entry, returns holdId
 *   settleHold(holdId, actual) -> releases the hold (+N) and debits `actual`
 *   releaseHold(holdId) -> releases the hold (+N), no debit (session aborted)
 * Spendable balance already reflects outstanding holds because the hold entry
 * is negative. Settling swaps the estimate for the real cost atomically from
 * the caller's perspective.
 *
 * Concurrency (meditation-pal): every spend operation is a read-then-write —
 * read the balance, then append a hold/debit. The read does `await
 * store.listEntries`, which yields the event loop, so two concurrent requests
 * for the SAME account could both read "enough" before either writes and
 * overdraw the balance. `node:sqlite` is synchronous, so these async wrappers
 * are the only interleaving point in the store; we close it by serializing all
 * compound (read-modify-write) ops PER ACCOUNT through a keyed promise chain
 * (runExclusive). Different accounts never contend; same-account ops queue. This
 * mirrors the atomic compare-and-set the gift code already uses for the same
 * hazard. Single-append ops (grant/purchase) don't read first, so they don't
 * need the lock — purchase idempotency is the store's unique index, not this.
 */

import { randomUUID } from 'node:crypto';
import type { Clock } from '@aloud/core';
import type { CreditsStore, LedgerEntry, LedgerKind } from './store.js';

/** A hold older than this is considered orphaned (its turn can't still be in
 *  flight) and is swept by releaseStaleHolds. Holds are per-turn and live for
 *  seconds; 10 minutes is far past any legitimate turn. */
export const STALE_HOLD_MAX_AGE_SEC = 10 * 60;

export class InsufficientCreditsError extends Error {
    constructor(public readonly needed: number, public readonly available: number) {
        super(`insufficient credits: need ${needed}, have ${available}`);
        this.name = 'InsufficientCreditsError';
    }
}

export class Ledger {
    private readonly now: () => number;

    /** Per-account tail of the in-flight op chain. A spend op for an account
     *  awaits the prior op for that same account, so balance()->append() can't
     *  interleave. Keyed by accountId; entries are pruned when their chain is
     *  the current tail and has settled (keeps the map from growing unbounded). */
    private readonly chains = new Map<string, Promise<unknown>>();

    constructor(
        private readonly store: CreditsStore,
        clock?: Clock
    ) {
        // core's Clock is `() => number` (seconds since epoch).
        this.now = clock ?? (() => Date.now() / 1000);
    }

    /** Run `fn` with exclusive access to `accountId`: it starts only after the
     *  previous op for that account finishes (success OR failure), so the
     *  read-then-write inside it is atomic against other same-account ops. A
     *  rejecting fn doesn't poison the chain — the stored tail swallows the
     *  error so the next op still runs. */
    private runExclusive<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.chains.get(accountId) ?? Promise.resolve();
        const result = prev.then(fn, fn);
        // Tail used only for ordering — swallow errors so a failed op doesn't
        // reject every queued successor.
        const tail = result.then(
            () => undefined,
            () => undefined
        );
        this.chains.set(accountId, tail);
        // Prune once settled, but only if we're still the latest tail (else a
        // newer op already owns the slot and must keep it).
        void tail.then(() => {
            if (this.chains.get(accountId) === tail) this.chains.delete(accountId);
        });
        return result;
    }

    async balance(accountId: string): Promise<number> {
        const entries = await this.store.listEntries(accountId);
        return entries.reduce((sum, e) => sum + e.amount, 0);
    }

    private async append(
        accountId: string,
        kind: LedgerKind,
        amount: number,
        reason: string,
        holdId?: string
    ): Promise<LedgerEntry> {
        const entry: LedgerEntry = {
            id: randomUUID(),
            accountId,
            kind,
            amount,
            reason,
            createdAt: this.now(),
            ...(holdId ? { holdId } : {}),
        };
        await this.store.appendEntry(entry);
        return entry;
    }

    /** One-time signup grant (meditation-pal-2yb). Caller guards against
     *  granting twice; this just records it. */
    grant(accountId: string, credits: number, reason = 'signup_grant'): Promise<LedgerEntry> {
        return this.append(accountId, 'signup_grant', Math.abs(credits), reason);
    }

    /** Claw back credits on a refund or chargeback (meditation-pal-7tl). A
     *  NEGATIVE entry; unlike a spend it does NOT check the balance — the buyer
     *  may have already spent the credits, and the account *should* go negative
     *  (it reflects a real debt and nets against any future top-up). Idempotent
     *  on `reason` via the store's partial unique index (kind='refund'), so a
     *  webhook retry claws back exactly once. */
    refund(accountId: string, credits: number, reason: string): Promise<LedgerEntry> {
        return this.append(accountId, 'refund', -Math.abs(credits), reason);
    }

    /** Record a completed credit purchase (called from the Stripe webhook
     *  after payment confirmation). */
    purchase(accountId: string, credits: number, reason: string): Promise<LedgerEntry> {
        return this.append(accountId, 'purchase', Math.abs(credits), reason);
    }

    /** Place a pre-auth hold, failing if spendable balance can't cover it.
     *  The hold entry is tagged with its own holdId so settle/release can find
     *  it. Serialized per account so the balance check and the hold append are
     *  atomic against a concurrent hold for the same account. Sweeps any stale
     *  (orphaned) holds for the account first, so a turn whose settle/release
     *  was lost (crash mid-stream) can't lock the credits out forever. */
    placeHold(accountId: string, credits: number, reason: string): Promise<string> {
        return this.runExclusive(accountId, async () => {
            await this.sweepStaleHolds(accountId);
            const available = await this.balance(accountId);
            if (available < credits) throw new InsufficientCreditsError(credits, available);
            const holdId = randomUUID();
            await this.append(accountId, 'hold', -Math.abs(credits), reason, holdId);
            return holdId;
        });
    }

    /** Release every outstanding hold older than `maxAgeSec` for one account.
     *  Holds are per-turn pre-auths a few seconds long in practice; one that has
     *  sat for many minutes was orphaned (client disconnect / crash between the
     *  hold and its settle), and releasing it gives the credits back. Called
     *  lazily on the account's spend/balance paths rather than from a timer —
     *  an orphan only matters at the moment the account is next looked at. */
    releaseStaleHolds(accountId: string, maxAgeSec = STALE_HOLD_MAX_AGE_SEC): Promise<void> {
        return this.runExclusive(accountId, () => this.sweepStaleHolds(accountId, maxAgeSec));
    }

    /** The unsynchronized sweep — call only while holding the account's
     *  runExclusive slot (a nested runExclusive would deadlock on itself). */
    private async sweepStaleHolds(
        accountId: string,
        maxAgeSec = STALE_HOLD_MAX_AGE_SEC
    ): Promise<void> {
        const cutoff = this.now() - maxAgeSec;
        const entries = await this.store.listEntries(accountId);
        // Net outstanding amount and placement time per holdId.
        const open = new Map<string, { amount: number; placedAt: number }>();
        for (const e of entries) {
            if (!e.holdId) continue;
            const h = open.get(e.holdId) ?? { amount: 0, placedAt: e.createdAt };
            if (e.kind === 'hold') {
                h.amount += -e.amount; // hold is negative; track the magnitude held
                h.placedAt = e.createdAt;
            } else if (e.kind === 'hold_release') {
                h.amount -= e.amount;
            }
            open.set(e.holdId, h);
        }
        for (const [holdId, h] of open) {
            if (h.amount <= 0 || h.placedAt > cutoff) continue;
            await this.append(accountId, 'hold_release', h.amount, `stale_release:${holdId}`, holdId);
        }
    }

    /** Settle a hold to an actual cost: release the held amount, then debit
     *  the real cost. Net effect on balance is -actual. Idempotent: if the hold
     *  is already released (held == 0), this is a no-op — without that guard a
     *  second settle for the same holdId would re-fire the debit and double-
     *  charge (the release would be a harmless +0, but the debit isn't). */
    settleHold(
        accountId: string,
        holdId: string,
        actualCredits: number,
        reason: string
    ): Promise<void> {
        return this.runExclusive(accountId, async () => {
            const held = await this.heldAmount(accountId, holdId);
            if (held <= 0) return; // already settled/released, or never held
            await this.append(accountId, 'hold_release', held, `release:${holdId}`, holdId);
            if (actualCredits > 0) {
                await this.append(accountId, 'debit', -Math.abs(actualCredits), reason, holdId);
            }
        });
    }

    /** Release a hold with no charge (session aborted before any usage).
     *  Idempotent for the same reason as settleHold. */
    releaseHold(accountId: string, holdId: string): Promise<void> {
        return this.runExclusive(accountId, async () => {
            const held = await this.heldAmount(accountId, holdId);
            if (held <= 0) return;
            await this.append(accountId, 'hold_release', held, `release:${holdId}`, holdId);
        });
    }

    /** Direct debit with no prior hold (e.g. reconciling a turn outside a held
     *  session). Throws if it would overdraw. Serialized per account so the
     *  check and the debit append are atomic against concurrent same-account ops. */
    debit(accountId: string, credits: number, reason: string): Promise<void> {
        return this.runExclusive(accountId, async () => {
            const available = await this.balance(accountId);
            if (available < credits) throw new InsufficientCreditsError(credits, available);
            await this.append(accountId, 'debit', -Math.abs(credits), reason);
        });
    }

    /** The magnitude of an outstanding hold (positive). 0 if already released. */
    private async heldAmount(accountId: string, holdId: string): Promise<number> {
        const entries = await this.store.listEntries(accountId);
        let net = 0;
        for (const e of entries) {
            if (e.holdId !== holdId) continue;
            if (e.kind === 'hold') net += -e.amount; // hold is negative; magnitude held
            if (e.kind === 'hold_release') net -= e.amount; // release is positive
        }
        return Math.max(0, net);
    }
}
