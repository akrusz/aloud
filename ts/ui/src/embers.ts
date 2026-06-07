/**
 * Ember particles — ambient background animation.
 *
 * Lifted 1:1 from src/web/static/js/ui.js + session.js initEmbers().
 * Same level counts, color palettes, shrink rate, easter egg (5 clicks
 * at level 4 unlocks level 5 with a 100-particle burst).
 *
 * Embers render into a single fixed container at body level so the
 * particles persist across view changes. Controls live in views that
 * want to expose them — currently only the session view.
 */

const EMBER_COUNTS: readonly number[] = [0, 3, 6, 12, 24, 48];
const EMBER_COLORS_DARK: readonly string[] = ['#e8a840', '#d4873a', '#c07830', '#e0a038', '#cc8030'];
const EMBER_COLORS_LIGHT: readonly string[] = ['#fed025', '#f6b818', '#fcc430', '#f0a80e', '#f8c020'];
const EMBER_COLORS_RAINBOW: readonly string[] = [
    '#f7a8c4', '#f4b8a0', '#f5e6a0', '#a8e6cf', '#a0e0f0', '#c4b4f0', '#e8a0d8',
];
const EMBER_SHRINK_RATE = 0.3; // px/s

const STORAGE_KEY = 'aloud-embers';

interface EmberState {
    level: number;
    /** Whether the level-5 easter egg has been unlocked this session. */
    eggUnlocked: boolean;
    /** Whether the orb is in rainbow mode (changes the palette). */
    rainbow: boolean;
}

const state: EmberState = {
    level: 1,
    eggUnlocked: false,
    rainbow: false,
};

let containerEl: HTMLElement | null = null;
let levelLoaded = false;

function hexGlow(hex: string): string {
    return (
        'rgba(' +
        parseInt(hex.slice(1, 3), 16) +
        ',' +
        parseInt(hex.slice(3, 5), 16) +
        ',' +
        parseInt(hex.slice(5, 7), 16) +
        ',0.4)'
    );
}

/**
 * Resolve (or create) the ember container. Embers are session-only in
 * the original app — the `<div class="ember-container">` lives inside
 * session.html, not base.html. We mirror that: the container is
 * created lazily inside the body the FIRST time a session view calls
 * mountEmberContainer(). Once removed (when the session view tears
 * down), regenerateEmbers / burstEmbers become no-ops.
 */
function existingContainer(): HTMLElement | null {
    if (containerEl && document.body.contains(containerEl)) return containerEl;
    containerEl = document.querySelector<HTMLElement>('.ember-container');
    return containerEl;
}

/** Called by the session view on mount. */
export function mountEmberContainer(): void {
    // The session/noting views render their own `.ember-container` in the
    // template; reuse it when present, otherwise create one at body level.
    if (!existingContainer()) {
        const el = document.createElement('div');
        el.className = 'ember-container';
        document.body.appendChild(el);
        containerEl = el;
    }
    if (!levelLoaded) {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved !== null) {
            const parsed = parseInt(saved, 10);
            if (!Number.isNaN(parsed)) state.level = Math.min(parsed, 4);
        }
        levelLoaded = true;
    }
    // Always generate for the current level. Previously this bailed whenever a
    // container already existed — but the views always render one in their
    // template, so the early return meant embers never started on a fresh
    // session until the user nudged the level (which calls setEmberLevel
    // directly). (meditation-pal-q7bg)
    setEmberLevel(state.level);
}

/** Called when the session view unmounts — clears particles + container. */
export function unmountEmberContainer(): void {
    const el = existingContainer();
    if (el) el.remove();
    containerEl = null;
}

