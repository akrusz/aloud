/**
 * Three pink ripples off the nav orb: the hello the website's orb gives on load
 * (docs/css/style.css, orbRipple), here the visual half of the signature sound.
 * The rings are the orb's pseudo-elements (.orb-ripple in app-base.css).
 *
 * Asked for before the orb that should wear them exists: the opening starts
 * while the setup view's orb is still in the nav, and a close starts as the
 * session's orb is about to leave with it. So a pulse is owed to the NEXT orb
 * painted into the nav, and each place that paints one reports it.
 */

/** Two rings, three emissions (::before twice, ::after once between them). */
const RIPPLE_MS = 3600;
/** How long a pulse stays owed. A session that takes longer than this to save
 *  lands on its next screen after the close has mostly rung out. */
const OWED_MS = 6000;

let owedUntil = 0;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export function pulseNextNavOrb(): void {
    owedUntil = Date.now() + OWED_MS;
}

/** Call after painting an orb into the nav. */
export function navOrbPainted(): void {
    if (Date.now() >= owedUntil) return;
    owedUntil = 0;
    const orb = document.querySelector<HTMLElement>('#navCenter .orb');
    if (!orb) return;
    clearTimeout(clearTimer);
    orb.classList.add('orb-ripple');
    clearTimer = setTimeout(() => orb.classList.remove('orb-ripple'), RIPPLE_MS + 100);
}
