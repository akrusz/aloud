"""Transcribe audio with the desktop app's own Whisper model, on this machine.

A check for work nobody has listened to yet: that a cut did not clip a word,
or that a TTS take did not swallow its first one. The small model mishears
now and then, so a miss means "listen to this one", not "this one is bad".

    UV_PYTHON_PREFERENCE=only-managed uv run --python 3.12 --with pywhispercpp \\
        python assets/promo/play-video/tools/transcribe.py [--words] <audio>...

--words prints a start time before each word, for finding a cut point inside
a long clip. Times are approximate; snap the cut to the nearest pause
(ffmpeg silencedetect). Needs ffmpeg and the model the desktop app downloads.
"""

import os
import subprocess
import sys
import tempfile

from pywhispercpp.model import Model

MODEL = os.path.expanduser("~/Library/Application Support/app.aloud.meditation/models/ggml-base.en.bin")

args = sys.argv[1:]
words = "--words" in args
paths = [a for a in args if a != "--words"]
model = Model(MODEL, print_realtime=False, print_progress=False)
with tempfile.TemporaryDirectory() as tmp:
    for path in paths:
        wav = os.path.join(tmp, "in.wav")
        subprocess.check_call(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]
        )
        if words:
            segments = model.transcribe(wav, token_timestamps=True, max_len=1, split_on_word=True)
            text = " ".join(f"{s.t0 / 100:.2f}|{s.text.strip()}" for s in segments)
        else:
            text = " ".join(s.text.strip() for s in model.transcribe(wav))
        print(f"{os.path.basename(path)}: {text}")