function gracefullyEndEmbers(): void {
    const container = existingContainer();
    if (!container) return;
    const existing = container.querySelectorAll<HTMLElement>('.ember');
    existing.forEach((el) => {
        if (el.dataset['finishing']) return;
        el.dataset['finishing'] = '1';
        const anims = el.getAnimations();
        if (anims.length === 0) {
            el.remove();
            return;
        }
        const a = anims[0]!;
        try {
            const timing = a.effect!.getTiming();
            const dur = Number(timing.duration);
            const delay = timing.delay ?? 0;
            const currentTime = Number(a.currentTime ?? 0);
            const elapsed = currentTime - delay;
            const iters = elapsed < 0 ? 1 : Math.floor(elapsed / dur) + 1;
            a.effect!.updateTiming({ iterations: iters });
            a.onfinish = () => {
                el.remove();
                if (state.level === 0 && !container.querySelector('.ember')) {
                    container.classList.remove('active');
                }
            };
        } catch {
            el.remove();
        }
    });
}

export function regenerateEmbers(): void {
    const container = existingContainer();
    if (!container) return; // No session view mounted — nothing to do.
    gracefullyEndEmbers();
    if (state.level === 0) {
        if (!container.querySelector('.ember')) container.classList.remove('active');
        return;
    }
    container.classList.add('active');
    const count = EMBER_COUNTS[state.level] ?? 0;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const palette = state.rainbow
        ? EMBER_COLORS_RAINBOW
        : isLight
          ? EMBER_COLORS_LIGHT
          : EMBER_COLORS_DARK;
    const sizeRange = [0, 2, 3.5, 5, 6.5, 8][state.level] ?? 0;

    for (let i = 0; i < count; i++) {
        const span = document.createElement('span');
        span.className = 'ember';
        const size = 2 + Math.random() * sizeRange;
        const color = palette[Math.floor(Math.random() * palette.length)]!;
        const glow = Math.round(3 + size);
        span.style.left = `${5 + Math.random() * 90}%`;
        span.style.width = `${size}px`;
        span.style.height = `${size}px`;
        span.style.background = color;
        span.style.boxShadow = `0 0 ${glow}px ${Math.round(size * 0.4)}px ${hexGlow(color)}`;

        const dur = 10 + Math.random() * 20; // 10-30s for speed variety
        const drift = Math.round(-30 + Math.random() * 60);
        const endScale = Math.max(0, 1 - (EMBER_SHRINK_RATE * dur) / size).toFixed(3);

        span.animate(
            [
                { transform: 'translateY(0) translateX(0) scale(1)', opacity: 0, offset: 0 },
                {
                    transform: `translateY(-5vh) translateX(${Math.round(drift * 0.06)}px) scale(0.97)`,
                    opacity: 0.7,
                    offset: 0.06,
                },
                {
                    transform: `translateY(-95vh) translateX(${drift}px) scale(${endScale})`,
                    opacity: 0,
                    offset: 1.0,
                },
            ],
            {
                duration: dur * 1000,
                delay: Math.random() * dur * 1000,
                iterations: Infinity,
                easing: 'linear',
            }
        );

        container.appendChild(span);
    }
}

export function burstEmbers(count: number): void {
    const container = existingContainer();
    if (!container) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const palette = state.rainbow
        ? EMBER_COLORS_RAINBOW
        : isLight
          ? EMBER_COLORS_LIGHT
          : EMBER_COLORS_DARK;
    container.classList.add('active');

    for (let i = 0; i < count; i++) {
        const span = document.createElement('span');
        span.className = 'ember';
        const size = 2 + Math.random() * 8;
        const color = palette[Math.floor(Math.random() * palette.length)]!;
        const glow = Math.round(3 + size);
        span.style.left = `${5 + Math.random() * 90}%`;
        span.style.bottom = '-10px';
        span.style.width = `${size}px`;
        span.style.height = `${size}px`;
        span.style.background = color;
        span.style.boxShadow = `0 0 ${glow}px ${Math.round(size * 0.4)}px ${hexGlow(color)}`;

        const dur = 2 + Math.random() * 3;
        const driftX = -60 + Math.random() * 120;
        const driftY = -(window.innerHeight * 0.4) - Math.random() * (window.innerHeight * 0.6);

        const anim = span.animate(
            [
                { transform: 'translate(0,0) scale(1)', opacity: 0.9, offset: 0 },
                {
                    transform: `translate(${driftX * 0.3}px,${driftY * 0.3}px) scale(0.8)`,
                    opacity: 0.7,
                    offset: 0.3,
                },
                {
                    transform: `translate(${driftX}px,${driftY}px) scale(0)`,
                    opacity: 0,
                    offset: 1.0,
                },
            ],
            {
                duration: dur * 1000,
                delay: Math.random() * 400,
                easing: 'ease-out',
                fill: 'forwards',
            }
        );

        container.appendChild(span);
        anim.onfinish = () => span.remove();
    }
}

