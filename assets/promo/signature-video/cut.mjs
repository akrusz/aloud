/**
 * The signature-sound video: every word on screen and every sound under it.
 *
 * Edit freely. Scenes run back to back for `dur` seconds; times inside a scene
 * (`at`) count from the scene's start. A cue is one sound: `src` names a
 * render in ../signature-candidates (`harmonica-open`), an app sound
 * (`app:bowl`), a call-quality render (`phone:ripples4-open.8k`), noting's synth
 * chime (`chime`) or the pen's word read as a wave (`pen`). `from`/`len` trim
 * it, `gain` is dB on top of its matched level, `soft` takes the top off (the
 * autograph's buzz), and `viz` says what the picture draws from it.
 *
 * Copy is lowercase, as on the site; no em-dashes. The video is Alex's, so
 * the captions are in his voice and Claude is named in the third person.
 */

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
/** Integrated loudness of the whole mix. */
export const LUFS = -16;

/** Who the transcript bubbles say is talking. */
export const PEOPLE = { dev: 'Alex', claude: 'Claude' };

/** The autograph is harsher than the rest at the same loudness. */
const AUTOGRAPH = { soft: true, gain: -4.5 };

export const SCENES = [
    {
        id: 'cold',
        kind: 'title',
        dur: 5.4,
        title: 'a sound for aloud.',
        sub: 'made with Claude, from raw waveforms',
        soundOn: 'sound on',
        cues: [{ id: 'cold', src: 'harmonica-open', at: 0.4 }],
    },
    {
        id: 'brief',
        kind: 'brief',
        dur: 8.6,
        lines: [
            { at: 0.2, text: 'aloud had a look, the orb,' },
            { at: 1.4, text: "but it didn't sound like anything.", mark: 'sound' },
            { at: 2.6, text: 'so I asked Claude for an opening and a closing sound for every session.' },
        ],
        aside: { at: 4.0, text: 'the app already had a bowl, a bell and a chime. this needed its own sound.' },
        heard: [
            { at: 5.0, text: 'bowl', cue: 'had-bowl' },
            { at: 5.9, text: 'bell', cue: 'had-bell' },
            { at: 6.8, text: 'chime', cue: 'had-chime' },
        ],
        cues: [
            { id: 'had-bowl', src: 'app:bowl', at: 5.05, len: 1.3, fadeOut: 0.6, gain: -3 },
            { id: 'had-bell', src: 'app:rin', at: 5.95, len: 1.2, fadeOut: 0.6, gain: -5 },
            { id: 'had-chime', src: 'chime', at: 6.85, gain: 4 },
        ],
    },
    {
        id: 'round1',
        kind: 'grid',
        dur: 18.4,
        title: 'round one: six directions',
        first: 0.8,
        each: 2.8,
        cards: [
            { name: 'hum', text: "three voices humming a chord, 'mm' opening to 'ah'", src: 'hum-open' },
            { name: 'drone', text: 'lips buzzing into a tube, overtones stepping up out of it', src: 'drone-open' },
            { name: 'breath', text: 'a breath in, then a blown note rising into pitch', src: 'breath-open' },
            { name: 'ripples', text: 'three nylon strings: D, A, F sharp', src: 'ripples-open' },
            { name: 'autograph', text: 'the wild one, more on it in a moment', src: 'autograph-open', ...AUTOGRAPH },
            { name: 'bloom', text: 'hum, a dark drone and the ripples, layered', src: 'bloom-open' },
        ],
    },
    {
        id: 'voice',
        kind: 'voice',
        dur: 10.2,
        lines: [
            { at: 0.0, text: 'inside hum: a buzz of harmonics, shaped by a moving mouth' },
            { at: 4.9, text: 'the default opening keeps that mouth, with harmonica reeds in place of voices' },
        ],
        cues: [
            { id: 'voice-hum', src: 'hum-open', at: 0.4, viz: ['line'] },
            { id: 'voice-harmonica', src: 'harmonica-open', at: 5.3, viz: ['line'] },
        ],
    },
    {
        id: 'autograph',
        kind: 'autograph',
        dur: 13.4,
        lines: [
            { at: 0.0, text: 'the wild one: one cycle of its waveform is the word aloud in handwriting' },
            { at: 7.4, text: 'played, it starts as an ellipse, comes into focus, then lingers on each letter' },
        ],
        axes: { x: "left channel: the pen's x", y: "right channel: the pen's y" },
        /** Indices into the generator's FOCUS (harmonics kept), one per step. */
        build: { at: 1.4, step: 0.62, steps: [0, 1, 2, 3, 4, 5, 6, 7, 11] },
        steps: {
            0: '1 harmonic: an ellipse, the orb',
            7: '16 harmonics: legible',
            11: '96: sharp',
        },
        play: { at: 8.0, cue: 'autograph-scope' },
        cues: [
            { id: 'pen-build', src: 'pen', at: 1.4, steps: [0, 1, 2, 3, 4, 5, 6, 7, 11], stepS: 0.62, soft: true, gain: -4 },
            { id: 'autograph-scope', src: 'autograph-open', at: 8.0, viz: ['scope'], ...AUTOGRAPH },
        ],
    },
    {
        id: 'ears',
        kind: 'ears',
        dur: 13.0,
        lines: [{ at: 0.0, text: "Claude can't hear, so it checked its work by measuring:" }],
        chips: [
            { at: 1.0, text: 'spectrograms' },
            { at: 1.35, text: 'loudness' },
            { at: 1.7, text: 'mono' },
            { at: 2.05, text: 'phone-call quality', cue: 'phone' },
        ],
        then: { at: 3.8, text: 'and used an audio classifier as a stand-in listener. some of what it heard:' },
        tags: [
            { at: 5.0, label: 'Steam whistle', why: 'more breath in the voices' },
            { at: 5.8, label: 'Train whistle', why: 'a note that sags as it ends' },
            { at: 6.6, label: 'Theremin', why: 'a pitch that follows the pen' },
            { at: 7.4, label: 'Clang', why: 'a steel pan with no sympathetic ring' },
            { at: 8.2, label: 'Static', why: 'noise standing in for a wave' },
            { at: 9.0, label: 'Foghorn', why: 'a held low note that drops', cue: 'foghorn' },
        ],
        verdict: { at: 11.0, text: 'then I listened and gave notes.' },
        cues: [
            { id: 'phone', src: 'phone:ripples4-open.8k', at: 2.1, len: 2.6, fadeOut: 0.8, gain: -2 },
            { id: 'foghorn', src: 'drone3-close', at: 9.0, len: 3.7, fadeOut: 1.2 },
        ],
    },
    {
        id: 'notes',
        kind: 'notes',
        dur: 23.4,
        title: 'five more rounds of notes and revisions',
        exchanges: [
            {
                at: 0.3,
                note: 'I want the wood to sing. Is it possible to bring in a little bit of cello energy?',
                reply: 'drone2: a cello-sized wooden body, and a modeled bowed string',
                before: 'notes-drone',
                after: 'notes-drone2',
            },
            {
                at: 6.3,
                note: 'if the second part sounded more like an ocean wave, that could be really cool',
                reply: 'autograph5: the word written in sand, with a wave washing over it',
                scope: 'notes-autograph5',
            },
            {
                at: 11.8,
                note: 'slightly reminds me of when someone loses on a game show',
                reply: 'drone7: no more falling pitch at the end',
                before: 'notes-drone3',
                after: 'notes-drone7',
            },
            {
                at: 17.7,
                note: "my friend asked me why I didn't have any based on handpans",
                reply: 'handpan: modeled on measurements of two real handpans',
                spec: 'notes-handpan',
            },
        ],
        cues: [
            { id: 'notes-drone', src: 'drone-open', at: 1.1, len: 2.6, fadeOut: 0.6, viz: ['spec'] },
            { id: 'notes-drone2', src: 'drone2-open', at: 3.6, len: 2.7, fadeOut: 0.8, viz: ['spec'] },
            { id: 'notes-autograph5', src: 'autograph5-open', at: 7.3, viz: ['scope'], ...AUTOGRAPH },
            { id: 'notes-drone3', src: 'drone3-close', at: 12.5, from: 0.9, len: 2.3, fadeIn: 0.15, fadeOut: 0.7, viz: ['spec'] },
            { id: 'notes-drone7', src: 'drone7-close', at: 14.7, len: 2.9, fadeOut: 1.0, viz: ['spec'] },
            { id: 'notes-handpan', src: 'handpan-open', at: 18.7, viz: ['spec'] },
        ],
    },
    {
        id: 'five',
        kind: 'pairs',
        dur: 38.8,
        title: 'five made it into the app',
        sub: 'pick one in Settings → Look and Feel',
        pairs: [
            { at: 0.6, dur: 7.3, name: 'marimba', text: 'a marimba, rolled with soft mallets', open: 'marimba-open', close: 'marimba-close' },
            { at: 7.9, dur: 7.3, name: 'drone', text: 'a low reed drone, and a bowed string climbing out of it', open: 'drone7-open', close: 'drone7-close' },
            { at: 15.2, dur: 7.3, name: 'ripples', text: 'three nylon strings over a bowed low D', open: 'ripples4-open', close: 'ripples4-close' },
            { at: 22.5, dur: 7.3, name: 'handpan', text: 'a hand-played steel pan', open: 'handpan8-open', close: 'handpan9-close' },
            {
                at: 29.8,
                dur: 9.0,
                name: 'bloom',
                tag: 'the default',
                text: 'harmonica reeds to open, a hummed chord to close',
                open: 'harmonica-open',
                close: 'bloom8-close',
                quote: 'my heart loves harmonica-bloom8',
                closeAt: 5.0,
                full: true,
            },
        ],
    },
    {
        id: 'end',
        kind: 'end',
        dur: 6.0,
        mark: 'aloud.',
        line: 'in the app now: Settings → Look and Feel',
        site: 'aloud.rest',
    },
];

