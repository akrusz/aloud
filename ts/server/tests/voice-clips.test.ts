import { describe, it, expect } from 'vitest';
import {
    GATE,
    analyzePcm,
    clipFaults,
    secondsPerCharNorm,
    phraseCount,
    spokenChars,
} from '../scripts/voice-clips/analysis.js';
import {
    clipFile,
    clipHash,
    emptyManifest,
    orphanFiles,
    planClips,
    pruneManifest,
    serializeManifest,
    type ClipManifest,
    type HouseVoice,
} from '../scripts/voice-clips/plan.js';

const RATE = 24_000;

/** Concatenated segments: silence, or a 220Hz sine at a peak amplitude with
 *  an optional linear fade-in. */
type Seg = { silence: number } | { tone: number; amp: number; rampMs?: number };

function pcm(...segs: Seg[]): Float32Array {
    const chunks: number[] = [];
    for (const seg of segs) {
        if ('silence' in seg) {
            for (let i = 0; i < seg.silence * RATE; i++) chunks.push(0);
            continue;
        }
        const ramp = ((seg.rampMs ?? 0) / 1000) * RATE;
        for (let i = 0; i < seg.tone * RATE; i++) {
            const gain = ramp > 0 ? Math.min(1, i / ramp) : 1;
            chunks.push(seg.amp * gain * Math.sin((2 * Math.PI * 220 * i) / RATE));
        }
    }
    return Float32Array.from(chunks);
}

// Every test clip starts with the route's 200ms lead silence.
const LEAD = { silence: 0.2 };
const WORD = { tone: 0.8, amp: 0.3, rampMs: 40 };

