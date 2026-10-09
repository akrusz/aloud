# Promo materials - status and handoff

Working notes for the promo video effort (started 2026-09-23). Read this
first when picking the work back up.

## Where it stands

- **Play Store video**: first cut built 2026-10-09, waiting on the dev's eyes
  and ears: `play-video/build/aloud-play-video.mp4` (gitignored), 84.5s,
  1920x1080. "Building the video" below has how, and what in it is the dev's
  to judge.
- **Play Store video script**: `play-video/script.md`, approved as written
  2026-10-08. The file is the source of truth; build from what it says, not
  from these notes.
- **Real excerpts**: chosen (2026-10-08). The dev's own 2026-10-07 sit
  replaces the scripted exchange in beat 2 and the scripted w1 in beat 8; the
  script's "Real excerpts" table has the source clips and cut points. A rough
  audio cut is in `play-video/build/audition/` (`rough-cut-v4.m4a`,
  gitignored, rebuildable from that table). Keep the raw
  clips out of the tracked `recordings/` folder unless the dev says otherwise:
  the repo is public and the sit is personal. Only the excerpts in the script
  are for use; the sit's bigger moments were left out as too big a promise.
- **Recordings**: done. `play-video/recordings/n1.wav` and `v1.wav` are his
  Voice Memos takes with the start and stop clicks trimmed off (the `aloud-*`
  originals sit beside them). Trimmed and faded only, not levelled: match
  them to the excerpts with plain gain, since loudnorm misbehaves on clips
  this short. Their room tone sits near -55 dBFS, where the excerpts are
  gated silent, so listen for hiss coming and going around them.
- **Facilitator lines are the dev's to handcraft.** Treat what the model said
  in the sit as a draft: he rewrote f1. Only his side of the exchange is
  presented as real, so no caption should call it an unedited session.
- **Open**: the cut runs 84.5s against a 60s target (Play allows 30s-2min);
  the dev decides what to trim. The script's 77s estimate didn't count c1's
  own 3s after the cut, and gave f3 6s where Harper takes 9.4. Dropping e3
  saves 9s; the caption holds are `HOLD` in `tools/build-audio.mjs`.
- **Bowl sounds**: done. `bowl-candidates/` has the generator
  (`synth_bowls.py`) and mp3s. `bowl.mp3` (5s mid bowl) and `rin.mp3` (2s rin)
  ship in the app's noting sounds. `bowl-deep-long` (10s) and `rin-long` (7s)
  are for the video only: too long for noting, since the next turn waits for
  the sound to end. The wavs are gitignored; regenerate with the script (needs
  a venv with numpy + scipy).
- **Auditions** (all in `play-video/build/audition/`, gitignored): the
  excerpt cuts, Harper takes of f0, f1 and f3 in `harper/`, and the rough cut.
  The video uses the rough cut's takes plus `f3-felt-sense-take2`, the
  shortest of the three f3 takes (8.7s; all three transcribe right and start
  clean). The build reads the takes from there, so they are not in the repo.

## Building the video

Three stages, each a script in `play-video/tools/` with its command line in
its header. All output goes to `play-video/build/` (gitignored).

```bash
node assets/promo/play-video/tools/build-audio.mjs   # 1. soundtrack + timeline
npm run web:dev                                      #    (the app, for stage 2)
node assets/promo/play-video/tools/capture-ui.mjs    # 2. film the real UI
node assets/promo/play-video/tools/render-film.mjs   # 3. render + encode (~3 min)
node assets/promo/play-video/tools/render-film.mjs --preview   # or watch it in a browser
```

1. **`build-audio.mjs`** reads `script.md`, cuts and levels every spoken line,
   lays the soundtrack (`build/audio/mix.wav`) and writes `build/timeline.json`:
   when every line, caption and bowl lands. The picture follows it, so a line
   that runs long stretches its beat and a line deleted from the script drops
   out with its time. Caption words light up on times from Whisper
   (`transcribe.py --words`), matched back onto the script's wording.
2. **`capture-ui.mjs`** films the app at phone size in headless Chrome, one PNG
   per video frame, holding every CSS animation at that frame's time
   (`tools/lib/stage.js`). The app, its layout and its motion are the live UI,
   and the setup controls are worked by real clicks. The words in a session
   transcript are written in from the script, as `scripts/site-screenshots.mjs`
   does for the site, and the voice label is set to Harper. The model call is
   blocked and the recognizer stubbed: nothing is billed, and Ollama isn't woken.
3. **`render-film.mjs`** renders `play-video/film/` (one page, every scene a
   function of time) frame by frame and encodes it with the soundtrack.
   `--still 12.5,40` writes single frames to look at.

Stage 2 only needs repeating when timings or the app's UI change; stage 3
refuses UI shots filmed for a different cut.

**The dev's to judge**, since none of it has been heard by a person:

- The mix as a whole. It measures -15.2 LUFS integrated, peak -1 dBFS.
- The sounds added past the rough cut, there so no caption plays over dead
  air: a quiet `rin-long` on the cut to c1, the app's short `rin` as each
  setup control lands and again as the timer takes, and the opening bowl
  twice more under beats 7-8. Levels are `LEVEL` in `build-audio.mjs`; zero
  one to drop it.
