/**
 * Knobs the operator can change live from the admin panel, no redeploy: e.g.
 * stop handing out free credits while still testing the live service.
 *
 * Source of truth at runtime:
 *   - freeSignupCredits  → deps.config.freeSignupCredits (auth.ts reads it per
 *                          sign-in, so a mutation applies immediately)
 *   - freeGrantBudget/hr → deps.grantBreaker (the live circuit-breaker budget)
 *
 * Overrides persist in the store's settings KV so a redeploy won't snap the knob
 * back to the env default. ALOUD_FREE_SIGNUP_CREDITS and
 * ALOUD_FREE_GRANT_BUDGET_PER_HOUR seed the initial value; a persisted panel
 * override wins on subsequent boots.
 */

import type { Deps } from '../deps.js';
import { USD_PER_CREDIT, PACK_MARKUP } from '../pricing/meter.js';

const KEY_SIGNUP = 'free_signup_credits';
const KEY_BUDGET = 'free_grant_budget_per_hour';
const KEY_PAUSED = 'metered_paused';
const KEY_TESTERS = 'tester_emails';

/** The knobs the panel can change, plus read-only pricing context. */
export interface EffectiveConfig {
    freeSignupCredits: number;
    freeGrantBudgetPerHour: number;
    /** Soft-launch spend pause + the emails exempt from it. */
    meteredPaused: boolean;
    testerEmails: string[];
    /** Read-only, for context in the panel. */
    usdPerCredit: number;
    packMarkup: number;
}

/** A partial update; only the present fields change. */
export interface ConfigPatch {
    freeSignupCredits?: number;
    freeGrantBudgetPerHour?: number;
    meteredPaused?: boolean;
    testerEmails?: string[];
}

/** Snapshot the effective values: config for the grant, breaker for the budget,
 *  each the live source the request path actually reads. */
export function effectiveConfig(deps: Deps): EffectiveConfig {
    return {
        freeSignupCredits: deps.config.freeSignupCredits,
        freeGrantBudgetPerHour: deps.grantBreaker.budget,
        meteredPaused: deps.config.meteredPaused,
        testerEmails: deps.config.testerEmails,
        usdPerCredit: USD_PER_CREDIT,
        packMarkup: PACK_MARKUP,
    };
}

/** The in-character turn returned instead of a real, billed LLM response when a
 *  blocked account makes a conversation call. The client renders it transiently
 *  but does NOT retain it (see BILLING_PAUSED_FINISH), so the saved transcript
 *  resumes from the last real turn. */
export const FREE_LIMIT_MESSAGE =
    "Apologies, but we've reached the limit of free credit usage. Please try back later, or buy credits to continue.";

/** Shown when an account runs out of credits mid-session (balance <= 0).
 *  Distinct from the soft-launch pause: a top-up DOES unblock them, so the
 *  client pairs this with an inline buy affordance. Server-owned because the
 *  free /tts/canned endpoint voices this exact text; the client mirrors the
 *  string for the on-screen bubble. */
export const OUT_OF_CREDITS_MESSAGE =
    "We've used up the clouds for this session. Add more to keep going, or switch to a local or bring-your-own-key provider in settings.";

/** finishReason sentinel on a paused canned turn. The web client keys off it to
 *  keep the apology out of session history/logs and to skip a buy prompt (a
 *  top-up can't lift the pause). Out-of-credits uses the 402 path instead. */
export const BILLING_PAUSED_FINISH = 'billing_paused';

/** The fixed text the free /tts/canned endpoint will synthesize, by reason.
 *  Server-controlled strings only: that's what makes voicing them without a
 *  balance check safe, since a user can't coax arbitrary free TTS. */
export const CANNED_MESSAGES = {
    paused: FREE_LIMIT_MESSAGE,
    insufficient_credits: OUT_OF_CREDITS_MESSAGE,
} as const;

export type CannedReason = keyof typeof CANNED_MESSAGES;

/** True when this account may NOT spend on conversation right now: the
 *  soft-launch pause is on and the account isn't on the tester allowlist. The
 *  LLM route returns FREE_LIMIT_MESSAGE before placing any hold. */
export function isMeteredBlocked(deps: Deps, email: string): boolean {
    if (!deps.config.meteredPaused) return false;
    return !deps.config.testerEmails.includes(email.toLowerCase());
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
        // Keep config's copy in sync so readers/logs agree with the breaker,
        // which stays the source of truth for the live budget.
        deps.config.freeGrantBudgetPerHour = patch.freeGrantBudgetPerHour;
        await deps.store.setSetting(KEY_BUDGET, String(patch.freeGrantBudgetPerHour));
    }
    if (patch.meteredPaused !== undefined) {
        deps.config.meteredPaused = patch.meteredPaused;
        await deps.store.setSetting(KEY_PAUSED, patch.meteredPaused ? '1' : '0');
    }
    if (patch.testerEmails !== undefined) {
        const normalized = patch.testerEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
        deps.config.testerEmails = normalized;
        await deps.store.setSetting(KEY_TESTERS, JSON.stringify(normalized));
    }
    return effectiveConfig(deps);
}

/** Boot-time: fold persisted overrides over the env-seeded defaults. Call once
 *  after buildDeps, before serving. Tolerates absent/garbage values. */
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
    const paused = await deps.store.getSetting(KEY_PAUSED);
    if (paused !== undefined) deps.config.meteredPaused = paused === '1';
    const testers = await deps.store.getSetting(KEY_TESTERS);
    if (testers !== undefined) {
        try {
            const arr = JSON.parse(testers) as unknown;
            if (Array.isArray(arr)) {
                deps.config.testerEmails = arr
                    .filter((e): e is string => typeof e === 'string')
                    .map((e) => e.toLowerCase());
            }
        } catch {
            /* malformed persisted value: keep the env-seeded default */
        }
    }
}
