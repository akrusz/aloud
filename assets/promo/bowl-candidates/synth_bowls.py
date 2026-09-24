#!/usr/bin/env python3
"""Synthesize singing-bowl / rin candidates for aloud.

Model per voice: a set of inharmonic partials, each a *pair* of slightly
detuned sinusoids (the pair's beat is the bowl's slow "wah"), each partial
with its own exponential decay (higher = faster), a soft mallet transient,
per-channel beat phase for subtle stereo, and a short synthetic room.

Writes <name>.wav (48 kHz, 24-bit, stereo, peak -1 dBFS) and <name>.mp3
(44.1 kHz stereo 128k, level-matched to the app's old bell.mp3 strike),
plus spectrograms/<name>.png.

    python3 synth_bowls.py            # render everything
    python3 synth_bowls.py rin-bright-short   # just one

Needs numpy + scipy + ffmpeg on PATH.
"""
import os
import subprocess
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))

# The mp3s are gained so their first 0.7 s (the strike) measures this, which
# sits them with the other noting sounds (card, poof, rattle peak near 0 dBFS
# at about -20 LUFS). The old bell.mp3 was -40.7, which is why it read as weak.
MP3_MATCH_LUFS = -20.0
MP3_MATCH_WINDOW = 0.7
WAV_PEAK_DBFS = -1.0
STEREO_SPREAD = 0.45  # radians of beat-phase offset per channel

# partials: (ratio, rel. amplitude, T60 seconds, beat Hz)
# Ratios follow measured Himalayan bowls (~1 : 2.7 : 5.0-5.2 : 8.2 : 11.8).
# Upper modes kept strong on purpose: a near-dominant low fundamental reads
# as an electronic sine.
DEEP_BOWL = [
    (1.000, 1.00, 15.0, 0.42),
    (2.705, 0.78, 9.5, 0.95),
    (5.040, 0.36, 5.0, 1.7),
    (8.210, 0.15, 2.8, 2.6),
    (11.87, 0.06, 1.6, 3.3),
    (16.02, 0.025, 0.9, 4.1),
    (20.61, 0.012, 0.5, 5.0),
]
# Organic extras for render(): only voices that pass them get them, so the
# other voices render exactly as before.
ORGANIC = dict(
    fast_decay=0.35,   # share of each partial in a quicker first-stage decay
    drift=0.06,        # Hz of slow random frequency wander per partial
    wobble=0.05,       # depth of slow random amplitude wander
    grain=0.012,       # level of noise ringing at each partial (metal texture)
    rt60=2.4,          # a larger room than the default 1.6 s
)
MID_BOWL = [
    (1.000, 1.00, 12.0, 0.8),
    (2.740, 0.50, 7.0, 1.4),
    (5.120, 0.20, 3.6, 2.2),
    (8.300, 0.08, 1.9, 3.0),
    (12.10, 0.03, 1.0, 3.8),
]
# Rin: small, thick-walled, bright; upper partials carry more of the sound.
RIN = [
    (1.000, 1.00, 14.0, 1.2),
    (2.760, 0.65, 8.0, 2.1),
    (5.300, 0.30, 2.8, 3.0),
    (8.600, 0.12, 1.4, 4.2),
]

CANDIDATES = {
    # name: (f0, partials, total seconds, decay scale, mallet hardness 0..1,
    #        damp-out start s or None, room wet[, organic extras])
    'bowl-deep-long':    (164.0, DEEP_BOWL, 10.0, 1.0, 0.25, None, 0.28, ORGANIC),
    'bowl-mid-medium':   (311.0, MID_BOWL, 5.0, 0.55, 0.40, 3.0, 0.20),
    'rin-long':          (1046.0, RIN, 7.0, 1.0, 0.70, None, 0.22),
    'rin-short':         (1046.0, RIN, 2.0, 0.30, 0.70, 1.1, 0.18),
}


def db(x):
    return 10 ** (x / 20)


def mallet(n, hardness, rng):
    """Felt-to-wood mallet contact: a few ms of low-passed noise."""
    dur = int(SR * (0.012 - 0.007 * hardness))
    noise = rng.standard_normal(dur)
    env = np.sin(np.linspace(0, np.pi, dur)) ** 2
    cutoff = 1200 + 5000 * hardness
    burst = sosfilt(butter(2, [250, cutoff], 'band', fs=SR, output='sos'), noise * env)
    out = np.zeros(n)
    out[:dur] = burst / (np.abs(burst).max() + 1e-12)
    return out