- n1 and v1 took 8.0 and 8.8 dB of gain to sit with the excerpts, so their
  room tone is near -46 dBFS now.
- The f3 take, and whether 84.5s is too long.
- Nothing on screen says whose words e3 and e4 are. A caption for that would
  be new copy, so it isn't there.

## Audio recipe

How the rough cut was made, and what the build repeats.

- **Excerpts**: cut from the capture at the script's in/out points, then
  `afade=t=in:d=0.03`, a 50ms fade out, `loudnorm=I=-18:TP=-2:LRA=11`,
  resampled to 48 kHz mono. No EQ or noise reduction: the capture is already
  gated to silence between words, so it wants a quiet bed (a bowl tail, room
  tone) under it more than cleanup.
- **Harper**: `play-video/tools/render-line.mts`, one call per sentence, three
  takes; a line's sentences are concatenated as they come (each clip carries
  its own lead and tail silence) and normalized to -19 LUFS. Takes in the
  cut: `f0-settle-take2`, `f-present-s1-take2`, `f-anywhere-s2-take2`.
- **Spacing**: 0.5-0.6s between a line and the reply, on top of the clips' own
  silence. `bowl-deep-long.mp3` opens at 0.22 gain, faded out over 6-10s, with
  the first voice at 2.5s.
- **Mix**: stereo, voices centred. ffmpeg's own mono-to-stereo upmix takes
  3 dB off, which would leave the voices that much under the bowls, so the
  build pans them instead. The build levels Harper with plain gain to -19 LUFS
  rather than loudnorm, then lifts the whole mix 1 dB to a -1 dBFS ceiling.
- **Checking without ears**: `play-video/tools/transcribe.py` runs the desktop
  app's Whisper model locally over a cut or a take.

## Decisions so far

- **Pitch the format, not features** ("more forest, less trees"): a live,
  spoken meditation / somatic exploration that follows what you notice. It is
  not a voice chatbot, not prerecorded meditations, not a timer. Made by
  someone who bounced off the existing apps and found this format works.
- **Lead with what it helps you do.** The hook is a body-listening exchange
  ("my shoulders have been tense lately... maybe my body's trying to tell me
  something"). No "not X, not Y" opener. The contrast with other apps comes
  late and is phrased positively ("most apps play the same recording to
  everyone...").
- **Keep dead air to the first ~3s.** Holding silence is one feature among
  several, not the story.
- **Noting gets ~2s.** Felt sense is the facilitator reading its real opener
  (line f3 matches `FELT_SENSE_OPENERS` in `ts/src/facilitation/felt-sense.ts`;
  keep them in sync).
- Copy style: no em-dashes (use " - " or commas), lowercase-leaning captions to
  match the site.

## Plan for the build

1. **Play Store video**: ~60s, landscape 1920x1080. Play takes an unlisted
   YouTube URL (30s-2min, no ads, full `watch?v=` link).
2. **App Store preview**: 15-30s, portrait at device resolution. Apple wants
   footage mostly captured from the app, so this is a real-UI cut of beats 2-6.
3. **Twitter piece**: looser on brand. Ideas floated: the turn signals as
   kinetic type, a git-history time-lapse (Flask to TS, glooow to aloud., the
   first paying user), a founder clip in his own voice.

**Toolchain** (all installed, nothing new needed): build scenes as HTML/canvas
using the app's real CSS tokens (`ts/ui/src/app-base.css`,
`dev-docs/style.md`), Knewave for the logo only, and the orb. Render them frame
by frame with playwright-core driving the system Chrome, then assemble with
ffmpeg (libx264). Real UI footage: `npm run web:dev` (Vite :4649 + Hono :8787)
captured via Playwright; `scripts/site-screenshots.mjs` shows how the site shots
drive the UI. Kill any dev servers afterwards.

**Tools**: `play-video/tools/` has the two scripts above and the three build
stages; each file's header has its command line.

**Existing assets**: `assets/store/video-title-card.*`,
`assets/store/video-end-card.*`, `scripts/build-promo-video.sh` (tops and tails
a phone recording). Use them as a starting point, not a template.

**Facilitator voice**: Harper, the app's default hosted voice (lines f0, f1,
f3). The dev picked her over Wren, the voice he sat with (2026-10-08). Render
three takes of each sentence and check the first word: her onsets are
sometimes soft.
Cloud spend for promo work is pre-approved at the cents level; confirm with the
dev before anything reaching dollars. Generate TTS only after the dev finalizes
the lines, to avoid paying twice. `say` is fine for placeholders.

## Next steps

1. The dev watches `play-video/build/aloud-play-video.mp4` and marks up
   `script.md` (wording, order, `> note:` lines) or names what to change in
   the picture and the mix.
2. Rebuild from the marked-up script (above). A reworded facilitator line
   needs new Harper takes first: `tools/render-line.mts`, then `HARPER_TAKES`
   in `build-audio.mjs`.
3. Upload unlisted to YouTube and give Play the full `watch?v=` link.
