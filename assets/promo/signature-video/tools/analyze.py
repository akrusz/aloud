#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "scipy"]
# ///
"""The signature-sound video's soundtrack, and what the picture draws from it.

Reads build/cues.json (written by build.mjs from cut.mjs) and writes:
  build/mix.wav            48 kHz stereo 24-bit, the whole soundtrack
  build/analysis.json      per cue: spectrogram columns, level, line spectra;
                           and the pen's word at each step of focus
  build/scope/<cue>.f32    a cue's stereo samples as played (interleaved
                           float32, 48 kHz), for the XY scope

Every visual comes from the sound that plays under it: a cue's spectrogram is
of that cue after its fades, so a picture can't run ahead of its sound.

    uv run --with numpy --with scipy python tools/analyze.py   (build.mjs runs it)
"""
import json
import os
import subprocess
import sys

import numpy as np
from scipy.signal import butter, sosfiltfilt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
BUILD = os.path.join(ROOT, 'build')
CANDIDATES = os.path.normpath(os.path.join(ROOT, '..', 'signature-candidates'))
APP_AUDIO = os.path.normpath(os.path.join(ROOT, '..', '..', '..', 'ts', 'ui', 'public', 'audio'))
SR = 48000

sys.path.insert(0, CANDIDATES)
import synth_signature as synth  # noqa: E402  (the generator: its PEN, FOCUS and pen_cycle)

MEASURED = json.load(open(os.path.join(CANDIDATES, 'audition', 'measured.json')))


def db(x):
    return 10 ** (x / 20)


def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)


def source(name):
    """A sound by name at its level: a candidate at the level its mp3 was
    matched to (-20 LUFS on its loudest 0.7s), an app sound as shipped."""
    if name.startswith('app:'):
        return decode(os.path.join(APP_AUDIO, name[4:] + '.mp3'))
    if name.startswith('phone:'):  # already at its mp3's level
        return decode(os.path.join(CANDIDATES, 'phone', name[6:] + '.wav'))
    if name == 'chime':
        return decode(os.path.join(CANDIDATES, 'audition', 'chime.wav'))
    return decode(os.path.join(CANDIDATES, name + '.wav')) * db(MEASURED[name]['gainDb'])


def pen_tone(steps, step_s, at_f0=synth.D3):
    """The pen's word read as a wave at one focus after another, step_s each:
    the drawing sharpening, heard. Tables are unit RMS per axis."""
    tables, _ = synth.pen_cycle()
    n = int(SR * step_s * len(steps))
    t = np.arange(n) / SR
    cents = 5 * np.sin(2 * np.pi * 0.7 * t)
    turn = np.cumsum(at_f0 * 2 ** (cents / 1200)) / SR % 1.0
    m = tables.shape[1]
    idx = (turn * m).astype(int) % m
    # Which step each sample is in, with a short crossfade into the next.
    pos = t / step_s
    lo = np.minimum(pos.astype(int), len(steps) - 1)
    hi = np.minimum(lo + 1, len(steps) - 1)
    mix = np.clip((pos - lo - 0.9) / 0.1, 0, 1)[:, None]
    a = tables[np.array(steps)[lo], idx]
    b = tables[np.array(steps)[hi], idx]
    out = a * (1 - mix) + b * mix
    edge = np.minimum(1, np.minimum(t / 0.08, (t[-1] - t) / 0.3))
    return out * edge[:, None] * 0.06


def soften(x):
    """The autograph's buzz, taken down where it is harshest."""
    return sosfiltfilt(butter(2, 4200, 'low', fs=SR, output='sos'), x, axis=0)


def fade(n, fade_in, fade_out):
    g = np.ones(n)
    i, o = int(SR * fade_in), int(SR * fade_out)
    if i:
        g[:i] = np.sin(np.linspace(0, np.pi / 2, i)) ** 2
    if o:
        g[n - o:] *= np.cos(np.linspace(0, np.pi / 2, o)) ** 2
    return g


def render_cue(cue):
    if cue['src'] == 'pen':
        x = pen_tone(cue['steps'], cue['stepS'])
    else:
        x = source(cue['src'])
    start = int(SR * cue.get('from', 0))
    x = x[start:]
    if cue.get('len'):
        x = x[:int(SR * cue['len'])]
    if cue.get('soft'):
        x = soften(x)
    x = x * fade(len(x), cue.get('fadeIn', 0.0), cue.get('fadeOut', 0.0))[:, None]
    return x * db(cue.get('gain', 0.0))


# ---- what the picture reads ---------------------------------------------------

SPEC_BINS = 96
SPEC_LO, SPEC_HI = 45.0, 9000.0
SPEC_RANGE = 66.0  # dB shown below a cue's loudest point
EDGES = np.geomspace(SPEC_LO, SPEC_HI, SPEC_BINS + 1)


