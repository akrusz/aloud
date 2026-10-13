# Signature sound candidates

Candidates for aloud's signature sound: an opening and a closing for a
session (and for the promo video, which opens and closes on
`bowl-deep-long` today). Idea 2 in `dev-docs/design-push.md`. Six rounds
(2026-10-11 and 12), after which five pairs went into the app as presets: see
Chosen, below. The video still has its bowl.

**To listen, open `audition.html`.** Each direction plays alone, as a pair,
and with the facilitator's first line coming in over the opening's tail.
"Play as" switches every button to call quality; two sliders set when the
voice comes in and how far the opening is turned down under it. "Speed" slows
any sound to try an idea: at the same pitch it is the browser's own stretch,
which is rougher than a re-render, and with "lower with it" it is a clean
slowed tape. "Mix a pair" plays any opening with any close. The newest round
is at the top until it has been heard; under it
are the revisions still in the running (`LIVE` in the script), each with the
version it revises beside it; earlier rounds follow. The sounds it must not be
confused with are at the bottom.

A copy is published as a Claude artifact, which the dev shares by link (the
link is his to give out, so it isn't written here). It holds only the newest
round and what is in the running, less `bloom5`, as of round 6. To refresh it
after a render,
`python3 stage_artifact.py <empty dir> --running --without bloom5` stages the
page and the files it plays; publish `<dir>/aloud-signature-sounds.html` with
the files in `<dir>/files.json` over the artifact, and remove the files of
anything that has left the set.

All of it is synthesized by `synth_signature.py`, so there's no licensing
question. Re-tune there and re-run:

```bash
python3 -m venv <venv> && <venv>/bin/pip install numpy scipy
<venv>/bin/python synth_signature.py            # all
<venv>/bin/python synth_signature.py hum drone  # just those
# or: uv run synth_signature.py
```

## Chosen

Five pairs ship as presets (2026-10-12): `SIGNATURE_SOUNDS` in
`ts/ui/src/signature-sound.ts`, picked in Settings under Look and Feel. The
app's files are copies of the renders here, in
`ts/ui/public/audio/signature/` as `<preset>-open.mp3` and
`<preset>-close.mp3`:

| Preset | Opening | Close |
|---|---|---|
| `bloom`, the default | `harmonica-open` | `bloom8-close` |
| `handpan` | `handpan8-open` (which is `handpan2`'s) | `handpan9-close` |
| `ripples` | `ripples4-open` | `ripples4-close` |
| `drone` | `drone7-open` | `drone7-close` |
| `marimba` | `marimba-open` | `marimba-close` |

On the default, the dev: "my heart loves harmonica-bloom8". It was close with
`bloom7`'s opening, which "sounds like coming home" where the harmonica
"sounds like an idyllic cyberscape full of potential". Two friends liked the
blooms less and preferred `ripples2` or `ripples4`, so the default may move
to `ripples`.

In the app the opening starts as soon as the session's mic is open, 6 dB
down (the audition page's "under the voice" default), and the facilitator's
first words wait for it to end; the close plays as the session ends. A new render reaches the
app only when its file is copied over.

Everything in the running stays to come back to. Git ignores the renders
except the ones kept on purpose with `git add -f`, which is what is in the
running (`LIVE`); the rest come back from a run of the script.

## Round 1

| Direction | What it is | Source |
|-----------|------------|--------|
| `hum` | Three voices humming a chord and letting it open, 'mm' into 'ah'. The close is 'ah' sinking back into 'mm'. | Harmonics of a wavering pitch through a moving vocal tract, breath through the same tract |
| `drone` | A low breath-driven drone, near a didgeridoo, with three overtones stepping up out of it (down, to close). | Lips buzzing into a tube, a mouth tuned to one harmonic at a time |
| `breath` | A breath in, then a blown note rising into pitch. The close lets the note go in a long breath out. | Turbulence through an open throat, a stopped pipe |
| `ripples` | Three ripples across three strings, D A F sharp, up to open and back down to the root to close. | Thumbed nylon on a small wooden body |
| `autograph` | The wild one. One cycle of the wave is the word *aloud* in handwriting: left channel is the pen's x, right its y. | A drawing (see below) |
| `bloom` | The layered experiment: `hum`, a dark drone under it for speakers that can carry it, the ripples an octave up on top. | The three above |

## Round 2

After the first listen: `ripples` was the most usable as it stood but simple,
and its close wanted more; `bloom` beat `hum` but ran long and sat on its
opening hum; `drone` had something harsh in it and wanted wood and some cello;
`autograph` lingered, its close was weaker than its open, and both were more
electronic than wanted; `breath` looked the hardest to adapt. Earlier rounds
still render exactly as they did (every later option defaults to off), so any
two versions can be compared.

| Revision | Of | What changed |
|----------|----|--------------|
| `ripples2` | `ripples` | A chord on the last note (A and E with the F sharp: D with a ninth added). The close starts from the chord and takes a fourth step, down to the low D. |
| `ripples3` | `ripples` | An undertone: a bowed string takes up the root as the last string is let go, and sings on. In the close it is the fourth thing to happen. |
| `bloom2` | `bloom` | The opening's hum is a grace note and the whole opening is 3.4s (was 5). Six voices, two to a part; a darker closed mouth. The close keeps its shape. |
| `drone2` | `drone` | About 4 dB less between 2 and 4 kHz and almost no hiss; heard through a cello-sized wooden body; a bowed string on the D an octave up. 4.0s and 5.6s (were 4.8 and 6.6). |
| `autograph2` | `autograph` | Same start, then it puffs into a cloud the moment the word is in focus: 2.8s (was 5). The close mirrors it: out of a puff into the word, back down to the orb with the pitch falling a fourth, 4.2s (was 6.6). Three slightly different hands take turns, and the pen rubs on the paper. |

The bowed string (`bow()`) is the one source here that is a physical model,
not a drawn spectrum: a bow sticking and slipping on a string. A first try as
drawn harmonics scored as a foghorn with the tagger below; the model scores as
a bowed string on its own. How much of it to let through is the open question
in `drone2`: brighter or louder and the pair scores as overdriven, darker and
it scores as a horn. Below D3 the model turned rough until its bridge damping
was scaled to the string's length (round 3).

## Round 3

After the second listen: `ripples2` is right as it is; in `ripples3` the
string should meet the last pluck of the open, and in the close be lower,
carrying the descent on; `bloom2` should read less as people singing vowels,
and its close began with a tick; `drone2` is a good sound that doesn't do
enough, the close least of all, so a few takes on it; `autograph2` should be
one smooth arc and not two humps, with one version by those words and one by
instinct.

| Revision | Of | What changed |
|----------|----|--------------|
| `ripples4` | `ripples3` | Open: the string swells in under the roll and is within 2 dB of full when the last string is plucked. Close: the string is the low D, an octave under the last pluck. |
| `bloom3` | `bloom2` | Formants widened 1.8x, vibrato 8 cents (was 14): the same sound without settling on a vowel. The tick was the first plucked string landing before the voices; it eases in and waits for them. |
| `drone3` | `drone2` | A step in the bass: up a fourth onto D to open, down a fourth onto D to close. |
| `drone4` | `drone2` | The string climbs D, E, F sharp with the three overtones, and walks back down to close. |
| `drone5` | `drone2` | Three breaths: three swells of the bass, one overtone to each. |
| `autograph3` | `autograph2` | One arc. The cloud is a crossfade from the line as written to the same line come loose, over 0.8s, under a level that only falls. |
| `autograph4` | `autograph2` | The pen writes the word once, at writing speed: pitch follows the pen's height, the sound travels left to right, and the close ends on the underline. |

Two things the tagger settled this round. For `bloom3`, widening the formants
alone took the chant and singing scores down; giving each voice its own vowel
or keeping the mouths ajar pushed it toward a chant, and all three together
scored as a foghorn. For `autograph4`, how far the pitch follows the pen:
more and it scores as a theremin or a boing, less and the held buzz scores as
an insect.

## Round 4

After the third listen: `ripples4` and `bloom3` are close to right. `bloom3`
starts a little abruptly, its vocal texture is worth trying other ways, and a
slower one was asked for ("0.7 speed", less happy, more chill). The drones
should not fall in pitch at the end, and `drone3`'s close, a held low note
dropping a fourth, recalled a foghorn and a game-show loss. `autograph3`'s
cloud sounded like static: more overlap, or an ocean wave in its place.
`autograph4` was fun and isn't it. Some sounds began with a tick on some
plays and not others.

| Revision | Of | What changed |
|----------|----|--------------|
| `bloom4` | `bloom3` | A softer start: 180 ms to arrive, was 90. Nothing else. |
| `bloom5` | `bloom3` | A texture, on the softer start: twelve voices, four to a part, none quite together. |
| `bloom6` | `bloom3` | A texture, on the softer start: three bowed strings play the three parts under the voices, 5 LU down. |
| `bloom7` | `bloom3` | At 0.7 speed, same pitch: 4.9s and 9.4s. The vowels are smeared a third further, since slower voices scored as more of a chant. |
| `bloom8` | `bloom3` | `bloom7` with the third at the bottom of the chord and E on top: the lower voices hold F sharp and A, only the top one moves (D to E, and back to close). Without the low D, on a phone, it leans minor. |
| `drone6` | `drone3` | No sag at the end and the last overtone held. A new close: the bass comes home from below (A up to D, as in the opening). It starts as the bass alone, dark; the mouth opens and the string joins as it lands on D, and the overtones step down. A first version held E in the string and an overtone from the start, which didn't belong. The balance of the two pulses took three tries: the second 4 dB over the first was too loud, level made the low first one too loud, and it is 2 to 3 dB under the second now. |
| `drone7` | `drone4` | No sag at the end and the last overtone held. |
| `drone8` | `drone5` | The same. The close's breaths are set apart without a falling end: troughs 12 to 14 dB down (were 8 to 10), a 22 cent scoop up into each, the mouth opening into each overtone. A flatter version (10 cents, shallow troughs) was too constant. The first breath arrives in about 0.2s (was 0.35), the second a little sooner than it did. |
| `drone9` | `drone6` | A close with no step in it: two pulses on D, one-twoooo. A short dark one, 4 dB or so under, then a long one that opens, takes the string and the stepping overtones, and fades. Same opening as `drone6`. |
| `autograph5` | `autograph3` | A wave where the cloud was: the word is written in sand. Open: the wave runs in under the word as it comes into focus, breaks over it and draws back. Close: the word comes up out of a blur over most of a second (a first version had it there at once, which was too sharp a start), a slower wave covers it, and the water drawing back is the last thing heard. |

What was measured on the way:

- **The tick.** Every file starts from silence with no step in it (the
  first sample is 90 dB or more under the peak), so a tick that comes and
  goes is in playback. The page was cutting off whatever was still playing
  when another button was pressed, and that click lands on the next sound's
  start; it now fades the old one out. It also keeps a silent stream open, in
  case an idle output (Bluetooth, a USB DAC) was clipping the first moment.
  Neither is confirmed as the cause.
- **Falling pitch.** The drones' last second sagged 40 to 60 cents and the
  overtone slid down under it; both are gone (the last two seconds now stay
  within about 15 cents, which is the reed's own drift).
- **Foghorns.** Two shapes score as one: a held low note that drops, and a
  held low note over surf. The first is why `drone6`'s close goes up. The
  second is why `autograph5`'s close puts the wave last: wave first and the
  word ringing after it scored 0.44 as a foghorn; this order scores 0.17.
- **The wave** (`surf()`) is built to the numbers of two recordings of real
  ones from Wikimedia Commons ("Sea waves.wav", "Ocean Waves on a Tropical
  Beach.ogg"; measured, not used). The tagger calls three seconds of a real
  wave "Waves, surf" at 0.37 to 0.45, white noise "Static" at 0.47, and this
  one, alone, "Waves, surf" at 0.23 with static under 0.03. What moved it: a
  slow rise (a fast one with bass in it is an explosion), a roar falling 8
  dB an octave, each band swelling on its own, and a hiss made of bursts
  (earlier versions without those two scored as static or pink noise).
- **Bloom's textures.** More breath in the voices scored as a steam whistle
  at every amount tried, so it isn't here. The strings alone score as an
  overdriven guitar chord; 5 LU under the voices the tagger no longer
  notices them.

## Round 5

Three asks. A friend wanted to know why nothing here was based on a
handpan, and the brief was loosened to make room: it is "a guide, not a
prison", and what is not wanted is "a plain bell with nothing else
interesting going on, or a plain bowl". Someone who heard `bloom8` liked the
blooms less than the dev does, so: `bloom8` with its voices replaced, once
keeping the path the mouths trace ("aaa-ooooo", near the vowels of the name)
and once not. And another listener preferred `bloom7`'s opening with `bloom8`'s
close to either pair. `ripples3` left the running (`ripples4` is just
better).

| Revision | Of | What changed |
|----------|----|--------------|
| `handpan` | `ripples` | Its three notes on a hand-played steel pan, and nothing else: the ding with the low breath of the air inside it, the fifth, the F sharp; back down to the ding to close. 3.8s and 4.8s. |
| `handpan2` | `handpan` | The hand in it. Open: a ghost tap on the bare steel before the roll. Close: two seconds into the ring the hand is laid on the pan, a dull pat, and the ring dies under it (4.4s). |
| `handpan3` | `ripples4` | The pan's roll over `ripples4`'s bowed string, unchanged: swelling in under the roll to open, the low D to close. |
| `handpan4` | `handpan` | At the water's edge: `autograph5`'s wave runs in over the ring of the roll, breaks and draws back, 6 LU under the pan. |
| `handpan5` | `bloom8` | `bloom8` with the pan playing its chord through it where the plucked glints were (ding, fifth, ninth), a light hand, 6 LU under the voices. Voices and drone are `bloom8`'s. |
| `handpan6` | `handpan` | The pan alone as `bloom8` would have it: at 0.7 of the pace, the ninth (E) on top where the F sharp was. 4.4s and 5.3s. |
| `harmonica` | `bloom8` | The voices replaced by a tremolo harmonica, blown softly, that keeps the vowel path: each reed is heard through a mouth and cupped hands doing what its singer's did. Drone and glints are `bloom8`'s. |
| `marimba` | `bloom8` | The voices replaced by a marimba rolled with soft mallets, for what it is: no vowel. The top bar moves D to E. Drone and glints are `bloom8`'s. |
| `marimba2` | `marimba` | A duet: the marimba holds F sharp and A, the harmonica takes the one line that moves, 3 LU under the wood. |
| `bloom9` | `bloom8` | A pairing, not a new sound: `bloom7`'s opening, `bloom8`'s close. The files are copies of those two. |

**The pan** (`stroke()`, `shell_answer()`, `handpan_dry()`) is built to the
numbers of two recordings of real Hangs from Wikimedia Commons ("Hang 2005
horizontal.ogg" and "Hang 2007 vertical.ogg", Michael Paschko, CC BY-SA 3.0;
measured, not used). The 2007 one happens to be in D, its ding on D3 and its
air on D2: the key of everything here. What they showed, and the model does:

- A field's three tuned modes sit within about 10 cents of 1:2:3, not on it.
- A stroke starts almost only the first. The octave and the twelfth bloom
  over the next 0.1 to 0.2s, by 10 to 16 dB, and beat a little against the
  push that raised them.
- The first mode is gone in about 1.5s and the upper two take nearly 3, so a
  note's tail thins upward. A bell's or a bowl's does the opposite: its
  lowest tone is what stays.
- The ding's octave and twelfth come up level with it within 0.2s, because
  the D4 and A4 fields ring with them.
- Every stroke wakes the fields it didn't hit, 20 to 27 dB under the note.
  This is what makes it a pan: without it the upper notes scored "Clang" at
  0.3 to 0.5 with the tagger, and with it they score as the recordings do.
- A hand is dark. Above 1.5 kHz the stroke is about 30 dB under the note and
  gone in 70 ms.
- The air inside sounds for half a second under the ding, an octave below
  it: the one part of these that a phone can't carry.

The tagger calls single notes and sparse phrases of the real Hangs "Music"
(0.65 to 0.8), "Musical instrument" (0.05 to 0.27), "Percussion" and "Drum"
(under 0.2), "Singing bowl" at 0.04 or less and never a bell or a chime. The
pan alone (`handpan`, `handpan2`) scores "Music" 0.61 to 0.70, "Musical
instrument" 0.05 to 0.09, "Percussion" 0.03, "Ding" 0.04 or less, and no
bowl, bell or chime above 0.03. `handpan3` scores as `ripples4` does, a
little more "Synthesizer" in the close (0.19 against 0.09); `handpan4` adds
"Waves, surf" 0.18 to 0.20; `handpan5` scores as `bloom8`.

A stroke also starts sharp, as the recordings do: about 10 cents (15 for
the ding), settled in a third of a second, in the first mode only.

Measured: the pan alone loses 4.0 to 5.0 dB at 8 kHz (`ripples` loses 3.1
to 4.5), since the ding and the fifth sit under 300 Hz and a phone hears
them by their octaves. `handpan5` loses 1.7, as `bloom8` does. The wave
leaves the voice 13.9 dB clear at worst in `handpan4` (`autograph5`: 16.6).

**The new cores** (`harmonica_dry()`, `marimba_dry()`, played from the
voices' own parts by `bloom_of(core=...)`) were made by a second agent, on
Fable 5.1, working from this README and the generator, and merged as they
came (the merged renders match its own to the last bit of a 24-bit file).
What it found:

- **The vowel path survives the change of instrument**, by measurement: the
  balance of 600-1300 Hz against 250-500 Hz in the harmonica alone climbs
  from -17 dB to +11 and falls back to -15 as the voices' does (-16, +13,
  -15), and the centre of its spectrum walks from 320 Hz to 950 and back to
  370 (the voices: 340, 930, 350). The marimba's balance stays between -12
  and -4: no vowel. Whether an ear hears "aaa-ooooo" in a harmonica is not
  something that measures.
- The tagger never names the harmonica. Bare, its chord scores a little as
  a vehicle horn (0.06 to 0.13); in the frame, through the mouth, no horn
  survives, and the opening scores "Television" at 0.16 (a jingle, a sting),
  which nothing moved without a cost. Leading the duet with it scored 0.48
  to 0.65, which is why the reeds sit under the wood there (0.26).
- More breath in the reeds was a foghorn, a hand tremolo a foghorn or an
  organ, less sag in pitch more of a jingle.
- The marimba's first build (a 1.2s ring, a weak fourth partial) scored its
  close as a gong (0.21) and a singing bowl (0.10): a long rolled chord
  ringing down is one. Shorter and brighter, it scores "Marimba" 0.10 and
  "Percussion" 0.14 to 0.17, "Gong" 0.06.
- The marimba loses 5.4 dB at 8 kHz: soft mallets put the weight in the
  fundamentals, under a phone's floor. The fix is the chord an octave up,
  which is another sound.
- Dropped: bowed strings through the singers' mouths (a wah pedal: "Effects
  unit" up to 0.41), wind through a mouth (a whoosh, and over the drone a
  vehicle), blown bottles on the chord (a gong, or an octave up a theremin).

A marimba is also the timbre of a ringtone everyone knows. This is a soft
roll and not a tune, and the tagger gives "Ringtone" under 0.03, but it is the
one association here that the brief names and only a listener can rule out.

## Round 6

The dev's verdict on round 5. Into the running: `handpan`, `handpan2`,
`handpan5` ("going back and forth", kept for now), `handpan6`, `harmonica`
and `marimba`. Out: `handpan3`, `handpan4` and `marimba2` ("a bit busy").
`harmonica` "doesn't read as one to me but it's a cool vaporwavey synth
thing that kinda goes with the decor really well". Four things asked for,
each a revision beside the pair it comes from, none of them in the running
until heard:

| Revision | Of | What was asked | What changed |
|----------|----|----------------|--------------|
| `handpan7` | `handpan` | "sounds good but a bit generic": an extra feature, "or even just one more note" | A fourth note: E, a step under the F sharp. Open: it answers the roll a beat later (0.93s), softly, and the two ring on a step apart. Close: it is a grace note into the F sharp, 80 ms ahead of it, and the roll comes down from the pair. |
| `handpan8` | `handpan2` | "the hand ending is slightly too abrupt": same length, the cutoff starting a fraction of a second earlier | The hand is laid on the pan at 1.7s, was 2.0s, and takes 0.8s to stop the ring, was 0.5s. The opening is `handpan2`'s. |
| `handpan9` | `handpan6` | the same as `handpan` | Two hands on the top note: B, a fourth under the E, 30 ms apart from it. The opening rolls up into the pair (B first); the close starts from it (E first). |
| `harmonica2` | `harmonica` | "its close might have room for one more subtle feature" | A second breath: as the chord fades the mouth half opens again, on 'oo', and the reeds swell once more, then sink back. The opening is `harmonica`'s. |

`handpan7` and `handpan9` are two different answers to one remark on
purpose, a note after and a note with: whichever works can be given to the
other. Both stay inside the pan (`pan_roll()`'s `more`): what was cut this
round was the pan with something from another family laid over it.

Measured:
- `handpan8`: the ring has lost 10 dB 79 ms after the hand lands, was 44 ms,
  and 20 dB after 0.29s, was 0.11s. By 2.5s the hand has taken 30 dB off it
  in both, and both files are 4.4s. The fall keeps its shape (`handpan_dry()`'s
  `rest`), only stretched: if it is still abrupt, the shape is the next knob.
- `harmonica2`: between 600 and 1300 Hz, where the vowel is, the second
  breath comes up 15 dB out of the shut mouth's hum, to 18 dB under the
  first, at 5.5 to 6s. The level as a whole holds for two seconds (4.5 to
  6.5s, within 1.5 dB) where `harmonica`'s falls 9 dB, then goes a little
  faster than it did: it is a change of colour more than of loudness (`harmonica_dry()`'s `again`). A
  bigger swell this early is not a second breath but a plateau, since the
  drone and the reeds' fundamentals hold the level up: that was the first try.
- `handpan7`, `handpan9`: the E peaks 3 to 4 dB under the F sharp, the B
  about 1 dB under its E. A second in the chord makes it rougher: by
  Sethares's measure, on what is ringing from 1.0 to 1.8s of the opening,
  0.07 and 0.06, where `handpan` is 0.02, `handpan6` 0.03, `ripples2` 0.05
  and `ripples4` 0.18. Nothing changes in what the tagger hears: no bell, bowl,
  chime or clock above 0.03, "Ringtone" 0.04 on `handpan7`'s opening
  (`handpan`: 0.03). On a call `handpan9`'s close loses 3.8 dB, was 4.4.
- The pairs these come from render as before, bit for bit.

Only ears can say whether E after the F sharp reads as an answer or as a
second thought, and whether D, E, F sharp and A in four even-ish strokes
come anywhere near a clock's quarters (the same four notes of the scale;
neither the order nor the rhythm is a clock's).

Heard: all four stay in the running, and `handpan8`'s opening with
`handpan9`'s close is the `handpan` preset.

Formats, as in `../bowl-candidates/`:
- `<name>-open.mp3`, `<name>-close.mp3`: 44.1 kHz stereo 128k, at the level of
  the bowls and the noting sounds. In git only for what is in the running. Those are strikes matched on their first
  0.7s; a swell peaks later, so these are matched on their loudest 0.7s, at
  -20 LUFS.
- `.wav`: 48 kHz, 24-bit, stereo, peaks at -1 dBFS. For video. Gitignored.
- `phone/*.16k.wav`, `*.8k.wav`: mono, band-limited (50-7000 Hz, 300-3400 Hz),
  at the mp3's level. Gitignored.
- `audition/`: the facilitator take levelled to -19 LUFS (as the video has
  it), each opening mixed under it, and the autographs' scope videos.
  `autograph5`'s shows the wave as a cloud over the word.
  Gitignored: the take is local, so those mixes need
  `../play-video/build/audition/harper/f0-settle-take2.mp3` and are skipped
  without it.
- `audition-data.js`: what `audition.html` lists, with the measurements.

## What is measured

The page shows these per sound; the script prints them.

- **At 16 kHz / at 8 kHz**: loudness lost when band-limited to call quality.
  A sound whose weight is in deep bass or airy highs loses a lot here.
- **In mono**: loudness lost when the channels are summed, as a call link
  does.
- **Rise**: time from 30 dB under the sound's peak to 6 dB under it. A strike
  takes a few ms.
- **Voice over its tail**: how far the facilitator's line stands above the
  opening between 1 and 4 kHz, where consonants are, while both sound (median
  and worst tenth of frames), with the voice in at 2.5s and the opening 6 dB
  down.

One more check was run by hand, not by the script: an AudioSet tagger (AST,
`MIT/ast-finetuned-audioset-10-10-0.4593`) as a rough stand-in for a listener.
It names the existing sounds correctly (`bowl-deep-long` "Singing bowl",
`rin` "Ding", `plop` "Plop", the facilitator "Speech"). On these candidates it
never scores a bowl, bell or chime above 0.03. It steered three choices:
`hum` sits high because with a bass under it the same chord scored as
"Mantra"; spoken-style hums ("mm-hm") were dropped because they scored as
groans and animals; `breath`'s note barely sags in the close because a
falling one scored as a train whistle.

What it can't settle, and nothing here can: whether any of these is
pleasant, whether `hum` sounds like people or like a synthesizer (the tagger
calls it music with a little singing, not voices), and how any of them sits
on a real phone speaker or a Bluetooth headset.

## autograph

A stereo wave is a pen: left is x, right is y. `PEN` in the script is the
word in one stroke with an underline back to the start, so the stroke closes
and repeats, 147 times a second. Its harmonics are the drawing's detail: one
harmonic is an ellipse (a pure tone), about sixteen make the word legible.
The sound starts as the ellipse, adds harmonics until the word is in focus,
then slows the pen on each letter in turn, which changes the timbre without
changing the picture. `audition/autograph-*-scope.mp4` plots left against
right from the finished file. Nothing can be equalized without redrawing the
word, which is why it loses more than the others at call quality.
