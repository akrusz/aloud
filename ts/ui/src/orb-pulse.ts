/**
 * Three pink ripples off the nav orb: the hello the website's orb gives on load
 * (docs/css/style.css, orbRipple), here the visual half of the signature sound.
 * The rings are the orb's pseudo-elements (.orb-ripple in app-base.css).
 *
 * A pulse is bound to a specific orb, and that orb isn't always in the nav yet:
 * an opening can start while the setup view's orb is still there, and a close
 * starts as the session's orb is about to leave with it. When the named orb is
 * missing the pulse is deferred until that orb is next painted into the nav
 * (each place that paints one calls navOrbPainted).
 */

/** The session views' breathing orb, or the idle one everywhere else. */
export type NavOrb = 'session' | 'home';
const ORB_ID: Record<NavOrb, string> = { session: 'orb', home: 'home-orb' };

/** Two rings, three emissions (::before twice, ::after once between them). */
const RIPPLE_MS = 3600;
/** How long a pulse stays owed. A session that takes longer than this to save
 *  reaches its next screen after the close has mostly rung out. */
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
