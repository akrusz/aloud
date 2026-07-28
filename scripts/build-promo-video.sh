#!/usr/bin/env bash
# Assemble the Play listing promo video from a phone screen recording.
#
#   ./scripts/build-promo-video.sh ~/Downloads/aloud-recording.mp4 [out.mp4]
#
# Prepends assets/store/video-title-card.png and appends video-end-card.png,
# with a short crossfade into and out of the recording. Cards are scaled and
# padded to the recording's own dimensions, so any phone aspect ratio works
# (the pad colour is the same brand background the cards use, so it's
# invisible). Audio from the recording is kept; the cards are silent.
#
# Needs: ffmpeg (brew install ffmpeg).

set -euo pipefail

IN="${1:?usage: build-promo-video.sh <screen-recording.mp4> [output.mp4]}"
OUT="${2:-aloud-promo.mp4}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TITLE="$HERE/assets/store/video-title-card.png"
END="$HERE/assets/store/video-end-card.png"
BG="0x110d08"

# Seconds each card holds, and the crossfade length between segments.
TITLE_SECS=2.5
END_SECS=3
FADE=0.5

for f in "$IN" "$TITLE" "$END"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of default=nw=1:nk=1 "$IN")
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$IN")
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")
echo "recording: ${W}x${H}, ${DUR}s -> $OUT"

# Offsets for the two crossfades. The second is measured on the already
# concatenated (title + recording) timeline, minus the overlap the first
# crossfade consumed.
OFF1=$(awk -v t="$TITLE_SECS" -v f="$FADE" 'BEGIN{printf "%.3f", t-f}')
OFF2=$(awk -v t="$TITLE_SECS" -v d="$DUR" -v f="$FADE" 'BEGIN{printf "%.3f", t+d-2*f}')
# Each crossfade eats FADE seconds of overlap, so the finished video is this
# long. The audio chain is concatenated end to end and must be trimmed to match.
TOTAL=$(awk -v t="$TITLE_SECS" -v d="$DUR" -v e="$END_SECS" -v f="$FADE" \
  'BEGIN{printf "%.3f", t+d+e-2*f}')
AFADE_OUT=$(awk -v x="$TOTAL" 'BEGIN{printf "%.3f", x-0.6}')

ffmpeg -y -loglevel warning -stats \
  -loop 1 -t "$TITLE_SECS" -i "$TITLE" \
  -i "$IN" \
  -loop 1 -t "$END_SECS" -i "$END" \
  -filter_complex "
    [0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,
         pad=${W}:${H}:-1:-1:color=${BG},fps=30,format=yuv420p[t];
    [1:v]scale=${W}:${H},fps=30,format=yuv420p[m];
    [2:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,
         pad=${W}:${H}:-1:-1:color=${BG},fps=30,format=yuv420p[e];
    [t][m]xfade=transition=fade:duration=${FADE}:offset=${OFF1}[tm];
    [tm][e]xfade=transition=fade:duration=${FADE}:offset=${OFF2}[v];
    anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${TITLE_SECS}[sa];
    anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${END_SECS}[ea];
    [1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ma];
    [sa][ma][ea]concat=n=3:v=0:a=1,atrim=0:${TOTAL},asetpts=PTS-STARTPTS,
      afade=t=in:d=0.3,afade=t=out:st=${AFADE_OUT}:d=0.6[a]
  " \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -movflags +faststart \
  "$OUT"

echo
echo "done: $OUT"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" \
  | awk '{printf "length: %.1fs\n", $1}'
