#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "scipy"]
# ///
"""Synthesize signature-sound candidates for aloud: one opening and one
closing per direction, for the frame of a session and of the promo video.

Same toolchain and formats as ../bowl-candidates/synth_bowls.py. The sources
of the first four rounds are a voice (harmonics of a jittering pitch through
a moving vocal tract, plus breath through the same tract), a breath-driven
reed, blown air, a thumbed string and a bowed one, and none is a struck
object: every pitch drifts, every level wobbles, and the timbre moves while
the sound lasts. Round 5 adds one that is struck, by hand: a steel pan.

Writes, per sound:
  <name>-<open|close>.wav     48 kHz, 24-bit, stereo, peak -1 dBFS
  <name>-<open|close>.mp3     44.1 kHz stereo 128k, loudest 0.7 s at -20 LUFS
  spectrograms/<...>.png
  phone/<...>.16k.wav, .8k.wav   mono, band-limited to call quality
  audition/<name>-open-into-voice.mp3   the opening under the facilitator's line
  audition/autograph-<open|close>-scope.mp4   that pair's left channel drawn against its right
and audition-data.js, which audition.html reads.

    python3 synth_signature.py            # render everything
    python3 synth_signature.py hum drone  # just those directions

Needs numpy + scipy + ffmpeg on PATH (`uv run synth_signature.py` works too).
"""
import json
import os
import subprocess
import sys

import numpy as np
from scipy.interpolate import CubicSpline, PchipInterpolator
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, istft, lfilter, resample_poly, sosfilt, sosfiltfilt, stft

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))

# Same level as the bowls and the other noting sounds. Those are strikes, so
# their loudest 0.7 s is their first 0.7 s; a swell peaks later, so here it is
# whichever 0.7 s is loudest.
MP3_MATCH_LUFS = -20.0
MP3_MATCH_WINDOW = 0.7
WAV_PEAK_DBFS = -1.0

# The facilitator line an opening leads into (local, gitignored), levelled as
# the video levels it, and where it comes in. The opening is turned down under
# it by OPEN_UNDER_VOICE_DB; audition.html has sliders for both.
VOICE = os.path.join(HERE, '..', 'play-video', 'build', 'audition', 'harper', 'f0-settle-take2.mp3')
VOICE_LUFS = -19.0
VOICE_AT = 2.5
OPEN_UNDER_VOICE_DB = -6.0

HOP = 64  # samples between control points of a moving tract
BOW_TRIM = 1.1  # samples of lag in a bowed string's loop besides its delay lines; tunes bow() (measured)

D2, A2, D3, FS3, A3, D4, E4, FS4, A4, D5, E5 = (73.42, 110.0, 146.83, 185.0, 220.0, 293.66, 329.63, 369.99, 440.0,
                                                587.33, 659.26)

# Formants (centre Hz, bandwidth Hz, peak dB) for an average adult tract; a
# voice scales the centres. 'm' is a closed mouth. The peaks are levels of the
# tract alone (the cords add their own -6 dB/octave), set so a vowel's upper
# formants sit about 20 dB under its first, as they do in a recorded voice. A
# plain cascade of five resonators leaves them 15-20 dB lower than that, which
# is most of what makes a synthetic vowel sound like a filtered buzz.
TRACT = {
    'm': [(260, 70, 0), (1000, 250, -10), (2200, 220, -8.5), (3000, 260, -9), (3900, 350, -14.5)],
    'a': [(710, 110, 0), (1120, 120, -1), (2500, 170, -11), (3350, 220, -12.5), (4300, 300, -20)],
    'oo': [(380, 80, 0), (900, 100, -2.5), (2300, 170, -16.5), (3200, 220, -17.5), (4100, 300, -23)],
}
HUM_DB = -6.0  # a closed mouth lets less out


def db(x):
    return 10 ** (x / 20)


def curve(t, pts):
    """Smooth interpolation through (seconds, value) points, without overshoot."""
    x, y = np.array(pts, float).T
    return PchipInterpolator(x, y)(np.clip(t, x[0], x[-1]))


def wander(n, rng, lo, hi):
    """Unit-RMS random motion between lo and hi Hz: drift, flutter, jitter."""
    f = np.fft.rfftfreq(n, 1 / SR)
    keep = (f > 0) / np.sqrt(1 + (lo / np.maximum(f, 1e-9)) ** 4) / np.sqrt(1 + (f / hi) ** 4)
    x = np.fft.irfft(np.fft.rfft(rng.standard_normal(n)) * keep, n)
    return x / (x.std() + 1e-12)


def tract_gain(f, centres, widths):
    """Complex gain at f of two-pole resonators in cascade: a tube with formants."""
    s = 1j * f
    g = 1.0
    for c, w in zip(centres, widths):
        p = -w / 2 + 1j * c
        g = g * (c ** 2 + w ** 2 / 4) / ((s - p) * (s - np.conj(p)))
    return g


def voiced(phase, f0, shape, tilt=1.0, fmax=9000.0):
    """Harmonics of a pitch, each weighted by shape(k, Hz) as its frequency
    moves. shape returns a complex gain per control point (every HOP samples),
    so a harmonic sliding over a formant swells and turns in phase as it does
    in a throat."""
    n = len(f0)
    at = np.arange(0, n, HOP)
    idx = np.arange(n)
    f0c = f0[at]
    out = np.zeros(n)
    for k in range(1, int(fmax / f0c.min()) + 1):
        fk = k * f0c
        g = shape(k, fk) * k ** -tilt * np.clip((fmax - fk) / (0.15 * fmax), 0, 1)
        if np.abs(g).max() < 1e-6:
            continue
        out += np.interp(idx, at, np.abs(g)) * np.sin(k * phase + np.interp(idx, at, np.unwrap(np.angle(g))))
    return out