describe('clip analysis', () => {
    it('counts one burst for one utterance and measures its voiced span', () => {
        const a = analyzePcm(pcm(LEAD, WORD, { silence: 0.3 }), RATE);
        expect(a.bursts).toHaveLength(1);
        expect(a.gapsS).toEqual([]);
        expect(a.voicedS).toBeCloseTo(0.8, 1);
        expect(clipFaults(a, 'Body focus is on.')).toEqual([]);
    });

    it('flags a short line voiced twice: two bursts across a ~1.5s gap', () => {
        const a = analyzePcm(pcm(LEAD, WORD, { silence: 1.5 }, WORD, { silence: 0.3 }), RATE);
        expect(a.bursts).toHaveLength(2);
        expect(a.gapsS[0]).toBeCloseTo(1.5, 1);
        expect(clipFaults(a, 'Body focus is on.').join()).toMatch(/2 bursts for 1 phrase/);
    });

    it('lets each sentence end or comma pause as long as a repeat gap', () => {
        const a = analyzePcm(pcm(LEAD, WORD, { silence: 0.9 }, WORD), RATE);
        expect(a.bursts).toHaveLength(2);
        expect(clipFaults(a, "Hi, I'm Harper. This is how I sound.")).toEqual([]);
        expect(clipFaults(a, 'Okay, noting mode.')).toEqual([]);
        const three = analyzePcm(pcm(LEAD, WORD, { silence: 0.9 }, WORD, { silence: 1.5 }, WORD), RATE);
        expect(clipFaults(three, 'Okay, noting mode.').join()).toMatch(/3 bursts for 2 phrases/);
    });

    it('bridges pauses shorter than the gap, and ignores clicks', () => {
        const click = { tone: 0.02, amp: 0.3 };
        const a = analyzePcm(pcm(LEAD, WORD, { silence: 0.4 }, WORD, { silence: 1 }, click, { silence: 1 }), RATE);
        expect(a.bursts).toHaveLength(1);
        expect(a.voicedS).toBeCloseTo(2.0, 1);
    });

    it('treats a noise floor under -40 dBFS as silence', () => {
        const hiss = { tone: 2, amp: 0.005 }; // about -49 dBFS RMS
        const a = analyzePcm(pcm(LEAD, hiss), RATE);
        expect(a.bursts).toEqual([]);
        expect(clipFaults(a, 'Okay, noting mode.')).toEqual(['no voice above the floor']);
    });

    it('reads a hard start as a 0ms onset: a cut first word', () => {
        const a = analyzePcm(pcm(LEAD, { tone: 0.8, amp: 0.5 }), RATE);
        expect(a.onsetRiseMs).toBe(0);
        expect(clipFaults(a, 'Okay, noting mode.').join()).toMatch(/cut first word/);
    });

    it('reads a ramped start as a clean onset', () => {
        // Linear to 0.5 over 60ms: -40 dBFS near 2ms in, -20 near 17ms.
        const a = analyzePcm(pcm(LEAD, { tone: 0.8, amp: 0.5, rampMs: 60 }), RATE);
        expect(a.onsetRiseMs).toBeGreaterThanOrEqual(GATE.minRiseMs);
        expect(a.onsetRiseMs).toBeGreaterThanOrEqual(10);
        expect(a.onsetRiseMs).toBeLessThanOrEqual(20);
        expect(clipFaults(a, 'Okay, noting mode.')).toEqual([]);
    });

    it('measures the onset of the voice, not of a stray click before it', () => {
        const a = analyzePcm(
            pcm({ silence: 0.1 }, { tone: 0.005, amp: 0.3 }, { silence: 0.8 }, { tone: 0.8, amp: 0.5, rampMs: 60 }),
            RATE
        );
        expect(a.onsetRiseMs).toBeGreaterThanOrEqual(10);
    });

    it('calls an onset that never reaches -20 dBFS soft, not cut', () => {
        const a = analyzePcm(pcm(LEAD, { tone: 0.8, amp: 0.05 }), RATE);
        expect(a.bursts).toHaveLength(1);
        expect(a.onsetRiseMs).toBeNull();
        expect(clipFaults(a, 'Okay, noting mode.')).toEqual([]);
    });

    it('counts phrases and spoken characters in both languages', () => {
        expect(phraseCount('Body focus is on.')).toBe(1);
        expect(phraseCount('Okay, noting mode.')).toBe(2);
        expect(phraseCount("Hi, I'm Harper. This is how I sound.")).toBe(3);
        expect(phraseCount('This is how I sound. ')).toBe(1);
        expect(phraseCount('Try saying: twenty minutes.')).toBe(2);
        expect(phraseCount('就这些。准备好了，就说“开始”。')).toBe(3);
        expect(phraseCount('计时五分钟。')).toBe(1);
        expect(phraseCount('no terminator')).toBe(1);
        expect(spokenChars('Okay, noting mode.')).toBe(14);
        expect(spokenChars('好的，标记模式。')).toBe(6);
    });

    it('flags a clip far longer than its voice norm, once the set is big enough', () => {
        const set = Array.from({ length: GATE.minNormClips }, () => ({ voicedS: 1.4, text: 'Okay, noting mode.' }));
        expect(secondsPerCharNorm(set.slice(1))).toBeNull();
        const norm = secondsPerCharNorm([...set, { voicedS: 9, text: 'Okay, noting mode.' }])!;
        expect(norm).toBeCloseTo(0.1, 3);

        const one = (voicedS: number) => ({
            durationS: voicedS + 0.5,
            bursts: [{ startS: 0.2, endS: 0.2 + voicedS }],
            gapsS: [],
            voicedS,
            onsetRiseMs: 20,
        });
        expect(clipFaults(one(1.5), 'Okay, noting mode.', norm)).toEqual([]);
        expect(clipFaults(one(3.5), 'Okay, noting mode.', norm).join()).toMatch(/expected at this voice's pace/);
    });
});

describe('clip plan', () => {
    const harper: HouseVoice = {
        name: 'Harper',
        language: 'en',
        gender: 'female',
        providerVoiceId: 'en-US-Harper:MAI-Voice-2.1-Flash',
        style: 'softvoice',
    };
    const text = (_v: HouseVoice, id: string) => `Line ${id}.`;

    it('names a clip by voice, language, line and a hash of what shapes the audio', () => {
        expect(clipFile(harper, 'mode-noting', 'Okay, noting mode.')).toMatch(/^harper\/en\/mode-noting\.[0-9a-f]{8}\.mp3$/);
        const h = clipHash('Okay, noting mode.', harper.providerVoiceId, 'softvoice');
        expect(clipHash('Okay, noting mode.', harper.providerVoiceId, 'softvoice')).toBe(h);
        expect(clipHash('Okay, noting mode!', harper.providerVoiceId, 'softvoice')).not.toBe(h);
        expect(clipHash('Okay, noting mode.', harper.providerVoiceId, undefined)).not.toBe(h);
        expect(clipHash('Okay, noting mode.', 'en-US-Harper:MAI-Voice-2-Flash', 'softvoice')).not.toBe(h);
    });

    it('renders only what is missing or stale', () => {
        const manifest: ClipManifest = {
            voices: {
                Harper: {
                    language: 'en',
                    gender: 'female',
                    fixedPace: true,
                    clips: {
                        a: { file: clipFile(harper, 'a', 'Line a.'), text: 'Line a.' },
                        b: { file: clipFile(harper, 'b', 'Old b.'), text: 'Old b.' },
                        c: { file: clipFile(harper, 'c', 'Line c.'), text: 'Line c.' },
                        d: { file: clipFile({ ...harper, style: 'whisper' }, 'd', 'Line d.'), text: 'Line d.' },
                    },
                },
            },
        };
        const present = new Set([clipFile(harper, 'a', 'Line a.'), clipFile(harper, 'b', 'Old b.')]);
        const plan = planClips([harper], ['a', 'b', 'c', 'd', 'e'], text, manifest, (f) => present.has(f));
        expect(plan.map((t) => [t.lineId, t.status, t.why])).toEqual([
            ['a', 'current', undefined],
            ['b', 'stale', 'text changed'],
            ['c', 'missing', 'file missing'],
            ['d', 'stale', 'voice id or style changed'],
            ['e', 'missing', 'not rendered'],
        ]);
    });

    it('prunes removed lines and voices, and finds the files nothing names', () => {
        const manifest: ClipManifest = {
            voices: {
                Harper: {
                    language: 'en',
                    gender: 'male',
                    fixedPace: false,
                    clips: {
                        a: { file: 'harper/en/a.11111111.mp3', text: 'Line a.' },
                        gone: { file: 'harper/en/gone.22222222.mp3', text: 'Gone.' },
                    },
                },
                Mira: { language: 'en', gender: 'female', fixedPace: false, clips: {} },
            },
        };
        const { manifest: out, removed } = pruneManifest(manifest, [harper], ['a']);
        expect(Object.keys(out.voices)).toEqual(['Harper']);
        expect(out.voices['Harper']).toMatchObject({ gender: 'female', fixedPace: true });
        expect(Object.keys(out.voices['Harper']!.clips)).toEqual(['a']);
        expect(removed).toEqual(['Harper/gone (line removed)', 'Mira (no longer a house voice)']);
        expect(
            orphanFiles(out, ['harper/en/a.11111111.mp3', 'harper/en/gone.22222222.mp3', 'harper/en/a.33333333.mp3'])
        ).toEqual(['harper/en/gone.22222222.mp3', 'harper/en/a.33333333.mp3']);
    });

    it('serializes with keys sorted all the way down', () => {
        const json = serializeManifest({
            voices: {
                Yunfan: { language: 'zh', gender: 'male', fixedPace: false, clips: { b: { text: 'B', file: 'b' }, a: { text: 'A', file: 'a' } } },
                Ethan: { language: 'en', gender: 'male', fixedPace: true, clips: {} },
            },
        });
        expect(json.indexOf('"Ethan"')).toBeLessThan(json.indexOf('"Yunfan"'));
        expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"b"'));
        expect(json.indexOf('"clips"')).toBeLessThan(json.indexOf('"language"'));
        expect(json.indexOf('"file"')).toBeLessThan(json.indexOf('"text"'));
        expect(serializeManifest(emptyManifest())).toBe('{\n    "voices": {}\n}\n');
    });
});