/** Scene start times, and every cue on the one clock. */
export function layout() {
    let t = 0;
    const scenes = SCENES.map((s) => {
        const start = t;
        t += s.dur;
        return { ...s, start, end: t };
    });
    const cues = [];
    for (const s of scenes) {
        for (const c of s.cues ?? []) cues.push({ ...c, at: s.start + c.at, scene: s.id });
        if (s.kind === 'grid') {
            s.cards.forEach((card, i) => {
                const { name, text, src, ...rest } = card;
                cues.push({ id: `grid-${name}`, src, at: s.start + s.first + i * s.each, len: s.each, fadeOut: 0.8, viz: ['spec'], ...rest, scene: s.id });
            });
        }
        if (s.kind === 'pairs') {
            for (const p of s.pairs) {
                const closeAt = p.closeAt ?? 3.6;
                cues.push({ id: `pair-${p.name}-open`, src: p.open, at: s.start + p.at + 0.4, len: p.full ? 0 : closeAt + 0.6, fadeOut: p.full ? 0 : 0.7, viz: ['spec'], scene: s.id });
                cues.push({ id: `pair-${p.name}-close`, src: p.close, at: s.start + p.at + closeAt, len: p.full ? 0 : p.dur - closeAt, fadeOut: p.full ? 0 : 1.3, viz: ['spec'], scene: s.id });
            }
        }
    }
    return { scenes, cues, duration: t, fps: FPS, width: WIDTH, height: HEIGHT, lufs: LUFS };
}
