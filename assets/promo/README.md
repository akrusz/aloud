# Promo materials - status and handoff

Working notes for the promo video effort (started 2026-09-23). Read this
first when picking the work back up.

## Where it stands

- **Play Store video script**: `play-video/script.md`, waiting on the dev's
  edits. The file is the source of truth; build from what it says, not from
  these notes.
- **Real excerpts**: chosen (2026-10-08). The dev's own 2026-10-07 sit
  replaces the scripted exchange in beat 2 and the scripted w1 in beat 8; the
  script's "Real excerpts" table has the source clips and cut points. A rough
  audio cut is in `play-video/build/audition/` (`rough-cut-v4.m4a`,
  gitignored, rebuildable from that table). Keep the raw
  clips out of the tracked `recordings/` folder unless the dev says otherwise:
  the repo is public and the sit is personal. Only the excerpts in the script
  are for use; the sit's bigger moments were left out as too big a promise.
- **Recordings**: none yet. The dev still records n1 and v1 into
  `play-video/recordings/<id>.wav`.
- **Facilitator lines are the dev's to handcraft.** Treat what the model said
  in the sit as a draft: he rewrote f1. Only his side of the exchange is
  presented as real, so no caption should call it an unedited session.
- **Open**: the script runs about 77s as written against a 60s target; the dev
  decides what to trim (note in beat 8).
- **Bowl sounds**: done. `bowl-candidates/` has the generator
  (`synth_bowls.py`) and mp3s. `bowl.mp3` (5s mid bowl) and `rin.mp3` (2s rin)
  ship in the app's noting sounds. `bowl-deep-long` (10s) and `rin-long` (7s)
  are for the video only: too long for noting, since the next turn waits for
  the sound to end. The wavs are gitignored; regenerate with the script (needs
  a venv with numpy + scipy).
- **Audio so far** (all in `play-video/build/audition/`, gitignored): the
  excerpt cuts, Harper takes of f0, f1 and f3 in `harper/`, and the rough cut.
  f3 runs 9-10s, longer than its 6s beat. No video frames yet.

## Audio recipe

How the rough cut was made, so the build can repeat it.

- **Excerpts**: cut from the capture at the script's in/out points, then
  `afade=t=in:d=0.03`, a 50ms fade out, `loudnorm=I=-18:TP=-2:LRA=11`,
  resampled to 48 kHz mono. No EQ or noise reduction: the capture is already
  gated to silence between words, so it wants a quiet bed (a bowl tail, room
  tone) under it more than cleanup.
- **Harper**: `play-video/tools/render-line.mts`, one call per sentence, three
  takes; a line's sentences are concatenated as they come (each clip carries
  its own lead and tail silence) and normalized to -19 LUFS. Takes in the
  rough cut: `f0-arrive-take2`, `f-present-s1-take2`, `f-anywhere-s2-take2`.
- **Spacing**: 0.5-0.6s between a line and the reply, on top of the clips' own
  silence. `bowl-deep-long.mp3` opens at 0.22 gain, faded out over 6-10s, with
  the first voice at 2.5s.
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

**Tools**: `play-video/tools/` has the two scripts above; each file's header
has its command line.

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

The dev approved `play-video/script.md` as written on 2026-10-08. The video
build is the next job.

1. Re-read `play-video/script.md` and follow it.
2. Build the visual scenes: orb, caption cards, end card, and real-UI captures
   of exploration, felt sense, noting and the setup screen.
3. Assemble them with the audio above and render to `play-video/build/`
   (gitignored). Until the dev records n1 and v1, stand them in with `say`.
