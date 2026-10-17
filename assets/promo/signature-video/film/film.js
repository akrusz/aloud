/**
 * The signature-sound video's picture. Reads cut.mjs (what is said and played,
 * when) and build/analysis.json (what each sound looks like: spectrogram
 * columns, level, line spectra, the pen's word), builds every scene's DOM once
 * and exposes window.seek(t): put the whole stage at time t.
 *
 * Layout is in stage pixels (1920x1080). Each scene is a function of time
 * only, so frames can be rendered in any order and in parallel.
 */

import { PEOPLE, layout } from '../cut.mjs';

const CUT = layout();
const AN = await fetch('../build/analysis.json').then((r) => r.json());
const SCOPES = Object.fromEntries(
    await Promise.all(
        CUT.cues
            .filter((c) => c.viz?.includes('scope'))
            .map(async (c) => [c.id, new Float32Array(await fetch(`../build/scope/${c.id}.f32`).then((r) => r.arrayBuffer()))])
    )
);
await document.fonts.load("200px 'Knewave'");

const stage = document.getElementById('stage');
const FPS = CUT.fps;
const SR = 48000;
const CUE = Object.fromEntries(CUT.cues.map((c) => [c.id, { ...c, ...AN.cues[c.id] }]));

// ---- small maths ------------------------------------------------------------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** 0 before a, 1 after b, linear between. */
const ramp = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeInOut = (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
/** Overshoots a little, then settles: the sticker landing. */
const backOut = (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2;

/** Seconds into a cue (negative before it starts). */
const into = (id, t) => t - CUE[id].at;
const playing = (id, t) => into(id, t) >= 0 && into(id, t) < CUE[id].seconds;
/** A cue's level at t, 0-1, lightly smoothed; 0 when it isn't playing. */
function level(id, t) {
    const env = CUE[id].env;
    const f = into(id, t) * FPS;
    if (f < 0 || f >= env.length) return 0;
    const i = Math.floor(f);
    let sum = 0;
    for (let k = i - 1; k <= i + 1; k++) sum += env[Math.min(env.length - 1, Math.max(0, k))];
    return sum / 3;
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
const place = (el, x, y, w, hgt) => {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (w !== undefined) el.style.width = `${w}px`;
    if (hgt !== undefined) el.style.height = `${hgt}px`;
    return el;
};

/** A line of words that arrive in a quick stagger. Words in `pink` are inked
 *  pink; `mark` is underlined once the line has landed. */
function makeWords(parent, text, { pink = [], mark = null } = {}) {
    const bare = (s) => s.toLowerCase().replace(/[^a-z0-9'.]/g, '');
    const spans = text.split(/\s+/).map((w, i) => {
        if (i) parent.appendChild(document.createTextNode(' '));
        const span = h('span', 'word', parent, w);
        if (pink.some((p) => bare(p) === bare(w))) span.classList.add('pink');
        if (mark && bare(w).replace(/\.$/, '') === mark) span.classList.add('hl');
        return span;
    });
    return (t, at, { stagger = 0.045, dur = 0.38 } = {}) => {
        spans.forEach((span, i) => {
            const p = easeOut(ramp(t, at + i * stagger, at + i * stagger + dur));
            span.style.opacity = p;
            span.style.transform = `translateY(${(1 - p) * 22}px)`;
            if (span.classList.contains('hl')) span.style.setProperty('--drawn', easeInOut(ramp(t, at + spans.length * stagger + 0.3, at + spans.length * stagger + 0.8)));
        });
    };
}

/** Fades an element up and in at `at`, and out at `out` (if given). */
function arrive(el, t, at, out = Infinity, { rise = 20, dur = 0.4 } = {}) {
    const p = easeOut(ramp(t, at, at + dur)) * (out === Infinity ? 1 : 1 - ramp(t, out - 0.3, out));
    if (!show(el, p > 0)) return 0;
    el.style.opacity = p;
    el.style.transform = `translateY(${(1 - p) * rise}px)`;
    return p;
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

/** The app's three pink ripples as a signature sound plays (orbRipple in
 *  app-base.css): emissions at 0, 0.9 and 1.8s, each 1.8s, out to 2.4x. */
function makeRipples(parent) {
    const els = Array.from({ length: 3 }, () => h('div', 'abs ring', parent));
    return (t, starts, x, y, d) => {
        const live = [];
        for (const at of starts) for (const k of [0, 0.9, 1.8]) live.push(t - at - k);
        live.sort((a, b) => a - b);
        let n = 0;
        for (const age of live) {
            if (age < 0 || age >= 1.8 || n >= els.length) continue;
            const el = els[n++];
            show(el, true);
            const p = age / 1.8;
            const s = 1 + 1.4 * easeOut(p);
            const o = p < 0.7 ? lerp(0.6, 0.15, p / 0.7) : lerp(0.15, 0, (p - 0.7) / 0.3);
            el.style.width = el.style.height = `${d}px`;
            el.style.transform = `translate(${x - d / 2}px, ${y - d / 2}px) scale(${s})`;
            el.style.opacity = o;
            el.style.borderWidth = `${3 / s}px`;
            el.style.boxShadow = '0 0 18px 3px rgba(231, 31, 117, 0.35)';
        }
        for (; n < els.length; n++) show(els[n], false);
    };
}

/** Spectrogram ink: the orb's gradient run from the background up. */
const LUT = (() => {
    const stops = [
        [0, [17, 13, 8]],
        [0.24, [44, 10, 28]],
        [0.43, [122, 10, 58]],
        [0.58, [231, 31, 117]],
        [0.72, [237, 115, 38]],
        [0.85, [255, 184, 5]],
        [0.94, [248, 242, 136]],
        [1, [255, 244, 192]],
    ];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
        const v = i / 255;
        let k = 0;
        while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
        const [a, ca] = stops[k];
        const [b, cb] = stops[k + 1];
        const p = clamp01((v - a) / (b - a));
        for (let c = 0; c < 3; c++) lut[i * 3 + c] = lerp(ca[c], cb[c], p);
    }
    return lut;
})();

/** A cue's spectrogram, filling left to right as it plays (low notes at the
 *  bottom, 45 Hz to 9 kHz on a log scale). */
function makeSpectro(parent, id, w, hgt) {
    const canvas = h('canvas', 'abs spectro', parent);
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    const cols = CUE[id].spec;
    const n = cols.length;
    const bins = cols[0].length;
    const sheet = document.createElement('canvas');
    sheet.width = n;
    sheet.height = bins;
    const img = sheet.getContext('2d').createImageData(n, bins);
    cols.forEach((col, x) =>
        col.forEach((v, b) => {
            const o = ((bins - 1 - b) * n + x) * 4;
            img.data.set([LUT[v * 3], LUT[v * 3 + 1], LUT[v * 3 + 2], 255], o);
        })
    );
    sheet.getContext('2d').putImageData(img, 0, 0);
    return Object.assign(canvas, {
        draw(t) {
            ctx.fillStyle = '#0a0705';
            ctx.fillRect(0, 0, w, hgt);
            const k = Math.min(n, into(id, t) * FPS);
            if (k <= 0) return;
            const cols = Math.max(1, Math.ceil(k));
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(sheet, 0, 0, cols, bins, 0, 0, (w * cols) / n, hgt);
            if (k < n) {
                const x = (w * k) / n;
                const g = ctx.createLinearGradient(x - 26, 0, x + 2, 0);
                g.addColorStop(0, 'rgba(255, 244, 192, 0)');
                g.addColorStop(1, 'rgba(255, 244, 192, 0.55)');
                ctx.fillStyle = g;
                ctx.fillRect(x - 26, 0, 28, hgt);
                ctx.fillStyle = '#0a0705';
                ctx.fillRect(x + 2, 0, w - x, hgt);
            }
        },
    });
}

/** Draw a stroke as a phosphor trace: a pink glow under a hot core. */
function phosphor(ctx, path, alpha, width = 2.6) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(231, 31, 117, 0.9)';
    ctx.shadowBlur = 22;
    ctx.strokeStyle = 'rgba(245, 88, 154, 0.85)';
    ctx.lineWidth = width * 2.2;
    ctx.stroke(path);
    ctx.shadowBlur = 6;
    ctx.shadowColor = 'rgba(255, 184, 5, 0.6)';
    ctx.strokeStyle = 'rgba(255, 236, 210, 0.95)';
    ctx.lineWidth = width * 0.7;
    ctx.stroke(path);
    ctx.restore();
}

/** Left channel against right, as an XY oscilloscope draws a stereo cue:
 *  the last frame's worth of samples, with two fainter frames behind it.
 *  Scaled so the `q` quantile of each channel reaches the edge. */
function makeScope(id, q = 1) {
    const s = SCOPES[id];
    const pct = (ch) => {
        const a = [];
        for (let i = ch; i < s.length; i += 2) a.push(Math.abs(s[i]));
        a.sort((x, y) => x - y);
        return a[Math.min(a.length - 1, Math.floor(a.length * q))];
    };
    const maxL = pct(0);
    const maxR = pct(1);
    const span = SR / FPS;
    return (ctx, t, cx, cy, halfW, halfH) => {
        const at = Math.floor(into(id, t) * SR);
        if (at <= 0) return;
        // Held a little as the sound falls away, so the shape stays in view.
        const lift = Math.min(2.2, 10 ** (((1 - level(id, t)) * 48 * 0.5) / 20));
        const sc = 0.92 * Math.min(halfW / maxL, halfH / maxR) * Math.min(lift, 1.6);
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx - halfW, cy - halfH, 2 * halfW, 2 * halfH);
        ctx.clip();
        [
            [2, 0.16],
            [1, 0.4],
            [0, 1],
        ].forEach(([back, alpha]) => {
            const end = Math.min(s.length / 2, at - back * span);
            const start = Math.max(0, end - span * 1.15);
            if (end <= start) return;
            const path = new Path2D();
            for (let i = Math.floor(start); i < end; i++) {
                const x = cx + s[2 * i] * sc;
                const y = cy - s[2 * i + 1] * sc;
                if (i === Math.floor(start)) path.moveTo(x, y);
                else path.lineTo(x, y);
            }
            phosphor(ctx, path, alpha, 2.2);
        });
        ctx.restore();
    };
}

/** A speaker, for "sound on". */
const SPEAKER =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

// ---- scenes -----------------------------------------------------------------

const BUILDERS = {};

BUILDERS.title = (s, layer) => {
    const orb = makeOrb(layer);
    const ripples = makeRipples(layer);
    const title = place(h('div', 'abs caption', layer), 0, 640, 1920);
    title.style.cssText += 'text-align:center;font-size:118px;font-weight:820';
    const words = makeWords(title, s.title, { pink: ['aloud.'] });
    const sub = place(h('div', 'abs sub', layer), 360, 800, 1200);
    sub.style.cssText += 'text-align:center;font-size:46px';
    const subWords = makeWords(sub, s.sub);
    const chip = place(h('div', 'abs chip', layer), 1560, 70);
    chip.innerHTML = `${SPEAKER}<span>${s.soundOn}</span>`;
    chip.style.color = 'var(--yellow)';
    const cue = s.cues[0];
    return (t, abs) => {
        const lvl = level(cue.id, abs);
        orb({ x: 960, y: 380, d: 240, scale: breath(t) * (1 + 0.05 * lvl), glow: 1 + 0.7 * lvl, opacity: easeOut(ramp(t, 0, 0.6)) });
        ripples(t, [cue.at], 960, 380, 240);
        words(t, 1.0);
        subWords(t, 2.3, { stagger: 0.03 });
        arrive(chip, t, 0.3, 5.6, { rise: 0 });
    };
};

BUILDERS.brief = (s, layer) => {
    const lines = s.lines.map((line, i) => {
        const el = place(h('div', 'abs caption', layer), 150, [160, 272, 404][i], 1620);
        el.style.fontSize = i < 2 ? '84px' : '62px';
        return { line, words: makeWords(el, line.text, { mark: line.mark, pink: ['aloud'] }) };
    });
    const aside = place(h('div', 'abs sub', layer), 150, 590, 1500);
    aside.style.fontSize = '46px';
    const asideWords = makeWords(aside, s.aside.text);
    const tilt = [-3, 2.2, -1.6];
    const row = place(h('div', 'abs', layer), 150, 704, 1620);
    row.style.cssText += 'display:flex;gap:40px';
    const heard = s.heard.map((n, i) => {
        const el = h('div', 'sticker', row);
        el.style.cssText += 'position:relative;font-size:56px';
        el.textContent = n.text;
        return { n, el, i };
    });
    return (t, abs) => {
        for (const { line, words } of lines) words(t, line.at);
        asideWords(t, s.aside.at, { stagger: 0.03 });
        for (const { n, el, i } of heard) {
            const p = backOut(ramp(t, n.at - 0.05, n.at + 0.4));
            el.style.visibility = t >= n.at - 0.05 ? 'visible' : 'hidden';
            el.style.opacity = ramp(t, n.at - 0.05, n.at + 0.1);
            el.style.transform = `rotate(${tilt[i]}deg) scale(${0.6 + 0.4 * p})`;
            const on = clamp01(level(n.cue, abs) * 1.5);
            el.style.borderColor = `color-mix(in oklab, var(--accent) ${Math.round(on * 100)}%, var(--border-warm))`;
            el.style.color = `color-mix(in oklab, var(--yellow) ${Math.round(on * 100)}%, var(--text-primary))`;
        }
    };
};

BUILDERS.grid = (s, layer) => {
    const head = place(h('div', 'abs caption', layer), 80, 62, 1700);
    head.style.fontSize = '64px';
    const headWords = makeWords(head, s.title);
    const W = 560;
    const H = 400;
    const cards = s.cards.map((c, i) => {
        const x = 80 + (i % 3) * (W + 40);
        const y = 180 + Math.floor(i / 3) * (H + 30);
        const card = place(h('div', 'abs card', layer), x, y, W, H);
        const inner = place(h('div', 'abs', card), 30, 28, W - 60);
        h('div', 'name', inner, c.name);
        h('div', 'text', inner, c.text);
        const spec = makeSpectro(card, `grid-${c.name}`, W - 48, 176);
        place(spec, 21, H - 176 - 24);
        return { card, spec, id: `grid-${c.name}`, i, name: inner.firstChild };
    });
    return (t, abs) => {
        headWords(t, 0.05);
        for (const c of cards) {
            const p = easeOut(ramp(t, 0.1 + c.i * 0.07, 0.5 + c.i * 0.07));
            const on = playing(c.id, abs) ? clamp01(Math.min(into(c.id, abs) / 0.2, (CUE[c.id].seconds - into(c.id, abs)) / 0.3)) : 0;
            c.card.style.opacity = p;
            c.card.style.transform = `translateY(${(1 - p) * 30 - 8 * on}px)`;
            c.card.style.borderColor = `color-mix(in oklab, var(--accent) ${Math.round(on * 100)}%, var(--border-warm))`;
            c.card.style.boxShadow = on ? `0 0 ${50 * on}px rgba(231, 31, 117, ${0.35 * on})` : 'none';
            c.name.style.color = `color-mix(in oklab, var(--yellow) ${Math.round(on * 100)}%, var(--text-primary))`;
            c.spec.draw(abs);
        }
    };
};

BUILDERS.voice = (s, layer) => {
    const caps = s.lines.map((line) => {
        const el = place(h('div', 'abs caption', layer), 120, 64, 1680);
        el.style.fontSize = '60px';
        return { line, el, words: makeWords(el, line.text, { pink: ['hum:', 'harmonica'] }) };
    });
    const X = 120;
    const Y = 300;
    const W = 1680;
    const H = 560;
    const panel = place(h('div', 'abs panel', layer), X, Y, W, H);
    const canvas = place(h('canvas', 'abs', layer), X, Y);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const TOP = 2600;
    for (const f of [500, 1000, 1500, 2000, 2500]) {
        const el = place(h('div', 'abs axis', layer), X + (W * f) / TOP - 60, Y + H + 14, 120);
        el.style.textAlign = 'center';
        el.textContent = `${f} Hz`;
    }
    const vowel = place(h('div', 'abs caption', layer), X + W - 300, Y + 30, 260);
    vowel.style.cssText += 'text-align:right;font-size:110px;color:var(--yellow)';
    const which = place(h('div', 'abs chip', layer), X + 30, Y + 30);
    const legend = place(h('div', 'abs axis', layer), X + W - 730, Y + 150, 700);
    legend.style.textAlign = 'right';
    legend.innerHTML = '<span style="color:#ffb805">harmonics</span> &nbsp;·&nbsp; <span style="color:var(--accent-text)">the mouth</span>';
    const ids = s.cues.map((c) => c.id);
    const names = { 'voice-hum': 'hum', 'voice-harmonica': 'harmonica' };

    /** The mouth's vowel at frame f: 'mm' until it first opens to 'ah', then
     *  'ah' while open, 'oo' as it closes again. Read from the spectrum. */
    function vowelAt(id, f) {
        let state = 'mm';
        for (let i = 0; i <= f; i++) {
            const row = CUE[id].line[i];
            const pow = (a, b) => {
                let sum = 0;
                for (let k = a; k < b; k++) sum += 10 ** ((row[k] / 255) * 6);
                return sum;
            };
            const bal = 10 * Math.log10(pow(60, 130) / pow(25, 50));
            if (bal > 2) state = 'ah';
            else if (state === 'ah' && bal < -2) state = 'oo';
        }
        return state;
    }

    return (t, abs) => {
        caps[0].words(t, s.lines[0].at);
        arrive(caps[0].el, t, 0, s.lines[1].at, { rise: 0, dur: 0.01 });
        caps[1].words(t, s.lines[1].at);
        panel.style.opacity = canvas.style.opacity = easeOut(ramp(t, 0.1, 0.5));
        ctx.clearRect(0, 0, W, H);
        const id = ids.findLast((c) => into(c, abs) >= 0) ?? ids[0];
        which.textContent = names[id];
        const f = Math.floor(into(id, abs) * FPS);
        const row = f >= 0 ? CUE[id].line[Math.min(f, CUE[id].line.length - 1)] : null;
        if (!row) {
            vowel.textContent = '';
            return;
        }
        const n = row.length;
        const xs = (k) => (W * k) / (n - 1);
        const ys = (v) => H - 30 - (v / 255) ** 1.35 * (H - 160);
        // Harmonics: the spectrum itself.
        const fill = new Path2D();
        fill.moveTo(0, H);
        for (let k = 0; k < n; k++) fill.lineTo(xs(k), ys(row[k]));
        fill.lineTo(W, H);
        fill.closePath();
        const g = ctx.createLinearGradient(0, 40, 0, H);
        g.addColorStop(0, 'rgba(255, 244, 192, 1)');
        g.addColorStop(0.35, 'rgba(255, 184, 5, 1)');
        g.addColorStop(0.65, 'rgba(237, 115, 38, 0.9)');
        g.addColorStop(1, 'rgba(231, 31, 117, 0.3)');
        ctx.fillStyle = g;
        ctx.fill(fill);
        // The mouth: the shape the harmonics' peaks sit under.
        const peak = row.map((_, k) => {
            let m = 0;
            for (let j = Math.max(0, k - 9); j <= Math.min(n - 1, k + 9); j++) m = Math.max(m, row[j]);
            return m;
        });
        const smooth = peak.map((_, k) => {
            let sum = 0;
            let w = 0;
            for (let j = Math.max(0, k - 12); j <= Math.min(n - 1, k + 12); j++) {
                const q = Math.exp(-(((j - k) / 6) ** 2));
                sum += peak[j] * q;
                w += q;
            }
            return sum / w;
        });
        const env = new Path2D();
        smooth.forEach((v, k) => (k ? env.lineTo(xs(k), ys(v) - 10) : env.moveTo(xs(k), ys(v) - 10)));
        ctx.save();
        ctx.strokeStyle = '#f5589a';
        ctx.lineWidth = 6;
        ctx.shadowColor = 'rgba(231, 31, 117, 0.9)';
        ctx.shadowBlur = 18;
        ctx.globalAlpha = level(id, abs) > 0.05 ? 1 : level(id, abs) / 0.05;
        ctx.stroke(env);
        ctx.restore();
        vowel.textContent = playing(id, abs) && level(id, abs) > 0.25 ? vowelAt(id, f) : '';
    };
};

BUILDERS.autograph = (s, layer) => {
    const caps = s.lines.map((line) => {
        const el = place(h('div', 'abs caption', layer), 120, 54, 1680);
        el.style.fontSize = '58px';
        return { line, el, words: makeWords(el, line.text, { pink: ['aloud'] }) };
    });
    const X = 230;
    const Y = 236;
    const W = 1460;
    const H = 680;
    const panel = place(h('div', 'abs panel', layer), X, Y, W, H);
    const canvas = place(h('canvas', 'abs', layer), X, Y);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const ax = place(h('div', 'abs axis', layer), X, Y + H + 16, W);
    ax.style.textAlign = 'center';
    ax.textContent = `${s.axes.x}  →`;
    const ay = place(h('div', 'abs axis', layer), X - 40 - 340, Y + H / 2 - 18, 680);
    ay.style.cssText += 'text-align:center;transform:rotate(-90deg)';
    ay.textContent = `${s.axes.y}  →`;
    const count = place(h('div', 'abs', layer), X + W - 360, Y + 26, 330);
    count.style.cssText += 'text-align:right;font-size:92px;font-weight:800;letter-spacing:-0.03em;color:var(--yellow);line-height:1';
    const countLabel = place(h('div', 'abs axis', layer), X + W - 360, Y + 124, 330);
    countLabel.style.textAlign = 'right';
    const note = place(h('div', 'abs chip', layer), X + 30, Y + H - 96);
    const live = place(h('div', 'abs chip', layer), X + 30, Y + 30);
    live.innerHTML = `${SPEAKER}<span>the actual sound file, on an oscilloscope</span>`;
    live.style.color = 'var(--yellow)';

    const { focus, shapes } = AN.pen;
    let bx = 0;
    let by = 0;
    for (const [x, y] of shapes.at(-1)) {
        bx = Math.max(bx, Math.abs(x));
        by = Math.max(by, Math.abs(y));
    }
    const sc = 0.86 * Math.min(W / 2 / bx, H / 2 / by);
    const scope = makeScope(s.play.cue);
    const b = s.build;
    const buildEnd = b.at + b.steps.length * b.step;

    return (t, abs) => {
        caps[0].words(t, s.lines[0].at);
        arrive(caps[0].el, t, 0, s.lines[1].at, { rise: 0, dur: 0.01 });
        caps[1].words(t, s.lines[1].at);
        const vis = easeOut(ramp(t, 0.2, 0.6));
        for (const el of [panel, canvas, ax, ay]) el.style.opacity = vis;
        ctx.clearRect(0, 0, W, H);
        // The word drawn with more and more harmonics.
        const k = (t - b.at) / b.step;
        const penOn = (t >= b.at - 0.2) * (1 - ramp(t, s.play.at - 0.5, s.play.at));
        if (penOn > 0) {
            const i = Math.max(0, Math.min(b.steps.length - 1, Math.floor(k)));
            const j = Math.min(b.steps.length - 1, i + 1);
            const m = k < b.steps.length - 1 ? easeInOut(clamp01((k - i - 0.62) / 0.38)) : 0;
            const A = shapes[b.steps[i]];
            const B = shapes[b.steps[j]];
            const path = new Path2D();
            for (let p = 0; p <= A.length; p++) {
                const q = p % A.length;
                const x = W / 2 + lerp(A[q][0], B[q][0], m) * sc;
                const y = H / 2 - lerp(A[q][1], B[q][1], m) * sc;
                if (p) path.lineTo(x, y);
                else path.moveTo(x, y);
            }
            phosphor(ctx, path, penOn * easeOut(ramp(t, b.at - 0.2, b.at + 0.2)), 2.6);
            const step = b.steps[k < 0 ? 0 : i];
            const shown = focus[m > 0.5 ? b.steps[j] : step];
            count.textContent = shown;
            countLabel.textContent = shown === 1 ? 'harmonic' : 'harmonics';
            const said = s.steps[m > 0.5 ? b.steps[j] : step];
            if (said) note.textContent = said;
            const noteOn = said ? 1 : 0;
            note.style.opacity = penOn * noteOn * ramp(t, b.at - 0.1, b.at + 0.2);
            count.style.opacity = countLabel.style.opacity = penOn * ramp(t, b.at - 0.1, b.at + 0.2);
        } else {
            note.style.opacity = count.style.opacity = countLabel.style.opacity = 0;
        }
        // Then the sound itself.
        if (t >= s.play.at - 0.05) scope(ctx, abs, W / 2, H / 2, W / 2, H / 2);
        live.style.opacity = ramp(t, s.play.at, s.play.at + 0.3) * (1 - ramp(t, s.dur - 0.6, s.dur - 0.3));
        void buildEnd;
    };
};

BUILDERS.ears = (s, layer) => {
    const line = place(h('div', 'abs caption', layer), 120, 64, 1680);
    line.style.fontSize = '64px';
    const lineWords = makeWords(line, s.lines[0].text);
    const row = place(h('div', 'abs', layer), 120, 196, 1680);
    row.style.cssText += 'display:flex;gap:18px';
    const chips = s.chips.map((c) => {
        const el = h('div', 'chip', row);
        if (c.cue) el.innerHTML = `${SPEAKER}<span>${c.text}</span>`;
        else el.textContent = c.text;
        return { c, el };
    });
    const then = place(h('div', 'abs caption', layer), 120, 312, 1680);
    then.style.fontSize = '52px';
    const thenWords = makeWords(then, s.then.text, { pink: ['listener.'] });
    const tags = s.tags.map((tag, i) => {
        const el = place(h('div', 'abs card tag', layer), 120 + (i % 3) * 570, 482 + Math.floor(i / 3) * 192, 540, 172);
        h('div', 'label', el, tag.label);
        h('div', 'why', el, tag.why);
        if (tag.score) h('div', 'score', el, tag.score);
        return { tag, el, i };
    });
    const verdict = place(h('div', 'abs caption', layer), 120, 912, 1680);
    verdict.style.cssText += 'font-size:66px;color:var(--yellow)';
    const verdictWords = makeWords(verdict, s.verdict.text);
    return (t, abs) => {
        lineWords(t, s.lines[0].at);
        for (const { c, el } of chips) {
            const p = backOut(ramp(t, c.at, c.at + 0.35));
            el.style.opacity = ramp(t, c.at, c.at + 0.1);
            el.style.transform = `scale(${0.7 + 0.3 * p})`;
            if (c.cue) {
                const on = level(c.cue, abs);
                el.style.borderColor = `color-mix(in oklab, var(--accent) ${Math.round(on * 100)}%, var(--border-warm))`;
                el.style.color = `color-mix(in oklab, var(--yellow) ${Math.round(on * 100)}%, var(--text-primary))`;
            }
        }
        thenWords(t, s.then.at, { stagger: 0.035 });
        for (const { tag, el, i } of tags) {
            const p = backOut(ramp(t, tag.at, tag.at + 0.4));
            el.style.opacity = ramp(t, tag.at, tag.at + 0.12);
            el.style.transform = `rotate(${[-1.4, 1, -0.6, 1.2, -1, 0.7][i]}deg) scale(${0.75 + 0.25 * p})`;
            const on = tag.cue ? level(tag.cue, abs) : 0;
            el.style.borderColor = `color-mix(in oklab, var(--accent) ${Math.round(on * 100)}%, var(--border-warm))`;
        }
        verdictWords(t, s.verdict.at);
    };
};

BUILDERS.notes = (s, layer) => {
    const head = place(h('div', 'abs caption', layer), 120, 62, 1680);
    head.style.fontSize = '64px';
    const headWords = makeWords(head, s.title);
    const ex = s.exchanges.map((e, i) => {
        const out = s.exchanges[i + 1]?.at ?? s.dur;
        const box = place(h('div', 'abs', layer), 120, 196, 1680);
        const user = h('div', 'row user', box);
        const ub = h('div', 'bubble user', user);
        h('span', 'who', ub, PEOPLE.dev);
        const note = h('span', null, ub);
        const noteWords = makeWords(note, e.note);
        const fac = h('div', 'row facilitator', box);
        fac.style.marginTop = '26px';
        const av = h('div', 'orb avatar', fac);
        const fb = h('div', 'bubble facilitator', fac);
        h('span', 'who', fb, PEOPLE.claude);
        const [rev, ...rest] = e.reply.split(': ');
        h('span', 'rev', fb, `${rev}: `);
        h('span', null, fb, rest.join(': '));
        const top = Math.max(612, 196 + box.offsetHeight + 40);
        const media = place(h('div', 'abs', layer), 120, top, 1680, 1040 - top);
        let draw = () => {};
        if (e.before) {
            const parts = [
                ['before', e.before, 0],
                ['after', e.after, 860],
            ].map(([label, id, x]) => {
                const lab = place(h('div', 'abs media-label', media), x, 0, 820);
                lab.textContent = `${label}: ${CUE[id].src.replace(/-(open|close)$/, '')}`;
                const spec = makeSpectro(media, id, 820, 200);
                place(spec, x, 50);
                return { lab, spec, id };
            });
            draw = (abs) => {
                for (const p of parts) {
                    p.spec.draw(abs);
                    p.lab.classList.toggle('on', playing(p.id, abs));
                }
            };
        } else if (e.scope) {
            const W = 1680;
            const H = 1040 - top;
            const pan = place(h('div', 'abs panel', media), 0, 0, W, H);
            const canvas = place(h('canvas', 'abs', media), 0, 0);
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');
            const scope = makeScope(e.scope, 0.995);
            void pan;
            draw = (abs) => {
                ctx.clearRect(0, 0, W, H);
                scope(ctx, abs, W / 2, H / 2, 800, H / 2 - 6);
            };
        } else if (e.spec) {
            const lab = place(h('div', 'abs media-label', media), 0, 0, 1680);
            lab.textContent = 'handpan, open';
            const spec = makeSpectro(media, e.spec, 1680, 200);
            place(spec, 0, 50);
            draw = (abs) => {
                spec.draw(abs);
                lab.classList.toggle('on', playing(e.spec, abs));
            };
        }
        return { e, out, box, ub, fac, av, media, draw, noteWords };
    });
    return (t, abs) => {
        headWords(t, 0.05);
        for (const x of ex) {
            const on = t >= x.e.at - 0.05 && t < x.out;
            show(x.box, on);
            if (!show(x.media, on)) continue;
            const leave = ramp(t, x.out - 0.35, x.out);
            x.box.style.opacity = 1 - leave;
            x.media.style.opacity = (1 - leave) * easeOut(ramp(t, x.e.at + 0.4, x.e.at + 0.8));
            arrive(x.ub, t, x.e.at, Infinity, { rise: 26 });
            x.noteWords(t, x.e.at + 0.05, { stagger: 0.03 });
            arrive(x.fac, t, x.e.at + 1.0, Infinity, { rise: 26 });
            x.av.style.transform = `scale(${breath(t)})`;
            x.media.style.transform = `translateY(${(1 - easeOut(ramp(t, x.e.at + 0.4, x.e.at + 0.8))) * 20}px)`;
            x.draw(abs);
        }
    };
};

BUILDERS.pairs = (s, layer) => {
    const head = place(h('div', 'abs caption', layer), 120, 62, 1100);
    head.style.fontSize = '56px';
    const headWords = makeWords(head, s.title);
    const sub = place(h('div', 'abs sub', layer), 120, 136, 1100);
    sub.style.fontSize = '36px';
    const subWords = makeWords(sub, s.sub);
    const dots = place(h('div', 'abs dots', layer), 960 - (s.pairs.length * 32 - 18) / 2, 1012);
    const dotEls = s.pairs.map(() => h('i', null, dots));
    const orb = makeOrb(layer);
    const ripples = makeRipples(layer);
    const pairs = s.pairs.map((p, i) => {
        const box = h('div', 'layer', layer);
        const name = place(h('div', 'abs pair-name', box), 0, 470, 1920);
        name.style.textAlign = 'center';
        name.textContent = p.name;
        if (p.tag) {
            const pill = h('span', 'pill', name, p.tag);
            pill.style.marginLeft = '30px';
            pill.style.transform = 'translateY(-14px) rotate(-3deg)';
        }
        const text = place(h('div', 'abs sub', box), 260, 624, 1400);
        text.style.cssText += 'text-align:center;font-size:42px';
        text.textContent = p.text;
        const strips = [
            ['opening', `pair-${p.name}-open`, 200],
            ['closing', `pair-${p.name}-close`, 980],
        ].map(([label, id, x]) => {
            const lab = place(h('div', 'abs media-label', box), x, 716, 740);
            lab.textContent = label;
            const spec = makeSpectro(box, id, 740, 214);
            place(spec, x, 762);
            return { lab, spec, id };
        });
        let quote = null;
        if (p.quote) {
            quote = place(h('div', 'abs bubble user', box), 1190, 230);
            quote.style.cssText += 'font-size:38px;max-width:620px;transform-origin:0 100%';
            h('span', 'who', quote, PEOPLE.dev);
            h('span', null, quote, p.quote);
        }
        return { p, i, box, strips, quote, name };
    });
    return (t, abs) => {
        headWords(t, 0.05);
        subWords(t, 0.6, { stagger: 0.03 });
        let lvl = 0;
        const starts = [];
        for (const x of pairs) {
            const from = x.p.at;
            const to = x.p.at + x.p.dur;
            const last = x.i === pairs.length - 1;
            const vis = ramp(t, from - 0.1, from + 0.3) * (last ? 1 : 1 - ramp(t, to - 0.3, to));
            dotEls[x.i].classList.toggle('on', t >= from - 0.1 && t < to);
            if (!show(x.box, vis > 0)) continue;
            x.box.style.opacity = vis;
            x.name.style.transform = `translateY(${(1 - easeOut(ramp(t, from - 0.1, from + 0.45))) * 30}px)`;
            for (const st of x.strips) {
                st.spec.draw(abs);
                st.lab.classList.toggle('on', playing(st.id, abs));
                starts.push(CUE[st.id].at - (abs - t));
                lvl = Math.max(lvl, level(st.id, abs));
            }
            if (x.quote) {
                const q = backOut(ramp(t, from + 2.4, from + 2.9));
                x.quote.style.opacity = ramp(t, from + 2.4, from + 2.55);
                x.quote.style.transform = `rotate(-2deg) scale(${0.6 + 0.4 * q})`;
            }
        }
        orb({ x: 960, y: 330, d: 170, scale: breath(t) * (1 + 0.06 * lvl), glow: 1 + 0.8 * lvl, opacity: easeOut(ramp(t, 0, 0.5)) });
        ripples(t, starts, 960, 330, 170);
    };
};

BUILDERS.end = (s, layer) => {
    const orb = makeOrb(layer);
    const mark = h('div', 'abs wordmark', layer);
    h('span', 'under', mark, s.mark);
    h('span', 'over', mark, s.mark);
    const size = { w: mark.lastChild.offsetWidth, h: mark.lastChild.offsetHeight };
    const line = place(h('div', 'abs sub', layer), 0, 690, 1920);
    line.style.cssText += 'text-align:center;font-size:46px;color:var(--text-primary)';
    line.textContent = s.line;
    const site = place(h('div', 'abs', layer), 0, 790, 1920);
    site.style.cssText += 'text-align:center;font-size:64px;font-weight:750;letter-spacing:-0.01em;color:#ffd820';
    site.textContent = s.site;
    const close = CUT.cues.findLast((c) => c.scene === 'five');
    return (t, abs) => {
        const lvl = level(close.id, abs);
        orb({ x: 960, y: 420, d: 300, scale: breath(t) * (1 + 0.05 * lvl), glow: 1 + 0.7 * lvl, opacity: easeOut(ramp(t, 0, 0.6)) });
        const q = backOut(ramp(t, 0.25, 0.75));
        mark.style.opacity = ramp(t, 0.25, 0.4);
        mark.style.width = `${size.w}px`;
        mark.style.height = `${size.h}px`;
        mark.style.transform = `translate(${960 - size.w / 2}px, ${420 - size.h / 2}px) scale(${0.72 + 0.28 * q})`;
        arrive(line, t, 1.0);
        arrive(site, t, 1.45);
    };
};

// ---- the cut ------------------------------------------------------------------

const scenes = CUT.scenes.map((s, i) => {
    const layer = h('div', 'layer');
    const draw = BUILDERS[s.kind](s, layer);
    const first = i === 0;
    const last = i === CUT.scenes.length - 1;
    return (t) => {
        if (!show(layer, t >= s.start && t < s.end + (last ? 1 : 0))) return;
        layer.style.opacity = (first ? 1 : easeOut(ramp(t, s.start, s.start + 0.35))) * (last ? 1 : 1 - ramp(t, s.end - 0.3, s.end));
        draw(t - s.start, t);
    };
});

/** Up from black at the start, down to it at the end. */
{
    const black = h('div', 'layer');
    black.style.cssText = 'background:#000;z-index:60';
    scenes.push((t) => {
        const o = Math.max(1 - easeInOut(ramp(t, 0, 0.7)), easeInOut(ramp(t, CUT.duration - 0.8, CUT.duration)));
        if (show(black, o > 0)) black.style.opacity = o;
    });
}

// ---- driving it ---------------------------------------------------------------

function draw(t) {
    for (const scene of scenes) scene(t);
}

window.seek = async (t) => {
    draw(t);
};
window.film = { duration: CUT.duration, fps: FPS };

if (new URLSearchParams(location.search).has('preview')) {
    // Watch it against the soundtrack: space plays and pauses, the slider and
    // the arrow keys scrub.
    const audio = new Audio('../build/mix.wav');
    const hud = h('div', null, document.body);
    hud.id = 'hud';
    const slider = h('input', null, hud);
    Object.assign(slider, { type: 'range', min: 0, max: CUT.duration, step: 1 / FPS, value: 0 });
    const readout = h('span', null, hud);
    const fit = () => {
        stage.style.transform = `scale(${Math.min(innerWidth / 1920, innerHeight / 1080)})`;
    };
    addEventListener('resize', fit);
    fit();
    const tick = () => {
        const t = audio.currentTime;
        draw(t);
        slider.value = t;
        const here = CUT.scenes.find((s) => t >= s.start && t < s.end);
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