export function setEmberLevel(level: number): void {
    state.level = Math.max(0, Math.min(level, state.eggUnlocked ? 5 : 4));
    // Re-fill the level blocks if they exist in the current view.
    document
        .querySelectorAll<HTMLElement>('.ember-block')
        .forEach((block, i) => block.classList.toggle('filled', i < state.level));
    regenerateEmbers();
}

export function getEmberLevel(): number {
    return state.level;
}

export function setRainbow(rainbow: boolean): void {
    state.rainbow = rainbow;
    regenerateEmbers();
}

/**
 * Wire +/- buttons and the per-block click handler onto a freshly
 * rendered ember-control widget. Returns nothing; safe to call once
 * per view mount (it scopes by element refs).
 */
export function wireEmberControls(root: ParentNode): void {
    const minus = root.querySelector<HTMLButtonElement>('#ember-minus');
    const plus = root.querySelector<HTMLButtonElement>('#ember-plus');
    const blocks = root.querySelector<HTMLElement>('#ember-blocks');
    if (!minus || !plus || !blocks) return;

    let eggClicks: number[] = [];

    function shakeBlocks(): void {
        blocks!.classList.remove('shake');
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        blocks!.offsetHeight; // reflow to restart animation
        blocks!.classList.add('shake');
    }

    function addFifthBlock(): void {
        if (blocks!.querySelector('[data-level="5"]')) return;
        const block = document.createElement('span');
        block.className = 'ember-block growing';
        block.dataset['level'] = '5';
        blocks!.appendChild(block);
    }

    function persist(level: number): void {
        localStorage.setItem(STORAGE_KEY, String(Math.min(level, 4)));
    }

    function unlockFifth(): void {
        state.eggUnlocked = true;
        addFifthBlock();
        setTimeout(() => {
            const fifth = blocks!.querySelector<HTMLElement>('[data-level="5"]');
            if (fifth) fifth.classList.remove('growing');
            setEmberLevel(5);
            persist(5);
            burstEmbers(100);
        }, 400);
    }

    minus.addEventListener('click', () => {
        setEmberLevel(Math.max(0, state.level - 1));
        persist(state.level);
    });

    plus.addEventListener('click', () => {
        const cap = state.eggUnlocked ? 5 : 4;
        if (state.level < cap) {
            setEmberLevel(state.level + 1);
            persist(state.level);
            return;
        }
        if (state.level === 4 && !state.eggUnlocked) {
            shakeBlocks();
            const now = Date.now();
            eggClicks.push(now);
            eggClicks = eggClicks.filter((t) => now - t < 2500);
            if (eggClicks.length >= 5) {
                eggClicks = [];
                unlockFifth();
            }
        }
    });

    blocks.addEventListener('click', (e) => {
        const block = (e.target as HTMLElement).closest<HTMLElement>('.ember-block');
        if (!block) return;
        const clicked = parseInt(block.dataset['level'] ?? '0', 10);
        const next = clicked === state.level ? 0 : clicked;
        setEmberLevel(next);
        persist(next);
    });

    // Reflect current state on the just-rendered blocks.
    blocks
        .querySelectorAll<HTMLElement>('.ember-block')
        .forEach((b, i) => b.classList.toggle('filled', i < state.level));
}
