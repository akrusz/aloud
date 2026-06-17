/**
 * Kasina gazing mode — shared between the exploration and noting session views.
 *
 * The orb leaves the nav, grows to a 140px center gaze object (.orb-kasina),
 * can be dragged anywhere, and a shake or 4 quick clicks toggles the rainbow
 * easter egg. Click outside (or re-toggle) exits. Forces dark theme while
 * gazing.
 *
 * Window/document-level listeners (drag, outside-click) outlive the view's own
 * elements, so — unlike the old multi-page app, which reloaded per navigation —
 * they must be removed on teardown or they leak across sessions. The caller passes
 * an AbortSignal (one per view, aborted in endSession) that covers them all.
 */

import { setRainbow } from './embers.js';

export interface KasinaOptions {
    /** The breathing orb (id="orb"), nav-anchored at rest. */
    orb: HTMLElement;
    /** The session view's root container — used to find `.session-container`. */
    root: ParentNode;
    /** The hidden checkbox that toggles kasina mode (id="kasina-toggle"). */
    toggle: HTMLInputElement;
    /** Aborted on view teardown — detaches all document-level listeners. */
    signal: AbortSignal;
}

export function initKasinaMode(opts: KasinaOptions): void {
    const { orb, root, toggle, signal } = opts;
    const sessionContainer = root.querySelector<HTMLElement>('.session-container');
    const docOpts = { signal };

    let orbClickTimes: number[] = [];
    let orbDragStartX = 0;
    let orbDragStartY = 0;
    let shakeHistory: Array<{ x: number; y: number; time: number }> = [];
    let orbRainbow = false;
    let prevTheme: string | null = null;
    let orbDragging = false;
    let orbMoved = false;
    let rainbowCooldownUntil = 0;

    function toggleRainbow(now: number): void {
        if (rainbowCooldownUntil && now < rainbowCooldownUntil) return;
        orbRainbow = !orbRainbow;
        orb.classList.toggle('orb-rainbow', orbRainbow);
        setRainbow(orbRainbow);
        rainbowCooldownUntil = now + 2000;
    }

    // Click orb in nav to enter kasina; 4 quick clicks while gazing
    // toggles rainbow. Suppress the click that ends a drag.
    orb.addEventListener('click', (e) => {
        if (orbMoved) {
            orbMoved = false;
            return;
        }
        if (!toggle.checked && !orbDragging) {
            e.stopPropagation();
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change'));
            return;
        }
        if (toggle.checked) {
            const nowClick = Date.now();
            orbClickTimes.push(nowClick);
            while (orbClickTimes.length && nowClick - orbClickTimes[0]! > 1500) {
                orbClickTimes.shift();
            }
            if (orbClickTimes.length >= 4) {
                toggleRainbow(nowClick);
                orbClickTimes = [];
            }
        }
    });

    // FLIP animation for the kasina toggle: snapshot the orb's
    // position/appearance before and after the layout change, then
    // animate the delta so the orb glides between nav and center.
    toggle.addEventListener('change', () => {
        const cs = getComputedStyle(orb);
        const startOpacity = cs.opacity;
        const startFilter = cs.filter;
        const startBoxShadow = cs.boxShadow;
        const startBackground = cs.background;

        const first = orb.getBoundingClientRect();
        orb.style.animation = 'none';

        if (toggle.checked) {
            orb.classList.remove('orb-breathing', 'orb-nav');
            orb.classList.add('orb-kasina');
            document.body.appendChild(orb);
            sessionContainer?.classList.add('kasina-active');
            const currentTheme = document.documentElement.getAttribute('data-theme');
            if (currentTheme !== 'dark') {
                prevTheme = currentTheme;
                document.documentElement.setAttribute('data-theme', 'dark');
            }
        } else {
            orb.classList.remove('orb-kasina', 'orb-rainbow');
            const wasRainbow = orbRainbow;
            orbRainbow = false;
            if (wasRainbow) setRainbow(false);
            orb.classList.add('orb-breathing', 'orb-nav');
            orb.style.left = '';
            orb.style.top = '';
            orb.style.inset = '';
            orb.style.margin = '';
            orb.style.cursor = '';
            document.querySelector('.nav-session-info')?.prepend(orb);
            sessionContainer?.classList.remove('kasina-active');
            if (prevTheme) {
                document.documentElement.setAttribute('data-theme', prevTheme);
                prevTheme = null;
            }
        }

        orb.style.animation = '';
        const cs2 = getComputedStyle(orb);
        const endOpacity = cs2.opacity;
        const endFilter = cs2.filter;
        const endBoxShadow = cs2.boxShadow;
        const endBackground = cs2.background;
        const endMatrix = cs2.transform;
        let endScale = 1;
        if (endMatrix && endMatrix !== 'none') {
            const m = endMatrix.match(/matrix\(([^,]+)/);
            if (m) endScale = parseFloat(m[1]!);
        }
        orb.style.animation = 'none';

        const last = orb.getBoundingClientRect();
        const dx = first.left + first.width / 2 - (last.left + last.width / 2);
        const dy = first.top + first.height / 2 - (last.top + last.height / 2);
        const scale = first.width / last.width;

        const anim = orb.animate(
            [
                {
                    transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
                    opacity: startOpacity,
                    filter: startFilter,
                    boxShadow: startBoxShadow,
                    background: startBackground,
                },
                {
                    transform: `translate(0, 0) scale(${endScale})`,
                    opacity: endOpacity,
                    filter: endFilter,
                    boxShadow: endBoxShadow,
                    background: endBackground,
                },
            ],
            { duration: 600, easing: 'ease-in-out', fill: 'forwards' }
        );
        anim.onfinish = () => {
            orb.style.animation = '';
            requestAnimationFrame(() => anim.cancel());
        };
    });

    function startOrbDrag(clientX: number, clientY: number): void {
        if (!toggle.checked) return;
        orbDragging = true;
        orbMoved = false;
        const rect = orb.getBoundingClientRect();
        orb.style.inset = 'auto';
        orb.style.margin = '0';
        orb.style.left = `${rect.left}px`;
        orb.style.top = `${rect.top}px`;
        orb.style.cursor = 'grabbing';
        orbDragStartX = clientX - rect.left;
        orbDragStartY = clientY - rect.top;
    }

    function moveOrbDrag(clientX: number, clientY: number): void {
        if (!orbDragging) return;
        orbMoved = true;
        orb.style.left = `${clientX - orbDragStartX}px`;
        orb.style.top = `${clientY - orbDragStartY}px`;

        const now = Date.now();
        shakeHistory.push({ x: clientX, y: clientY, time: now });
        while (shakeHistory.length && now - shakeHistory[0]!.time > 1500) {
            shakeHistory.shift();
        }
        // Detect a shake: count direction reversals with enough travel.
        if (shakeHistory.length >= 3) {
            let reversals = 0;
            for (let i = 2; i < shakeHistory.length; i++) {
                const a = shakeHistory[i - 2]!;
                const b = shakeHistory[i - 1]!;
                const c = shakeHistory[i]!;
                const dx1 = b.x - a.x;
                const dy1 = b.y - a.y;
                const dx2 = c.x - b.x;
                const dy2 = c.y - b.y;
                const dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                if (dist > 6 && dx1 * dx2 + dy1 * dy2 < 0) reversals++;
            }
            if (reversals >= 2) {
                toggleRainbow(Date.now());
                shakeHistory = [];
            }
        }
    }

    function endOrbDrag(): void {
        if (!orbDragging) return;
        orbDragging = false;
        orb.style.cursor = '';
    }

    orb.addEventListener('mousedown', (e) => {
        if (!toggle.checked) return;
        e.preventDefault();
        startOrbDrag(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => moveOrbDrag(e.clientX, e.clientY), docOpts);
    document.addEventListener('mouseup', endOrbDrag, docOpts);

    orb.addEventListener(
        'touchstart',
        (e) => {
            if (!toggle.checked) return;
            e.preventDefault();
            const t = e.touches[0];
            if (t) startOrbDrag(t.clientX, t.clientY);
        },
        { passive: false }
    );
    document.addEventListener(
        'touchmove',
        (e) => {
            if (orbDragging && e.touches[0])
                moveOrbDrag(e.touches[0].clientX, e.touches[0].clientY);
        },
        docOpts
    );
    document.addEventListener('touchend', endOrbDrag, docOpts);

    // Click outside the orb (beyond its glow radius) exits kasina.
    document.addEventListener(
        'click',
        (e) => {
            if (!toggle.checked || orbDragging) return;
            if (orbMoved) {
                orbMoved = false;
                return;
            }
            const target = e.target as HTMLElement;
            if (target.closest('.input-area, .input-controls, .nav')) return;
            const rect = orb.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const ddx = e.clientX - cx;
            const ddy = e.clientY - cy;
            if (Math.sqrt(ddx * ddx + ddy * ddy) < 100) return;
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));
        },
        docOpts
    );
}
