/**
 * The Play Store video's picture. Reads build/timeline.json (who says what,
 * when) and build/ui/manifest.json (the filmed UI), builds every scene's DOM
 * once, and exposes window.seek(t): put the whole stage at time t.
 *
 * Layout is in stage pixels (1920x1080). Each scene is a function of time
 * only, so frames can be rendered in any order and in parallel.
 */

const [TL, UI] = await Promise.all(
    ['../build/timeline.json', '../build/ui/manifest.json'].map((url) => fetch(url).then((r) => r.json()))
);
await document.fonts.load("168px 'Knewave'");

const stage = document.getElementById('stage');
const FPS = TL.fps;
const L = TL.lines;
const B = Object.fromEntries(TL.beats.map((b) => [b.id, b]));
const strike = (id) => TL.sounds.find((s) => s.id === id)?.start ?? null;

// ---- small maths ------------------------------------------------------------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** 0 before a, 1 after b, linear between. */
const ramp = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeInOut = (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
/** Overshoots a little, then settles: the sticker landing. */
const backOut = (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;
const during = (t, span) => Boolean(span) && t >= span.start && t < span.end;

/** A voice's loudness at t, 0-1, lightly smoothed. */
function level(who, t) {
    const env = TL.env[who];
    const f = Math.round(t * FPS);
    let sum = 0;
    for (let i = f - 1; i <= f + 1; i++) sum += env[Math.min(env.length - 1, Math.max(0, i))];
    return sum / 3;
}

/** Deterministic randomness, so every render of a frame is the same frame. */
function seeded(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- DOM helpers ------------------------------------------------------------

function h(tag, cls, parent = stage, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    parent.appendChild(el);
    return el;
}
const show = (el, on) => {
    el.style.display = on ? '' : 'none';
    return on;
};
/** Centre of an element in stage pixels (offsets, so a scaled preview and a
 *  transform on the element itself don't skew it). */
function centreOf(el) {
    let x = el.offsetWidth / 2;
    let y = el.offsetHeight / 2;
    for (let node = el; node && node !== stage; node = node.offsetParent) {
        x += node.offsetLeft;
        y += node.offsetTop;
    }
    return { x, y };
}

/** Images still decoding after a seek; the renderer waits on these. */
const pending = [];
function setFrame(img, shotName, t) {
    const shot = UI.shots[shotName];
    if (!shot) return;
    const i = Math.min(shot.frames - 1, Math.max(0, Math.round((t - shot.from) * FPS)));
    const src = `../build/ui/${shotName}/${String(i).padStart(4, '0')}.png`;
    if (img.dataset.src === src) return;
    img.dataset.src = src;
    img.src = src;
    pending.push(img.decode().catch(() => {}));
}

// ---- parts ------------------------------------------------------------------

/** The orb at kasina proportions: the gradient plus its three halos. */
function makeOrb(parent) {
    const el = h('div', 'abs orb', parent);
    return (o) => {
        if (!show(el, Boolean(o) && o.opacity !== 0)) return;
        const k = o.d / 140;
        const glow = o.glow ?? 1;
        el.style.width = el.style.height = `${o.d}px`;
        el.style.transform = `translate(${o.x - o.d / 2}px, ${o.y - o.d / 2}px) scale(${o.scale ?? 1})`;
        el.style.opacity = o.opacity ?? 1;
        el.style.filter = `brightness(${o.bright ?? 1})`;
        el.style.boxShadow =
            `0 0 ${60 * k}px rgba(245, 165, 47, ${0.3 * glow}), ` +
            `0 0 ${120 * k}px rgba(231, 31, 117, ${0.32 * glow}), ` +
            `0 0 ${200 * k}px rgba(231, 31, 117, ${0.16 * glow})`;
    };
}
/** The orb's own slow breath and flicker (kasinaPulse, orbFlicker). */
const breath = (t) => 1 + 0.028 * Math.sin((2 * Math.PI * t) / 7 - 1.2);
const flicker = (t) => 1 + 0.07 * Math.sin((2 * Math.PI * t) / 4.3);

/** Rings leaving a struck bowl. */
function makeRings(parent, count = 3) {
    const els = Array.from({ length: count }, () => h('div', 'abs ring', parent));
    return (t, at, x, y, r0, { color = '#e71f75', life = 3.6, spread = 1.7, strength = 1 } = {}) => {
        els.forEach((el, k) => {
            const p = at === null ? 0 : ramp(t, at + k * 0.45, at + k * 0.45 + life);
            if (!show(el, p > 0 && p < 1 && strength > 0)) return;
            const r = r0 * (1.1 + spread * easeOut(p));
            el.style.width = el.style.height = `${2 * r}px`;
            el.style.transform = `translate(${x - r}px, ${y - r}px)`;
            el.style.opacity = 0.62 * strength * (1 - p) ** 1.5 * ramp(p, 0, 0.05);
            el.style.borderColor = color;
            el.style.boxShadow = `0 0 16px ${color}, inset 0 0 16px ${color}`;
        });
    };
}

/**
 * A spoken line as words that light up as they are said. The whole line is
 * there from the start in a dimmer ink, so it can be read ahead of the voice
 * (and with the sound off).
 */
function makeSpoken(parent, words, { lead = 0.08, fade = 0.2 } = {}) {
    const spans = words.map((w, i) => {
        if (i) parent.appendChild(document.createTextNode(' '));
        return h('span', 'word', parent, w.w);
    });
    return (t) => {
        spans.forEach((span, i) => {
            const p = ramp(t, words[i].t - lead, words[i].t - lead + fade);
            span.style.color = `color-mix(in oklab, var(--lit) ${Math.round(p * 100)}%, var(--dim))`;
        });
    };
}

/** One side of the exchange, large: the app's bubble, with the orb beside the
 *  facilitator's, moving with her voice. */
function makeRow(parent, line, cls = '') {
    const facilitator = line.kind === 'aloud';
    const row = h('div', `row ${facilitator ? 'facilitator' : 'user'}`, parent);
    const orb = facilitator ? h('div', 'orb', h('div', 'avatar', row)) : null;
    if (orb) orb.style.cssText = 'width:64px;height:64px';
    const bubble = h('div', `bubble ${facilitator ? 'facilitator' : 'user'} ${cls}`, row);
    const words = makeSpoken(bubble, line.words);
    return (t) => {
        const p = easeOut(ramp(t, line.voiceStart - 0.4, line.voiceStart - 0.08));
        row.style.opacity = p;
        row.style.transform = `translateY(${(1 - p) * 26}px)`;
        words(t);
        if (orb) {
            const voice = t >= line.voiceStart - 0.1 && t < line.voiceEnd + 0.2 ? level('aloud', t) : 0;
            orb.style.transform = `scale(${breath(t) + 0.2 * voice})`;
            orb.style.filter = `brightness(${flicker(t) + 0.12 * voice})`;
            orb.style.boxShadow =
                `0 0 ${24 + 26 * voice}px rgba(245, 165, 47, ${0.34 + 0.4 * voice}), ` +
                `0 0 ${52 + 40 * voice}px rgba(231, 31, 117, ${0.3 + 0.3 * voice})`;
        }
    };
}

/**
 * A silent caption: words that arrive in a quick stagger. `marks` names the
 * words to underline, as [phrase, ink] pairs; a phrase the caption no longer
 * has is skipped, so rewording the script can't break the build.
 */
function makeCaption(parent, text, marks = []) {
    const tokens = text.split(/\s+/);
    const bare = (s) => s.toLowerCase().replace(/[^a-z0-9']/g, '');
    const spans = [];
    const lines = [];
    for (let i = 0; i < tokens.length; ) {
        const mark = marks.find(([phrase]) => {
            const want = phrase.split(' ').map(bare);
            return want.every((w, k) => tokens[i + k] !== undefined && bare(tokens[i + k]) === w);
        });
        if (i) parent.appendChild(document.createTextNode(' '));
        if (mark) {
            const n = mark[0].split(' ').length;
            // The stroke stops at the word: trailing punctuation sits outside
            // it, in one unbreakable box with the phrase so a comma can't wrap
            // to the next line on its own.
            const hold = h('span', null, parent);
            hold.style.cssText = 'display:inline-block;white-space:nowrap';
            const hl = h('span', 'hl', hold);
            hl.style.setProperty('--ink', mark[1]);
            for (let k = 0; k < n; k++) {
                if (k) hl.appendChild(document.createTextNode(' '));
                const [, word, tail] = /^(.*?)([.,!?]*)$/.exec(tokens[i + k]);
                spans.push(h('span', 'word', hl, k === n - 1 ? word : tokens[i + k]));
                if (k === n - 1 && tail) spans.push(h('span', 'word', hold, tail));
            }
            lines.push({ el: hl, after: spans.length });
            i += n;
        } else {
            spans.push(h('span', 'word', parent, tokens[i]));
            i++;
        }
    }
    return (t, start, { step = 0.045 } = {}) => {
        spans.forEach((span, i) => {
            const p = easeOut(ramp(t, start + i * step, start + i * step + 0.3));
            span.style.opacity = p;
            span.style.transform = `translateY(${(1 - p) * 20}px)`;
        });
        for (const line of lines) {
            const from = start + line.after * step + 0.28;
            line.el.style.setProperty('--drawn', easeInOut(ramp(t, from, from + 0.4)));
        }
    };
}

/** The phone: a plain frame around the filmed UI. */
const PHONE = { x: 130, y: 78, inset: 18 };
function makePhone(parent) {
    const body = h('div', 'abs phone', parent);
    const img = h('img', null, h('div', 'screen', body));
    return (o) => {
        if (!show(body, Boolean(o))) return;
        setFrame(img, o.shot, o.t);
        body.style.opacity = o.opacity ?? 1;
        body.style.transform = `translate(${PHONE.x}px, ${PHONE.y + (o.dy ?? 0)}px)`;
    };
}
/** A point on the phone's screen, given in the UI's own CSS pixels. */
const onPhone = (x, y) => ({ x: PHONE.x + PHONE.inset + x, y: PHONE.y + PHONE.inset + y });

// ---- the stage, back to front -------------------------------------------------

/** Every scene, as a function of time; drawn in this order each frame. */
const scenes = [];

/** Embers, as in a session: slow sparks rising behind everything. */
{
    const layer = h('div', 'layer');
    const rand = seeded(11);
    const colors = ['#e8a840', '#d4873a', '#c07830', '#e0a038', '#cc8030'];
    const embers = Array.from({ length: 16 }, () => ({
        el: h('div', 'abs ember', layer),
        x: rand() * 1920,
        size: 3 + rand() * 4,
        life: 11 + rand() * 9,
        offset: rand() * 20,
        sway: 18 + rand() * 46,
        swayEvery: 5 + rand() * 6,
        color: colors[Math.floor(rand() * colors.length)],
    }));
    for (const e of embers) {
        e.el.style.width = e.el.style.height = `${e.size}px`;
        e.el.style.background = e.color;
        e.el.style.boxShadow = `0 0 ${e.size * 2.2}px ${e.color}`;
    }
    scenes.push((t) => {
        for (const e of embers) {
            const p = ((t + e.offset) / e.life) % 1;
            const x = e.x + e.sway * Math.sin((2 * Math.PI * (t + e.offset)) / e.swayEvery);
            e.el.style.transform = `translate(${x}px, ${1100 - p * 1180}px)`;
            e.el.style.opacity = 0.62 * Math.sin(Math.PI * p) ** 0.7;
        }
    });
}

/**
 * The orb on its own: the opening (it then travels into the phone and becomes
 * the session's orb), and again under the closing words and the end card.
 */
{
    const layer = h('div', 'layer');
    // Above the phone: the opening orb lands on the session's own.
    layer.style.zIndex = 5;
    const brand = h('div', 'layer', layer);
    // The end card's standing rings, as on the share card: radii 1.27 / 1.82 /
    // 2.44 of the orb's, fading before they reach the type below.
    brand.style.maskImage = 'linear-gradient(to bottom, transparent 4%, #000 20%, #000 54%, transparent 62%)';
    const brandRings = [
        [1.27, 4.4, 0.55],
        [1.82, 3.6, 0.28],
        [2.44, 2.9, 0.15],
    ].map(([k, width, alpha]) => ({ el: h('div', 'abs ring', brand), k, width, alpha }));
    const rings = makeRings(layer);
    const voiceRings = makeRings(layer, 2);
    const listening = Array.from({ length: 3 }, () => h('div', 'abs ring', layer));
    const orb = makeOrb(layer);

    const target = UI.shots.hook?.noted;
    const landing = target
        ? { ...onPhone(target.x + target.width / 2, target.y + target.height / 2), d: target.width }
        : { x: 960, y: 540, d: 300 };
    const hookAt = B.hook?.start ?? B.settle?.end ?? 0;
    const WHY = { x: 960, y: 318, d: 236 };
    const END = { x: 960, y: 390, d: 256 };

    scenes.push((t) => {
        const closing = during(t, B.why) || during(t, B.end);
        if (!show(layer, t < hookAt + 0.1 || closing)) return;
        show(brand, during(t, B.end));

        if (!closing) {
            // Settle, then fly: centre stage to the phone's own orb.
            const p = easeInOut(ramp(t, hookAt - 0.85, hookAt));
            const at = { x: lerp(960, landing.x, p), y: lerp(540, landing.y, p), d: lerp(300, landing.d, p) };
            orb({
                ...at,
                scale: breath(t),
                bright: flicker(t),
                opacity: ramp(t, 0, 0.9) * (1 - ramp(t, hookAt - 0.1, hookAt + 0.06)),
            });
            rings(t, strike('bowl-open'), 960, 540, 150, { strength: 1 - ramp(t, hookAt - 1.1, hookAt - 0.6) });
            voiceRings(t, null, 0, 0, 0);
            listening.forEach((el) => show(el, false));
            return;
        }

        // Under his words: the orb listening, moved by the voice.
        const voice = during(t, B.why) ? level('you', t) : 0;
        const p = B.end ? easeInOut(ramp(t, B.end.start, B.end.start + 0.6)) : 0;
        const at = { x: lerp(WHY.x, END.x, p), y: lerp(WHY.y, END.y, p), d: lerp(WHY.d, END.d, p) };
        const arrive = B.why ? easeOut(ramp(t, B.why.start, B.why.start + 0.5)) : 1;
        orb({ ...at, scale: (0.9 + 0.1 * arrive) * (breath(t) + 0.035 * voice), bright: flicker(t) + 0.05 * voice, glow: 1 + 0.5 * voice, opacity: arrive });
        rings(t, strike('bowl-close'), at.x, at.y, at.d / 2, { spread: 2.2 });
        voiceRings(t, strike('bowl-bed'), at.x, at.y, at.d / 2, { strength: 0.6 * arrive, spread: 2 });
        // Listening: slow rings that are there while he speaks and gone when
        // he stops, their strength his voice over the last half second.
        let heard = 0;
        if (during(t, B.why)) for (let k = 0; k < 8; k++) heard += level('you', t - k / 16) / 8;
        listening.forEach((el, k) => {
            const p = (t / 3.4 + k / listening.length) % 1;
            if (!show(el, heard > 0.02)) return;
            const r = (at.d / 2) * (1.12 + 1.5 * p);
            el.style.cssText =
                `width:${2 * r}px;height:${2 * r}px;border-width:2.5px;opacity:${0.5 * Math.min(1, heard * 1.6) * (1 - p) ** 1.4 * ramp(p, 0, 0.08)};` +
                `transform:translate(${at.x - r}px, ${at.y - r}px);box-shadow:0 0 12px rgba(231,31,117,0.5), inset 0 0 12px rgba(231,31,117,0.5)`;
        });
        if (B.end) {
            const settle = easeOut(ramp(t, B.end.start + 0.15, B.end.start + 1.1));
            for (const ring of brandRings) {
                const r = (END.d / 2) * ring.k * (0.9 + 0.1 * settle);
                ring.el.style.cssText =
                    `width:${2 * r}px;height:${2 * r}px;border-width:${ring.width}px;opacity:${ring.alpha * settle};` +
                    `transform:translate(${END.x - r}px, ${END.y - r}px);box-shadow:0 0 12px rgba(231,31,117,0.45), inset 0 0 12px rgba(231,31,117,0.45)`;
            }
        }
    });
}

/** The phone, wherever the real UI is on screen. */
{
    const phone = makePhone(stage);
    const timerFrom = L.v1 ? TL.marks.timerAsk : null;
    scenes.push((t) => {
        const rise = (from, d = 0.45) => {
            const p = easeOut(ramp(t, from, from + d));
            return { dy: (1 - p) * 70, opacity: p };
        };
        if (B.hook && t >= B.hook.start - 1.05 && t < B.hook.end) phone({ shot: 'hook', t, ...rise(B.hook.start - 1.05, 0.75) });
        else if (during(t, B.felt)) phone({ shot: 'felt', t, ...rise(B.felt.start) });
        else if (during(t, B.noting)) phone({ shot: 'noting', t, ...(B.felt ? {} : rise(B.noting.start)) });
        else if (timerFrom !== null && t >= timerFrom && t < B.tune.end) phone({ shot: 'timer', t, ...rise(timerFrom, 0.4) });
        else phone(null);
    });
}

const COLUMN = 'left:690px;top:0;width:1110px;height:1080px';

/** 2. the hook: the exchange beside the phone. */
if (B.hook) {
    const column = h('div', 'abs column');
    column.style.cssText = COLUMN;
    const rows = ['f0', 'e1', 'f1'].filter((id) => L[id]).map((id) => makeRow(column, L[id]));
    scenes.push((t) => {
        if (show(column, during(t, B.hook))) rows.forEach((row) => row(t));
    });
}

/** c1 lands over the cut: what this is, in one line. */
if (B.claim) {
    const layer = h('div', 'layer');
    const rings = makeRings(layer, 2);
    const orb = makeOrb(layer);
    const box = h('div', 'abs centered caption', layer);
    box.style.cssText = 'left:210px;top:380px;width:1500px;height:420px;font-size:90px';
    const caption = makeCaption(h('div', null, box), L.c1.text, [
        ['listens', 'var(--accent)'],
        ['follows', 'var(--orb-yellow)'],
    ]);
    scenes.push((t) => {
        if (!show(layer, during(t, B.claim))) return;
        const at = B.claim.start;
        const p = easeOut(ramp(t, at, at + 0.4));
        orb({ x: 960, y: 262, d: 124, scale: (0.8 + 0.2 * p) * breath(t), bright: flicker(t), opacity: p });
        rings(t, strike('rin-cut'), 960, 262, 62, { life: 2.6, spread: 2.4 });
        caption(t, at + 0.12);
    });
}

/** 3. what else it helps with: three stickers, one after another. */
if (B.cards) {
    const inks = ['var(--orb-yellow)', 'var(--orb-orange)', 'var(--accent)'];
    const cards = ['c2', 'c3', 'c4']
        .filter((id) => L[id])
        .map((id, i) => {
            const box = h('div', 'abs centered');
            box.style.cssText = 'left:0;top:0;width:1920px;height:1080px';
            const card = h('div', 'sticker', box, L[id].text);
            card.style.boxShadow = `14px 14px 0 ${inks[i % inks.length]}`;
            // As large as the line allows, with air either side.
            const size = Math.min(132, (132 * 1560) / card.offsetWidth);
            card.style.fontSize = `${size}px`;
            return { line: L[id], box, card, tilt: i % 2 ? 3 : -3 };
        });
    scenes.push((t) => {
        for (const { line, box, card, tilt } of cards) {
            if (!show(box, during(t, line))) continue;
            // Lands a little crooked, then straightens: square at rest.
            const p = ramp(t, line.start, line.start + 0.34);
            const q = backOut(p);
            card.style.opacity = ramp(t, line.start, line.start + 0.1);
            card.style.transform = `translateY(${(1 - q) * 46}px) rotate(${(1 - q) * tilt}deg) scale(${0.93 + 0.07 * q})`;
        }
    });
}

/** 4 and 5. felt sense and noting: the phone again, the mode named beside it. */
{
    const titles = [
        ['c5', B.felt, 'var(--accent)'],
        ['c6', B.noting, 'var(--orb-orange)'],
    ]
        .filter(([id, span]) => L[id] && span)
        .map(([id, span, ink]) => {
            const el = h('div', 'abs mode-title');
            el.style.cssText = `left:776px;top:148px;color:${ink}`;
            const text = h('span', null, el, L[id].text);
            const bar = h('span', 'bar', el);
            bar.style.background = ink;
            return { span, el, text, bar };
        });
    scenes.push((t) => {
        for (const { span, el, text, bar } of titles) {
            if (!show(el, during(t, span))) continue;
            const p = easeOut(ramp(t, span.start + 0.05, span.start + 0.4));
            text.style.opacity = p;
            el.style.transform = `translateY(${(1 - p) * 18}px)`;
            bar.style.transform = `scaleX(${easeInOut(ramp(t, span.start + 0.2, span.start + 0.65))})`;
        }
    });

    if (B.felt && L.f3) {
        const column = h('div', 'abs column');
        column.style.cssText = COLUMN;
        const row = makeRow(column, L.f3);
        scenes.push((t) => {
            if (show(column, during(t, B.felt))) row(t);
        });
    }

    if (B.noting && L.n1) {
        const column = h('div', 'abs column');
        column.style.cssText = `${COLUMN};gap:44px`;
        const note = makeRow(column, L.n1, 'big');
        // The bowl takes its turn: where a facilitator's bubble would be.
        const turn = h('div', 'row facilitator', column);
        const badge = h('div', 'bubble facilitator', turn);
        badge.style.cssText = 'padding:22px 34px 16px;margin-left:86px;border-color:rgba(212,105,42,0.5)';
        badge.innerHTML =
            '<svg width="118" height="92" viewBox="0 0 118 92" fill="none" stroke="#ed7326" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M14 26 C16 62 38 74 59 74 C80 74 102 62 104 26"/><ellipse cx="59" cy="26" rx="45" ry="9"/><path d="M34 86 H84"/></svg>';
        const layer = h('div', 'layer');
        const rings = makeRings(layer);
        const at = TL.marks.notingBowl;
        let centre = null;
        scenes.push((t) => {
            const on = during(t, B.noting);
            show(layer, on);
            if (!show(column, on)) return;
            note(t);
            centre ??= centreOf(badge);
            const p = backOut(ramp(t, at - 0.02, at + 0.3));
            turn.style.opacity = ramp(t, at - 0.02, at + 0.1);
            turn.style.transform = `scale(${0.8 + 0.2 * p})`;
            rings(t, at, centre.x, centre.y, 78, { color: '#ed7326', life: 2.2, spread: 2.6 });
        });
    }
}

/** 6. yours to tune: the real controls, large, then a timer asked for aloud. */
if (B.tune) {
    /** When each part of a caption arrives, in seconds after it starts:
     *  with the taps on the control beside it. */
    const PARTS_AT = { c7: [0.2, 0.6, 1.0], c8: [0.2, 0.6, 1.0], c9: [0.15, 0.85] };
    const controls = [
        ['c7', 'focus'],
        ['c8', 'vibe'],
        ['c9', 'guidance'],
        ['c10', 'checkin'],
    ]
        .filter(([id, shot]) => L[id] && UI.shots[shot])
        .map(([id, shot], n) => {
            const { width, height } = UI.shots[shot];
            const scale = Math.min(960 / width, 850 / height);
            const card = h('div', 'abs ui-card');
            card.style.width = `${width * scale}px`;
            card.style.height = `${height * scale}px`;
            card.style.boxShadow = '13px 13px 0 var(--brand-stroke)';
            const img = h('img', null, card);
            const box = h('div', 'abs tune-caption');
            box.style.cssText = 'left:1120px;top:0;width:760px;height:1080px';
            // "a · b · c" and "a, or b" read as a list: one part to a line.
            const parts = L[id].text.includes(' · ') ? L[id].text.split(' · ') : L[id].text.split(/(?<=,) /);
            const list = L[id].text.includes(' · ');
            const lines = parts.map((part, i) => {
                const el = h('div', null, box, part);
                if (list && i < parts.length - 1) h('span', 'sep', el, ' ·');
                if (parts.length === 1) el.style.textWrap = 'balance';
                return el;
            });
            const partsAt = PARTS_AT[id]?.length === parts.length ? PARTS_AT[id] : parts.map((_, i) => 0.15 + i * 0.3);
            return { line: L[id], shot, card, img, box, lines, partsAt, x: 560 - (width * scale) / 2, y: 540 - (height * scale) / 2, tilt: n % 2 ? 2.5 : -2.5 };
        });
    scenes.push((t) => {
        for (const c of controls) {
            const on = during(t, c.line);
            show(c.box, on);
            if (!show(c.card, on)) continue;
            setFrame(c.img, c.shot, t);
            const q = backOut(ramp(t, c.line.start, c.line.start + 0.32));
            c.card.style.opacity = ramp(t, c.line.start, c.line.start + 0.1);
            c.card.style.transform = `translate(${c.x}px, ${c.y + (1 - q) * 44}px) rotate(${(1 - q) * c.tilt}deg)`;
            c.lines.forEach((el, i) => {
                const p = easeOut(ramp(t, c.line.start + c.partsAt[i], c.line.start + c.partsAt[i] + 0.3));
                el.style.opacity = p;
                el.style.transform = `translateX(${(1 - p) * 26}px)`;
            });
        }
    });

    if (L.v1 && UI.shots.timer?.noted && UI.shots['timer-clock']) {
        const from = TL.marks.timerAsk;
        const lands = TL.marks.timerLands;
        const column = h('div', 'abs column');
        column.style.cssText = 'left:690px;top:0;width:1110px;height:780px';
        const row = makeRow(column, L.v1, 'mid');

        // A magnifier on the session clock: the same shot, filmed close.
        const clock = UI.shots.timer.noted;
        const close = UI.shots['timer-clock'];
        const spot = onPhone(clock.x + clock.width / 2, clock.y + clock.height / 2);
        // Held over the phone just above the clock it enlarges.
        const LOUPE = { x: spot.x + 62, y: spot.y - 196, d: 290, zoom: 4.6 };
        const layer = h('div', 'layer');
        const stem = h('div', 'abs', layer);
        const halo = h('div', 'abs ring', layer);
        const rings = makeRings(layer, 2);
        const loupe = h('div', 'abs loupe', layer);
        loupe.style.width = loupe.style.height = `${LOUPE.d}px`;
        const img = h('img', null, loupe);
        img.style.width = `${close.width * LOUPE.zoom}px`;
        img.style.height = `${close.height * LOUPE.zoom}px`;
        img.style.left = `${LOUPE.d / 2 - (close.width * LOUPE.zoom) / 2 - 5}px`;
        img.style.top = `${LOUPE.d / 2 - (close.height * LOUPE.zoom) / 2 - 5}px`;
        const reach = Math.hypot(LOUPE.x - spot.x, LOUPE.y - spot.y);
        const angle = Math.atan2(LOUPE.y - spot.y, LOUPE.x - spot.x);
        stem.style.cssText +=
            `;width:${reach}px;height:4px;border-radius:2px;background:var(--brand-stroke);transform-origin:0 50%;` +
            `transform:translate(${spot.x}px, ${spot.y - 2}px) rotate(${angle}rad)`;
        halo.style.cssText += `;width:92px;height:60px;border-radius:30px;border:4px solid var(--brand-stroke);transform:translate(${spot.x - 46}px, ${spot.y - 30}px)`;

        scenes.push((t) => {
            const on = t >= from && t < B.tune.end;
            show(layer, on);
            if (!show(column, on)) return;
            row(t);
            setFrame(img, 'timer-clock', t);
            const p = backOut(ramp(t, from + 0.3, from + 0.68));
            const draw = easeOut(ramp(t, from + 0.2, from + 0.5));
            // The moment the timer takes: the magnifier jumps and rings.
            const bump = Math.sin(Math.PI * ramp(t, lands, lands + 0.4));
            halo.style.opacity = draw;
            stem.style.opacity = draw;
            stem.style.clipPath = `inset(0 ${(1 - draw) * 100}% 0 0)`;
            loupe.style.opacity = ramp(t, from + 0.3, from + 0.42);
            loupe.style.transform = `translate(${LOUPE.x - LOUPE.d / 2}px, ${LOUPE.y - LOUPE.d / 2}px) scale(${Math.max(0, p) * (1 + 0.1 * bump)})`;
            rings(t, lands, LOUPE.x, LOUPE.y, LOUPE.d / 2, { color: '#e8b820', life: 1.3, spread: 0.7 });
        });
    }
}

/** 7. how it's different. */
if (B.different) {
    const bars = [14, 30, 22, 40, 18, 34, 26, 12, 36, 20, 28, 16];
    const make = (id, cls, marks) => {
        if (!L[id]) return null;
        const box = h('div', `abs centered caption ${cls}`);
        box.style.cssText = 'left:160px;top:0;width:1600px;height:1080px;gap:64px';
        const caption = makeCaption(h('div', null, box), L[id].text, marks);
        return { line: L[id], box, caption };
    };
    const same = make('c11', '', []);
    const live = make('c12', '', [['live conversation', 'var(--accent)']]);
    let tapes = [];
    if (same) {
        same.box.style.fontSize = '82px';
        same.box.style.color = 'var(--text-muted)';
        // The same recording, five times over.
        const strip = h('div', null, same.box);
        strip.style.cssText = 'display:flex;gap:22px';
        tapes = Array.from({ length: 5 }, () => {
            const tape = h('div', 'tape', strip);
            for (const height of bars) h('i', null, tape).style.height = `${height}px`;
            return tape;
        });
    }
    if (live) live.box.style.fontSize = '94px';
    scenes.push((t) => {
        if (same && show(same.box, during(t, same.line))) {
            same.caption(t, same.line.start + 0.05, { step: 0.035 });
            tapes.forEach((tape, i) => {
                const p = easeOut(ramp(t, same.line.start + 0.5 + i * 0.09, same.line.start + 0.8 + i * 0.09));
                tape.style.opacity = p;
                tape.style.transform = `translateY(${(1 - p) * 16}px)`;
            });
        }
        if (live && show(live.box, during(t, live.line))) live.caption(t, live.line.start + 0.05, { step: 0.04 });
    });
}

/** 8. why it exists: his own words, under the orb. */
if (B.why) {
    /** A line split into caption-sized pages at its sentences. */
    const pages = ['e3', 'e4']
        .filter((id) => L[id])
        .flatMap((id) => {
            const out = [[]];
            let length = 0;
            let sentence = [];
            const flush = () => {
                const size = sentence.reduce((n, w) => n + w.w.length + 1, 0);
                if (out.at(-1).length && length + size > 72) {
                    out.push([]);
                    length = 0;
                }
                out.at(-1).push(...sentence);
                length += size;
                sentence = [];
            };
            for (const w of L[id].words) {
                sentence.push(w);
                if (/[.?!]$/.test(w.w) && !w.w.endsWith('...')) flush();
            }
            flush();
            return out.map((words) => ({ words, voiceEnd: L[id].voiceEnd }));
        });
    const box = h('div', 'abs centered');
    box.style.cssText = 'left:0;top:520px;width:1920px;height:440px';
    pages.forEach((page, i) => {
        page.from = page.words[0].t - 0.4;
        const next = pages[i + 1];
        // A page stays until the next one is due, or a beat after its last word.
        page.to = next ? next.words[0].t - 0.4 : B.why.end;
        page.el = h('div', 'bubble user wide', box);
        page.el.style.position = 'absolute';
        page.spoken = makeSpoken(page.el, page.words);
    });
    scenes.push((t) => {
        if (!show(box, during(t, B.why))) return;
        for (const page of pages) {
            if (!show(page.el, t >= page.from && t < page.to)) continue;
            const p = easeOut(ramp(t, page.from, page.from + 0.3));
            page.el.style.opacity = p;
            page.el.style.transform = `translateY(${(1 - p) * 22}px)`;
            page.spoken(t);
        }
    });
}

/** 9. end card: the mark on the orb, the offer, the address. */
if (B.end) {
    const layer = h('div', 'layer');
    // Over the orb, which sits above the other scenes.
    layer.style.zIndex = 6;
    const mark = h('div', 'abs wordmark', layer);
    if (L.c13) {
        h('span', 'under', mark, L.c13.text);
        h('span', 'over', mark, L.c13.text);
    }
    const size = L.c13 ? { w: mark.lastChild.offsetWidth, h: mark.lastChild.offsetHeight } : { w: 0, h: 0 };
    const offer = h('div', 'abs centered', layer);
    offer.style.cssText = 'left:0;top:694px;width:1920px;height:70px;font-size:46px;font-weight:550;color:var(--text-primary)';
    if (L.c14) h('div', null, offer, L.c14.text);
    const site = h('div', 'abs centered', layer);
    site.style.cssText = 'left:0;top:800px;width:1920px;height:90px;font-size:62px;font-weight:750;letter-spacing:-0.01em;color:#ffd820';
    if (L.c15) h('div', null, site, L.c15.text);
    scenes.push((t) => {
        if (!show(layer, during(t, B.end))) return;
        const at = B.end.start;
        const q = backOut(ramp(t, at + 0.25, at + 0.75));
        mark.style.opacity = ramp(t, at + 0.25, at + 0.4);
        mark.style.transform = `translate(${960 - size.w / 2}px, ${398 - size.h / 2}px) scale(${0.72 + 0.28 * q})`;
        mark.style.width = `${size.w}px`;
        mark.style.height = `${size.h}px`;
        [
            [offer, 1.0],
            [site, 1.45],
        ].forEach(([el, delay]) => {
            const p = easeOut(ramp(t, at + delay, at + delay + 0.5));
            el.style.opacity = p;
            el.style.transform = `translateY(${(1 - p) * 18}px)`;
        });
    });
}

/** Up from black at the very start. */
{
    const black = h('div', 'layer');
    black.style.cssText = 'background:#000;z-index:60';
    scenes.push((t) => {
        if (show(black, t < 0.8)) black.style.opacity = 1 - easeInOut(ramp(t, 0, 0.8));
    });
}

// ---- driving it ---------------------------------------------------------------

function draw(t) {
    for (const scene of scenes) scene(t);
}

/** Put the stage at time t and wait for the UI frames it needs. */
window.seek = async (t) => {
    draw(t);
    await Promise.all(pending.splice(0));
};
window.film = { duration: TL.duration, frames: TL.frames, fps: FPS };

if (new URLSearchParams(location.search).has('preview')) {
    // Watch it against the soundtrack: space plays and pauses, the slider and
    // the arrow keys scrub.
    const audio = new Audio('../build/audio/mix.wav');
    const hud = h('div', null, document.body);
    hud.id = 'hud';
    const slider = h('input', null, hud);
    Object.assign(slider, { type: 'range', min: 0, max: TL.duration, step: 1 / FPS, value: 0 });
    const readout = h('span', null, hud);
    const fit = () => {
        stage.style.transform = `scale(${Math.min(innerWidth / 1920, innerHeight / 1080)})`;
    };
    addEventListener('resize', fit);
    fit();
    const tick = () => {
        const t = audio.currentTime;
        draw(t);
        pending.length = 0;
        slider.value = t;
        const here = TL.beats.find((b) => during(t, b));
        readout.textContent = ` ${t.toFixed(2)}s  ${here?.id ?? ''}`;
        requestAnimationFrame(tick);
    };
    slider.addEventListener('input', () => (audio.currentTime = Number(slider.value)));
    addEventListener('keydown', (e) => {
        if (e.key === ' ') audio.paused ? audio.play() : audio.pause();
        else if (e.key === 'ArrowRight') audio.currentTime += e.shiftKey ? 1 : 1 / FPS;
        else if (e.key === 'ArrowLeft') audio.currentTime -= e.shiftKey ? 1 : 1 / FPS;
        else return;
        e.preventDefault();
    });
    tick();
} else {
    draw(0);
}
document.documentElement.dataset.ready = '1';
