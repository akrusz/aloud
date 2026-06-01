/**
 * The credit-rate unit shown across every credit-spending dropdown — the LLM
 * model picker, the hosted voice picker, and anything else billed by the aloud
 * cloud. One ☁️ stands for ~1 credit per hour of use, so a user can eyeball how
 * fast an option drains their balance and add two options up in their head
 * (model rate + voice rate ≈ session rate).
 *
 * Only the aloud cloud costs credits, so the badge appears ONLY on hosted
 * options; BYOK / local / Ollama options carry no badge (they're free to use —
 * the user pays the provider directly, or nothing).
 *
 * Everything funnels through here so the symbol and the scale are one-line
 * changes. If real rates ever cluster (all 1s, or all huge), bump
 * CREDITS_PER_EMOJI and every label across the app rescales together.
 */

export const RATE_EMOJI = '☁️';

/** Credits represented by one emoji. The renormalization knob: at 1, a 3-credit
 *  /hr option shows "3☁️"; set 0.5 to double the resolution, 5 to compress it. */
export const CREDITS_PER_EMOJI = 1;

/** The legend shown next to any picker that uses the badge. */
export const RATE_LEGEND = `1${RATE_EMOJI} ≈ 1 credit / hour`;

/** Whole emoji-units for a credits/hr rate. Rounds to the nearest unit, but
 *  never below 1 for a genuinely paid option — so a cheap-but-not-free choice
 *  can't read as free. A zero/negative rate (local/BYOK) returns 0. */
export function rateUnits(creditsPerHour: number | null | undefined): number {
    if (!creditsPerHour || creditsPerHour <= 0) return 0;
    return Math.max(1, Math.round(creditsPerHour / CREDITS_PER_EMOJI));
}

/** Badge text for a rate, e.g. "3☁️". Empty string when free (0). */
export function rateBadge(creditsPerHour: number | null | undefined): string {
    const n = rateUnits(creditsPerHour);
    return n > 0 ? `${n}${RATE_EMOJI}` : '';
}

/** Parenthesised suffix to append to a dropdown <option> label, e.g. " (3☁️)".
 *  Empty for free options, so their labels stay clean. */
export function rateSuffix(creditsPerHour: number | null | undefined): string {
    const badge = rateBadge(creditsPerHour);
    return badge ? ` (${badge})` : '';
}