def shaped(x, gain_tf, nper=1024):
    """x through a moving magnitude response gain_tf(Hz column, seconds row)."""
    f, tt, z = stft(x, SR, nperseg=nper, noverlap=nper * 3 // 4)
    y = istft(z * gain_tf(f[:, None], tt[None, :]), SR, nperseg=nper, noverlap=nper * 3 // 4)[1]
    return np.pad(y, (0, max(0, len(x) - len(y))))[:len(x)]


def pan(x, where):
    """Mono to stereo, equal power; where is -1 (left) to 1 (right)."""
    a = (where + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], axis=1)


def room(sig, rt_low, rt_high, wet, seed=7):
    """A room whose highs die sooner than its lows, with a few first walls."""
    rng = np.random.default_rng(seed)
    n = int(SR * rt_low * 1.25)
    out = sig.copy()
    for c in range(2):
        f, tt, z = stft(rng.standard_normal(n), SR, nperseg=512, noverlap=384)
        rt = rt_high + (rt_low - rt_high) / (1 + (f / 1200) ** 2)
        z = z * np.exp(-6.91 * tt[None, :] / rt[:, None]) * (f / (f + 150))[:, None]
        tail = istft(z, SR, nperseg=512, noverlap=384)[1][:n]
        tail *= np.clip(np.arange(n) / (SR * 0.03), 0, 1) ** 2  # the diffuse field takes a moment to build
        tail /= np.sqrt((tail ** 2).sum())
        for _ in range(6):
            tail[int(SR * rng.uniform(0.009, 0.05))] += rng.choice([-1, 1]) * rng.uniform(0.1, 0.24)
        out[:, c] += wet * fftconvolve(sig[:, c], tail)[:len(sig)]
    return out


def finish(sig):
    sig = sosfilt(butter(2, 28, 'high', fs=SR, output='sos'), sig, axis=0)
    fade = int(SR * 0.15)
    sig[-fade:] *= np.cos(np.linspace(0, np.pi / 2, fade))[:, None] ** 2
    return sig


# ITU-R BS.1770 K-weighting at 48 kHz.
K_SOS = np.array([
    [1.53512485958697, -2.69169618940638, 1.19839281085285, 1.0, -1.69065929318241, 0.73248077421585],
    [1.0, -2.0, 1.0, 1.0, -1.99004745483398, 0.99007225036621],
])


def loudest(sig, seconds=MP3_MATCH_WINDOW):
    """(LUFS, start sample) of the loudest window of a stereo signal."""
    p = (sosfilt(K_SOS, sig, axis=0) ** 2).sum(axis=1)
    w = min(int(seconds * SR), len(p))
    c = np.concatenate([[0], np.cumsum(p)])
    win = (c[w:] - c[:-w]) / w
    i = int(np.argmax(win))
    return -0.691 + 10 * np.log10(win[i] + 1e-20), i


def at_level(sig, lufs):
    """A layer scaled so its loudest window sits at lufs: layers of unlike
    kinds are then balanced by loudness, not by whatever units they came in."""
    return sig * db(lufs - loudest(sig)[0])


# ---- sources ----

def sing(seed, base, cents, mouth, rounding, level, vt=1.0, breath=0.06, shut_db=0.0, blur=1.0, press=1.0):
    """One untrained voice. cents is its pitch about base Hz; mouth runs 0
    (closed, a hum) to 1 (open); rounding 0 ('ah') to 1 ('oo'); level 0..1 is
    loudness and, with it, how hard the voice is pressed. All per sample.
    shut_db turns the upper formants down further while the mouth is closed:
    a hum that reads as 'mm' and not 'oo'. blur widens every formant, which
    makes whatever the mouth is saying less of a vowel. press under 1 is a
    voice held back: softer cords, so fewer upper harmonics at any loudness."""
    rng = np.random.default_rng(seed)
    n = len(cents)
    cents = cents + 12 * wander(n, rng, 0.05, 0.8) + 5 * wander(n, rng, 2, 9)
    f0 = base * 2 ** (cents / 1200) * (1 + 0.004 * wander(n, rng, 30, base / 2))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    at = np.arange(0, n, HOP)
    o, r, e = mouth[at], rounding[at], (press * level[at]) ** 0.5
    move = [1 + 0.03 * wander(n, rng, 0.4, 4)[at] for _ in TRACT['m']]  # a jaw and tongue are never quite still

    def tract(f, o, r, move):
        g = 0
        for i, ((mc, mw, ml), (ac, aw, al), (uc, uw, ul)) in enumerate(zip(TRACT['m'], TRACT['a'], TRACT['oo'])):
            centre = vt * move[i] * mc ** (1 - o) * (ac ** (1 - r) * uc ** r) ** o
            width = blur * mw ** (1 - o) * (aw ** (1 - r) * uw ** r) ** o
            peak = db(ml * (1 - o) + (al * (1 - r) + ul * r) * o + (shut_db * (1 - o) if i else 0.0))
            # Signs alternate so neighbours add between their peaks, as the
            # poles of one tube do, and don't cancel into a false notch.
            g = g + (-1) ** i * peak * (width / 2) / (width / 2 + 1j * (f - centre))
        return g * db(HUM_DB * (1 - o))

    def shape(k, fk):
        # A soft voice's harmonics fall away sooner than a pressed one's, and
        # the cords stay open for more of each cycle, which moves the dips in
        # the source's spectrum: the harmonics never sit in a tidy 1/k row.
        dips = 0.45 + 0.55 * np.abs(np.sin(np.pi * k * (0.72 - 0.2 * e)))
        return tract(fk, o, r, move) * dips / np.sqrt(1 + (fk / (1500 * (6000 / 1500) ** e)) ** 2)

    tone = voiced(phase, f0, shape) * (1 + 0.04 * wander(n, rng, 0.5, 25))

    def air_gain(f, tt):
        i = np.minimum((tt * SR / HOP).astype(int), len(at) - 1)
        return np.abs(tract(f, o[i], r[i], [m[i] for m in move])) * f / (f + 600)

    # Breath leaks through the same throat, pulsing with the cords.
    air = shaped(rng.standard_normal(n) * (1 + 0.6 * np.sin(phase)), air_gain)
    air *= breath * np.sqrt((tone ** 2).mean() / ((air ** 2).mean() + 1e-20))
    return tone * level + air * level ** 0.6  # a soft voice is more air than tone


def reed(seed, base, cents, over, level, breath=0.035, side=0.0, width=55.0, peak=6.0, bell=1.8, top=3200.0):
    """Lips buzzing into a tube, with a mouth behind them. over is the
    harmonic number the mouth is tuned to: as it moves, one overtone after
    another stands out of the drone. peak and width are how far and how
    narrowly it stands out, bell is the tube's buzz near 1.7 kHz, and top is
    how far up a full breath pushes the harmonics."""
    rng = np.random.default_rng(seed)
    n = len(cents)
    cents = cents + 6 * wander(n, rng, 0.05, 0.6) + 3 * wander(n, rng, 3, 7)
    f0 = base * 2 ** (cents / 1200) * (1 + 0.0025 * wander(n, rng, 20, 60))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    at = np.arange(0, n, HOP)
    f0c, e = f0[at], level[at] ** 0.5
    mouth = over[at] * f0c
    hollow = (1.0, 0.5, 0.95, 0.55, 0.8)  # the tube favours odd harmonics down low

    def tract(f, mouth):
        # One sharp resonance where the mouth is tuned, and the broad one near
        # 1.7 kHz that gives such a tube its buzz. side nudges the broad one:
        # a slightly different instrument for each ear, in the same phase.
        tuned = 1 + peak / (1 + 1j * (f - mouth) / (width / 2))
        return tuned * (1 + bell / (1 + ((f - 1700 * (1 + side)) / 450) ** 2))

    def shape(k, fk):
        # The lips shut for a share of each cycle that grows with the breath
        # behind them, so the balance of the harmonics shifts as it swells.
        dips = 0.25 + 0.75 * np.abs(np.sin(np.pi * k * (0.36 + 0.08 * e)))
        g = tract(fk, mouth) * dips / np.sqrt(1 + (fk / (500 * (top / 500) ** e)) ** 2)
        return g * (hollow[k - 1] if k <= len(hollow) else 1.0)

    tone = voiced(phase, f0, shape, fmax=7000.0)
    tone *= 1 + 0.06 * wander(n, rng, 4, 7) + 0.03 * wander(n, rng, 15, 30)

    def air_gain(f, tt):
        i = np.minimum((tt * SR / HOP).astype(int), len(at) - 1)
        return np.abs(tract(f, mouth[i])) * f / (f + 200) / (1 + (f / 3000) ** 2)

    air = shaped(rng.standard_normal(n) * (1 + 0.5 * np.sin(phase)), air_gain)
    air *= breath * np.sqrt((tone ** 2).mean() / ((air ** 2).mean() + 1e-20))
    return tone * level + air * level ** 0.6  # a soft breath is more air than buzz


def air(seed, n, amount, centres, widths, dark):
    """Breath alone: turbulence through an open throat. centres is a list of
    per-sample formant tracks; dark is the per-sample Hz above which the hiss
    falls away."""
    rng = np.random.default_rng(seed)
    at = np.arange(0, n, HOP)
    cs = [c[at] for c in centres]
    d = dark[at]

    def gain(f, tt):
        i = np.minimum((tt * SR / HOP).astype(int), len(at) - 1)
        g = np.abs(tract_gain(f, [c[i] for c in cs], widths))
        return g * (f / (f + 350)) / (1 + (f / d[i]) ** 2)

    x = shaped(rng.standard_normal(n), gain)
    x *= 1 + 0.25 * wander(n, rng, 1, 8)
    return x / (np.sqrt((x ** 2).mean()) + 1e-12) * amount


def blown(seed, base, cents, level):
    """A note blown, not struck: a stopped pipe's odd partials over a strong
    fundamental, leaning sharp as the breath presses, a slow shake once it has
    settled, and the hiss of the breath, most of it in the first moment."""
    rng = np.random.default_rng(seed)
    n = len(cents)
    t = np.arange(n) / SR
    shake = 14 * np.clip((t - 0.5) / 0.6, 0, 1) * np.sin(
        2 * np.pi * np.cumsum(5.0 * (1 + 0.08 * wander(n, rng, 0.3, 2))) / SR)
    cents = cents + 6 * wander(n, rng, 0.1, 1.0) + 3 * wander(n, rng, 3, 10) + 14 * (level - 0.6) + shake
    f = base * 2 ** (cents / 1200)
    phase = 2 * np.pi * np.cumsum(f) / SR
    # Upper partials need more breath than the fundamental: they arrive later and leave sooner.
    tone = sum(a * level ** (0.4 * i) * np.sin((i + 1) * phase + 1.3 * i)
               for i, a in enumerate((1, 0.03, 0.18, 0.01, 0.06)))
    tone = tone * (1 + 0.08 * wander(n, rng, 4, 30))
    at = np.arange(0, n, HOP)
    fc = f[at]

    def near(hz, tt):
        i = np.minimum((tt * SR / HOP).astype(int), len(at) - 1)
        return sum(w / np.sqrt(1 + ((hz - mult * fc[i]) / (40 * mult)) ** 2)
                   for mult, w in ((1, 1.0), (2, 0.6), (3, 0.5), (4, 0.3)))

    edge = shaped(rng.standard_normal(n), near)
    edge *= np.sqrt((tone ** 2).mean() / ((edge ** 2).mean() + 1e-20))
    chiff = np.exp(-np.maximum(t - t[np.argmax(level > 0.02)], 0) / 0.06)
    return tone * level + edge * level ** 0.5 * (0.1 + 0.5 * chiff) * np.minimum(level * 8, 1)


def wood_ir(seed=61, seconds=0.5):
    """What a cello-sized wooden body rings like when its bridge is tapped:
    the few low resonances every such box has, then a thicket of them."""
    rng = np.random.default_rng(seed)
    modes = [(98, 9, 0.7), (186, 10, 1.0), (224, 12, 0.6), (282, 14, 0.8), (415, 20, 0.9), (520, 24, 0.9),
             (640, 28, 0.7)]
    f = 700.0
    while f < 6000:
        f *= rng.uniform(1.03, 1.08)
        hill = 1 + 0.8 * np.exp(-(np.log2(f / 2300) / 0.55) ** 2)  # the bridge's own broad resonance
        gain = rng.uniform(0.35, 1.0) * 0.55 * hill / (1 + (f / 4200) ** 3)
        modes.append((f, f / rng.uniform(22, 40), gain))
    t = np.arange(int(SR * seconds)) / SR
    ir = np.zeros(len(t))
    for centre, width, gain in modes:
        thin = (centre / 140) ** 2 / (1 + (centre / 140) ** 2)  # a box this size hardly radiates below its air resonance
        ir += gain * thin * width * np.exp(-np.pi * width * t) * np.sin(2 * np.pi * centre * t + rng.uniform(0, 2 * np.pi))
    return ir / np.sqrt((ir ** 2).sum())


def in_wood(x, direct=0.25, mellow=None):
    """x heard through the wooden body, with a little of it bare. mellow is
    a ceiling in Hz put on x first: a bow kept over the fingerboard."""
    if mellow:
        x = sosfilt(butter(2, mellow, 'low', fs=SR, output='sos'), x)
    return direct * x + fftconvolve(x, wood_ir())[:len(x)]


def bow(seed, base, cents, level, shake=11.0, press=0.75, beta=0.127):
    """A bowed string, modelled where the other sources are drawn: the bow
    drags the string along until it slips, the kink runs to the bridge and
    to the nut and back, and the bow catches it again (McIntyre, Schumacher
    and Woodhouse's model, in the form the Synthesis ToolKit uses). The
    stick and slip are never quite regular, which is the grain of the sound.
    level is the bow's speed; shake is cents of vibrato once the note has
    settled. Below D3 the bridge's damping is scaled to the string's length:
    with the damping of a short string a long one turns rough. Down there a
    lighter press (0.6) holds the note better."""
    rng = np.random.default_rng(seed)
    n = len(cents)
    t = np.arange(n) / SR
    settled = np.clip((t - t[np.argmax(level > 0.02)] - 0.5) / 0.6, 0, 1)
    rate = 5.2 * (1 + 0.06 * wander(n, rng, 0.3, 2))
    cents = (cents + shake * settled * np.sin(2 * np.pi * np.cumsum(rate) / SR)
             + 4 * wander(n, rng, 0.05, 0.8) + 2 * wander(n, rng, 2, 9))
    pole, lag = 0.75 - 0.2 * 22050.0 / SR, BOW_TRIM
    if base < D3:
        pole = pole ** (base / D3)  # the same damping per trip of the kink, not per second
        lag = 0.85 * pole / (1 - pole) - 0.53  # measured, as BOW_TRIM was
    loop = (SR / (base * 2 ** (cents / 1200)) - lag).tolist()  # samples round the string, less the filter's lag
    speed = (0.12 * level * (1 + 0.04 * rng.standard_normal(n))).tolist()  # rosin is not smooth
    slope = 5.0 - 4.0 * press
    size = int(max(loop)) + 8
    neck, bridge = [0.0] * size, [0.0] * size
    b0 = 0.95 * (1 - pole)
    damped = 0.0
    out = [0.0] * n
    for i in range(n):
        p = i - loop[i] * (1 - beta)
        k = int(p // 1)
        from_nut = neck[k % size] + (p - k) * (neck[(k + 1) % size] - neck[k % size])
        p = i - loop[i] * beta
        k = int(p // 1)
        from_bridge = bridge[k % size] + (p - k) * (bridge[(k + 1) % size] - bridge[k % size])
        damped = b0 * from_bridge + pole * damped  # the bridge end gives a little, more at the top
        slip = speed[i] + damped + from_nut  # the bow's speed against the string's
        grip = (abs(slip * slope) + 0.75) ** -4
        pushed = slip * min(grip, 1.0)
        neck[i % size] = pushed - damped
        bridge[i % size] = pushed - from_nut
        out[i] = from_bridge
    return np.array(out)


def body_ir(rng):
    """A small wooden soundbox: a few short resonances."""
    tt = np.arange(int(SR * 0.25)) / SR
    ir = np.zeros(len(tt))
    for f, g, t60 in ((98, 1.0, 0.20), (204, 0.9, 0.16), (290, 0.45, 0.11), (415, 0.5, 0.09),
                      (560, 0.35, 0.07), (730, 0.25, 0.06), (980, 0.2, 0.05)):
        ir += g * np.exp(-6.91 * tt / t60) * np.sin(2 * np.pi * f * tt + rng.uniform(0, np.pi))
    return ir / np.sqrt((ir ** 2).sum())


def pluck(seed, n, f0, at, gain=1.0, pos=0.27, soft=1900.0, ring=1.4, ease=0.003, thumb=0.5):
    """A nylon string let go by the pad of a thumb at `at` seconds, on a
    small wooden body. soft is how far up the thumb lets the string speak;
    ease is how long it takes to let go and thumb how much of its own
    touch is heard."""
    rng = np.random.default_rng(seed)
    i0 = int(at * SR)
    tt = np.arange(n - i0) / SR
    # Tension: a plucked string starts a few cents sharp and settles.
    base = 2 * np.pi * np.cumsum(f0 * 2 ** (5 * np.exp(-tt / 0.07) / 1200)) / SR
    y = np.zeros(len(tt))
    for k in range(1, int(7000 / f0) + 1):
        stiff = np.sqrt(1 + 5e-5 * k * k)
        fk = k * f0 * stiff
        a = np.sin(np.pi * k * pos) / k * np.exp(-fk / soft)
        t60 = ring * 4.0 / (1 + (fk / 650) ** 1.25)
        # The string swings in two planes that disagree slightly, so the note
        # dies in two stages and shimmers a little.
        for detune, share, quick in ((1 - 2e-4, 0.62, 1.0), (1 + 3e-4, 0.38, 0.55)):
            y += a * share * np.exp(-6.91 * tt / (t60 * quick)) * np.sin(k * stiff * detune * base + rng.uniform(0, 0.4))
    y *= 1 - np.exp(-tt / ease)
    touch = np.zeros(len(tt))
    m = int(SR * 0.012)
    touch[:m] = sosfilt(butter(2, [110, 700], 'band', fs=SR, output='sos'),
                        rng.standard_normal(m) * np.sin(np.linspace(0, np.pi, m)) ** 2)
    y += thumb * np.abs(y).max() * touch / (np.abs(touch).max() + 1e-12)
    y = y + 0.6 * fftconvolve(y, body_ir(rng))[:len(y)]
    out = np.zeros(n)
    out[i0:] = gain * y / (np.abs(y).max() + 1e-12)
    return out


# ---- directions ----
# Each returns its layers dry (stereo, no room), so `bloom` can stack them.

# seed, tract scale, pickup Hz, home Hz, rest Hz, entry s, pan, gain, breath
# Kept high and light: with a bass on D3 under it the same chord read as a
# chant (see the README's note on the tagger).
HUM_VOICES = (
    (11, 1.04, FS3, A3, A3, 0.00, -0.20, 0.85, 0.06),
    (12, 1.15, A3, D4, D4, 0.05, 0.30, 0.80, 0.08),
    (13, 1.20, D4, FS4, D4, 0.03, -0.05, 0.75, 0.08),
)
HUM_SHAKE = 14.0  # cents of vibrato once a held note has settled


def hum_parts(kind, seconds, voices=None, brisk=False, soft=False, pace=1.0):
    """What each voice of the hum does, as (voice, cents, mouth, rounding,
    level, settled) per voice: the score, whoever sings it. seconds is the
    length at pace 1; a pace under 1 takes that much longer over it."""
    t = np.arange(int(SR * seconds / pace)) / SR * pace
    for voice in voices or HUM_VOICES:
        seed, vt, pickup, home, rest, late, where, gain, breath = voice
        if kind == 'open' and brisk:
            step = 1200 * np.log2(pickup / home)
            g = 0.16 + late
            cents = curve(t, [(0, step - 60), (0.07 + late, step), (g, step), (g + 0.12, 10), (g + 0.3, 0),
                              (seconds - 1.0, 0), (seconds, -30)])
            mouth = curve(t, [(0, 0), (g - 0.02, 0), (g + 0.1, 1), (0.85, 1), (1.5, 0.3), (2.0, 0), (seconds, 0)])
            rounding = curve(t, [(0, 0), (0.8, 0), (1.5, 0.6), (seconds, 0.6)])
            rise = [(late + 0.13, 0.26), (g + 0.04, 0.55), (g + 0.24, 1)] if soft else \
                [(late + 0.07, 0.45), (g, 0.55), (g + 0.2, 1)]
            level = curve(t, [(0, 0), (late + 0.001, 0), *rise, (0.8, 0.85),
                              (1.4, 0.4), (2.0, 0.17), (2.7, 0.05), (seconds, 0)])
        elif kind == 'open':
            step = 1200 * np.log2(pickup / home)
            g = 0.40 + late  # the mouth opens as the pitch arrives
            cents = curve(t, [(0, step - 70), (0.11 + late, step), (g, step), (g + 0.14, 12), (g + 0.34, 0),
                              (seconds - 1.2, 0), (seconds, -30)])
            mouth = curve(t, [(0, 0), (g, 0), (g + 0.11, 1), (1.2, 1), (2.0, 0.3), (2.7, 0), (seconds, 0)])
            rounding = curve(t, [(0, 0), (1.1, 0), (2.0, 0.6), (seconds, 0.6)])
            level = curve(t, [(0, 0), (late + 0.001, 0), (late + 0.1, 0.5), (g, 0.55), (g + 0.24, 1), (1.15, 0.8),
                              (2.0, 0.34), (2.8, 0.15), (3.7, 0.05), (seconds, 0)])
        else:
            step = 1200 * np.log2(rest / home)
            g = 0.95 + late
            cents = curve(t, [(0, -45), (0.12 + late, 0), (g, 0), (g + 0.32, step), (seconds - 1.5, step),
                              (seconds, step - 40)])
            mouth = curve(t, [(0, 0.6), (0.16, 1), (0.8, 1), (g + 0.5, 0.25), (g + 1.0, 0), (seconds, 0)])
            rounding = curve(t, [(0, 0), (0.7, 0), (1.5, 0.6), (seconds, 0.6)])
            level = curve(t, [(0, 0), (late + 0.001, 0), (late + 0.22, 0.85), (0.8, 0.8), (1.5, 0.5), (2.4, 0.28),
                              (3.6, 0.13), (5.0, 0.04), (seconds, 0)])
        yield voice, cents, mouth, rounding, level, np.clip((t - g - 0.45) / 0.5, 0, 1)


def hum_dry(kind, seconds, voices=None, brisk=False, shut_db=0.0, blur=1.0, shake=None, soft=False, pace=1.0,
            airy=1.0, press=1.0):
    """Three people humming a chord together and letting it open: 'mm' into
    'ah', every voice stepping up as the mouths open. The close is the same
    breath backwards: 'ah' sinking into 'mm', the top voice coming down.
    brisk makes the opening's hum a grace note and the whole of it shorter;
    soft gives that opening about twice as long to arrive. blur smears the
    vowel and shake is the vibrato in cents (HUM_SHAKE unless given): less
    of either sounds less like people singing. airy multiplies every voice's
    breath, and press under 1 holds the voices back."""
    n = int(SR * seconds / pace)
    clock = np.arange(n) / SR
    depth = HUM_SHAKE if shake is None else shake
    out = np.zeros((n, 2))
    for voice, cents, mouth, rounding, level, settled in hum_parts(kind, seconds, voices, brisk, soft, pace):
        seed, vt, pickup, home, rest, late, where, gain, breath = voice
        cents = cents + depth * settled * np.sin(2 * np.pi * (4.7 + 0.13 * (seed % 5)) * clock + seed)
        out += pan(gain * sing(seed, home, cents, mouth, rounding, level, vt, breath * airy, shut_db, blur, press),
                   where)
    return out


def hum(kind):
    return room(hum_dry(kind, 4.6 if kind == 'open' else 6.4), 0.7, 0.35, 0.16)


def drone_dry(kind, seconds, plain=False, brisk=False, pace=1.0):
    """A low breath-driven drone, the family of a didgeridoo or a jaw harp,
    with three overtones stepping out of it: up to open, down to close.
    plain keeps the mouth dark and still (the body under `bloom`); brisk is
    a shorter opening, with no steps, to go under a brisk hum. A pace under
    1 takes that much longer over the same shape."""
    n = int(SR * seconds / pace)
    t = np.arange(n) / SR * pace
    if kind == 'open' and brisk:
        over = np.full(n, 4.5)
        level = curve(t, [(0, 0), (0.25, 0.8), (0.9, 1.0), (1.5, 0.6), (2.2, 0.2), (2.9, 0.04), (seconds, 0)])
        cents = curve(t, [(0, -55), (0.2, 0), (seconds - 1.0, 0), (seconds, -40)])
    elif kind == 'open':
        over = curve(t, [(0, 5.2), (0.35, 6), (0.62, 6.1), (0.80, 8), (1.10, 8), (1.26, 9), (1.56, 9), (1.72, 10),
                         (2.3, 10), (3.2, 7), (seconds, 5)])
        level = curve(t, [(0, 0), (0.06, 0.1), (0.30, 0.8), (0.8, 0.9), (1.8, 1.0), (2.4, 0.7), (3.2, 0.3),
                          (4.0, 0.1), (seconds, 0)])
        cents = curve(t, [(0, -55), (0.22, 0), (seconds - 1.4, 0), (seconds, -45)])
    else:
        over = curve(t, [(0, 9), (0.3, 10), (0.9, 10), (1.1, 9), (1.6, 9), (1.8, 8), (2.5, 8), (3.4, 6),
                         (seconds, 4.5)])
        level = curve(t, [(0, 0), (0.35, 0.85), (1.0, 0.9), (2.4, 0.7), (3.6, 0.35), (5.0, 0.1), (seconds, 0)])
        cents = curve(t, [(0, -40), (0.25, 0), (2.6, 0), (seconds, -70)])
    if plain:
        over = np.full(n, 4.5)
    return np.stack([reed(21, D2, cents, over, level, side=s) for s in (-0.03, 0.03)], axis=1)


def drone(kind):
    return room(drone_dry(kind, 4.8 if kind == 'open' else 6.6), 1.3, 0.5, 0.2)


def breath_dry(kind, seconds):
    """Air that becomes a note. Open: a breath in, then a blown tone that
    rises into pitch. Close: the tone sags as the breath runs out and is let
    go in a long breath out."""
    n = int(SR * seconds)
    t = np.arange(n) / SR
    widths = [250, 300, 350, 450]
    if kind == 'open':
        lift = curve(t, [(0, 0), (0.95, 1), (seconds, 1)])
        breath_in = curve(t, [(0, 0), (0.15, 0.12), (0.55, 0.5), (0.82, 1.0), (0.93, 0.7), (1.0, 0), (seconds, 0)])
        tone = curve(t, [(0, 0), (1.02, 0), (1.32, 0.9), (1.7, 1.0), (2.3, 0.7), (3.1, 0.25), (3.8, 0.05),
                         (seconds, 0)])
        cents = curve(t, [(0, -60), (1.0, -60), (1.2, 0), (1.7, 6), (3.0, -4), (seconds, -30)])
        breath_out = 0.3 * curve(t, [(0, 0), (1.0, 0), (1.3, 1.0), (2.0, 0.8), (3.0, 0.3), (3.9, 0.05), (seconds, 0)])
        sink = curve(t, [(0, 0), (1.0, 0), (seconds, 1)])
    else:
        lift = np.zeros(n)
        breath_in = np.zeros(n)
        tone = curve(t, [(0, 0), (0.3, 0.9), (0.9, 1.0), (1.6, 0.6), (2.3, 0.15), (2.9, 0), (seconds, 0)])
        cents = curve(t, [(0, -35), (0.25, 0), (1.0, -5), (2.9, -40), (seconds, -40)])
        breath_out = curve(t, [(0, 0), (0.5, 0.25), (1.6, 0.7), (2.2, 1.0), (3.0, 0.75), (4.4, 0.3), (5.6, 0.05),
                               (seconds, 0)])
        sink = curve(t, [(0, 0), (1.6, 0.1), (seconds, 1)])
    note = blown(31, D5, cents, tone)
    out = pan(note, 0.0)
    for c in range(2):
        # A breath in is brighter and its throat opens; a breath out rounds and falls.
        out[:, c] += 0.15 * breath_in * air(32 + c, n, 1.0, [f * (1 + 0.12 * lift) for f in (600, 1650, 2700, 3600)],
                                            widths, 2200 + 1500 * lift)
        out[:, c] += 0.24 * breath_out * air(34 + c, n, 1.0, [f * (1 - 0.15 * sink) for f in (480, 1150, 2500, 3400)],
                                             widths, 2400 - 1200 * sink)
    return out


def breath(kind):
    return room(breath_dry(kind, 4.4 if kind == 'open' else 6.2), 0.9, 0.4, 0.18)


def ripples_dry(kind, seconds, octave=1.0, soft=1900.0, ease=0.003, thumb=0.5, top=FS4, pace=1.0):
    """Three ripples across three strings: a slow thumb over D, A and F
    sharp (or another top string), rising to open and falling back to the
    root to close. A pace under 1 leaves that much longer between them."""
    n = int(SR * seconds / pace)
    if kind == 'open':
        notes = ((D3, 0.05, 1.0, -0.25), (A3, 0.21, 0.92, 0.05), (top, 0.39, 0.9, 0.32))
    else:
        notes = ((top, 0.05, 0.9, 0.32), (A3, 0.27, 0.85, 0.05), (D3, 0.55, 0.95, -0.25))
    out = np.zeros((n, 2))
    for i, (f, at, gain, where) in enumerate(notes):
        out += pan(pluck(41 + i, n, f * octave, at / pace, gain, soft=soft, ease=ease, thumb=thumb), where)
    return out


def ripples(kind):
    return room(ripples_dry(kind, 4.6 if kind == 'open' else 6.0), 1.1, 0.45, 0.2)


# The word in one pen stroke (x-height 1, baseline 0), then an underline back
# to where the pen began, so the stroke closes and can be one cycle of a wave.
PEN = [
    (-0.45, 0.0), (0.05, 0.22), (0.5, 0.8),                               # lead-in
    (0.76, 0.98), (0.42, 1.0), (0.08, 0.52), (0.36, 0.03), (0.72, 0.38),  # a: bowl
    (0.87, 0.97), (0.89, 0.4), (1.03, 0.04), (1.3, 0.28),                 # a: stem, out
    (1.56, 1.0), (1.72, 1.85), (1.66, 2.15), (1.5, 1.8), (1.5, 0.9),      # l: loop
    (1.57, 0.2), (1.76, 0.03), (2.0, 0.3),                                # l: foot, out
    (2.24, 0.78), (2.47, 1.0), (2.14, 0.55), (2.42, 0.03), (2.76, 0.5),   # o: bowl
    (2.52, 0.97), (2.8, 0.8), (3.03, 0.86),                               # o: closing loop, out along the top
    (3.15, 0.95), (3.19, 0.4), (3.4, 0.03), (3.7, 0.5), (3.77, 0.97),     # u
    (3.8, 0.4), (3.94, 0.04), (4.18, 0.22),                               # u: foot, out
    (4.56, 0.8), (4.86, 0.98), (4.62, 1.0), (4.32, 0.52), (4.58, 0.03),   # d: bowl
    (4.9, 0.42), (4.97, 1.2), (4.99, 2.1), (5.03, 1.0), (5.07, 0.3),      # d: stem up and back down
    (5.22, 0.04), (5.5, 0.16), (5.85, 0.0),                               # tail
    (5.7, -0.42), (4.2, -0.62), (2.4, -0.5), (0.6, -0.56), (-0.6, -0.4), (-0.78, -0.14),  # underline
]
LETTERS = ((-0.1, 1.15), (1.3, 1.9), (2.05, 2.95), (3.05, 4.05), (4.25, 5.3))  # where a, l, o, u, d sit along x
UNDERLINE_FROM = 49  # index of the first underline point in PEN
FOCUS = (1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 96)  # harmonics kept at each step from blur to sharp


def pen_path(m=4096, hand=None):
    """One trip of the pen as m samples evenly spaced in the hand's own
    time: (x, height, word), flat on the page; word is true while it is
    writing the word and false along the underline. hand seeds a slightly
    different writing of the same word."""
    p = np.array(PEN + [PEN[0]], float)
    if hand is not None:
        p[:-1] += np.random.default_rng(hand).normal(0, 0.03, (len(PEN), 2))
        p[-1] = p[0]
    s = np.concatenate([[0], np.cumsum(np.sqrt((np.diff(p, axis=0) ** 2).sum(axis=1)) ** 0.5)])
    cx, cy = CubicSpline(s, p[:, 0], bc_type='periodic'), CubicSpline(s, p[:, 1], bc_type='periodic')
    u = np.linspace(0, s[-1], 40001)
    speed = np.hypot(cx(u, 1), cy(u, 1))
    bend = np.abs(cx(u, 1) * cy(u, 2) - cy(u, 1) * cx(u, 2)) / (speed ** 3 + 1e-9)
    # A hand slows into a tight curve and runs along a straight (the
    # two-thirds power law), which also keeps the wave free of sharp corners.
    pace = (bend + 0.6) ** (-1 / 3)
    t = np.concatenate([[0], np.cumsum(0.5 * (speed[1:] / pace[1:] + speed[:-1] / pace[:-1]) * np.diff(u))])
    at = np.interp(np.linspace(0, t[-1], m, endpoint=False), t, u)
    return cx(at), cy(at), at < s[UNDERLINE_FROM]


def pen_cycle(m=4096, hand=None):
    """One trip of the pen as a wave: (tables, letters). tables[j] is the
    stroke (x, y) drawn with only about FOCUS[j] harmonics, each axis at unit
    RMS; letters are where in the trip (0..1) the pen is in each letter."""
    flat, height, word = pen_path(m, hand)
    letters = [float(np.mean(np.nonzero(word & (flat > lo) & (flat < hi))[0])) / m for lo, hi in LETTERS]
    x, y = flat + 0.22 * height, height + 0.07 * flat  # the letters lean and the line climbs, as a signature does
    k = np.arange(m // 2 + 1)
    tables = []
    for keep in FOCUS:
        blur = 1 / (1 + (k / keep) ** 4)
        blur[0] = 0
        pair = [np.fft.irfft(np.fft.rfft(a) * blur, m) for a in (x, y)]
        tables.append(np.stack([a / a.std() for a in pair], axis=1))
    return np.array(tables), letters


def trace(hands, whose, turn, focus, linger, centre, scatter=None):
    """Read the stroke where the pen is, sample by sample: (stereo wave, the
    pen's place in the table). hands is one or more sets of tables from
    pen_cycle and whose (per sample, per hand) is how much of each is
    writing; turn is the pen's trip as 0..1, focus an index into FOCUS,
    linger and centre how long and where it dwells; scatter knocks the pen
    off its place by that much of a trip."""
    n, m, top = len(turn), hands[0].shape[1], len(FOCUS) - 1
    grid = np.linspace(0, 1, 513)
    out = np.zeros((n, 2))
    place = np.zeros(n)
    block = 256
    for i in range(0, n, block):
        j = slice(i, min(i + block, n))
        # Where the pen lingers it moves slowly and the rest of the trip hurries.
        dense = 1 + linger[i] * np.exp(12 * (np.cos(2 * np.pi * (grid - centre[i])) - 1))
        clock = np.concatenate([[0], np.cumsum(0.5 * (dense[1:] + dense[:-1]))])
        at = turn[j] if scatter is None else (turn[j] + scatter[j]) % 1.0
        along = np.interp(at, clock / clock[-1], grid) * m
        lo = int(min(focus[i], top - 1e-6))
        mix = focus[i] - lo
        a, b = along.astype(int) % m, (along.astype(int) + 1) % m
        frac = (along % 1)[:, None]
        for h, tables in enumerate(hands):
            for table, share in ((tables[lo], 1 - mix), (tables[lo + 1], mix)):
                out[j] += whose[i, h] * share * (table[a] * (1 - frac) + table[b] * frac)
        place[j] = along
    return out, place


def autograph(kind):
    """The wild one: a wave that is a drawing. Left is the pen's x, right its
    y, and one cycle is the word in handwriting. It begins as a pure tone (an
    ellipse: the orb), comes into focus as the word, and is written letter by
    letter: the pen lingers on each in turn, so for a moment each letter's
    shape is the timbre. The close unwrites it, d back to a."""
    seconds = 5.0 if kind == 'open' else 6.6
    n = int(SR * seconds)
    t = np.arange(n) / SR
    rng = np.random.default_rng(51)
    tables, letters = pen_cycle()
    top = len(FOCUS) - 1
    step = 1200 * np.log2(A2 / D3)
    if kind == 'open':
        cents = curve(t, [(0, step), (0.38, step), (0.6, 10), (0.85, 0), (seconds - 1.5, 0), (seconds, -25)])
        level = curve(t, [(0, 0), (0.3, 0.45), (0.6, 0.6), (1.0, 1.0), (2.3, 0.85), (3.0, 0.4), (4.1, 0.12),
                          (seconds, 0)])
        focus = curve(t, [(0, 0), (0.45, 0), (1.3, top), (2.3, top), (3.1, 2), (seconds, 0)])
        linger = curve(t, [(0, 0), (0.7, 0), (1.0, 4), (2.3, 4), (2.8, 0), (seconds, 0)])
        where = curve(t, [(0, 0), (0.95, 0), (1.25, 1), (1.55, 2), (1.85, 3), (2.15, 4), (seconds, 4)])
    else:
        cents = curve(t, [(0, -30), (0.2, 0), (2.6, 0), (seconds, -45)])
        level = curve(t, [(0, 0), (0.35, 1.0), (2.2, 0.85), (3.2, 0.5), (4.4, 0.2), (5.6, 0.05), (seconds, 0)])
        focus = curve(t, [(0, 3), (0.4, top), (2.0, top), (3.6, 2), (5.0, 0), (seconds, 0)])
        linger = curve(t, [(0, 0), (0.3, 4), (2.0, 4), (2.6, 0), (seconds, 0)])
        where = curve(t, [(0, 4), (0.45, 4), (0.8, 3), (1.15, 2), (1.5, 1), (1.85, 0), (seconds, 0)])
    cents = cents + 4 * wander(n, rng, 0.05, 0.8) + 2 * wander(n, rng, 2, 8)  # a hand, not a clock
    turn = np.cumsum(D3 * 2 ** (cents / 1200)) / SR % 1.0
    centre = np.interp(where, np.arange(len(letters)), letters)
    out = trace([tables], np.ones((n, 1)), turn, focus, linger, centre)[0]
    out *= (level * (1 + 0.03 * wander(n, rng, 0.5, 6)))[:, None]
    return room(out, 0.8, 0.35, 0.08)


def bloom(kind):
    """The experiment in using the range a phone doesn't have: `hum` as the
    part every speaker plays, a dark drone under it for good speakers to put
    in the body, and the three ripples an octave up, lightly, on top."""
    seconds = 5.0 if kind == 'open' else 6.6
    n = int(SR * seconds)
    out = at_level(hum_dry(kind, seconds), 0)
    under = drone_dry(kind, seconds, plain=True)
    out += at_level(sosfilt(butter(4, 280, 'low', fs=SR, output='sos'), under, axis=0), -5)
    glints = at_level(ripples_dry(kind, seconds, octave=2.0, soft=2600.0), -12)
    lead = int(SR * (0.38 if kind == 'open' else 0.0))  # the first ripple lands as the mouths open
    out[lead:] += glints[:n - lead]
    return room(out, 1.1, 0.4, 0.2)


# ---- round 2: the same directions, revised after a first listen ----

def ripples2(kind):
    """`ripples` with a chord on its last note: A and E go with the F sharp,
    so the roll ends on D with a ninth added. The close starts from that
    chord and takes a fourth step, down to the low D."""
    seconds = 4.6 if kind == 'open' else 6.6
    n = int(SR * seconds)
    out = ripples_dry(kind, seconds)
    if kind == 'open':
        extra = ((A4, 0.415, 0.42, 0.45, 1900.0, 1.4), (E5, 0.43, 0.45, -0.4, 1900.0, 1.4))
    else:
        extra = ((A4, 0.065, 0.42, 0.45, 1900.0, 1.4), (E5, 0.08, 0.45, -0.4, 1900.0, 1.4),
                 (D2, 1.0, 0.95, 0.0, 1300.0, 1.6))
    for i, (f, at, gain, where, soft, ring) in enumerate(extra):
        out += pan(pluck(44 + i, n, f, at, gain, soft=soft, ring=ring), where)
    return room(out, 1.1, 0.45, 0.2)


def ripples3(kind):
    """`ripples` with an undertone: as the last string is let go, a bowed
    string takes up the root beneath it and sings on after the plucks."""
    seconds = 4.6 if kind == 'open' else 6.4
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        level = curve(t, [(0, 0), (0.3, 0), (0.9, 0.85), (1.5, 1.0), (2.2, 0.6), (3.0, 0.2), (3.8, 0.02), (seconds, 0)])
    else:
        level = curve(t, [(0, 0), (0.5, 0), (1.2, 0.9), (1.9, 1.0), (2.8, 0.6), (4.0, 0.2), (5.2, 0.02), (seconds, 0)])
    out = at_level(ripples_dry(kind, seconds), 0)
    out += at_level(pan(in_wood(bow(82, D3, np.zeros(n), level, shake=9.0), mellow=1800.0), 0.0), -10)
    return room(out, 1.1, 0.45, 0.2)


# Two to a part: each voice of HUM_VOICES and a second singer beside it, a few
# cents off, a moment late, built a little differently, on the other side.
def choir(trio):
    return trio + tuple(
        (seed + 20, vt * 0.97, pickup * off, home * off, rest * off, late + 0.035, -where, gain * 0.75, breath)
        for (seed, vt, pickup, home, rest, late, where, gain, breath), off
        in zip(trio, (2 ** (6 / 1200), 2 ** (-5 / 1200), 2 ** (4 / 1200))))


HUM_CHOIR = choir(HUM_VOICES)


def bloom2(kind):
    """`bloom`, quicker and with more people in it. The opening's hum is a
    grace note and it is over in three seconds; the close keeps bloom's
    shape. Six voices, and a closed mouth that is darker."""
    seconds = 3.4 if kind == 'open' else 6.6
    n = int(SR * seconds)
    out = at_level(hum_dry(kind, seconds, voices=HUM_CHOIR, brisk=True, shut_db=-8.0), 0)
    under = drone_dry(kind, seconds, plain=True, brisk=True)
    out += at_level(sosfilt(butter(4, 280, 'low', fs=SR, output='sos'), under, axis=0), -5)
    glints = at_level(ripples_dry(kind, seconds, octave=2.0, soft=2600.0), -12)
    lead = int(SR * (0.12 if kind == 'open' else 0.0))
    out[lead:] += glints[:n - lead]
    return room(out, 1.1, 0.4, 0.2)


def wooden_drone(cents, over, level, sung_cents, sung, string_lu=-3.0):
    """The sound of `drone2` and its variations: the softened reed on D2
    (cents, over, level as for reed()) and a bowed string on D3 (its own
    cents and level), both through the wooden body."""
    lips = np.stack([in_wood(reed(21, D2, cents, over, level, breath=0.025, side=side, width=70.0, peak=4.0,
                                  bell=0.4, top=2000.0), direct=1.0, mellow=1500.0)
                     for side in (-0.03, 0.03)], axis=1)
    # How much string, and how bright, is the knob here: brighter or louder and the pair starts to
    # sound overdriven, darker and it turns into a horn.
    string = pan(in_wood(bow(81, D3, sung_cents, sung), mellow=1000.0), 0.0)
    return at_level(lips, 0) + at_level(string, string_lu)


def drone2(kind):
    """`drone` with its edge taken off (less buzz above 1.5 kHz, a broader
    overtone, less hiss) and heard through a cello-sized wooden body, with a
    bowed string singing the D an octave above it as the overtones climb."""
    seconds = 4.0 if kind == 'open' else 5.6
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        over = curve(t, [(0, 5.2), (0.3, 6), (0.5, 6.1), (0.66, 8), (0.92, 8), (1.06, 9), (1.32, 9), (1.46, 10),
                         (2.0, 10), (2.8, 7), (seconds, 5)])
        level = curve(t, [(0, 0), (0.06, 0.1), (0.28, 0.8), (0.7, 0.9), (1.5, 1.0), (2.0, 0.7), (2.7, 0.3),
                          (3.4, 0.08), (seconds, 0)])
        cents = curve(t, [(0, -55), (0.22, 0), (seconds - 1.2, 0), (seconds, -40)])
        sung = curve(t, [(0, 0), (0.25, 0), (0.7, 0.6), (1.5, 1.0), (2.1, 0.7), (2.8, 0.25), (3.5, 0.03), (seconds, 0)])
    else:
        over = curve(t, [(0, 9), (0.3, 10), (0.8, 10), (1.0, 9), (1.4, 9), (1.6, 8), (2.2, 8), (3.0, 6),
                         (seconds, 4.5)])
        level = curve(t, [(0, 0), (0.35, 0.85), (0.9, 0.9), (2.0, 0.7), (3.0, 0.35), (4.2, 0.1), (seconds, 0)])
        cents = curve(t, [(0, -40), (0.25, 0), (2.4, 0), (seconds, -60)])
        sung = curve(t, [(0, 0), (0.3, 0.8), (0.9, 1.0), (2.2, 0.7), (3.2, 0.3), (4.4, 0.05), (seconds, 0)])
    return room(wooden_drone(cents, over, level, np.zeros(n), sung), 1.3, 0.5, 0.2)


def sign(seed, cents, level, focus, linger, where, scatter, smoke, sway=None, loose=None):
    """The later autographs' pen, dry: three slightly different hands take
    turns at the word, the nib rubs on the paper, and the line can be knocked
    off its place (scatter, as a share of a trip) and let go into a cloud
    (smoke). cents is about D3; where is which letter it lingers on, 0 to 4.
    sway is a per-sample (left, right) gain: the sound moving as it writes.
    loose (0..1) crossfades from the line as written to the same line fully
    come loose: scatter makes the cloud arrive almost at once however gently
    it is raised, since the least knock already blurs the upper harmonics,
    and loose lets it arrive as slowly as it is asked to."""
    n = len(cents)
    rng = np.random.default_rng(seed)
    written = [pen_cycle(hand=hand) for hand in (None, 1, 2)]
    hands, letters = [tables for tables, _ in written], written[0][1]
    m = hands[0].shape[1]
    top = len(FOCUS) - 1
    cents = cents + 7 * wander(n, rng, 0.05, 0.8) + 3 * wander(n, rng, 2, 8)
    turn = np.cumsum(D3 * 2 ** (cents / 1200)) / SR % 1.0
    centre = np.interp(where, np.arange(len(letters)), letters)
    lean = np.exp(1.5 * np.stack([wander(n, rng, 0.3, 2.5) for _ in hands], axis=1))
    whose = lean / lean.sum(axis=1, keepdims=True)
    knock = sosfilt(butter(2, 700, 'low', fs=SR, output='sos'), rng.standard_normal(n))
    out, place = trace(hands, whose, turn, focus, linger, centre, scatter * knock / knock.std())
    if loose is not None:
        cloud = trace(hands, whose, turn, focus, linger, centre, 0.2 * knock / knock.std())[0]
        out = np.cos(loose * np.pi / 2)[:, None] * out + np.sin(loose * np.pi / 2)[:, None] * cloud
    # The pen on the paper: a hiss that comes and goes with how fast the nib is moving.
    nib = np.hypot(*np.gradient(hands[0][top], axis=0).T)
    nib = (nib / nib.mean())[place.astype(int) % m]
    nib = nib * (0.3 + 0.7 * focus / top)  # a blurred line has less edge to catch
    for c in range(2):
        rub = sosfilt(butter(2, [700, 3500], 'band', fs=SR, output='sos'), rng.standard_normal(n))
        out[:, c] += 0.04 * nib * rub / rub.std()
    out *= (level * (1 + 0.03 * wander(n, rng, 0.5, 6)))[:, None]
    if sway is not None:
        out *= sway
    for c in range(2):
        # The puff itself: the line lets go of the page, each ear its own cloud.
        cloud = sosfilt(butter(2, [150, 2200], 'band', fs=SR, output='sos'), rng.standard_normal(n))
        out[:, c] += smoke * cloud / cloud.std()
    return out


def autograph2(kind):
    """`autograph`, cut to the part that is the signature. The same start,
    then as soon as the word is in focus it puffs into a cloud and is gone.
    The close runs the other way: it gathers out of a puff into the word,
    blurs back down to the orb as the pitch falls the fourth the opening
    rose, and shrinks to nothing. Less like a machine: three slightly
    different hands take turns writing, the pen rubs on the paper, and the
    pitch wanders more."""
    seconds = 2.8 if kind == 'open' else 4.2
    n = int(SR * seconds)
    t = np.arange(n) / SR
    top = len(FOCUS) - 1
    step = 1200 * np.log2(A2 / D3)
    if kind == 'open':
        cents = curve(t, [(0, step), (0.38, step), (0.6, 10), (0.85, 0), (seconds - 0.6, 0), (seconds, -15)])
        level = curve(t, [(0, 0), (0.3, 0.45), (0.6, 0.6), (1.0, 1.0), (1.45, 0.95), (1.75, 0.3), (2.1, 0.05),
                          (2.5, 0), (seconds, 0)])
        focus = curve(t, [(0, 0), (0.45, 0), (1.3, top), (1.5, top), (1.9, 3), (2.5, 1), (seconds, 1)])
        linger = curve(t, [(0, 0), (0.7, 0), (1.0, 4), (1.3, 4), (1.6, 0), (seconds, 0)])
        where = curve(t, [(0, 0), (0.95, 0), (1.2, 1), (1.33, 2), (1.46, 3), (1.6, 4), (seconds, 4)])
        scatter = curve(t, [(0, 0), (1.45, 0), (1.6, 0.02), (1.8, 0.12), (2.2, 0.2), (seconds, 0.2)])
        smoke = curve(t, [(0, 0), (1.45, 0), (1.65, 0.35), (1.85, 0.22), (2.2, 0.06), (2.6, 0), (seconds, 0)])
    else:
        cents = curve(t, [(0, 0), (1.9, 0), (2.15, step + 10), (2.4, step), (seconds, step - 20)])
        level = curve(t, [(0, 0), (0.12, 0.4), (0.45, 1.0), (0.9, 0.95), (1.6, 0.6), (2.3, 0.4), (3.0, 0.15),
                          (3.7, 0.03), (seconds, 0)])
        focus = curve(t, [(0, 3), (0.2, top - 2), (0.45, top), (0.9, top), (2.0, 0), (seconds, 0)])
        linger = curve(t, [(0, 0), (0.3, 4), (0.75, 4), (1.1, 0), (seconds, 0)])
        where = curve(t, [(0, 4), (0.4, 4), (0.52, 3), (0.64, 2), (0.76, 1), (0.9, 0), (seconds, 0)])
        scatter = curve(t, [(0, 0.2), (0.15, 0.12), (0.4, 0), (seconds, 0)])
        smoke = curve(t, [(0, 0), (0.08, 0.3), (0.25, 0.15), (0.45, 0), (seconds, 0)])
    return room(sign(52, cents, level, focus, linger, where, scatter, smoke), 0.8, 0.35, 0.08)


# ---- round 3 ----

def low_string(kind, seconds):
    """ripples4's bowed string, dry: D3 swelling in under an opening roll,
    the low D2 arriving after a closing one."""
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        level = curve(t, [(0, 0), (0.03, 0), (0.39, 1.0), (0.9, 0.95), (1.6, 0.8), (2.3, 0.5), (3.1, 0.18),
                          (3.9, 0.02), (seconds, 0)])
        string = bow(82, D3, np.zeros(n), level, shake=9.0)
    else:
        level = curve(t, [(0, 0), (0.5, 0), (1.25, 0.9), (2.0, 1.0), (3.0, 0.6), (4.2, 0.2), (5.4, 0.02),
                          (seconds, 0)])
        string = bow(82, D2, np.zeros(n), level, shake=9.0, press=0.6)
    return pan(in_wood(string, mellow=1800.0), 0.0)


def ripples4(kind):
    """`ripples3` with the bowed string moved. Open: it swells in under the
    roll and is already singing when the last string is plucked. Close: it
    is the low D, an octave under the last pluck, the next step down."""
    seconds = 4.6 if kind == 'open' else 6.6
    out = at_level(ripples_dry(kind, seconds), 0)
    out += at_level(low_string(kind, seconds), -8)
    return room(out, 1.1, 0.45, 0.2)


def bloom3(kind):
    """`bloom2` saying less: every formant is nearly twice as wide, so the
    same sound opens and closes without settling on a vowel, and the vibrato
    is about half. (Giving each voice its own vowel, and never closing the
    mouths, were tried too: with the tagger they made it more of a chant, or
    a horn.) The top strings ease in, and in the close wait for the voices,
    which is where bloom2's tick was."""
    seconds = 3.4 if kind == 'open' else 6.6
    n = int(SR * seconds)
    out = at_level(hum_dry(kind, seconds, voices=HUM_CHOIR, brisk=True, shut_db=-8.0, blur=1.8, shake=8.0), 0)
    under = drone_dry(kind, seconds, plain=True, brisk=True)
    out += at_level(sosfilt(butter(4, 280, 'low', fs=SR, output='sos'), under, axis=0), -5)
    glints = at_level(ripples_dry(kind, seconds, octave=2.0, soft=2600.0, ease=0.012, thumb=0.15), -12)
    lead = int(SR * (0.12 if kind == 'open' else 0.2))
    out[lead:] += glints[:n - lead]
    return room(out, 1.1, 0.4, 0.2)


def drone3(kind):
    """`drone2` with a step in the bass. Open: it starts a fourth low, on A,
    and steps up to D as the overtones and the string arrive. Close: it
    starts a fourth high, on G, string and all, and settles down onto D."""
    seconds = 4.2 if kind == 'open' else 5.8
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        cents = curve(t, [(0, -540), (0.15, -500), (0.42, -500), (0.58, 12), (0.8, 0), (seconds - 1.2, 0),
                          (seconds, -40)])
        over = curve(t, [(0, 7.5), (0.42, 8), (0.6, 8), (0.95, 8), (1.1, 9), (1.4, 9), (1.55, 10), (2.1, 10),
                         (2.9, 7), (seconds, 5)])
        level = curve(t, [(0, 0), (0.08, 0.35), (0.4, 0.5), (0.62, 0.95), (1.6, 1.0), (2.2, 0.7), (2.9, 0.3),
                          (3.6, 0.08), (seconds, 0)])
        sung_cents = np.zeros(n)
        sung = curve(t, [(0, 0), (0.5, 0), (0.9, 0.7), (1.6, 1.0), (2.2, 0.7), (2.9, 0.25), (3.6, 0.03), (seconds, 0)])
    else:
        cents = curve(t, [(0, 470), (0.25, 500), (1.5, 500), (1.72, -10), (1.95, 0), (seconds - 2.0, 0),
                          (seconds, -60)])
        over = curve(t, [(0, 7), (0.3, 7.5), (1.4, 7.5), (1.75, 9), (2.3, 9), (2.5, 8), (3.2, 8), (4.0, 6),
                         (seconds, 4.5)])
        level = curve(t, [(0, 0), (0.35, 0.85), (1.4, 0.9), (1.8, 1.0), (2.8, 0.7), (3.8, 0.35), (4.8, 0.1),
                          (seconds, 0)])
        sung_cents = curve(t, [(0, 500), (1.5, 500), (1.72, 0), (seconds, 0)])
        sung = curve(t, [(0, 0), (0.3, 0.8), (1.4, 0.9), (1.8, 1.0), (2.8, 0.7), (3.8, 0.3), (4.8, 0.05), (seconds, 0)])
    return room(wooden_drone(cents, over, level, sung_cents, sung), 1.3, 0.5, 0.2)


def drone4(kind):
    """`drone2` with the string climbing. The bass holds D; the bowed string
    walks D, E, F sharp with the three overtones, two octaves under them,
    and walks back down to close."""
    seconds = 4.2 if kind == 'open' else 5.8
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        cents = curve(t, [(0, -55), (0.22, 0), (seconds - 1.2, 0), (seconds, -40)])
        over = curve(t, [(0, 5.2), (0.3, 6), (0.5, 6.1), (0.66, 8), (0.95, 8), (1.1, 9), (1.45, 9), (1.6, 10),
                         (2.2, 10), (3.0, 7), (seconds, 5)])
        level = curve(t, [(0, 0), (0.06, 0.1), (0.28, 0.8), (0.7, 0.9), (1.7, 1.0), (2.2, 0.7), (2.9, 0.3),
                          (3.6, 0.08), (seconds, 0)])
        # 8 : 9 : 10, the overtones' own tuning.
        sung_cents = curve(t, [(0, 0), (1.0, 0), (1.1, 204), (1.5, 204), (1.6, 386), (seconds, 386)])
        sung = curve(t, [(0, 0), (0.3, 0), (0.7, 0.7), (1.0, 0.85), (1.7, 1.0), (2.3, 0.75), (3.0, 0.3),
                         (3.7, 0.03), (seconds, 0)])
    else:
        cents = curve(t, [(0, -40), (0.25, 0), (2.6, 0), (seconds, -60)])
        over = curve(t, [(0, 9), (0.3, 10), (0.95, 10), (1.1, 9), (1.65, 9), (1.8, 8), (2.6, 8), (3.4, 6),
                         (seconds, 4.5)])
        level = curve(t, [(0, 0), (0.35, 0.85), (0.9, 0.9), (2.0, 0.8), (3.0, 0.4), (4.4, 0.1), (seconds, 0)])
        sung_cents = curve(t, [(0, 386), (1.0, 386), (1.12, 204), (1.7, 204), (1.82, 0), (seconds, 0)])
        sung = curve(t, [(0, 0), (0.3, 0.8), (0.9, 1.0), (2.0, 0.9), (3.0, 0.45), (4.4, 0.05), (seconds, 0)])
    return room(wooden_drone(cents, over, level, sung_cents, sung), 1.3, 0.5, 0.2)


def drone5(kind):
    """`drone2` in three breaths: the three ripples as three swells of the
    bass, one overtone to each, each scooping up into pitch. Open: the
    breaths grow. Close: they slow, sink and fade."""
    seconds = 4.4 if kind == 'open' else 6.0
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        cents = curve(t, [(0, -60), (0.25, 0), (0.62, -25), (0.9, 0), (1.35, -25), (1.65, 0), (seconds - 1.2, 0),
                          (seconds, -40)])
        over = curve(t, [(0, 6), (0.2, 8), (0.55, 8), (0.75, 9), (1.3, 9), (1.5, 10), (2.4, 10), (3.2, 7),
                         (seconds, 5)])
        level = curve(t, [(0, 0), (0.3, 0.75), (0.62, 0.3), (1.0, 0.9), (1.35, 0.35), (1.75, 1.0), (2.3, 0.7),
                          (3.0, 0.3), (3.7, 0.08), (seconds, 0)])
        sung = curve(t, [(0, 0), (0.3, 0), (0.9, 0.6), (1.35, 0.55), (1.8, 1.0), (2.4, 0.75), (3.1, 0.3),
                         (3.8, 0.03), (seconds, 0)])
    else:
        cents = curve(t, [(0, -40), (0.25, 0), (0.95, -30), (1.3, 0), (2.2, -35), (2.6, 0), (3.6, -20),
                          (seconds, -70)])
        over = curve(t, [(0, 9), (0.3, 10), (0.9, 10), (1.15, 9), (2.1, 9), (2.4, 8), (3.4, 8), (4.2, 6),
                         (seconds, 4.5)])
        level = curve(t, [(0, 0), (0.35, 1.0), (0.95, 0.35), (1.5, 0.8), (2.2, 0.3), (2.9, 0.6), (3.9, 0.3),
                          (4.9, 0.08), (seconds, 0)])
        sung = curve(t, [(0, 0), (0.3, 0.8), (0.9, 0.6), (1.5, 0.9), (2.2, 0.55), (2.9, 0.7), (3.8, 0.3),
                         (4.8, 0.04), (seconds, 0)])
    return room(wooden_drone(cents, over, level, np.zeros(n), sung), 1.3, 0.5, 0.2)


def autograph3(kind):
    """`autograph2` as one arc and not two. The word doesn't end and a puff
    begin: from the moment it is in focus the line starts coming loose, the
    cloud is the word losing its hold on the page, and the whole of it is
    already fading. The close gathers the same way, in one rise."""
    seconds = 2.8 if kind == 'open' else 4.2
    n = int(SR * seconds)
    t = np.arange(n) / SR
    top = len(FOCUS) - 1
    step = 1200 * np.log2(A2 / D3)
    if kind == 'open':
        cents = curve(t, [(0, step), (0.38, step), (0.6, 10), (0.85, 0), (seconds - 0.6, 0), (seconds, -15)])
        level = curve(t, [(0, 0), (0.3, 0.45), (0.6, 0.6), (1.0, 1.0), (1.35, 1.0), (1.7, 0.6), (2.1, 0.22),
                          (2.5, 0.04), (seconds, 0)])
        focus = curve(t, [(0, 0), (0.45, 0), (1.3, top), (1.45, top), (2.0, 4), (2.5, 1), (seconds, 1)])
        linger = curve(t, [(0, 0), (0.7, 0), (1.0, 4), (1.3, 4), (1.6, 0), (seconds, 0)])
        where = curve(t, [(0, 0), (0.95, 0), (1.2, 1), (1.33, 2), (1.46, 3), (1.6, 4), (seconds, 4)])
        loose = curve(t, [(0, 0), (1.3, 0), (2.15, 1), (seconds, 1)])
        smoke = curve(t, [(0, 0), (1.35, 0), (1.8, 0.1), (2.2, 0.05), (2.6, 0), (seconds, 0)])
    else:
        cents = curve(t, [(0, 0), (1.9, 0), (2.15, step + 10), (2.4, step), (seconds, step - 20)])
        level = curve(t, [(0, 0), (0.45, 1.0), (0.9, 0.95), (1.6, 0.6), (2.3, 0.4), (3.0, 0.15), (3.7, 0.03),
                          (seconds, 0)])
        focus = curve(t, [(0, 3), (0.2, top - 2), (0.45, top), (0.9, top), (2.0, 0), (seconds, 0)])
        linger = curve(t, [(0, 0), (0.3, 4), (0.75, 4), (1.1, 0), (seconds, 0)])
        where = curve(t, [(0, 4), (0.4, 4), (0.52, 3), (0.64, 2), (0.76, 1), (0.9, 0), (seconds, 0)])
        loose = curve(t, [(0, 1), (0.6, 0), (seconds, 0)])
        smoke = curve(t, [(0, 0), (0.15, 0.08), (0.4, 0.03), (0.6, 0), (seconds, 0)])
    return room(sign(52, cents, level, focus, linger, where, np.zeros(n), smoke, loose=loose), 0.8, 0.35, 0.08)


# How the pitch follows the pen in autograph4: cents for one x-height of climb, and (Hz) how much of
# the pen's quicker turning it follows. More of either and it wobbles like a theremin; less and the
# held buzz starts to sound like an insect.
PEN_RISE = 200.0
PEN_EASE = 4.0


def autograph4(kind):
    """My own turn at it: the pen writes the word once. The wave is still
    the word, 147 times a second, but now the hand moves through it at
    writing speed too: the pitch follows the pen's height (so l and d are
    the two tall leaps), the sound travels left to right with it, and it is
    sharper where the pen runs and softer where it turns. Open: the orb,
    the word written in a little over a second, a flick of the wrist and it
    is off the page. Close: written again, slower, and then underlined: one
    long low stroke back to where it started."""
    seconds = 2.5 if kind == 'open' else 4.0
    n = int(SR * seconds)
    t = np.arange(n) / SR
    top = len(FOCUS) - 1
    flat, height, word = pen_path()
    m = len(flat)
    ends = int(np.nonzero(word)[0][-1]) / m  # where in the trip the word ends and the underline begins
    begin = 0.3
    if kind == 'open':
        done = begin + 1.2
        trip = curve(t, [(0, 0), (begin, 0), (done, ends), (seconds, ends)])
        inked = curve(t, [(0, 0), (begin, 0), (begin + 0.15, 1), (seconds, 1)])
        level = curve(t, [(0, 0), (0.25, 0.5), (begin + 0.2, 0.9), (done, 1.0), (done + 0.3, 0.5), (done + 0.6, 0.12),
                          (done + 0.85, 0), (seconds, 0)])
        flick = curve(t, [(0, 0), (done - 0.05, 0), (done + 0.3, 250), (seconds, 250)])
        loose = curve(t, [(0, 0), (done - 0.1, 0), (done + 0.55, 1), (seconds, 1)])
        smoke = curve(t, [(0, 0), (done, 0), (done + 0.35, 0.08), (done + 0.7, 0.02), (seconds, 0)])
    else:
        done, back = begin + 1.5, begin + 1.5 + 1.1
        trip = curve(t, [(0, 0), (begin, 0), (done, ends), (back, 0.999), (seconds, 0.999)])
        inked = curve(t, [(0, 0), (begin, 0), (begin + 0.15, 1), (done, 1), (back, 0), (seconds, 0)])
        level = curve(t, [(0, 0), (0.3, 0.5), (begin + 0.3, 0.85), (done, 0.8), (done + 0.4, 0.65), (back, 0.25),
                          (seconds - 0.1, 0), (seconds, 0)])
        flick = np.zeros(n)
        loose = curve(t, [(0, 1), (0.45, 0), (seconds, 0)])
        smoke = curve(t, [(0, 0), (0.12, 0.06), (0.35, 0.02), (0.5, 0), (seconds, 0)])
    at = np.minimum((trip * m).astype(int), m - 1)
    # The hand, at the size of the gesture: where the pen is, without the nib's finest turns.
    ease = butter(2, PEN_EASE, 'low', fs=SR, output='sos')
    x, y = sosfiltfilt(ease, flat[at]), sosfiltfilt(ease, height[at])
    pace = sosfiltfilt(ease, np.hypot(np.gradient(x), np.gradient(y)))
    pace = np.clip(pace / pace.max(), 0, 1)
    cents = PEN_RISE * y + flick
    focus = inked * (4.5 + (top - 5.5) * np.sqrt(pace))
    across = 0.25 * (2 * (x - flat.min()) / (flat.max() - flat.min()) - 1)
    sway = np.sqrt(2) * np.stack([np.cos(np.pi / 4 + across), np.sin(np.pi / 4 + across)], axis=1)
    still = np.zeros(n)
    out = sign(53, cents, level * (0.7 + 0.3 * pace), focus, still, still, still, smoke, sway, loose)
    return room(out, 0.8, 0.35, 0.08)


# ---- round 4 ----

def surf(seed, n, swell, wash, lag=0.15, hiss_db=-16.0):
    """A wave running up a beach. Measured off recordings of real ones, not
    drawn: a roar that falls 8 dB an octave above 350 Hz (swell is its level,
    as (seconds, level) points) and a hiss above 3 kHz that outlasts it
    (wash). Two things keep it from being static, by the tagger and by the
    recordings: every band swells and thins on its own, and the hiss is made
    of bursts, so it is never even. The right ear hears it lag seconds after
    the left: it runs along the beach."""
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    frames = n // 256 + 8
    centres = np.geomspace(60, 14000, 16)
    knots = np.arange(0, frames + 8, 8)
    common = rng.standard_normal((2, n))
    out = np.zeros((n, 2))
    for c in range(2):
        field = np.stack([np.interp(np.arange(frames), knots, rng.standard_normal(len(knots))) for _ in centres])

        def grain(f, tt):
            i = np.minimum((tt * SR / 256).astype(int), frames - 1)[0]
            return db(2.0 * np.stack([np.interp(np.log(np.maximum(f[:, 0], 30)), np.log(centres), field[:, j])
                                      for j in i], axis=1))

        def roar(f, tt):
            return (f / (f + 140)) ** 2 * (1 + (f / 350) ** 2) ** (-8.0 / 12.04) * grain(f, tt)

        def foam(f, tt):
            return (f / 3000) ** 2 / (1 + (f / 3000) ** 2) / np.sqrt(1 + (f / 9000) ** 4) * grain(f, tt)

        # Some of each ear's water is the other's too: it survives being summed to mono.
        own = np.sqrt(0.7) * rng.standard_normal((2, n)) + np.sqrt(0.3) * common
        body = shaped(own[0], roar)
        hiss = shaped(own[1] * np.exp(0.33 * wander(n, rng, 20, 160)), foam)
        late = np.clip(t - c * lag, 0, None)
        out[:, c] = body / body.std() * curve(late, swell) + db(hiss_db) * hiss / hiss.std() * curve(late, wash)
    return out


def strings_dry(kind, seconds, soft=False, pace=1.0):
    """The hum's three parts on three bowed strings: the same notes, the
    same steps and the same swell, in wood."""
    out = np.zeros((int(SR * seconds / pace), 2))
    for voice, cents, mouth, rounding, level, settled in hum_parts(kind, seconds, None, True, soft, pace):
        seed, vt, pickup, home, rest, late, where, gain, breath = voice
        out += pan(gain * in_wood(bow(seed + 80, home, cents, level, shake=7.0), mellow=1800.0), 0.6 * where)
    return out


def crowd(trio, size=4, seed=5):
    """size singers to each part of a trio: the first as written, the rest
    up to 9 cents off, built up to a twentieth bigger or smaller, coming in
    late and standing where they like."""
    rng = np.random.default_rng(seed)
    out = []
    for voice_seed, vt, pickup, home, rest, late, where, gain, breath in trio:
        for j in range(size):
            off = 2 ** (rng.uniform(-9, 9) / 1200) if j else 1.0
            out.append((voice_seed + 20 * j, vt * (1 + 0.05 * rng.uniform(-1, 1) * (j > 0)), pickup * off, home * off,
                        rest * off, late + 0.03 * j * rng.uniform(0.6, 1.4),
                        float(np.clip(where + (0.5 * rng.uniform(-1, 1) if j else 0), -0.8, 0.8)),
                        gain * (0.75 if j else 1.0), breath))
    return tuple(out)


# The trio for a bloom with the third at the bottom and no sun on top: the
# two lower voices hold F sharp and A, and only the top one moves, from the
# root up a step to the ninth (and back down to the root to close). Over the
# low D that is D with a ninth; where a speaker can't play the low D it is
# closer to F sharp minor.
HUM_NINTH = (
    (11, 1.04, FS3, FS3, FS3, 0.00, -0.20, 0.85, 0.06),
    (12, 1.15, A3, A3, A3, 0.05, 0.30, 0.80, 0.08),
    (13, 1.20, D4, E4, D4, 0.03, -0.05, 0.75, 0.08),
)


def bloom_of(kind, voices=HUM_CHOIR, soft=True, pace=1.0, airy=1.0, press=1.0, strings=None, top=FS4, blur=1.8,
             steel=None, core=None):
    """bloom3 with round 4's options: a soft start, a pace, breathier or
    held-back voices, bowed strings on the voices' parts (strings is their
    level against the voices, in LU), another top string for the glints.
    steel gives the glints' place to a pan's roll: (its top field, its level
    in LU). core gives the voices' place to something else: a function of
    (kind, pace) that plays their parts, dry."""
    seconds = 3.4 if kind == 'open' else 6.6
    n = int(SR * seconds / pace)
    if core:
        out = at_level(core(kind, pace), 0)
    else:
        out = at_level(hum_dry(kind, seconds, voices=voices, brisk=True, shut_db=-8.0, blur=blur, shake=8.0,
                               soft=soft, pace=pace, airy=airy, press=press), 0)
    if strings is not None:
        out += at_level(strings_dry(kind, seconds, soft, pace), strings)
    under = drone_dry(kind, seconds, plain=True, brisk=True, pace=pace)
    out += at_level(sosfilt(butter(4, 280, 'low', fs=SR, output='sos'), under, axis=0), -5)
    if steel:
        field, level = steel
        wait = (0.12 if kind == 'open' else 0.2) / pace
        out += at_level(pan_roll(kind, seconds, field, pace, touch=0.7, wait=wait), level)
        return room(out, 1.1, 0.4, 0.2)
    glints = at_level(ripples_dry(kind, seconds, octave=2.0, soft=2600.0, ease=0.012, thumb=0.15, top=top, pace=pace),
                      -12)
    lead = int(SR * (0.12 if kind == 'open' else 0.2) / pace)
    out[lead:] += glints[:n - lead]
    return room(out, 1.1, 0.4, 0.2)


def bloom4(kind):
    """`bloom3` with a softer start: the voices take about twice as long to
    arrive. Nothing else is changed."""
    return bloom_of(kind)


def bloom5(kind):
    """A texture for `bloom4`: a crowd where there were six. Twelve voices,
    four to a part, none of them quite together: less a few mouths, more a
    room humming."""
    return bloom_of(kind, voices=crowd(HUM_VOICES))


def bloom6(kind):
    """A texture for `bloom4`: three bowed strings play the three parts
    under the voices, 5 LU down. (More breath in the voices was tried too:
    with the tagger it was a steam whistle.)"""
    return bloom_of(kind, strings=-5.0)


def bloom7(kind):
    """`bloom4` at 0.7 speed: every gesture takes 1.4 times as long, at the
    same pitch. Slower voices scored as more of a chant, so the vowels are
    smeared a third further to hold that off."""
    return bloom_of(kind, pace=0.7, blur=2.4)


def bloom8(kind):
    """`bloom7` with the sun taken off the top of the chord. The lower
    voices hold F sharp and A; only the top one moves, from D up a step to E
    to open and back down to D to close, and the glints end on E."""
    return bloom_of(kind, voices=choir(HUM_NINTH), pace=0.7, blur=2.4, top=E4)


def drone6(kind):
    """`drone3` with nothing falling. No sag at the end, and the last
    overtone is held, not let slide. The close is rebuilt: a held low note
    that drops is a foghorn, so the bass comes home from below as it does in
    the opening (A up to D). It starts as the bass alone, dark; the mouth
    opens and the string joins as it arrives on D, and the overtones step
    down from there. (A first try had the string and an overtone holding E
    from the start: a higher note in the beginning that didn't belong.)"""
    seconds = 4.2 if kind == 'open' else 5.8
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        cents = curve(t, [(0, -540), (0.15, -500), (0.42, -500), (0.58, 12), (0.8, 0), (seconds, 0)])
        over = curve(t, [(0, 7.5), (0.42, 8), (0.6, 8), (0.95, 8), (1.1, 9), (1.4, 9), (1.55, 10), (seconds, 10)])
        level = curve(t, [(0, 0), (0.08, 0.35), (0.4, 0.5), (0.62, 0.95), (1.6, 1.0), (2.2, 0.7), (2.9, 0.3),
                          (3.6, 0.08), (seconds, 0)])
        sung_cents = np.zeros(n)
        sung = curve(t, [(0, 0), (0.5, 0), (0.9, 0.7), (1.6, 1.0), (2.2, 0.7), (2.9, 0.25), (3.6, 0.03), (seconds, 0)])
    else:
        cents = curve(t, [(0, -528), (0.25, -498), (1.35, -498), (1.58, 10), (1.85, 0), (seconds, 0)])
        # The mouth stays dark while the bass is on A, tuned between two of its harmonics so that neither
        # sings out; it opens as the bass lands on D, then steps down.
        mouth = curve(t, [(0, 330), (0.3, 6.5 * 55), (1.3, 6.5 * 55), (1.75, 10 * D2), (2.45, 10 * D2), (2.6, 9 * D2),
                          (3.15, 9 * D2), (3.3, 8 * D2), (seconds, 8 * D2)])
        over = mouth / (D2 * 2 ** (cents / 1200))
        level = curve(t, [(0, 0), (0.35, 0.7), (1.25, 0.68), (1.7, 0.68), (2.6, 0.6), (3.6, 0.32), (4.8, 0.08),
                          (seconds, 0)])
        sung_cents = np.zeros(n)
        sung = curve(t, [(0, 0), (1.4, 0), (2.0, 0.8), (2.6, 1.0), (3.4, 0.6), (4.1, 0.25), (4.9, 0.04), (seconds, 0)])
        return room(wooden_drone(cents, over, level, sung_cents, sung, string_lu=-6.0), 1.3, 0.5, 0.2)
    return room(wooden_drone(cents, over, level, sung_cents, sung), 1.3, 0.5, 0.2)


def drone7(kind):
    """`drone4` with nothing falling at the end: no sag, and the last
    overtone is held."""
    seconds = 4.2 if kind == 'open' else 5.8
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        cents = curve(t, [(0, -55), (0.22, 0), (seconds, 0)])
        over = curve(t, [(0, 5.2), (0.3, 6), (0.5, 6.1), (0.66, 8), (0.95, 8), (1.1, 9), (1.45, 9), (1.6, 10),
                         (seconds, 10)])
        level = curve(t, [(0, 0), (0.06, 0.1), (0.28, 0.8), (0.7, 0.9), (1.7, 1.0), (2.2, 0.7), (2.9, 0.3),
                          (3.6, 0.08), (seconds, 0)])
        sung_cents = curve(t, [(0, 0), (1.0, 0), (1.1, 204), (1.5, 204), (1.6, 386), (seconds, 386)])
        sung = curve(t, [(0, 0), (0.3, 0), (0.7, 0.7), (1.0, 0.85), (1.7, 1.0), (2.3, 0.75), (3.0, 0.3),
                         (3.7, 0.03), (seconds, 0)])
    else:
        cents = curve(t, [(0, -40), (0.25, 0), (seconds, 0)])
        over = curve(t, [(0, 9), (0.3, 10), (0.95, 10), (1.1, 9), (1.65, 9), (1.8, 8), (seconds, 8)])
        level = curve(t, [(0, 0), (0.35, 0.85), (0.9, 0.9), (2.0, 0.8), (3.0, 0.4), (4.4, 0.1), (seconds, 0)])
        sung_cents = curve(t, [(0, 386), (1.0, 386), (1.12, 204), (1.7, 204), (1.82, 0), (seconds, 0)])
        sung = curve(t, [(0, 0), (0.3, 0.8), (0.9, 1.0), (2.0, 0.9), (3.0, 0.45), (4.4, 0.05), (seconds, 0)])
    return room(wooden_drone(cents, over, level, sung_cents, sung), 1.3, 0.5, 0.2)


def drone8(kind):
    """`drone5` with nothing falling at the end: no sag, and the last
    overtone held. The close's three breaths are kept apart another way:
    each sinks further between swells in level, scoops 22 cents up into
    pitch, and the mouth opens up into its overtone. (A flatter try, 10
    cents and shallow troughs, was too constant.)"""
    seconds = 4.4 if kind == 'open' else 6.0
    n = int(SR * seconds)
    t = np.arange(n) / SR
    if kind == 'open':
        cents = curve(t, [(0, -60), (0.25, 0), (0.62, -25), (0.9, 0), (1.35, -25), (1.65, 0), (seconds, 0)])
        over = curve(t, [(0, 6), (0.2, 8), (0.55, 8), (0.75, 9), (1.3, 9), (1.5, 10), (seconds, 10)])
        level = curve(t, [(0, 0), (0.3, 0.75), (0.62, 0.3), (1.0, 0.9), (1.35, 0.35), (1.75, 1.0), (2.3, 0.7),
                          (3.0, 0.3), (3.7, 0.08), (seconds, 0)])
        sung = curve(t, [(0, 0), (0.3, 0), (0.9, 0.6), (1.35, 0.55), (1.8, 1.0), (2.4, 0.75), (3.1, 0.3),
                         (3.8, 0.03), (seconds, 0)])
    else:
        cents = curve(t, [(0, -40), (0.14, 0), (0.95, -22), (1.22, 0), (2.2, -22), (2.6, 0), (seconds, 0)])
        over = curve(t, [(0, 9), (0.16, 10), (0.9, 10), (1.0, 8.5), (1.32, 9), (2.1, 9), (2.25, 7.5), (2.85, 8),
                         (seconds, 8)])
        level = curve(t, [(0, 0), (0.17, 1.0), (0.45, 0.9), (0.95, 0.22), (1.36, 0.8), (1.6, 0.75), (2.2, 0.18),
                          (2.9, 0.6), (3.9, 0.3), (4.9, 0.08), (seconds, 0)])
        sung = curve(t, [(0, 0), (0.17, 0.8), (0.9, 0.35), (1.36, 0.9), (2.2, 0.3), (2.9, 0.7), (3.8, 0.3),
                         (4.8, 0.04), (seconds, 0)])
    return room(wooden_drone(cents, over, level, np.zeros(n), sung), 1.3, 0.5, 0.2)


def drone9(kind):
    """`drone6` with a close that has no step in it: two pulses on D,
    one-twoooo. A short dark one, then a long one that opens, takes the
    string and the stepping overtones, and fades. The opening is drone6's."""
    if kind == 'open':
        return drone6(kind)
    seconds = 5.8
    n = int(SR * seconds)
    t = np.arange(n) / SR
    cents = curve(t, [(0, -30), (0.15, 0), (0.7, -15), (0.95, 0), (seconds, 0)])
    # Dark for the first pulse (the mouth between two harmonics, so neither sings), open for the second.
    over = curve(t, [(0, 6.5), (0.7, 6.5), (1.05, 10), (2.3, 10), (2.45, 9), (3.2, 9), (3.35, 8), (seconds, 8)])
    level = curve(t, [(0, 0), (0.16, 0.74), (0.38, 0.76), (0.7, 0.16), (1.05, 0.9), (1.5, 1.0), (2.4, 0.8), (3.4, 0.45),
                      (4.6, 0.12), (seconds, 0)])
    sung = curve(t, [(0, 0), (0.75, 0), (1.15, 0.8), (1.7, 1.0), (2.6, 0.8), (3.6, 0.35), (4.7, 0.05), (seconds, 0)])
    return room(wooden_drone(cents, over, level, np.zeros(n), sung, string_lu=-5.0), 1.3, 0.5, 0.2)


def autograph5(kind):
    """`autograph3` with a wave where its cloud was: the word is written in
    sand. Open: as it comes into focus a wave is already running in under
    it, breaks over it and draws back, and the word goes with the water.
    Close: the word comes up out of a blur, a slower wave covers it, and the
    last thing heard is the water drawing back. (The other order, the wave first
    and the word left ringing after it, is a low held note over surf: the
    tagger scored it 0.44 as a foghorn, and 0.21 with the old fall of a
    fourth. This order scores 0.17.)"""
    seconds = 3.8 if kind == 'open' else 5.1
    n = int(SR * seconds)
    t = np.arange(n) / SR
    top = len(FOCUS) - 1
    if kind == 'open':
        step = 1200 * np.log2(A2 / D3)
        cents = curve(t, [(0, step), (0.38, step), (0.6, 10), (0.85, 0), (seconds, 0)])
        level = curve(t, [(0, 0), (0.3, 0.45), (0.6, 0.6), (1.0, 1.0), (1.35, 1.0), (1.75, 0.6), (2.2, 0.2),
                          (2.7, 0.03), (3.0, 0), (seconds, 0)])
        focus = curve(t, [(0, 0), (0.45, 0), (1.3, top), (1.5, top), (2.4, 3), (seconds, 3)])
        linger = curve(t, [(0, 0), (0.7, 0), (1.0, 4), (1.3, 4), (1.6, 0), (seconds, 0)])
        where = curve(t, [(0, 0), (0.95, 0), (1.2, 1), (1.33, 2), (1.46, 3), (1.6, 4), (seconds, 4)])
        swell = [(0, 0), (0.5, 0), (0.95, 0.15), (1.55, 1.0), (1.95, 0.6), (2.6, 0.25), (3.2, 0.06), (seconds, 0)]
        wash = [(0, 0), (1.1, 0), (1.6, 0.9), (1.85, 1.0), (2.6, 0.7), (3.2, 0.25), (seconds, 0)]
    else:
        cents = np.zeros(n)
        # The word comes up over most of a second, out of a blur: arriving at once and sharp was too hard a start.
        level = curve(t, [(0, 0), (0.2, 0.2), (0.5, 0.7), (0.8, 1.0), (1.3, 0.95), (1.9, 0.55), (2.5, 0.2),
                          (3.1, 0.04), (3.4, 0), (seconds, 0)])
        focus = curve(t, [(0, 2), (0.45, 7), (0.85, top), (1.3, top), (2.7, 3), (seconds, 3)])
        linger = curve(t, [(0, 0), (0.6, 4), (1.05, 4), (1.4, 0), (seconds, 0)])
        where = curve(t, [(0, 4), (0.7, 4), (0.82, 3), (0.94, 2), (1.06, 1), (1.2, 0), (seconds, 0)])
        swell = [(0, 0), (0.6, 0), (1.1, 0.12), (1.8, 1.0), (2.3, 0.65), (3.1, 0.3), (3.9, 0.1), (4.6, 0.02),
                 (seconds, 0)]
        wash = [(0, 0), (1.3, 0), (1.85, 0.9), (2.15, 1.0), (3.1, 0.75), (3.9, 0.35), (4.6, 0.08), (seconds, 0)]
    still = np.zeros(n)
    word = sign(52, cents, level, focus, linger, where, still, still)
    return room(at_level(word, 0) + at_level(surf(71, n, swell, wash), -4), 0.8, 0.35, 0.08)


# ---- round 5: a pan ----
# A steel pan played by hand (a Hang, a handpan). Its numbers are measured
# off two recordings of real ones; nothing of the recordings is in it.

B3 = 246.94

# The tone fields: Hz, how far the field's octave and twelfth modes sit from
# true (cents), and where it lies, left to right. A tuner brings a field's
# three modes to within a few cents of 1:2:3, never onto it.
PAN_FIELDS = {
    'D3': (D3 * 2 ** (1.5 / 1200), 7, 4, 0.0),  # the ding, the dome in the middle
    'A3': (A3 * 2 ** (-2 / 1200), -6, 5, 0.10),
    'B3': (B3 * 2 ** (1 / 1200), 5, -4, -0.22),
    'D4': (D4 * 2 ** (2 / 1200), -5, -7, 0.30),
    'E4': (E4 * 2 ** (-1.5 / 1200), 6, -3, -0.34),
    'FS4': (FS4 * 2 ** (1 / 1200), -4, 6, 0.38),
    'A4': (A4 * 2 ** (-1 / 1200), 4, -6, -0.42),
}
PAN_AIR = (D2 * 2 ** (20 / 1200), 0.55)  # the air inside, through the port: Hz, seconds to die
# The knock of a hand on the shell itself: dull, a little above the notes,
# gone in a twentieth of a second. (Hz, seconds, share)
PAN_KNOCK = ((455, 0.05, 0.5), (540, 0.045, 0.6), (630, 0.04, 0.45), (790, 0.03, 0.25))


def pan_shell(seed=23, count=16):
    """The rest of the shell: untuned modes from 2.2 to 7 kHz that any stroke
    wakes and that are gone in a fraction of a second, as (Hz, seconds,
    share). They belong to the instrument, so every note has the same ones
    under it."""
    rng = np.random.default_rng(seed)
    f = 2200 * (7000 / 2200) ** np.sort(rng.random(count))
    return [(fk, rng.uniform(0.06, 0.3) * (2500 / fk) ** 0.5, rng.uniform(0.4, 1.0) * (2500 / fk) ** 0.6) for fk in f]


PAN_SHELL = pan_shell()


def field_modes(name):
    """A field's three tuned modes as (Hz, seconds to fall 60 dB), and where
    it lies. The upper two ring nearly twice as long as the first (measured),
    so a note's tail is thin and high, where a bell's is its lowest tone."""
    f, c2, c3, where = PAN_FIELDS[name]
    die = 1.5 * (f / D4) ** -0.25
    return ((f, die), (2 * f * 2 ** (c2 / 1200), 1.9 * die), (3 * f * 2 ** (c3 / 1200), 1.9 * die)), where


def ringer(x, f, t60, gain):
    """x through one mode of the shell: a resonator ringing at f for t60,
    heard as the steel's speed, not its place, so a slow push under it is
    not a thump. gain is in 1/s: a steady push of 1 at f raises the ring by
    gain a second, and a tap of area 1 starts it at twice gain."""
    r = np.exp(-6.91 / t60 / SR)
    w = 2 * np.pi * f / SR
    return lfilter([gain / SR, 0, -gain / SR], [1, -2 * r * np.cos(w), r * r], x)


def driven(mu, sigma, terms):
    """What a mode (decay mu, sitting sigma rad/s above the frame it is
    pushed in) does when pushed by a sum of decaying terms (coef, lam),
    each meaning coef * exp(-lam t): the same terms scaled, less the ring
    of its own that they start."""
    own = mu + 1j * sigma
    out, start = [], 0
    for coef, lam in terms:
        c = coef / (own - lam)
        out.append((c, lam))
        start += c
    out.append((-start, own))
    return out


def reach(f, soft):
    """How much of a hand's push, soft seconds long, gets to a mode at f."""
    x = f * soft
    return np.abs(np.sinc(x) / (1 - x * x + 1e-9))


def tap(m, seconds):
    """A push of area 1 that rises and lets go, m samples long in all."""
    k = int(seconds * SR)
    out = np.zeros(m)
    out[:k] = np.sin(np.pi * np.arange(k) / k) ** 2
    return out / (out.sum() / SR)


def tick(rng, m, seconds=0.006):
    """Skin leaving steel: a few milliseconds of hiss, peak 1."""
    j = int(SR * 0.03)
    out = np.zeros(m)
    out[:j] = (sosfilt(butter(2, [2300, 9000], 'band', fs=SR, output='sos'), rng.standard_normal(j))
               * np.exp(-np.arange(j) / (seconds * SR)))
    return out / np.abs(out).max()


def stroke(seed, n, name, at, strength=0.8, soft=0.004, edge=0.0, air=None):
    """One stroke of a hand on a field at `at` seconds: (the struck note in
    stereo, what it pushes the rest of the shell with as it rings, the jolt
    of the stroke itself). strength 0..1 is how hard; soft is how long the
    flesh stays on the steel (s), which is how dark the note starts; edge
    -1..1 moves the hand off the middle of the field, along its long axis
    (more octave) or its short one (more twelfth); air is the level of the
    breath through the port, in dB against the note."""
    rng = np.random.default_rng(seed)
    (m1, m2, m3), where = field_modes(name)
    ding = name == 'D3'
    i0 = int(at * SR)
    m = n - i0
    t = np.arange(m) / SR
    push = tap(m, soft) / reach(m1[0], soft)  # so the first mode starts at 1 however soft the hand
    # What the stroke itself starts: mostly the first mode.
    g2 = db(-20 + 8 * max(edge, 0) + rng.uniform(-3, 3))
    g3 = db(-24 + 9 * max(-edge, 0) + rng.uniform(-3, 3))
    # A shell is stiffer the further it swings: the first mode starts about
    # 10 cents sharp (15 for the ding), dips under and has settled in a third
    # of a second. The upper modes, swinging less, don't move. (Measured.)
    sharp, held, dip = (15.0, 0.12, 9.0) if ding else (11.0, 0.09, 3.0)
    cents = strength * (sharp * np.exp(-(t / held) ** 2) - dip * np.exp(-((t - 0.21) / 0.08) ** 2))
    clock = np.cumsum(2 ** (cents / 1200)) / SR
    y = np.interp(clock, t, ringer(push, m1[0], m1[1], 0.5))
    for (f, die), gain in ((m2, g2), (m3, g3)):
        y += ringer(push, f, die, gain / 2)
    # Steel this thin is not linear. The first mode, swinging, pushes the
    # octave at exactly twice its own frequency, and the two together push
    # the twelfth: each blooms a tenth of a second after the stroke, sits a
    # few cents off the push that raised it, and outlasts the mode that fed
    # it. The harder the stroke the more; the ding, a dome and not a dent,
    # gives more of itself than the rest.
    lag = soft / 2
    late = np.clip(t - lag, 0, None)
    mu1, mu2, mu3 = 6.91 / m1[1], 6.91 / m2[1], 6.91 / m3[1]

    def env(terms):
        return sum(c * np.exp(-lam * late) for c, lam in terms)

    two = driven(mu2, 2 * np.pi * (m2[0] - 2 * m1[0]), [(1.0, 2 * mu1)])
    peak = np.abs(env(two)).max()
    two = [(c / peak * db(-12 if ding else -15) * strength, lam) for c, lam in two]
    three = driven(mu3, 2 * np.pi * (m3[0] - 3 * m1[0]), [(c, lam + mu1) for c, lam in two])
    peak = np.abs(env(three)).max()
    three = [(c / peak * db(-9 if ding else -18) * strength ** 2, lam) for c, lam in three]
    ph = 2 * np.pi * m1[0] * np.clip(clock - lag, 0, None) + rng.uniform(0, 2 * np.pi)
    y += (t >= lag) * np.real(env(two) * np.exp(2j * ph) + env(three) * np.exp(3j * ph))
    # The rest of the shell under the hand, its knock, and the skin.
    jolt = tap(m, 0.0006)
    shell = np.zeros(m)
    for f, die, gain in PAN_SHELL:
        shell += ringer(jolt, f * (1 + 0.004 * rng.uniform(-1, 1)), die, gain * rng.uniform(0.5, 1.0) / 2)
    knock = sum(ringer(jolt, f, die, gain / 2) for f, die, gain in PAN_KNOCK)
    y += (db(-30) * strength * shell / np.abs(shell).max() + db(-14) * strength * knock
          + db(-20) * strength ** 1.5 * tick(rng, m))
    # The air inside, pushed out through the port: a low breath under the stroke.
    air = (-4.0 if ding else -30.0) if air is None else air
    breath = ringer(tap(m, soft) / reach(PAN_AIR[0], soft), PAN_AIR[0], PAN_AIR[1], db(air) / 2)
    out = np.zeros((n, 2))
    out[i0:] = strength * (pan(y, where) + pan(breath, 0.0))
    shove, kick = np.zeros(n), np.zeros(n)
    shove[i0:] = strength * y
    kick[i0:] = strength * jolt
    return out, shove, kick


def tak(seed, n, at, strength=0.35, where=0.0, dull=False):
    """A ghost stroke, on the steel between the fields: no note, only the
    knock of the hand, and every field jolted a little. dull is the flat of
    the hand, not a fingertip. Returns what `stroke` does."""
    rng = np.random.default_rng(seed)
    i0 = int(at * SR)
    m = n - i0
    jolt = tap(m, 0.002 if dull else 0.0006)
    y = db(-8) * sum(ringer(jolt, f, die, gain / 2) for f, die, gain in PAN_KNOCK)
    if not dull:
        shell = sum(ringer(jolt, f * (1 + 0.004 * rng.uniform(-1, 1)), die, gain * rng.uniform(0.5, 1.0) / 2)
                    for f, die, gain in PAN_SHELL)
        y = y + db(-24) * shell / np.abs(shell).max() + db(-20) * strength ** 0.5 * tick(rng, m)
    out = np.zeros((n, 2))
    out[i0:] = strength * pan(y, where)
    kick = np.zeros(n)
    kick[i0:] = strength * jolt
    return out, np.zeros(n), kick


def shell_answer(seed, n, name, shove, kick, give=3.5, jolt=-22.0):
    """The fields that weren't struck. Each mode of each is pushed by the
    shell as the struck note rings, and answers where it is in tune, a few
    cents from what pushed it: the ding's octave and twelfth are mostly the
    D4 and A4 fields. And the stroke itself jolts them all, about 22 dB
    under the note. Without that a pan's note is a clean tone, which the
    tagger calls a clang; with it the whole instrument is in every note."""
    rng = np.random.default_rng(seed + 500)
    out = np.zeros((n, 2))
    for other in PAN_FIELDS:
        if other == name:
            continue
        modes, where = field_modes(other)
        y = np.zeros(n)
        for (f, die), share, hit in zip(modes, (1.0, 0.7, 0.5), (1.0, 0.12, 0.05)):
            y += ringer(shove, f, die, give * share) + ringer(kick, f, die, db(jolt) * hit * rng.uniform(0.3, 1.0) / 2)
        out += pan(y, where)
    return out


def handpan_dry(seed, n, strokes, rest=None):
    """A pan played: strokes are (field, at s, strength, soft s, edge), or
    ('tak', at s, strength, where) for a ghost stroke. rest is (at s, over
    s) for a hand laid on the pan to end it: a dull pat, and the ring dies
    under the hand. Dry, stereo."""
    out = np.zeros((n, 2))
    for i, s in enumerate(strokes):
        name, at = s[0], s[1]
        if name == 'tak':
            note, shove, kick = tak(seed + i, n, at, *s[2:])
        else:
            note, shove, kick = stroke(seed + i, n, name, at, *s[2:])
        out += note + shell_answer(seed + i, n, name, shove, kick)
    if rest:
        at, over = rest
        out *= db(-30 * np.clip((np.arange(n) / SR - at) / over, 0, 1) ** 0.7)[:, None]
        out += tak(seed + 90, n, at, 0.3, dull=True)[0]
    return out


PAN_ROLL = {  # field, at s, strength, soft s; the top field is filled in
    'open': (('D3', 0.05, 0.85, 0.005), ('A3', 0.21, 0.72, 0.004), (None, 0.39, 0.8, 0.0035)),
    'close': ((None, 0.05, 0.8, 0.0035), ('A3', 0.27, 0.7, 0.004), ('D3', 0.55, 0.85, 0.0055)),
}


def pan_roll(kind, seconds, top='FS4', pace=1.0, touch=1.0, wait=0.0, first=(), rest=None, more=()):
    """ripples' three notes on the pan: the ding with the breath of its air
    under it, the fifth, a top field; back down to the ding to close. A pace
    under 1 leaves that much longer between them; touch under 1 is a
    lighter, darker hand; wait holds the whole roll back (s). first is
    strokes to play before it (the roll then waits for the last of them);
    more is strokes besides it, at the times they give."""
    late = wait + (first[-1][1] + 0.12 if first else 0.0)
    strokes = list(first) + [(field or top, late + at / pace, strength * touch, soft / touch ** 0.5)
                             for field, at, strength, soft in PAN_ROLL[kind]] + list(more)
    return handpan_dry(41, int(SR * seconds / pace), strokes, rest)


def handpan(kind):
    """`ripples` on steel: its three notes on a hand-played pan, nothing
    else. The ding first, with the low breath of the air inside it."""
    return room(pan_roll(kind, 3.8 if kind == 'open' else 4.8), 1.1, 0.45, 0.2)


def handpan2(kind):
    """`handpan` with the hand in it. Open: a ghost tap on the bare steel
    before the roll, the hand arriving. Close: two seconds into the ring
    the hand is laid on the pan, a dull pat, and the ring dies under it."""
    if kind == 'open':
        return room(pan_roll(kind, 3.9, first=[('tak', 0.05, 0.5, -0.15)]), 1.1, 0.45, 0.2)
    return room(pan_roll(kind, 4.4, rest=(2.0, 0.5)), 1.1, 0.45, 0.2)


def handpan3(kind):
    """`ripples4` on steel: the pan's roll over the same bowed string. Open:
    it swells in under the roll. Close: it is the low D, an octave under
    the ding."""
    seconds = 4.6 if kind == 'open' else 6.6
    out = at_level(pan_roll(kind, seconds), 0)
    out += at_level(low_string(kind, seconds), -8)
    return room(out, 1.1, 0.45, 0.2)


def handpan4(kind):
    """The pan at the water's edge: `autograph5`'s wave runs in over the
    ring of the roll, breaks and draws back. The close has a slower wave."""
    seconds = 4.6 if kind == 'open' else 5.6
    if kind == 'open':
        swell = [(0, 0), (0.4, 0), (0.9, 0.12), (1.6, 1.0), (2.05, 0.62), (2.8, 0.28), (3.5, 0.09), (4.1, 0.02),
                 (seconds, 0)]
        wash = [(0, 0), (1.1, 0), (1.65, 0.9), (1.95, 1.0), (2.6, 0.65), (3.3, 0.28), (4.0, 0.05), (seconds, 0)]
    else:
        swell = [(0, 0), (0.8, 0), (1.4, 0.12), (2.2, 1.0), (2.7, 0.65), (3.5, 0.3), (4.3, 0.1), (5.0, 0.02),
                 (seconds, 0)]
        wash = [(0, 0), (1.7, 0), (2.25, 0.9), (2.55, 1.0), (3.5, 0.75), (4.3, 0.35), (5.1, 0.08), (seconds, 0)]
    out = at_level(pan_roll(kind, seconds), 0) + at_level(surf(71, int(SR * seconds), swell, wash), -6)
    return room(out, 1.0, 0.4, 0.14)


def handpan5(kind):
    """`bloom8` with the pan playing its chord through it, where the plucked
    glints were: the ding, the fifth and the ninth, with a light hand, 6 LU
    under the voices."""
    return bloom_of(kind, voices=choir(HUM_NINTH), pace=0.7, blur=2.4, steel=('E4', -6.0))


def handpan6(kind):
    """`handpan` as `bloom8` would have it: at 0.7 of the pace, and the
    ninth on top where the F sharp was, so it ends open, not sunny."""
    return room(pan_roll(kind, 3.1 if kind == 'open' else 3.7, 'E4', pace=0.7), 1.1, 0.45, 0.2)


def bloom9(kind):
    """`bloom7` to open and `bloom8` to close: the happier one going in, the
    more restful one coming out. The opening ends with F sharp on top; the
    close begins from the ninth and comes down to the root."""
    return bloom7(kind) if kind == 'open' else bloom8(kind)


# ---- round 5: bloom8 with another core ----
# The same arc (the chord, the pace, the dark drone under it, the glints on
# top) with the humming voices replaced. Each core plays the voices' parts
# from hum_parts().

def mouth_gain(f, o, r, vt=1.0, blur=1.0, shut_db=0.0):
    """The hum's tract as a response in Hz: mouth o (0 closed to 1 open),
    rounding r (0 'ah' to 1 'oo'), the cascade sing() uses, without its
    restless jaw, so that anything can be put through a mouth."""
    gain = 0
    for i, ((mc, mw, ml), (ac, aw, al), (uc, uw, ul)) in enumerate(zip(TRACT['m'], TRACT['a'], TRACT['oo'])):
        centre = vt * mc ** (1 - o) * (ac ** (1 - r) * uc ** r) ** o
        width = blur * mw ** (1 - o) * (aw ** (1 - r) * uw ** r) ** o
        peak = db(ml * (1 - o) + (al * (1 - r) + ul * r) * o + (shut_db * (1 - o) if i else 0.0))
        gain = gain + (-1) ** i * peak * (width / 2) / (width / 2 + 1j * (f - centre))
    return gain * db(HUM_DB * (1 - o))


def through_mouth(x, mouth, rounding, vt=1.0, blur=1.0, shut_db=0.0, floor_db=-30.0):
    """x heard through a mouth that moves as the per-sample curves say.
    floor_db is how much of x gets past a shut mouth whatever the tract
    says, so the source is never filtered to nothing."""
    at = np.arange(0, len(x), HOP)
    o, r = mouth[at], rounding[at]

    def gain(f, tt):
        i = np.minimum((tt * SR / HOP).astype(int), len(at) - 1)
        return np.maximum(np.abs(mouth_gain(f, o[i], r[i], vt, blur, shut_db)), db(floor_db))

    return shaped(x, gain)


def free_reed(seed, base, cents, level, breath=0.09, flat=30.0, open_share=0.5, clip=0.17, top=5500.0):
    """One reed of a harmonica: a tongue of brass swinging in its slot,
    chopping the breath into pulses. Soft breath leaves it almost a sine;
    harder breath clips the flow and the harmonics pour in. A free reed
    sags flat as the breath presses (flat cents at full: less sag scored
    as more of a jingle, more breath as a foghorn), and the breath itself
    is heard through the slot, pulsing with the reed."""
    rng = np.random.default_rng(seed)
    n = len(cents)
    level = np.clip(level, 0, 1)
    cents = cents - flat * level + 5 * wander(n, rng, 0.05, 0.6) + 2.5 * wander(n, rng, 2, 8)
    f0 = base * 2 ** (cents / 1200) * (1 + 0.002 * wander(n, rng, 20, 60))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    e = np.clip(level[np.arange(0, n, HOP)], 0, 1) ** 0.5

    def shape(k, fk):
        # The slot is open for a share of each cycle that shrinks as the
        # breath presses: the dips in the pulse train's spectrum move with it.
        dips = 0.35 + 0.65 * np.abs(np.sin(np.pi * k * (open_share - clip * e)))
        return dips / np.sqrt(1 + (fk / (900 * (top / 900) ** e)) ** 2) * (1 if k == 1 else 0.8)

    tone = voiced(phase, f0, shape, tilt=0.9, fmax=8000.0) * (1 + 0.05 * wander(n, rng, 3, 9))

    def air_gain(f, tt):
        return (f / (f + 400)) / (1 + (f / 2600) ** 2) * np.ones_like(tt)

    air = shaped(rng.standard_normal(n) * (1 + 0.7 * np.sin(phase)), air_gain)
    air *= breath * np.sqrt((tone ** 2).mean() / ((air ** 2).mean() + 1e-20))
    return tone * level + air * level ** 0.6


def harmonica_dry(kind, pace=0.7, voices=None, blur=2.4, breath=0.09, pair=8.0, again=None):
    """The hum's parts on harmonica reeds, blown softly (bloom8's six
    unless voices are given). A part's step is a change of reed, not a
    bend: the first reed is let go as the second is taken up. Each note is
    two reeds a few cents apart (pair), as a tremolo harmonica has them.
    Every reed is heard through the player's mouth doing what the singer's
    did (shut, 'ah', rounding to 'oo'), which on a harmonica is what the
    hands cupped round it do too. (A hand tremolo was tried and scored as
    a foghorn or an organ.) again is a second breath: (when it starts and
    how long it takes, in the score's seconds, how much it adds to the
    level, how far the mouth opens for it)."""
    seconds = 3.4 if kind == 'open' else 6.6
    n = int(SR * seconds / pace)
    t = np.arange(n) / SR * pace

    def reeds(seed, f, level):
        x = free_reed(seed, f, np.zeros(n), level, breath)
        if pair:
            x = 0.5 * (x + free_reed(seed + 7, f * 2 ** (pair / 1200), np.zeros(n), level, breath))
        return x

    out = np.zeros((n, 2))
    for voice, cents, mouth, rounding, level, settled in hum_parts(kind, seconds, voices or choir(HUM_NINTH), True,
                                                                  True, pace):
        seed, vt, pickup, home, rest, late, where, gain, _ = voice
        if again:
            at, over, size, ajar = again
            swell = np.sin(np.pi * np.clip((t - at) / over, 0, 1) ** 0.55) ** 2  # quicker in than out
            level, mouth = level + size * swell, np.maximum(mouth, ajar * swell)
        start, end = (pickup, home) if kind == 'open' else (home, rest)
        step = 1200 * np.log2(start / end)
        if abs(step) > 1:
            # Which reed: the start note's until the part's pitch crosses to the end note's.
            w = np.clip((cents - step) / (0 - step), 0, 1)
            w = np.clip(sosfilt(butter(2, 6, 'low', fs=SR, output='sos'), w), 0, 1)
            sig = reeds(seed + 60, start, level * (1 - w)) + reeds(seed + 61, end, level * w)
        else:
            sig = reeds(seed + 60, start, level)
        sig = through_mouth(sig, mouth, rounding, vt, blur, shut_db=-8.0, floor_db=-24.0)
        out += pan(gain * sig, 0.7 * where)
    return out


def bar(f0, seconds, v, rng):
    """One soft-mallet stroke on a marimba bar: partials tuned 1 : 4 : 10
    as a marimba's are, the low one held up by the tube under the bar, the
    others gone in a breath; v (0..1) is how hard, which also decides how
    much of the upper partials speak. A yarn mallet's thump under it."""
    t = np.arange(int(SR * seconds)) / SR
    y = np.zeros(len(t))
    low = 0.7 * (220 / f0) ** 0.35  # low bars ring longer
    # A longer ring and a weaker fourth partial scored as a gong on the close.
    for ratio, amp, t60, bright in ((1.0, 1.0, low, 0.0), (4.0 * (1 + 0.003 * rng.standard_normal()), 0.45, 0.28, 0.6),
                                    (10.0 * (1 + 0.01 * rng.standard_normal()), 0.1, 0.09, 2.5)):
        f = f0 * ratio * 2 ** (2 * rng.standard_normal() / 1200)
        y += amp * v ** (1 + bright) * np.exp(-6.91 * t / t60) * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))
    y *= 1 - np.exp(-t / 0.0025)
    m = int(SR * 0.008)
    thump = sosfilt(butter(2, 420, 'low', fs=SR, output='sos'), rng.standard_normal(m) * np.hanning(m))
    y[:m] += 0.9 * v * thump / (np.abs(thump).max() + 1e-12)
    return y


def bar_roll(seed, f0, level, rate=8.5, ring=1.6):
    """A bar rolled: strokes at about rate a second, never evenly, each as
    hard as level (per sample) says at that moment, so the roll can come up
    from barely touching the bar."""
    rng = np.random.default_rng(seed)
    n = len(level)
    out = np.zeros(n)
    t = rng.uniform(0, 1 / rate)
    while t < n / SR:
        i = int(t * SR)
        v = level[i] * (1 + 0.12 * rng.standard_normal())
        if v > 0.01:
            hit = bar(f0, min(ring, (n - i) / SR), float(np.clip(v, 0, 1)), rng)
            out[i:i + len(hit)] += hit
        t += (1 / rate) * rng.uniform(0.82, 1.18)
    return out


def marimba_dry(kind, pace=0.7, voices=HUM_NINTH):
    """The hum's parts rolled on marimba bars with soft mallets: for
    bloom8's trio, F sharp and A held and D rolled up to E to open (E back
    down to D to close). A step is two rolls crossing: the roll on the next
    bar begins as the one on the last is let ring."""
    seconds = 3.4 if kind == 'open' else 6.6
    n = int(SR * seconds / pace)
    out = np.zeros((n, 2))
    for voice, cents, mouth, rounding, level, settled in hum_parts(kind, seconds, voices, True, True, pace):
        seed, vt, pickup, home, rest, late, where, gain, _ = voice
        start, end = (pickup, home) if kind == 'open' else (home, rest)
        step = 1200 * np.log2(start / end)
        if abs(step) > 1:
            w = np.clip((cents - step) / (0 - step), 0, 1)
            sig = bar_roll(seed + 40, start, level * (1 - w)) + bar_roll(seed + 41, end, level * w)
        else:
            sig = bar_roll(seed + 40, home, level)
        out += pan(gain * sig, 0.7 * where)
    return out


def harmonica(kind):
    """`bloom8` with the choir replaced by a harmonica, blown softly, that
    keeps the path the mouths traced. Six notes on paired reeds take the six
    parts; the top one changes reed for its step. Each is heard through the
    mouth and hands its singer's part asks for: shut as the chord swells
    in, open on the step, rounding as it settles, so the chord still goes
    'aaa-ooo'. The drone and the glints are bloom8's."""
    return bloom_of(kind, pace=0.7, top=E4, core=harmonica_dry)


def marimba(kind):
    """`bloom8` with the choir replaced by a marimba rolled with soft
    mallets: wood, and no vowel in it. The chord comes up from strokes too
    light to hear, the top bar moves from D to E (and back to close), and
    the rolls thin out as the hands lift. The drone and the glints are
    bloom8's."""
    return bloom_of(kind, pace=0.7, top=E4, core=marimba_dry)


def marimba2(kind):
    """A duet: the marimba holds F sharp and A in a soft roll, and the
    harmonica takes the top part alone, D stepping up to E through the
    opening mouth, and back down to close. The vowel path is on the one
    line that moves. The reeds sit 3 LU under the wood (level with it, the
    opening scored as a television jingle)."""
    def duet(kind, pace):
        nine = choir(HUM_NINTH)
        return (at_level(marimba_dry(kind, pace, HUM_NINTH[:2]), 0)
                + at_level(harmonica_dry(kind, pace, (nine[2], nine[5])), -3.0))

    return bloom_of(kind, pace=0.7, top=E4, core=duet)


# ---- round 6 ----

def handpan7(kind):
    """`handpan` with a fourth note: E, a step under the F sharp. Open: it
    answers the roll a beat later, softly, and the two ring on a step
    apart. Close: it is a grace note into the F sharp, and the roll comes
    down from the pair."""
    if kind == 'open':
        return room(pan_roll(kind, 3.8, more=[('E4', 0.93, 0.5, 0.0045)]), 1.1, 0.45, 0.2)
    return room(pan_roll(kind, 4.8, wait=0.08, more=[('E4', 0.05, 0.45, 0.004)]), 1.1, 0.45, 0.2)


def handpan8(kind):
    """`handpan2` with a slower hand to end the close: it is laid on the
    pan 0.3 s sooner and takes that much longer to stop the ring. The
    opening is handpan2's."""
    if kind == 'open':
        return handpan2(kind)
    return room(pan_roll(kind, 4.4, rest=(1.7, 0.8)), 1.1, 0.45, 0.2)


def handpan9(kind):
    """`handpan6` with two hands on the top note: B, a fourth under the E,
    a moment apart from it. The opening rolls up into the pair (B first);
    the close starts from it (E first)."""
    seconds, at = (3.1, 0.39 / 0.7 - 0.03) if kind == 'open' else (3.7, 0.05 / 0.7 + 0.03)
    return room(pan_roll(kind, seconds, 'E4', pace=0.7, more=[('B3', at, 0.62, 0.004)]), 1.1, 0.45, 0.2)


def harmonica2(kind):
    """`harmonica` with a second breath in the close: as the chord fades the
    mouth half opens again, on 'oo', and the reeds swell once more, far
    quieter, and sink back. The opening is harmonica's."""
    if kind == 'open':
        return harmonica(kind)
    return bloom_of(kind, pace=0.7, top=E4,
                    core=lambda kind, pace: harmonica_dry(kind, pace, again=(3.3, 2.6, 0.2, 0.7)))


CANDIDATES = {
    # name: (render, what it is, why it isn't a bowl or bell)
    'hum': (hum,
            "Three voices humming a chord and letting it open: 'mm' into 'ah', every voice stepping up as "
            "the mouths open. The close is the same breath backwards, 'ah' sinking into 'mm'.",
            'Harmonic partials that all move together with one wavering pitch, a breath-led start with no strike, '
            'and a timbre that opens and closes while it sounds.'),
    'drone': (drone,
              'A low breath-driven drone, a cousin of the didgeridoo and the jaw harp, with three overtones '
              'stepping out of it: up to open, down to close.',
              'A buzz kept alive by breath, not a ring dying away; the pitch stays put while the mouth picks '
              'overtones out of it one at a time.'),
    'breath': (breath,
               'Air that becomes a note: a breath in, then a blown tone rising into pitch. '
               'The close lets the tone sag and go in a long breath out.',
               'Mostly air: a blown pipe tone swelling in over a quarter of a second, bending with the '
               'pressure behind it, held up by breath and gone when the breath goes.'),
    'ripples': (ripples,
                'Three ripples across three strings: a slow thumb over D, A and F sharp, rising to open, '
                'falling back to the root to close.',
                'Plucked nylon on a wooden body: harmonic partials whose top dies in a fraction of a second, '
                'where a bowl is inharmonic and rings for ten.'),
    'autograph': (autograph,
                  "The wild one: a wave that is a drawing. Left is a pen's x, right its y, and one cycle of the "
                  'wave is the word aloud in handwriting. It starts as a pure tone (an ellipse: the orb), comes '
                  'into focus as the word, then the pen lingers on each letter in turn. The close unwrites it.',
                  'Not an instrument at all. No partials ringing down: each harmonic is there because the '
                  'handwriting needs it, and the timbre is redrawn letter by letter.'),
    'bloom': (bloom,
              "The layered experiment: the hum for every speaker, a dark drone under it for the body, "
              'the three ripples an octave up on top.',
              'As the hum: voices, no strike. The string on top is quiet and brief.'),
}


REVISIONS = {
    # name: (render, the sound it revises, what changed and why, round)
    'handpan7': (handpan7, 'handpan',
                 'One more note: E, a step under the F sharp. Open: it answers the roll a beat later, softly, and '
                 'the two ring on a step apart. Close: it is a grace note into the F sharp, and the roll comes down '
                 'from the pair to the ding.', 6),
    'handpan8': (handpan8, 'handpan2',
                 'A slower hand to end the close: it is laid on the pan a third of a second sooner and takes that '
                 "much longer to stop the ring. The length is the same, and the opening is handpan2's.", 6),
    'handpan9': (handpan9, 'handpan6',
                 'Two hands on the top note: B, a fourth under the E, struck a moment apart from it. The opening '
                 'rolls up into the pair and the close starts from it.', 6),
    'harmonica2': (harmonica2, 'harmonica',
                   "A second breath in the close: as the chord fades the mouth half opens again, on 'oo', and the "
                   "reeds swell once more, far quieter, and sink back. The opening is harmonica's.", 6),
    'handpan': (handpan, 'ripples',
                "ripples' three notes on a hand-played steel pan, and nothing else: the ding (the low note in the "
                'middle, with the breath of the air inside it underneath), the fifth, the F sharp. The close comes '
                'back down to the ding. Each note opens into its octave a moment after the hand, and the rest of '
                'the pan rings with it.', 5),
    'handpan2': (handpan2, 'handpan',
                 'The hand in it. Open: a ghost tap on the bare steel before the roll, the hand arriving. Close: '
                 'two seconds into the ring the hand is laid on the pan, a dull pat, and the ring dies under it.', 5),
    'handpan3': (handpan3, 'ripples4',
                 "ripples4 on steel: the pan's roll over the same bowed string. Open: the string swells in under "
                 'the roll. Close: it is the low D, an octave under the ding.', 5),
    'handpan4': (handpan4, 'handpan',
                 "The pan at the water's edge: autograph5's wave runs in over the ring of the roll, breaks and "
                 'draws back. The close has a slower wave.', 5),
    'handpan5': (handpan5, 'bloom8',
                 'bloom8 with the pan playing its chord through it, where the plucked glints were: the ding, the '
                 'fifth and the ninth, with a light hand, under the voices.', 5),
    'handpan6': (handpan6, 'handpan',
                 "The pan alone, as bloom8 would have it: at 0.7 of the pace, with the ninth (E) on top where the "
                 'F sharp was, so it ends open, not sunny.', 5),
    'harmonica': (harmonica, 'bloom8',
                  "bloom8 with the voices replaced by a harmonica, blown softly, that keeps the path the mouths "
                  "traced: every reed is heard through a mouth and cupped hands doing what the singer's did, shut, "
                  "then 'ah', then rounding to 'oo'. The top note changes reed for its step. The drone and the "
                  "glints are bloom8's.", 5),
    'marimba': (marimba, 'bloom8',
                'bloom8 with the voices replaced by a marimba rolled with soft mallets: wood, and no vowel in it. '
                'The chord comes up from strokes too light to hear, the top bar moves from D to E (and back to '
                "close), and the rolls thin out as the hands lift. The drone and the glints are bloom8's.", 5),
    'marimba2': (marimba2, 'marimba',
                 'A duet: the marimba holds F sharp and A, and the harmonica takes the one line that moves, D up '
                 'to E through the opening mouth, and back down to close.', 5),
    'bloom9': (bloom9, 'bloom8',
               "A pairing, not a new sound: bloom7's opening with bloom8's close. The happier one going in, the "
               'more restful one coming out.', 5),
    'bloom4': (bloom4, 'bloom3',
               'A softer start: the voices take about twice as long to arrive. Nothing else is changed.', 4),
    'bloom5': (bloom5, 'bloom3',
               'A texture, on the softer start: a crowd where there were six. Twelve voices, four to a part, '
               'none of them quite together. Less a few mouths, more a room humming.', 4),
    'bloom6': (bloom6, 'bloom3',
               'A texture, on the softer start: three bowed strings play the three parts under the voices.', 4),
    'bloom7': (bloom7, 'bloom3',
               'At 0.7 speed, on the softer start: every gesture takes 1.4 times as long, at the same pitch. '
               'Slower voices scored as more of a chant, so the vowels are smeared a little further.', 4),
    'bloom8': (bloom8, 'bloom3',
               'At 0.7 speed, with the sun taken off the top of the chord. The lower voices hold F sharp and '
               'A; only the top one moves, from D up a step to E to open and back down to close. On a phone, '
               'without the low D, it leans minor.', 4),
    'drone6': (drone6, 'drone3',
               'Nothing falls: no sag at the end, and the last overtone is held. The close is rebuilt, since a '
               'held low note that drops is a foghorn: the bass comes home from below as in the opening (A up '
               'to D). It starts as the bass alone, dark and held back; the mouth opens and the string joins '
               'as it lands on D, and the overtones step down from there.', 4),
    'drone7': (drone7, 'drone4', 'Nothing falls at the end: no sag, and the last overtone is held.', 4),
    'drone8': (drone8, 'drone5',
               'Nothing falls at the end: no sag, and the last overtone held. The three breaths of the close '
               'are set further apart: each sinks lower between swells, scoops up into pitch, and the mouth '
               'opens up into its overtone. The first breath arrives quickly, the second a little quicker '
               'than it did.', 4),
    'drone9': (drone9, 'drone6',
               'The close with no step in it: two pulses on D, one-twoooo. A short dark one, then a long one '
               'that opens, takes the string and the stepping overtones, and fades. The opening is drone6\'s.', 4),
    'autograph5': (autograph5, 'autograph3',
                   'A wave where the cloud was: the word is written in sand. Open: as it comes into focus a '
                   'wave is already running in under it, breaks over it and draws back, and the word goes '
                   'with the water. Close: the word comes up out of a blur, a slower wave covers it, and '
                   'the last thing heard is the water drawing back.', 4),
    'ripples4': (ripples4, 'ripples3',
                 'The bowed string moved. Open: it swells in under the roll and is already singing when the '
                 'last string is plucked. Close: it is the low D, an octave under the last pluck, the next '
                 'step down.', 3),
    'bloom3': (bloom3, 'bloom2',
               'Saying less: every formant is nearly twice as wide, so the same sound opens and closes '
               'without settling on a vowel, and the vibrato is about half. The tick at the start of the '
               'close was the first plucked string landing before the voices: it eases in now, and waits '
               'for them.', 3),
    'drone3': (drone3, 'drone2',
               'A step in the bass. Open: it starts a fourth low, on A, and steps up to D as the overtones and '
               'the string arrive. Close: it starts a fourth high, on G, string and all, and settles onto D.', 3),
    'drone4': (drone4, 'drone2',
               'The string climbs. The bass holds D while the bowed string walks D, E, F sharp with the three '
               'overtones, two octaves under them. The close walks back down.', 3),
    'drone5': (drone5, 'drone2',
               'Three breaths: the three ripples as three swells of the bass, one overtone to each, each '
               'scooping up into pitch. Open: they grow. Close: they slow, sink and fade.', 3),
    'autograph3': (autograph3, 'autograph2',
                   'By your words: one arc, not two humps. From the moment the word is in focus the line '
                   'starts coming loose, the cloud is the word losing its hold on the page, and the whole of '
                   'it is already fading. The close gathers the same way, in one rise.', 3),
    'autograph4': (autograph4, 'autograph2',
                   'By instinct: the pen writes the word once. The wave is still the word, but the hand also '
                   'moves through it at writing speed: pitch follows the height of the pen (l and d are the '
                   'two tall leaps), the sound travels left to right, sharper where the pen runs. Open: the '
                   'orb, the word, a flick and it is off the page. Close: written again, slower, then '
                   'underlined, one long low stroke back to the start.', 3),
    'ripples2': (ripples2, 'ripples',
                 'A chord on the last note: A and E go with the F sharp, so the roll ends on D with a ninth '
                 'added. The close starts from that chord and takes a fourth step, down to the low D.', 2),
    'ripples3': (ripples3, 'ripples',
                 'An undertone: as the last string is let go, a bowed string takes up the root beneath it '
                 'and sings on after the plucks have died. In the close it is the fourth thing to happen.', 2),
    'bloom2': (bloom2, 'bloom',
               "Quicker and less synthetic, I hope. The opening's hum is a grace note, not a held 'mm', and "
               "it is over in three seconds, not five. Six voices where there were three, and a closed mouth "
               "that is darker so it reads as 'mm'. The close keeps bloom's shape with those voices.", 2),
    'drone2': (drone2, 'drone',
               'The edge taken off (less buzz above 1.5 kHz, a broader overtone, less hiss), the whole of it '
               'heard through a cello-sized wooden body, and a bowed string singing the D an octave above as '
               'the overtones climb. A little shorter.', 2),
    'autograph2': (autograph2, 'autograph',
                   'The same start, then as soon as the word is in focus it puffs into a cloud and is gone: '
                   '2.8 s, was 5. The close now mirrors it: it gathers out of a puff into the word, blurs '
                   'back down to the orb as the pitch falls the fourth the opening rose, and shrinks away. '
                   'Less like a machine: three slightly different hands take turns writing it, the pen rubs '
                   'on the paper, the pitch wanders more.', 2),
}
RENDER = {**{name: c[0] for name, c in CANDIDATES.items()}, **{name: r[0] for name, r in REVISIONS.items()}}

# The revisions still in the running, in the order the page lists them. Above
# them it puts the latest round's, until they are in this list or the round is old.
LIVE = ('ripples2', 'ripples4', 'handpan', 'handpan2', 'handpan5', 'handpan6', 'handpan7', 'handpan8', 'handpan9',
        'bloom4', 'bloom5', 'bloom6', 'bloom7', 'bloom8', 'bloom9', 'harmonica', 'harmonica2', 'marimba', 'drone6',
        'drone7', 'drone8', 'drone9', 'autograph5')

DRAWN = ('autograph', 'autograph2', 'autograph3', 'autograph4', 'autograph5')  # directions whose stereo wave is a picture


# ---- measuring and writing ----

def phone(sig, rate):
    """What a call-quality link passes, still at 48 kHz: mono, 300-3400 Hz
    for an 8 kHz link, 50-7000 Hz for a 16 kHz one."""
    lo, hi = (300, 3400) if rate == 8000 else (50, 7000)
    mono = sosfilt(butter(2, lo, 'high', fs=SR, output='sos'), sig.mean(axis=1))
    return sosfilt(butter(10, hi, 'low', fs=SR, output='sos'), mono)


def rise_ms(sig):
    """How long the start takes to climb from 30 dB under the sound's peak to
    6 dB under it, on a 10 ms envelope. A strike does it in a few ms."""
    w = int(SR * 0.01)
    env = np.sqrt(np.convolve((sig ** 2).sum(axis=1), np.ones(w) / w, 'same'))
    top = env.max()
    a = int(np.argmax(env > top * db(-30)))
    b = int(np.argmax(env > top * db(-6)))
    return (b - a) / SR * 1000


def band_frames(x, lo, hi, frame=0.05):
    y = sosfilt(butter(4, [lo, hi], 'band', fs=SR, output='sos'), x)
    w = int(frame * SR)
    m = len(y) // w
    return 10 * np.log10((y[:m * w].reshape(m, w) ** 2).mean(axis=1) + 1e-20)


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def integrated_lufs(path, start=0.0, seconds=None):
    cmd = ['ffmpeg', '-hide_banner', '-nostats', '-ss', f'{start:.4f}', '-i', path]
    if seconds:
        cmd += ['-t', str(seconds)]
    cmd += ['-af', 'ebur128', '-f', 'null', '-']
    err = subprocess.run(cmd, capture_output=True, text=True).stderr
    line = [l for l in err.splitlines() if l.strip().startswith('I:')][-1]
    return float(line.split()[1])


def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(float)


def write_mp3(path, sig):
    tmp = path + '.tmp.wav'
    wavfile.write(tmp, SR, sig.astype(np.float32))
    run(['ffmpeg', '-y', '-i', tmp, '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', path])
    os.remove(tmp)


def write_phone(path, mono, rate):
    wavfile.write(path, rate, (np.clip(resample_poly(mono, rate, SR), -1, 1) * 32767).astype(np.int16))


def load_voice():
    """The facilitator line at VOICE_LUFS, or None when the take isn't here."""
    if not os.path.exists(VOICE):
        print('no facilitator take at', os.path.relpath(VOICE, HERE), '- skipping the voice mixes')
        return None
    voice = decode(VOICE) * db(VOICE_LUFS - integrated_lufs(VOICE))
    write_mp3(os.path.join(HERE, 'audition', 'voice.mp3'), voice)
    for rate in (16000, 8000):
        write_phone(os.path.join(HERE, 'audition', f'voice.{rate // 1000}k.wav'), phone(voice, rate), rate)
    return voice


def under_voice(sig, voice, at=VOICE_AT):
    """The opening, turned down, with the facilitator's line coming in over it."""
    n = max(len(sig), int(at * SR) + len(voice))
    sound = np.zeros((n, 2))
    sound[:len(sig)] = sig * db(OPEN_UNDER_VOICE_DB)
    speech = np.zeros((n, 2))
    speech[int(at * SR):int(at * SR) + len(voice)] = voice
    return sound, speech


def clearance(sound, speech, seconds):
    """How far the voice stands over the sound where consonants live
    (1-4 kHz), in dB, over the frames in which the voice is speaking and the
    sound (seconds long) hasn't ended: (median, worst tenth), or None when
    the sound is over before the voice starts."""
    v = band_frames(speech.mean(axis=1), 1000, 4000)
    s = band_frames(sound.mean(axis=1), 1000, 4000)
    talking = (v > v.max() - 25) & (np.arange(len(v)) * 0.05 < seconds)
    d = (v - s)[talking]
    return (float(np.median(d)), float(np.percentile(d, 10))) if len(d) else None


def write(name, sig, voice):
    """Write one sound in every format; returns its measurements."""
    sig = finish(sig)
    sig = sig / np.abs(sig).max() * db(WAV_PEAK_DBFS)
    wav = os.path.join(HERE, name + '.wav')
    tmp = os.path.join(HERE, name + '.tmp.wav')
    wavfile.write(tmp, SR, sig.astype(np.float32))
    run(['ffmpeg', '-y', '-i', tmp, '-c:a', 'pcm_s24le', wav])
    os.remove(tmp)

    lufs, start = loudest(sig)
    gain = MP3_MATCH_LUFS - integrated_lufs(wav, start / SR, MP3_MATCH_WINDOW)
    # A sound with a sharp start can't reach the level without clipping; say so.
    held = min(gain, -0.3 - 20 * np.log10(np.abs(sig).max()))
    level = sig * db(held)
    write_mp3(os.path.join(HERE, name + '.mp3'), level)

    run(['ffmpeg', '-y', '-i', wav, '-lavfi',
         'showspectrumpic=s=1200x600:mode=combined:scale=log:fscale=log:legend=1:stop=16000',
         os.path.join(HERE, 'spectrograms', name + '.png')])

    if name.split('-')[0] in DRAWN:
        # Left against right, as an XY oscilloscope shows it. The frame is wide
        # because both channels are at the same level and the word isn't square.
        run(['ffmpeg', '-y', '-i', wav, '-filter_complex',
             '[0:a]avectorscope=s=960x420:mode=lissajous_xy:draw=aaline:rate=30:zoom=0.85:mirror=y'
             ':rc=255:gc=70:bc=150:ac=255:rf=70:gf=70:bf=70:af=70[v]', '-map', '[v]', '-map', '0:a',
             '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '160k',
             os.path.join(HERE, 'audition', name + '-scope.mp4')])

    full = loudest(level)[0]
    m = {'seconds': round(len(sig) / SR, 1), 'riseMs': round(rise_ms(sig)), 'gainDb': round(held, 1),
         'shortDb': round(gain - held, 1)}
    mono = level.mean(axis=1)
    m['monoDb'] = round(loudest(np.stack([mono, mono], axis=1))[0] - full, 1)
    for rate in (16000, 8000):
        band = phone(level, rate)
        write_phone(os.path.join(HERE, 'phone', f'{name}.{rate // 1000}k.wav'), band, rate)
        m[f'phone{rate // 1000}kDb'] = round(loudest(np.stack([band, band], axis=1))[0] - full, 1)
    if voice is not None and name.endswith('-open'):
        sound, speech = under_voice(level, voice)
        write_mp3(os.path.join(HERE, 'audition', name + '-into-voice.mp3'), sound + speech)
        clear = clearance(sound, speech, len(sig) / SR)
        if clear:
            m['clearDb'], m['clearWorstDb'] = (round(x, 1) for x in clear)
    print(f"{name}: mp3 gain {held:+.1f} dB" + (f" ({gain - held:.1f} dB short of level)" if gain - held > 0.05 else '')
          + f", rise {m['riseMs']} ms, mono {m['monoDb']:+.1f}, 16k {m['phone16kDb']:+.1f}, 8k {m['phone8kDb']:+.1f}"
          + (f", voice clear {m['clearDb']:+.1f} / {m['clearWorstDb']:+.1f} dB" if 'clearDb' in m else ''))
    return m


def write_chime():
    """noting's synth chime (playChime in noting-session.ts), to compare against."""
    t = np.arange(int(SR * 0.2)) / SR
    f = np.where(t < 0.1, 440.0, 554.0)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.15 * (0.01 / 0.15) ** (t / 0.2)
    wavfile.write(os.path.join(HERE, 'audition', 'chime.wav'), SR, (y * 32767).astype(np.int16))


def main():
    for d in ('spectrograms', 'phone', 'audition'):
        os.makedirs(os.path.join(HERE, d), exist_ok=True)
    voice = load_voice()
    write_chime()
    data_path = os.path.join(HERE, 'audition', 'measured.json')
    measured = json.load(open(data_path)) if os.path.exists(data_path) else {}
    for name in sys.argv[1:] or list(RENDER):
        for kind in ('open', 'close'):
            measured[f'{name}-{kind}'] = write(f'{name}-{kind}', RENDER[name](kind), voice)
    json.dump(measured, open(data_path, 'w'), indent=1)

    def card(name, **more):
        return {'name': name, 'drawn': name in DRAWN, 'open': measured.get(name + '-open'),
                'close': measured.get(name + '-close'), **more}

    page = {
        'voice': voice is not None, 'voiceAt': VOICE_AT, 'underVoiceDb': OPEN_UNDER_VOICE_DB,
        'live': [name for name in LIVE if name + '-open' in measured],
        'fresh': max(r[3] for r in REVISIONS.values()),
        'revisions': [card(name, was=was, changed=changed, round=round_)
                      for name, (_, was, changed, round_) in REVISIONS.items() if name + '-open' in measured],
        'candidates': [card(name, what=what, why=why)
                       for name, (_, what, why) in CANDIDATES.items() if name + '-open' in measured],
    }
    with open(os.path.join(HERE, 'audition-data.js'), 'w') as f:
        f.write('// Written by synth_signature.py; audition.html reads it.\nwindow.SIGNATURE = '
                + json.dumps(page, indent=1) + ';\n')


if __name__ == '__main__':
    main()
