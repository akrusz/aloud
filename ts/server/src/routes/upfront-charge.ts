/**
 * Billing for the legs whose cost is known exactly before the provider call:
 * STT (priced by audio duration) and TTS (by billed characters). The LLM leg
 * can't know its cost up front, so it holds and settles instead (llm.ts).
 */

import type { Deps } from '../deps.js';
import type { CostBreakdown } from '../pricing/meter.js';
import type { RetreatPass } from '../credits/store.js';
import { recordUsage, type UsageInput } from '../credits/usage.js';
import { activeRetreatCoverage } from '../credits/retreat.js';

export interface UpfrontGate {
    pass: RetreatPass | null;
    /** Spendable balance at gate time; 0 under a pass (never read). */
    balance: number;
    /** False means refuse the call: the cost doesn't fit the balance. */
    fits: boolean;
    /** Take this call back off the account's pending sum. Idempotent. Call it
     *  on every path out of the route (chargeUpfront does it for the paid one),
     *  or the reservation stays against the balance until restart. */
    release: () => void;
}

const NOOP = (): void => undefined;

/** A retreat pass (meditation-pal-414) covers the call: no balance gate and no
 *  debit. Otherwise the cost must fit the balance, or a near-zero balance would
 *  buy an unbounded provider call with the debit clamped after the fact.
 *
 *  "Fits" counts the calls already past this gate and not yet debited
 *  (deps.upfrontPending). The debit only lands after the provider answers, so
 *  without that every call arriving in the meantime fit the same balance: a
 *  burst of sixty maximal syntheses on a balance that covered one all went
 *  out, and the debits past the first few failed. */
export async function gateUpfront(deps: Deps, accountId: string, cost: CostBreakdown): Promise<UpfrontGate> {
    const pass = await activeRetreatCoverage(deps.store, accountId, Date.now() / 1000);
    if (pass) return { pass, balance: 0, fits: true, release: NOOP };
    const balance = await deps.ledger.balance(accountId);
    const release = deps.upfrontPending.tryAdd(accountId, cost.credits, balance);
    return { pass: null, balance, fits: release != null, release: release ?? NOOP };
}

/**
 * Debit a call that passed the gate and record its usage. Returns the
 * response's creditsCharged/creditsRemaining.
 *
 * The debit is clamped to the balance (ledger.debitUpTo): the gate reserved
 * this call's cost against the other upfront legs, but an LLM hold placed
 * since can still have taken the credits, and the provider has already been
 * paid. Under a pass nothing is debited, but usage records the metered credits
 * so per-retreat spend and the daily-cap sum stay honest.
 */
export async function chargeUpfront(
    deps: Deps,
    gate: UpfrontGate,
    cost: CostBreakdown,
    reason: string,
    usage: Omit<UsageInput, 'providerCostUsd' | 'credits' | 'passId'>
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
    const { pass } = gate;
    let debit = 0;
    try {
        if (!pass) debit = await deps.ledger.debitUpTo(usage.accountId, cost.credits, reason);
    } finally {
        gate.release();
    }
    await recordUsage(deps.store, {
        ...usage,
        providerCostUsd: cost.providerCostUsd,
        credits: pass ? cost.credits : debit,
        passId: pass?.id ?? null,
    });
    return {
        creditsCharged: pass ? 0 : cost.credits,
        creditsRemaining: await deps.ledger.balance(usage.accountId),
    };
}
