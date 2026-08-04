# aloud. visual identity

Reference for the brand and color system locked in 2026-05-19. When in doubt, prefer this doc over what's "natural" to grep - the palette is deliberately loud, and previous warm/amber values still appear in places that were missed.

## Brand name usage

- **`aloud.`** (with terminal period) - titles, page `<title>`s, headers, logo, About modal, anywhere the brand is rendered as identity.
- **`aloud`** (no period) - mid-sentence prose, e.g. "Choose how aloud connects to a language model."
- Repo: `github.com/akrusz/aloud` (no period - the trademark display has the period; the repo doesn't, to avoid awkward `aloud..git` URLs).
- macOS bundle id: `app.aloud.meditation`.

## Logo

The brand mark is **Knewave**, a chunky display font. **Use Knewave ONLY for the logo** - `.nav-brand`, `.about-app-name`, and the inline `.brand-mark` span. Everything else (settings titles, welcome headers, h1–h6) stays in the body font.

Logo treatment:

- **Fill**: `var(--accent)` (pink)
- **Stroke**: `var(--brand-stroke)` (yellow), via `-webkit-text-stroke` + `paint-order: stroke fill` so the stroke renders *outside* the letters (doesn't eat into the fill).
- **Stroke widths scale with size**: 2px on `.brand-mark` (inline, ~1.4em of surrounding text), 3px on `.nav-brand` (1.8rem), 4px on `.about-app-name` (2.4rem). Hover on `.nav-brand` thickens to 4px.
- **Letter-spacing**: `0.05em` on nav/about, `0.04em` inline.
- **No text-shadow glow.** Stroke replaces it - we experimented with both, stroke won.

When the brand appears inline in body copy (welcome cards, hints), use `<span class="brand-mark">aloud.</span>` rather than a heading. The class sizes it at `1.4em` relative to surroundings so Knewave reads at proper brand presence without breaking the line.

## Color tokens

All at the top of `ui/src/app-base.css` - dark is the `:root` default, light is the `[data-theme="light"]` override. **Always reference via CSS variables, not hex literals.** Hardcoded hexes still exist in a few places (orb gradients, rgba alpha layers); fine, but new code uses tokens.

### Both themes share

| Token | Purpose |
|---|---|
| `--accent` | Primary brand color (pink). Borders, button fills, focus, active states. |
| `--accent-hover` | Darker pink for hover/pressed. |
| `--accent-dim` | Accent at low alpha - backgrounds for accent-tinted areas. |
| `--accent-glow` | Halo color for tour spotlights, button hover halos, orb breathing, focus rings. **Orange**, not yellow - yellow at low alpha against dim backgrounds blends perceptually toward green. |
| `--brand-stroke` | Yellow used for the logo's outline stroke and the tour-overlay-flat tint. |
| `--brand-glow` | Yellow soft-shadow color - defined but rarely used now that stroke replaced glow on the brand. Keep for future use. |
| `--warm` | Secondary muted gold accent. |

### Light mode

```
--bg-primary:    #f7efd6   /* warm paper - the body ground */
--bg-secondary:  #fcf7e6   /* one step RAISED from the ground (nav, base buttons) -
                              same direction as dark mode; pre-zine light had
                              secondary below primary, backwards from dark */
--bg-card:       #f9d0ae
--bg-input:      #fffaf2
--bg-surface:    #ffffff
--bg-tertiary:   #e9dab9
--text-primary:  #1f1a18   /* warm near-black */
--text-secondary:#5c4a44
--text-muted:    #756058
--accent:        #e71f75   /* hot pink */
--accent-hover:  #c01560
--accent-glow:   rgba(245, 165, 47, 0.45)   /* orange */
--brand-stroke:  #ffee25   /* bright sunny yellow */
--brand-glow:    rgba(245, 216, 32, 0.85)
--warm:          #e5a01a
--border:        #d9c3a2
```

### Dark mode

The dark-mode backgrounds are **neutral-warm browns**, not pink-tinted. We tried pink-shifted dark bgs (B≥G in the hex) - they made the pink accent elements read as cool/blue by relative contrast. The current values are restored from the pre-rebrand warm palette and the pink pops cleanly against them.

```
--bg-primary:    #110d08   /* warm dark brown */
--bg-secondary:  #1a1410
--bg-card:       #221a13
--bg-input:      #281f16
--bg-surface:    #2e2419
--bg-tertiary:   #1e1710
--text-primary:  #f5efe6   /* warm off-white */
--text-secondary:#c4b49e
--text-muted:    #b0a090
--accent:        #df3f88   /* pink, tuned for legibility on dark */
--accent-hover:  #c02a72
--accent-glow:   rgba(245, 165, 47, 0.30)   /* same orange, lower alpha */
--brand-stroke:  #e8b820   /* warmer gold */
--brand-glow:    rgba(255, 220, 80, 0.55)
--warm:          #c4a850
--border:        #302618
```

## Orb gradient

Both `.orb` (small, in nav) and `.orb-kasina` (large, click-orb-during-session) use the **same radial gradient**. Single source of truth - if you change one, change both.

```css
background: radial-gradient(circle at 45% 45% in oklab,
    #fff4c0 0%,   /* cream-yellow gazing center */
    #f8f288 18%,  /* pale lemon - keeps the center from snapping to saturated yellow */
    #f5d820 38%,  /* warm yellow band - the dominant "sunny" zone */
    #ffb805 49%,  /* deep gold - anchors the transition into orange */
    #ed7326 65%,  /* burnt orange */
    #e71f75 71%,  /* hot pink - encroaches well inward */
    #870a3e 76%   /* deep magenta - wide outer ring */
);
```

**Interpolating `in oklab`** is load-bearing. sRGB interpolation between yellow and coral runs through muddy olive and produces visible kinks at each stop. oklab interpolates along a perceptually-uniform path between stops, so the curve reads as a smooth arc through warm hues rather than a series of straight segments meeting at angles. Don't strip `in oklab` thinking it's optional; it isn't.

The center cream-yellow is intentionally not pure white - it's slightly tinted (`#fff4c0`) so on dark bgs it doesn't read as a white blob. Stops were tuned through an interactive gradient picker against the perceptual color space; if you adjust, keep this in mind. Pink gives way to deep magenta (`#870a3e` at 76%) beyond the outer rim of the orb as displayed, so magenta is not actually visible but it gives the bottom right surface of the orb a slightly deeper pink/magenta hue.

Box-shadow halos: orange inner (`var(--accent-glow)` ≈ `#f5a52f`) + pink outer (`rgba(231, 31, 117, 0.22-0.40)` depending on size and pulse state). Kasina has three stacked halos; small orb has two.

**Don't touch** the rainbow easter-egg orb (`.orb-rainbow`) - it's deliberately a multi-color cycle.

## Zine treatment (2026-08-03, `zine-restyle` branch)

The wordmark is hand-painted pop; the chrome around it leans the same way. Three moves, shared between the landing page (`docs/css/style.css`) and the app (`app-base.css`):

- **Squashed corners**: one ellipse per element, horizontal wider than vertical, identical on all four corners - hand-cut, not machine-rounded. In the app this rides the radius tokens: `--radius: 14px / 9px`, `--radius-sm: 10px / 7px`. The `h / v` value substitutes textually into `border-radius: var(--radius)` - **never wrap these tokens in `calc()`** (it can't divide an ellipse; use the other token instead).
- **Sticker shadows**: solid offset shadows (no blur) in `--brand-stroke` under filled pink controls - the wordmark's pink-on-yellow story as a control. App: 2px on `.btn-primary`, 3px on `.btn-begin` (kept inside the `btn-dirty-pulse` keyframes, since animating `box-shadow` replaces the whole list). Site: 3px buttons, 5-8px cards.
- **Orb bands as mode colors**: `--orb-yellow` / `--orb-orange` / `--accent` color-code the three modes everywhere they appear - exploration yellow, noting orange, felt sense pink (site mode cards; app mode-tab underline). Dark values stay in the approved gold/burnt family.

Landing-page-only flourishes: marker underline on section titles (`.hl` - a thin stroke riding the baseline, never over the letterforms), settle-in entrance (cards land ~1° crooked and straighten; square at rest), scalloped download-band edge. **No tilted or settling elements in the app** - the app is where people read and act; playful geometry stays on containers and entrances, not on working surfaces.

## Tour popup styling

Two visual modes:

1. **Spotlighted step** (highlights a UI element): `.tour-spotlight` is positioned over the target, with a `9999px` outer box-shadow at 55% black to dim everything else. Glow ring around the spotlight uses `var(--accent-glow)` (orange).
2. **Welcome / done card** (centered, no spotlight): `.tour-overlay-flat` class added to the overlay via JS (in `showCard()` toggle based on `className === 'tour-welcome'`). Renders a **flat tinted backdrop**: yellow tint via `color-mix(in srgb, var(--brand-stroke) 30%, transparent)`, plus a thin brightness-shift gradient on top (`rgba(0,0,0,0.18)` in light, `rgba(255,255,255,0.18)` in dark) to actually create dim separation. The welcome card itself has **no glow box-shadow** - just a drop shadow.

Don't add a glow halo to `.tour-welcome` - the flat overlay handles separation. Glow rings imply "look here, click this" which the welcome step doesn't offer.

## Embers

Ambient floating particles. Palette per theme, defined in `ui/src/embers.ts`:

- **Light mode** (`EMBER_COLORS_LIGHT`): saturated gold-yellows that contrast against the peach bg. Avoid pale yellows like `#f5e060` - they wash into the bg at the 0.7 peak opacity the ember animation targets.
- **Dark mode** (`EMBER_COLORS_DARK`): amber/burnt-orange tones (`#e8a840`, `#d4873a`, `#c07830`, …). Avoid pale/cream yellows like `#fff4c0` - they read as white blobs against the dark bg. (These are the pre-rebrand ambers the "things to avoid" list warns off for UI chrome; on embers against a near-black bg they still read right, so they stayed.)
- **Rainbow mode** (`EMBER_COLORS_RAINBOW`): pastel rainbow cycle, untouched (paired with the rainbow easter-egg orb).

Halo derived per-ember via `hexGlow()`. Light mode has an `!important` amber box-shadow override on `.ember` that wins regardless of inline color - leave it (the warmth reads well against peach).

## Inline circled `?`

For body copy that references the page's info buttons (tour hints, welcome cards), use `<span class="info-btn-glyph">?</span>`. It's a non-interactive twin of `.info-btn` - same circled-question-mark look, but smaller, with `currentColor` border so it inherits the surrounding text color. Don't use `<strong>?</strong>` (forces line wrap with awkward bolding) or the real `.info-btn` (it's a button with cursor/hover; semantically wrong inline).

## Things to avoid

- **Don't use Knewave outside the three brand classes.** Settings page headers, welcome `<h1>`s, etc. all use the body font.
- **Don't use `#f5f600`** (pure yellow) - it's green-leaning. Use `#ffd820` / `#f5d020` / `#e8b820` family.
- **Don't use the old warm ambers** (`#d4873a`, `#e8a840`, `#c07830`, etc.) **for UI chrome** - they predate the rebrand and don't match it. They remain correct for dark-mode embers, where they sit against a near-black bg (see Embers above).
- **Don't pink-tint the dark-mode backgrounds.** Keep them warm-neutral browns. (We tried and the relative contrast made the pink accent look bluer.)
- **Don't add glow rings to `.tour-welcome` cards.** The flat tinted overlay does the separation work.
- **Don't tint `--accent-glow` yellow.** Yellow at low alpha reads green over dim bgs - stay orange.
- **Don't use `text-shadow` for brand glow.** Stroke replaced it.
