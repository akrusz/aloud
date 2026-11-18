#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "scipy"]
# ///
"""Write the app's signature sounds (ts/ui/public/audio/signature/) from the
lossless renders here: each preset's candidate .wav, at the gain its .mp3
was given, APP_DB lower, in the .mp3's own format. The README's Chosen
section says why the app's copies are quieter.

    uv run app_copies.py            # every preset
    uv run app_copies.py bloom      # just that one

Run synth_signature.py first for any candidate whose .wav isn't here.
"""
import os
import sys

import numpy as np

from synth_signature import HERE, MP3_MATCH_LUFS, MP3_MATCH_WINDOW, SR, db, decode, integrated_lufs, loudest, write_mp3

APP = os.path.join(HERE, '..', '..', '..', 'ts', 'ui', 'public', 'audio', 'signature')

# How far under the candidates' level the app plays them: the audition page's
# "under the voice" 6 dB, raised 2 dB by ear in the app (2026-10-14). Baked in
# because iOS ignores an <audio> element's volume.
APP_DB = -4.0

# Preset -> (opening, close), as in the README's Chosen table.
PRESETS = {
    'bloom': ('harmonica-open', 'bloom8-close'),
    'handpan': ('handpan8-open', 'handpan9-close'),
    'ripples': ('ripples4-open', 'ripples4-close'),
    'drone': ('drone7-open', 'drone7-close'),
    'marimba': ('marimba-open', 'marimba-close'),
}


def candidate_gain(wav, sig):
    """The gain synth_signature.py's write() gave this render's .mp3."""
    start = loudest(sig)[1]
    gain = MP3_MATCH_LUFS - integrated_lufs(wav, start / SR, MP3_MATCH_WINDOW)
    return min(gain, -0.3 - 20 * np.log10(np.abs(sig).max()))


def main():
    for preset in sys.argv[1:] or list(PRESETS):
        for half, name in zip(('open', 'close'), PRESETS[preset]):
            wav = os.path.join(HERE, name + '.wav')
            sig = decode(wav)
            gain = candidate_gain(wav, sig)
            write_mp3(os.path.join(APP, f'{preset}-{half}.mp3'), sig * db(gain + APP_DB))
            print(f'{preset}-{half}: {name}, {gain:+.2f} {APP_DB:+.1f} dB')


if __name__ == '__main__':
    main()
