/**
 * The cloud credit unit, shown site-wide. ☁️ IS the credit: a 13.7-credit
 * balance renders "13.7☁️", a 50-credit pack "50☁️". In the credit-spending
 * pickers (LLM model, hosted voice, cloud STT) the number is a per-HOUR rate,
 * so a user can eyeball burn rate and add model + voice in their head. The
 * voice list carries the "≈ ☁️ per hour" legend; on the setup page the badges
 * are explained by the footer's "what are ☁️?" help button (#clouds-help).
 *
 * Rates are ESTIMATES calibrated on exploration mode talking as concisely as
 * possible, a near-floor: real use drifts up with how much gets said, and noting
 * mode uses fewer ☁️ for voices. The "≈" and RATE_LEGEND_TITLE carry that caveat.
 *
 * Badges appear ONLY on hosted options; BYOK / local / Ollama are free.
 *
 * Everything funnels through here so the symbol and scale are one-line changes:
 * bump CREDITS_PER_EMOJI and every rate label rescales together.
 */

export const RATE_EMOJI = '☁️';

/** Credits per emoji in a RATE context. The renormalization knob: at 1, an
 *  ~8-credit/hr option shows "8☁️"; 0.5 doubles the resolution, 5 compresses it.
 *  Currency amounts are shown 1:1, untouched. */
export const CREDITS_PER_EMOJI = 1;

/** Legend for a picker whose badges are per-hour rates. Terse so it fits the
 *  header row; the leading "≈" flags estimates, not exact charges. */
export const RATE_LEGEND = `≈ ${RATE_EMOJI} per hour`;

/** Fuller caveat for the legend's title/tooltip. */
export const RATE_LEGEND_TITLE =
    'Rough estimate, calibrated for concise exploration-mode talking. Actual ☁️ use rises the more is said; noting mode uses fewer for voices.';

/** A credit balance/amount as currency, e.g. "13.7☁️". */
export function creditAmount(credits: number, digits = 1): string {
    return `${credits.toFixed(digits)}${RATE_EMOJI}`;
}

/** Whole emoji-units for a credits/hr rate, rounded to NEAREST. This is the only
 *  place a rate rounds: the server sends unrounded per-hour figures precisely so
 *  a model + voice + STT sum can be composed first and rounded once, and the
 *  badges add up to the session pill. A positive rate under 0.5 returns 0 here -
 *  callers must not read that as free; rateBadge renders it "<1☁️". Zero or
 *  negative (local/BYOK) also returns 0, which IS free. */
export function rateUnits(creditsPerHour: number | null | undefined): number {
    if (!creditsPerHour || creditsPerHour <= 0) return 0;
    return Math.round(creditsPerHour / CREDITS_PER_EMOJI);
}

/** Per-mode estimate multiplier. Noting mode speaks short labels, not full
 *  sentences, so it burns far fewer ☁️ than the exploration-calibrated base
 *  rates suggest; scale a session estimate by the active mode before rounding.
 *  Applied to the composed session total, not the per-component picker badges,
 *  which stay exploration-calibrated with their own caveat. */
export const MODE_RATE_MULTIPLIER: Record<'exploration' | 'noting' | 'felt_sense', number> = {
    exploration: 1,
    noting: 0.4,
    // Full conversational turns like exploration; the practice's extra silence
    // only makes the exploration-calibrated estimate conservative.
    felt_sense: 1,
};

/** Badge text for a rate, e.g. "3☁️". A paid option too cheap to round to a
 *  whole credit reads "<1☁️" rather than "1☁️" (overstating by up to 12x at the
 *  Flash Lite end) or "" (which means free). Empty string only when free. */
export function rateBadge(creditsPerHour: number | null | undefined): string {
    if (!creditsPerHour || creditsPerHour <= 0) return '';
    const n = rateUnits(creditsPerHour);
    return n > 0 ? `${n}${RATE_EMOJI}` : `<1${RATE_EMOJI}`;
}

/** Suffix for a dropdown <option> label, e.g. " (3☁️)". Empty when free. */
export function rateSuffix(creditsPerHour: number | null | undefined): string {
    const badge = rateBadge(creditsPerHour);
    return badge ? ` (${badge})` : '';
}

/** Wrap each ☁️ in `text` with <span class="cloud-glyph"> so the glyph picks up
 *  the brown outline (legible on light surfaces). Returns HTML, so the caller
 *  assigns via innerHTML and must ensure the rest of `text` is safe to inject;
 *  our rate/balance strings are just numbers + fixed words. Unusable for native
 *  <select> options, which browsers won't style. */
export function withCloudOutline(text: string): string {
    return text.split(RATE_EMOJI).join(`<span class="cloud-glyph">${RATE_EMOJI}</span>`);
}
