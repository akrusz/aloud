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
}

/** A retreat pass (meditation-pal-414) covers the call: no balance gate and no
 *  debit. Otherwise the cost must fit the balance, or a near-zero balance would
 *  buy an unbounded provider call with the debit clamped after the fact. */
export async function gateUpfront(deps: Deps, accountId: string, cost: CostBreakdown): Promise<UpfrontGate> {
    const pass = await activeRetreatCoverage(deps.store, accountId, Date.now() / 1000);
    const balance = pass ? 0 : await deps.ledger.balance(accountId);
    return { pass, balance, fits: pass != null || balance >= cost.credits };
}

/**
 * Debit a call that passed the gate and record its usage. Returns the
 * response's creditsCharged/creditsRemaining.
 *
 * The debit is clamped to the gate-time balance so a concurrent-spend race
 * can't overdraw (the gate already refused what the balance can't cover).
 * Under a pass nothing is debited, but usage records the metered credits so
 * per-retreat spend and the daily-cap sum stay honest.
 */
export async function chargeUpfront(
    deps: Deps,
    gate: UpfrontGate,
    cost: CostBreakdown,
    reason: string,
    usage: Omit<UsageInput, 'providerCostUsd' | 'credits' | 'passId'>
): Promise<{ creditsCharged: number; creditsRemaining: number }> {
    const { pass } = gate;
    const debit = pass ? 0 : Math.min(cost.credits, gate.balance);
    if (debit > 0) await deps.ledger.debit(usage.accountId, debit, reason);
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