def frames_of(x, fps, nper):
    """Hann-windowed mono frames centred on each video frame."""
    mono = x.mean(axis=1)
    count = int(np.ceil(len(mono) / SR * fps))
    pad = np.concatenate([np.zeros(nper), mono, np.zeros(nper)])
    win = np.hanning(nper)
    centres = (np.arange(count) / fps * SR).astype(int) + nper
    return np.stack([pad[c - nper // 2:c + nper // 2] * win for c in centres])


def spectrogram(x, fps):
    """Columns of SPEC_BINS log-spaced bands, 0-255, one per video frame."""
    nper = 4096
    spec = np.abs(np.fft.rfft(frames_of(x, fps, nper), axis=1)) ** 2
    freqs = np.fft.rfftfreq(nper, 1 / SR)
    centre = np.sqrt(EDGES[:-1] * EDGES[1:])
    out = np.zeros((len(spec), SPEC_BINS))
    for b in range(SPEC_BINS):
        sel = (freqs >= EDGES[b]) & (freqs < EDGES[b + 1])
        # Low bands are narrower than an FFT bin: read them off the curve.
        out[:, b] = spec[:, sel].mean(axis=1) if sel.sum() >= 2 else \
            np.array([np.interp(centre[b], freqs, row) for row in spec])
    lev = 10 * np.log10(out + 1e-14)
    lev = np.clip((lev - (lev.max() - SPEC_RANGE)) / SPEC_RANGE, 0, 1)
    return np.round(lev * 255).astype(int).tolist()


def line_spectrum(x, fps, top=2600.0, bins=260):
    """A linear spectrum to `top` Hz per frame, 0-255 over 60 dB: harmonics
    stand apart here as they don't on a log axis."""
    nper = 8192
    spec = np.abs(np.fft.rfft(frames_of(x, fps, nper), axis=1))
    freqs = np.fft.rfftfreq(nper, 1 / SR)
    grid = np.linspace(0, top, bins)
    lev = 20 * np.log10(np.stack([np.interp(grid, freqs, row) for row in spec]) + 1e-9)
    lev = np.clip((lev - (lev.max() - 60)) / 60, 0, 1)
    return np.round(lev * 255).astype(int).tolist()


def envelope(x, fps):
    """Level per frame, 0-1 over 48 dB under the cue's loudest frame."""
    mono = x.mean(axis=1)
    hop = SR // fps
    count = int(np.ceil(len(mono) / hop))
    rms = np.array([np.sqrt(np.mean(mono[i * hop:(i + 1) * hop] ** 2) + 1e-12) for i in range(count)])
    lev = 20 * np.log10(rms)
    return np.round(np.clip((lev - lev.max() + 48) / 48, 0, 1), 3).tolist()


def pen_shapes(points=720):
    """The word at every step of FOCUS, as (x, y) lists, scaled to a box."""
    tables, _ = synth.pen_cycle()
    pick = np.linspace(0, tables.shape[1], points, endpoint=False).astype(int)
    shapes = tables[:, pick]
    return {'focus': list(synth.FOCUS),
            'shapes': [[[round(float(x), 4), round(float(y), 4)] for x, y in s] for s in shapes]}


def loudness(path):
    out = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    summary = out[out.rfind('Summary:'):]
    lufs = float(summary.split('I:')[1].split('LUFS')[0])
    peak = float(summary.split('Peak:')[1].split('dBFS')[0])
    return lufs, peak


def main():
    spec = json.load(open(os.path.join(BUILD, 'cues.json')))
    fps, total = spec['fps'], spec['duration']
    os.makedirs(os.path.join(BUILD, 'scope'), exist_ok=True)
    mix = np.zeros((int(SR * total) + SR, 2))
    analysis = {'cues': {}, 'pen': pen_shapes()}
    for cue in spec['cues']:
        x = render_cue(cue)
        at = int(round(SR * cue['at']))
        end = min(len(mix), at + len(x))
        mix[at:end] += x[:end - at]
        viz = cue.get('viz', [])
        entry = {'at': cue['at'], 'seconds': len(x) / SR, 'env': envelope(x, fps)}
        if 'spec' in viz:
            entry['spec'] = spectrogram(x, fps)
        if 'line' in viz:
            entry['line'] = line_spectrum(x, fps)
        if 'scope' in viz:
            (x / np.abs(x).max()).astype('<f4').tofile(os.path.join(BUILD, 'scope', cue['id'] + '.f32'))
        analysis['cues'][cue['id']] = entry
        print(f"  {cue['id']:<16} {cue['src']:<18} at {cue['at']:6.2f}s  {len(x) / SR:5.2f}s")
    mix = mix[:int(SR * total)]

    # Level the whole: integrated loudness to the target, peaks held under
    # the ceiling by ffmpeg's limiter (a strike's transient is the only thing
    # it should ever touch).
    raw = os.path.join(BUILD, 'mix-raw.wav')
    out = os.path.join(BUILD, 'mix.wav')
    from scipy.io import wavfile
    wavfile.write(raw, SR, mix.astype(np.float32))
    lufs, _ = loudness(raw)
    gain = spec.get('lufs', -16.0) - lufs
    for _ in range(3):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-af',
                        f'volume={gain:.2f}dB,alimiter=limit=0.84:attack=3:release=60:level=disabled',
                        '-c:a', 'pcm_s24le', out], check=True)
        got, peak = loudness(out)
        if abs(got - spec.get('lufs', -16.0)) < 0.3:
            break
        gain += spec.get('lufs', -16.0) - got
    os.remove(raw)
    json.dump(analysis, open(os.path.join(BUILD, 'analysis.json'), 'w'), separators=(',', ':'))
    print(f'mix: {got:.1f} LUFS integrated, peak {peak:.1f} dBFS ({gain:+.1f} dB on the sum)')


if __name__ == '__main__':
    main()
