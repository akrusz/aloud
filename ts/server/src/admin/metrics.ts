/**
 * Spend monitoring: aggregate the ledger so the operator can watch cost in
 * near-real-time and tweak the free grant or pricing if abuse spikes. Pure
 * function over store reads, no I/O. Trial-scale: scans all entries, where a
 * SQL store would use indexed aggregates.
 *
 * The key number for "am I bleeding on free users" is free-grant burn isolated
 * to NON-CONVERTING accounts. Credits are fungible, so a single debit can't be
 * attributed to a specific grant, but an account that never purchased has spent
 * only free credits, so its debits ARE free burn. Exact, not an estimate.
 */

import type { Account, LedgerEntry } from '../credits/store.js';
import { USD_PER_CREDIT, PACK_MARKUP } from '../pricing/meter.js';
import { centsForCredits } from '../billing/stripe.js';

export interface MetricsReport {
    generatedAt: number;
    windowSinceTs: number;
    usdPerCredit: number;
    packMarkup: number;

    totals: {
        accounts: number;
        creditsGranted: number;
        creditsPurchased: number;
        creditsDebited: number;
        creditsOutstanding: number;
        /** Our free-grant spend exposure if every granted credit is spent. */
        grantedCostUsd: number;
        /** What we've actually paid providers (credits debit at cost). */
        providerCostUsd: number;
        /** Provider cost spent by accounts that have NEVER purchased: money
         *  spent on free users who didn't convert. */
        freeBurnUsd: number;
        /** Rough gross revenue from purchases (Stripe is source of truth). */
        estGrossRevenueUsd: number;
    };

    window: {
        signups: number;
        creditsGranted: number;
        creditsPurchased: number;
        creditsDebited: number;
        providerCostUsd: number;
    };

    /** Velocity signals for mass-account detection. */
    abuse: {
        distinctSignupIps: number;
        /** Signup IPs with the most accounts, in the window. Top 10. */
        topSignupIps: Array<{ ip: string; signups: number }>;
        /** IPs with >= this many signups in the window (likely farming). */
        clusteredIpThreshold: number;
        ipsOverThreshold: number;
    };
}

const CLUSTER_THRESHOLD = 3;

function debitMagnitude(e: LedgerEntry): number {
    return e.kind === 'debit' ? -e.amount : 0; // debits are negative
}

export function buildMetrics(
    accounts: Account[],
    entries: LedgerEntry[],
    now: number,
    windowSinceTs: number
): MetricsReport {
    let creditsGranted = 0;
    let creditsPurchased = 0;
    let creditsDebited = 0;
    let creditsOutstanding = 0;
    // Gross revenue summed per purchase: each priced its credits on the volume
    // curve, so centsForCredits(amount) recovers the dollars paid, where a flat
    // markup would over-state. Not net of refunds (a separate ledger kind).
    let grossRevenueCents = 0;

    const purchasedAccounts = new Set<string>();
    const debitsByAccount = new Map<string, number>();

    for (const e of entries) {
        creditsOutstanding += e.amount;
        if (e.kind === 'signup_grant') creditsGranted += e.amount;
        else if (e.kind === 'purchase') {
            creditsPurchased += e.amount;
            grossRevenueCents += centsForCredits(e.amount);
            purchasedAccounts.add(e.accountId);
        } else if (e.kind === 'debit') {
            const mag = -e.amount;
            creditsDebited += mag;
            debitsByAccount.set(e.accountId, (debitsByAccount.get(e.accountId) ?? 0) + mag);
        }
    }

    // Free burn: debits by accounts that never purchased.
    let freeBurnCredits = 0;
    for (const [accountId, debited] of debitsByAccount) {
        if (!purchasedAccounts.has(accountId)) freeBurnCredits += debited;
    }

    // Windowed slice.
    const win = { signups: 0, creditsGranted: 0, creditsPurchased: 0, creditsDebited: 0 };
    for (const e of entries) {
        if (e.createdAt < windowSinceTs) continue;
        if (e.kind === 'signup_grant') win.creditsGranted += e.amount;
        else if (e.kind === 'purchase') win.creditsPurchased += e.amount;
        else if (e.kind === 'debit') win.creditsDebited += debitMagnitude(e);
    }

    // Signup velocity by IP (windowed).
    const ipCounts = new Map<string, number>();
    for (const a of accounts) {
        if (a.createdAt >= windowSinceTs) win.signups += 1;
        if (a.signupIp && a.createdAt >= windowSinceTs) {
            ipCounts.set(a.signupIp, (ipCounts.get(a.signupIp) ?? 0) + 1);
        }
    }
    const topSignupIps = [...ipCounts.entries()]
        .map(([ip, signups]) => ({ ip, signups }))
        .sort((a, b) => b.signups - a.signups)
        .slice(0, 10);
    const ipsOverThreshold = [...ipCounts.values()].filter((n) => n >= CLUSTER_THRESHOLD).length;

    return {
        generatedAt: now,
        windowSinceTs,
        usdPerCredit: USD_PER_CREDIT,
        packMarkup: PACK_MARKUP,
        totals: {
            accounts: accounts.length,
            creditsGranted,
            creditsPurchased,
            creditsDebited,
            creditsOutstanding,
            grantedCostUsd: round2(creditsGranted * USD_PER_CREDIT),
            providerCostUsd: round2(creditsDebited * USD_PER_CREDIT),
            freeBurnUsd: round2(freeBurnCredits * USD_PER_CREDIT),
            estGrossRevenueUsd: round2(grossRevenueCents / 100),
        },
        window: {
            signups: win.signups,
            creditsGranted: win.creditsGranted,
            creditsPurchased: win.creditsPurchased,
            creditsDebited: win.creditsDebited,
            providerCostUsd: round2(win.creditsDebited * USD_PER_CREDIT),
        },
        abuse: {
            distinctSignupIps: ipCounts.size,
            topSignupIps,
            clusteredIpThreshold: CLUSTER_THRESHOLD,
            ipsOverThreshold,
        },
    };
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
