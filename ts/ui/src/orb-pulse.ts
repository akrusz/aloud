/**
 * Three pink ripples off the nav orb: the hello the website's orb gives on load
 * (docs/css/style.css, orbRipple), here the visual half of the signature sound.
 * The rings are the orb's pseudo-elements (.orb-ripple in app-base.css).
 *
 * The orb that should wear them isn't always there yet: an opening can start
 * while the setup view's orb is still in the nav, and a close starts as the
 * session's orb is about to leave with it. So a pulse names its orb, and one
 * that finds another in the nav is owed to the next orb painted there, which
 * each place that paints one reports.
 */

/** The session views' breathing orb, or the idle one everywhere else. */
export type NavOrb = 'session' | 'home';
const ORB_ID: Record<NavOrb, string> = { session: 'orb', home: 'home-orb' };

/** Two rings, three emissions (::before twice, ::after once between them). */
const RIPPLE_MS = 3600;
/** How long a pulse stays owed. A session that takes longer than this to save
 *  lands on its next screen after the close has mostly rung out. */
const OWED_MS = 6000;

let owed: { orb: NavOrb; until: number } | null = null;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function navOrb(which: NavOrb): HTMLElement | null {
    return document.querySelector<HTMLElement>(`#navCenter #${ORB_ID[which]}`);
}

function ripple(orb: HTMLElement): void {
    clearTimeout(clearTimer);
    orb.classList.add('orb-ripple');
    clearTimer = setTimeout(() => orb.classList.remove('orb-ripple'), RIPPLE_MS + 100);
}

export function pulseNavOrb(which: NavOrb): void {
    const orb = navOrb(which);
    if (orb) ripple(orb);
    else owed = { orb: which, until: Date.now() + OWED_MS };
}

/** Call after painting an orb into the nav. */
export function navOrbPainted(): void {
    if (!owed) return;
    const { orb: which, until } = owed;
    const orb = navOrb(which);
    if (!orb) return;
    owed = null;
    if (Date.now() < until) ripple(orb);
}
