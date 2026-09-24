# Promo materials - status and handoff

Working notes for the promo video effort (started 2026-09-23). Read this
first when picking the work back up.

## Where it stands

- **Play Store video script**: `play-video/script.md`, waiting on the dev's
  edits. The file is the source of truth; build from what it says, not from
  these notes.
- **Recordings**: none yet. The dev records his lines into
  `play-video/recordings/<id>.wav` (ids in the script: m1, m2, n1, v1, w1). He
  may also find a real session excerpt (`excerpt.wav` + transcript), which
  replaces the scripted exchange in beat 2.
- **Bowl sounds**: done. `bowl-candidates/` has the generator
  (`synth_bowls.py`) and mp3s. `bowl.mp3` (5s mid bowl) and `rin.mp3` (2s rin)
  ship in the app's noting sounds. `bowl-deep-long` (10s) and `rin-long` (7s)
  are for the video only: too long for noting, since the next turn waits for
  the sound to end. The wavs are gitignored; regenerate with the script (needs
  a venv with numpy + scipy).
- **Nothing rendered yet.** No video frames, no TTS generated.

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

**Existing assets**: `assets/store/video-title-card.*`,
`assets/store/video-end-card.*`, `scripts/build-promo-video.sh` (tops and tails
a phone recording). Use them as a starting point, not a template.

**Facilitator voice**: the app's hosted aloud cloud TTS (lines f1, f2, f3).
Cloud spend for promo work is pre-approved at the cents level; confirm with the
dev before anything reaching dollars. Generate TTS only after the dev finalizes
the lines, to avoid paying twice. `say` is fine for placeholders.

## Next steps

1. Once the dev has edited `play-video/script.md`, re-read it and follow it.
2. Build the visual scenes that don't depend on his audio: orb, caption cards,
   end card, and real-UI captures of exploration, felt sense, noting and the
   setup screen.
3. Generate the facilitator TTS, cut a rough version with placeholder or real
   recordings, and render to `play-video/build/` (gitignored).