def slow_noise(n, rng, hz=0.3):
    """Smooth zero-mean random wander, unit RMS, varying on a ~1/hz timescale."""
    step = int(SR / hz / 4)
    pts = rng.standard_normal(n // step + 3)
    x = np.interp(np.arange(n) / step, np.arange(len(pts)), pts)
    x = sosfilt(butter(1, hz, 'low', fs=SR, output='sos'), x)
    return (x - x.mean()) / (x.std() + 1e-12)


def room_ir(rt60=1.6, seed=7):
    """Stereo exponentially-decaying noise IR, darkened: a small calm room."""
    rng = np.random.default_rng(seed)
    n = int(SR * rt60 * 1.2)
    t = np.arange(n) / SR
    env = np.exp(-6.91 * t / rt60)
    pre = int(SR * 0.012)
    ir = rng.standard_normal((n, 2)) * env[:, None]
    ir[:pre] = 0
    ir = sosfilt(butter(2, 4500, 'low', fs=SR, output='sos'), ir, axis=0)
    return ir / np.sqrt((ir ** 2).sum(axis=0))


def render(f0, partials, seconds, decay_scale, hardness, damp_at, wet, organic=None, seed=1):
    rng = np.random.default_rng(seed)
    org_rng = np.random.default_rng(seed + 100)  # separate stream: extras must not shift other voices' randomness
    n = int(SR * seconds)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    attack = 1 - np.exp(-t / 0.0025)  # ~2.5 ms rise, no click

    for i, (ratio, amp, t60, beat) in enumerate(partials):
        f = f0 * ratio
        if f > SR / 2 * 0.9:
            continue
        # Harder mallets excite upper partials more strongly.
        amp = amp * (1 + hardness * 1.5 * i / len(partials))
        decay = np.exp(-6.91 * t / (t60 * decay_scale))
        if organic:
            k = organic['fast_decay']
            decay = (1 - k) * decay + k * np.exp(-6.91 * t / (t60 * decay_scale * 0.25))
            decay = decay * (1 + organic['wobble'] * slow_noise(n, org_rng))
            # Wander in Hz, integrated to phase, so pitch drifts rather than jumps.
            wander = 2 * np.pi * np.cumsum(organic['drift'] * slow_noise(n, org_rng, 0.2)) / SR
        else:
            wander = 0
        # The two members of the degenerate mode pair, unequal so beating is
        # partial, not full, amplitude modulation.
        split = rng.uniform(0.55, 0.75)
        ph1, ph2 = rng.uniform(0, 2 * np.pi, 2)
        fa = f - beat / 2
        fb = f + beat / 2
        for ch, spread in enumerate((-STEREO_SPREAD, STEREO_SPREAD)):
            # Stereo: the ears hear the pair with slightly different relative
            # phase, so the "wah" peaks a little earlier on one side.
            s = (split * np.sin(2 * np.pi * fa * t + ph1 + wander)
                 + (1 - split) * np.sin(2 * np.pi * fb * t + ph2 + spread + wander))
            out[:, ch] += amp * decay * s
        if organic and organic['grain']:
            # Noise rung through a narrow band at the partial: the slightly
            # rough, textured part of a real metal ring.
            bw = max(4.0, f * 0.004)
            sos = butter(2, [f - bw, f + bw], 'band', fs=SR, output='sos')
            for ch in range(2):
                g = sosfilt(sos, org_rng.standard_normal(n))
                g /= np.abs(g).max() + 1e-12
                out[:, ch] += organic['grain'] * amp * decay * g * 8

    out *= attack[:, None]
    m = mallet(n, hardness, rng)
    # Colour the transient through the bowl's lower partials (bandpass sum),
    # plus a little raw contact noise.
    thock = np.zeros(n)
    for ratio, *_ in partials[:3]:
        fc = f0 * ratio
        sos = butter(2, [fc * 0.8, min(fc * 1.25, SR / 2 * 0.95)], 'band', fs=SR, output='sos')
        thock += sosfilt(sos, m)
    thock = 0.5 * thock / (np.abs(thock).max() + 1e-12) + 0.18 * (0.3 + hardness) * m
    out += thock[:, None] * np.abs(out).max() * 0.35

    if damp_at is not None:
        # A hand settling on the rim: smooth extra decay after damp_at.
        d = np.clip((t - damp_at) / (seconds - damp_at), 0, 1)
        out *= (0.5 * (1 + np.cos(np.pi * d)))[:, None]
    else:
        tail = int(SR * 0.4)
        out[-tail:] *= np.linspace(1, 0, tail)[:, None] ** 2

    ir = room_ir(organic['rt60']) if organic else room_ir()
    wet_sig = np.stack([fftconvolve(out[:, c], ir[:, c])[:n] for c in range(2)], axis=1)
    mix = (1 - wet) * out + wet * wet_sig * 2.0
    fade = int(SR * 0.05)
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return mix


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def integrated_lufs(path, seconds=None):
    cmd = ['ffmpeg', '-hide_banner', '-nostats', '-i', path]
    if seconds:
        cmd += ['-t', str(seconds)]
    cmd += ['-af', 'ebur128', '-f', 'null', '-']
    err = subprocess.run(cmd, capture_output=True, text=True).stderr
    line = [l for l in err.splitlines() if l.strip().startswith('I:')][-1]
    return float(line.split()[1])


def write(name, sig):
    sig = sig / np.abs(sig).max() * db(WAV_PEAK_DBFS)
    wav = os.path.join(HERE, name + '.wav')
    tmp = os.path.join(HERE, name + '.tmp.wav')
    wavfile.write(tmp, SR, sig.astype(np.float32))
    run(['ffmpeg', '-y', '-i', tmp, '-c:a', 'pcm_s24le', wav])
    os.remove(tmp)

    gain = MP3_MATCH_LUFS - integrated_lufs(wav, MP3_MATCH_WINDOW)
    mp3 = os.path.join(HERE, name + '.mp3')
    run(['ffmpeg', '-y', '-i', wav, '-af', f'volume={gain:.2f}dB',
         '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', mp3])

    png = os.path.join(HERE, 'spectrograms', name + '.png')
    run(['ffmpeg', '-y', '-i', wav, '-lavfi',
         'showspectrumpic=s=1200x600:mode=combined:scale=log:fscale=log:legend=1:stop=16000',
         png])
    print(f'{name}: mp3 gain {gain:+.1f} dB')


def main():
    os.makedirs(os.path.join(HERE, 'spectrograms'), exist_ok=True)
    names = sys.argv[1:] or list(CANDIDATES)
    for name in names:
        write(name, render(*CANDIDATES[name]))


if __name__ == '__main__':
    main()
