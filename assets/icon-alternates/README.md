# Icon alternates

Runners-up from the ripple-ring pass on the app icon (the rings echo the boot
throbber in `ts/ui/src/style.css`, `#boot-orb`). Kept so the decision can be
revisited without redoing the exploration. **Nothing here is built or shipped** -
the live sources are `assets/app-icon.svg`, `app-icon-ios.svg`,
`app-icon-android-fg.svg`, all rendered by `scripts/generate-app-icons.sh`.

What shipped is **U**: orb r220, rings r280 / 340 / 400, strokes 9 / 7.5 / 6,
opacity 0.58 / 0.36 / 0.22 - even 60px spacing, and the airiest of the set.

Every file below is a full 1024px tile, so `rsvg-convert -w 512 <file> -o out.png`
is enough to look at one. Radii are on that 1024 canvas, where the tile's flat
edge sits 412px from centre.

| File | Orb | Rings | What it does differently |
|------|-----|-------|--------------------------|
| `alt-t-front-loaded.svg` | r240 | 305 / 352 / 399 | Gaps 65 / 47 / 47 - a wide breath around the orb, then even steps. The other finalist; a bigger orb at the cost of air. |
| `alt-w-even.svg` | r230 | 292 / 346 / 400 | Splits T and U exactly (gaps 62 / 54 / 54). |
| `alt-y-tapered.svg` | r230 | 292 / 346 / 400 | W's geometry, strokes tapering harder (9 / 6.5 / 4.5) so the rings read as one wavefront thinning as it spreads. |
| `alt-ae-slow-falloff.svg` | r220 | 280 / 340 / 400 | U's geometry with a flatter alpha ramp (0.60 / 0.42 / 0.30) - outer rings hold on longer. |
| `alt-p-corner-crop.svg` | r262 | 334 / 430 / 535 | The pre-containment version: outer rings run off the tile's flat edges and survive only in the corners, which reads as "still travelling". |

Two things the exploration settled, worth not relearning:

- **Stroke width decides small-size survival, not opacity.** A 5px ring on this
  canvas is sub-pixel by 128px and leaves a dark smudge rather than a ring.
- **Don't contain the outer ring's glow.** Pulling it in far enough for the blur
  to fit inside the tile leaves a dead black margin; letting the glow feather off
  the edge is what keeps the figure breathing.
