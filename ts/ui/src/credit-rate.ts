/**
 * The cloud credit unit, shown site-wide. ☁️ IS the credit — a balance of 13.7
 * credits renders "13.7☁️", a 50-credit pack "50☁️". In the credit-spending
 * pickers (LLM model, hosted voice, cloud STT) the number is a per-HOUR rate, so
 * "8☁️" there means ~8 credits/hour and the picker carries an "≈ ☁️ per hour"
 * legend; a user can eyeball burn rate and add model + voice in their head.
 *
 * The rates are ESTIMATES, calibrated around exploration mode talking as
 * concisely as possible — a near-floor. Real use drifts up with how much gets
 * said, and noting mode (short labels, not sentences) uses fewer ☁️ for voices.
 * The "≈" and RATE_LEGEND_TITLE carry that caveat without cluttering the badge.
 *
 * Only the aloud cloud costs credits, so rate badges appear ONLY on hosted
 * options; BYOK / local / Ollama options carry none (free to use).
 *
 * Everything funnels through here so the symbol and the scale are one-line
 * changes. If real rates ever cluster (all 1s, or all huge), bump
 * CREDITS_PER_EMOJI and every rate label across the app rescales together.
 */

export const RATE_EMOJI = '☁️';

/** Credits represented by one emoji in a RATE context. The renormalization
 *  knob: at 1, an ~8-credit/hr option shows "8☁️"; set 0.5 to double the
 *  resolution, 5 to compress it. (Currency amounts are shown 1:1, untouched.) */
export const CREDITS_PER_EMOJI = 1;

/** Legend for a picker whose badges are per-hour rates. Kept terse so it fits
 *  on the picker's header row; the leading "≈" flags that the figures are
 *  estimates, not exact charges. */
export const RATE_LEGEND = `≈ ${RATE_EMOJI} per hour`;

/** Fuller caveat for the legend's title/tooltip: the rates are estimates,
 *  calibrated for the most concise (exploration-mode) talk, and real use drifts
 *  up with how much is said. Noting mode uses fewer ☁️ for voices. */
export const RATE_LEGEND_TITLE =
    'Rough estimate, calibrated for concise exploration-mode talking. Actual ☁️ use rises the more is said; noting mode uses fewer for voices.';

/** A credit balance/amount as currency, e.g. "13.7☁️" — ☁️ is the unit. */
export function creditAmount(credits: number, digits = 1): string {
    return `${credits.toFixed(digits)}${RATE_EMOJI}`;
}

/** Whole emoji-units for a credits/hr rate. Rounds DOWN (the estimates run high,
 *  so flooring keeps the badge from overstating), but never below 1 for a
 *  genuinely paid option — so a cheap-but-not-free choice can't read as free. A
 *  zero/negative rate (local/BYOK) returns 0. */
export function rateUnits(creditsPerHour: number | null | undefined): number {
    if (!creditsPerHour || creditsPerHour <= 0) return 0;
    return Math.max(1, Math.floor(creditsPerHour / CREDITS_PER_EMOJI));
}

/** Per-mode estimate multiplier. Noting mode speaks short labels, not full
 *  sentences, so it burns far fewer ☁️ than the exploration-calibrated base
 *  rates suggest; scale a combined session estimate by the active mode before
 *  rounding. (Applied to the composed session total, not the per-component
 *  picker badges, which stay exploration-calibrated with their own caveat.) */
export const MODE_RATE_MULTIPLIER: Record<'exploration' | 'noting' | 'felt_sense', number> = {
    exploration: 1,
    noting: 0.4,
    // Full conversational turns like exploration (the extra silence in the
    // practice only makes the exploration-calibrated estimate conservative).
    felt_sense: 1,
};

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

/** Wrap each ☁️ in `text` with <span class="cloud-glyph"> so the glyph picks up
 *  the brown outline (legible on light surfaces). Returns HTML, so the caller
 *  assigns it via innerHTML and must ensure the rest of `text` is safe to inject
 *  — our rate/balance strings are just numbers + fixed words. Native <select>
 *  options can't use this (browsers don't style option text). */
export function withCloudOutline(text: string): string {
    return text.split(RATE_EMOJI).join(`<span class="cloud-glyph">${RATE_EMOJI}</span>`);
}
