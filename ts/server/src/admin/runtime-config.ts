/**
 * Operator-tunable runtime config (dev ask). A small set of knobs the operator
 * can change live from the admin panel — without a redeploy — so they can, e.g.,
 * stop handing out free credits while still testing the live service.
 *
 * Source of truth at runtime:
 *   - freeSignupCredits  → deps.config.freeSignupCredits (auth.ts reads it per
 *                          sign-in, so a mutation takes effect immediately)
 *   - freeGrantBudget/hr → deps.grantBreaker (the live circuit-breaker budget)
 *
 * Overrides are persisted in the store's settings KV so they survive a restart
 * (a redeploy won't snap the knob back to the env default). The env vars
 * (ALOUD_FREE_SIGNUP_CREDITS, ALOUD_FREE_GRANT_BUDGET_PER_HOUR) still seed the
 * initial value; a persisted panel override then wins on subsequent boots.
 */

import type { Deps } from '../deps.js';
import { USD_PER_CREDIT, PACK_MARKUP } from '../pricing/meter.js';

const KEY_SIGNUP = 'free_signup_credits';
const KEY_BUDGET = 'free_grant_budget_per_hour';

/** The knobs the panel can change, plus read-only pricing context. */
export interface EffectiveConfig {
    freeSignupCredits: number;
    freeGrantBudgetPerHour: number;
    /** Read-only, for context in the panel. */
    usdPerCredit: number;
    packMarkup: number;
}

/** A partial update; only the present fields change. */
export interface ConfigPatch {
    freeSignupCredits?: number;
    freeGrantBudgetPerHour?: number;
}

/** Snapshot the current effective values (config for the grant, breaker for the
 *  budget — each the live source the request path actually reads). */
export function effectiveConfig(deps: Deps): EffectiveConfig {
    return {
        freeSignupCredits: deps.config.freeSignupCredits,
        freeGrantBudgetPerHour: deps.grantBreaker.budget,
        usdPerCredit: USD_PER_CREDIT,
        packMarkup: PACK_MARKUP,
    };
}

/** Apply a validated patch to the live config + breaker and persist it.
 *  Returns the new effective config. Callers validate inputs first. */
export async function applyRuntimeConfig(deps: Deps, patch: ConfigPatch): Promise<EffectiveConfig> {
    if (patch.freeSignupCredits !== undefined) {
        deps.config.freeSignupCredits = patch.freeSignupCredits;
        await deps.store.setSetting(KEY_SIGNUP, String(patch.freeSignupCredits));
    }
    if (patch.freeGrantBudgetPerHour !== undefined) {
        deps.grantBreaker.setBudget(patch.freeGrantBudgetPerHour);
        // Keep config's copy in sync so any future reader/log agrees with the
        // breaker (the breaker stays the source of truth for the live budget).
        deps.config.freeGrantBudgetPerHour = patch.freeGrantBudgetPerHour;
        await deps.store.setSetting(KEY_BUDGET, String(patch.freeGrantBudgetPerHour));
    }
    return effectiveConfig(deps);
}

/** Boot-time: fold any persisted overrides over the env-seeded defaults. Call
 *  once after buildDeps, before serving. Tolerates absent/garbage values. */
export async function loadRuntimeOverrides(deps: Deps): Promise<void> {
    const signup = await deps.store.getSetting(KEY_SIGNUP);
    if (signup !== undefined) {
        const n = Number(signup);
        if (Number.isFinite(n) && n >= 0) deps.config.freeSignupCredits = n;
    }
    const budget = await deps.store.getSetting(KEY_BUDGET);
    if (budget !== undefined) {
        const n = Number(budget);
        if (Number.isFinite(n) && n >= 0) {
            deps.grantBreaker.setBudget(n);
            deps.config.freeGrantBudgetPerHour = n;
        }
    }
}
