# Signature sounds video

A 2:17 landscape cut (1920x1080, under X's 2:20 limit) about how the session
opening and closing sounds were made: the brief, round one's six directions,
how two of them are built (a voice through a moving mouth, and the autograph's
stereo wave that draws the word), measuring without ears, the dev's notes and
the revisions they got, and the five pairs that ship.

Every picture of a sound is drawn from the file that plays under it: the
spectrograms, the line spectrum, and the autograph's XY scope (left channel
against right) are read from the renders in `../signature-candidates/`, and
the harmonic build-up is the generator's own `PEN` at each step of `FOCUS`.

## Building

```bash
node assets/promo/signature-video/tools/build.mjs                  # build/aloud-signature-sounds.mp4 (~5 min)
node assets/promo/signature-video/tools/build.mjs --preview        # watch it in a browser
node assets/promo/signature-video/tools/build.mjs --still 12,40    # single frames
node assets/promo/signature-video/tools/build.mjs --range 50,58    # only those seconds
```

`cut.mjs` holds every word and every sound with its timing; edit it and
rebuild. The soundtrack (`tools/analyze.py`, via uv with numpy + scipy) is
redone whenever `cut.mjs` or `analyze.py` changes. It needs the candidate
renders, which are gitignored: run `../signature-candidates/synth_signature.py`
first on a fresh checkout.

## The dev's to judge

- All the copy. Captions are in the dev's voice (he presents it; he's Alex on
  socials, `PEOPLE` in `cut.mjs`). The notes are his own words from the
  sessions; the replies are short summaries of the candidates README's
  revision tables. The first note is drone to drone2 because bloom2 to bloom3
  measured under 1 dB apart and was too subtle to hear.
- The mix: -16 LUFS integrated, peak -1.5 dBFS. The autograph clips play
  4.5 dB under their matched level with the top above 4.2 kHz rolled off
  (`AUTOGRAPH` in `cut.mjs`), since they're harsher than the rest at the same
  loudness.
- The classifier's labels are shown without scores: the candidates' README
  gives a single number for few of them, and those belong to other sounds
  than the one each card describes (Foghorn 0.44 was an `autograph5` draft
  with surf behind the word; Static 0.47 is plain white noise). Under
  Foghorn plays `drone3`'s falling close, the dev's "game show" one.
