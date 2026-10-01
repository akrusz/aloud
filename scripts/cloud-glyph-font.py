#!/usr/bin/env python3
"""
Build the ☁ credit glyph as a one-glyph font: ts/ui/src/assets/aloud-cloud.woff2.

☁ IS the aloud cloud credit (ui/src/credit-rate.ts), the one thing aloud sells,
so it's drawn as a cloud you'd want: white, sky blue underneath, with an
outline in the logo's colors like a cloud at sunset. As the system emoji it
looked different on every platform and was a pale shape that vanished on light
ones.

It's a color BITMAP font first (sbix: one PNG per strike size), and the format
is the point. Drawing a layered vector glyph (COLR, SVG) hits a WebKit bug, so
Safari and the macOS desktop app: WebKit records the text color into its cached
drawing of any text run holding such a glyph. After a theme switch, everything
after the ☁ in that run kept the old color ("13.7☁ remaining" -> "remaining"
stayed dark). Bitmap glyphs are drawn the way emoji are and don't do that
(checked on Safari 27, with a COLR-only build as the control that does). So
don't drop the strikes for sharper edges or a CSS-themable palette.

The font carries the art a second time as COLR layers, for Firefox alone:
Firefox strips sbix from a web font and would show the bare outline. WebKit
and Chrome prefer the strikes when both are there, so the bug stays away.
Change the art and both change together; they're built from the same shapes
and colors.

The colors are therefore fixed, the same in both themes and inside a pink
button; the glyph doesn't take the text color or embolden. On the pink button
the magenta of the outline blends in, leaving the white cloud on its yellow.

The font also keeps a plain outline glyph: the cloud's ring. A renderer
with no color font support at all draws that in the text color instead. The sbix "draw the outline
over the bitmap" flag stays off: Chrome honors it and WebKit doesn't, so the
two would disagree about the outline's color.

The UI loads it with unicode-range: U+2601, first in --font, so every ☁ in
page text uses it: badges, balances, copy, and a <select>, whose open menu the
browser draws in the page (appearance: base-select in app-base.css). OS-drawn
surfaces still use the system glyph: tooltips, and that menu on a browser
without base-select (Firefox, Safari before 27). The strings carry a bare
U+2601, never the emoji-presentation form U+2601 U+FE0F, which a browser may
send straight to the color-emoji font.

The shape is a union of circles over a capsule base, grown by EDGE for the
outline. Growing a circle or a capsule is exact, so the outline is even all
the way round rather than a stroke approximation. The strikes draw the same
primitives, so bitmap and fallback outline coincide.

Deps (not in the repo's toolchain; only needed to regenerate):
    pip install fonttools skia-pathops brotli pillow
Usage:
    python3 scripts/cloud-glyph-font.py [--svg outline.svg] [--png strike.png]
"""

import argparse
import io
import math
import os

import pathops
from PIL import Image, ImageChops, ImageDraw
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.timeTools import timestampSinceEpoch
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.sbixGlyph import Glyph as SbixGlyph
from fontTools.ttLib.tables.sbixStrike import Strike

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'ts/ui/src/assets/aloud-cloud.woff2')

UPM = 1000
# Outline width in font units: about a regular text stroke (~1.3px at 16px).
EDGE = 80
# Side bearing beyond the outline, so "3☁" doesn't touch.
BEARING = 70

# Base capsule: a flat-bottomed pill the bumps sit on. (x0, x1, y_center, r)
# Sized so the ink runs from just under the baseline to just over cap height,
# like a digit's neighbour rather than a lowercase-sized icon.
BASE = (210, 880, 185, 135)
# Bumps along the top, as (cx, cy, r): small left, tall centre-left, mid right.
BUMPS = [
    (290, 340, 145),
    (525, 450, 215),
    (770, 355, 170),
]

# The cloud's body: lit white on top, sky blue underneath. The only cool
# colors in the app, which makes the glyph read as a cloud and as its own
# thing beside warm text.
FILL = (255, 255, 255)
# Shading, painted in order: (color, how far up the body it reaches in font
# units). Each band is the body minus a copy of itself raised that much, so it
# follows the bottom curve. On a light surface the white top has nothing to
# stand against, and these bands are what make the cloud look filled.
SHADES = [
    ((226, 238, 252), 360),
    ((190, 213, 244), 150),
]
# The outline: the logo's colors as a sunset, yellow under the cloud, up
# through orange, to magenta over the top. Stops are (height, color), height 0
# at the outline's lowest point and 1 at its highest. Magenta has the top on
# purpose: on a white input it's what holds the white body. The yellow can't
# do that, so it sits below the blue, which can.
OUTLINE = [
    (0, (245, 200, 36)),
    (1 / 3, (237, 115, 38)),
    (2 / 3, (231, 31, 117)),
    (1, (231, 31, 117)),
]
# The COLR copy is flat layers, which can't hold a gradient, so its outline is
# cut into this many steps of height (main). Small enough to pass for smooth.
OUTLINE_STEPS = 24

# Strike sizes in pixels per em. A renderer picks the nearest and scales, so
# these step by ~1.4x from the smallest text at 1x to a pack price at 3x:
# never more than a mild downscale, which keeps the outline crisp. The PNGs
# are most of the file and the top strike is the biggest of them, so go past
# 96 only for a glyph that really is drawn larger.
STRIKES = [16, 24, 32, 48, 64, 96]
# Each strike is drawn this many times oversize and filtered down.
SUPERSAMPLE = 8

KAPPA = 0.5522847498  # cubic Bezier circle approximation


def add_circle(path, cx, cy, r):
    k = KAPPA * r
    path.moveTo(cx + r, cy)
    path.cubicTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r)
    path.cubicTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy)
    path.cubicTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r)
    path.cubicTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy)
    path.close()


def add_capsule(path, x0, x1, cy, r):
    """Horizontal stadium: semicircle caps at x0 and x1, radius r."""
    k = KAPPA * r
    path.moveTo(x1, cy - r)
    path.cubicTo(x1 + k, cy - r, x1 + r, cy - k, x1 + r, cy)
    path.cubicTo(x1 + r, cy + k, x1 + k, cy + r, x1, cy + r)
    path.lineTo(x0, cy + r)
    path.cubicTo(x0 - k, cy + r, x0 - r, cy + k, x0 - r, cy)
    path.cubicTo(x0 - r, cy - k, x0 - k, cy - r, x0, cy - r)
    path.close()


def silhouette(grow):
    parts = []
    p = pathops.Path()
    x0, x1, cy, r = BASE
    add_capsule(p, x0, x1, cy, r + grow)
    parts.append(p)
    for cx, cy, r in BUMPS:
        p = pathops.Path()
        add_circle(p, cx, cy, r + grow)
        parts.append(p)
    out = parts[0]
    for part in parts[1:]:
        out = pathops.op(out, part, pathops.PathOp.UNION, clockwise=True)
    return out


def bounds(path):
    return path.bounds  # (xMin, yMin, xMax, yMax)


def strike_size(box, ppem):
    xmin, ymin, xmax, ymax = box
    return (math.ceil((xmax - xmin) * ppem / UPM), math.ceil((ymax - ymin) * ppem / UPM))


def mask(box, dx, ppem, grow, rise=0):
    """Coverage mask of the silhouette grown by `grow` and raised by `rise`,
    on the pixel grid of a strike whose lower-left corner is the box's."""
    xmin, ymin, _, _ = box
    w, h = strike_size(box, ppem)
    k = ppem / UPM * SUPERSAMPLE
    im = Image.new('L', (w * SUPERSAMPLE, h * SUPERSAMPLE), 0)
    draw = ImageDraw.Draw(im)

    def px(x):
        return (x + dx - xmin) * k

    def py(y):
        return h * SUPERSAMPLE - (y + rise - ymin) * k

    x0, x1, cy, r = BASE
    r += grow
    draw.rounded_rectangle([px(x0 - r), py(cy + r), px(x1 + r), py(cy - r)], radius=r * k, fill=255)
    for cx, cy, r in BUMPS:
        r += grow
        draw.ellipse([px(cx - r), py(cy + r), px(cx + r), py(cy - r)], fill=255)
    return im.resize((w, h), Image.LANCZOS)


def outline_color(height):
    """OUTLINE at a height from 0 (the outline's lowest point) to 1 (its highest)."""
    for (t0, c0), (t1, c1) in zip(OUTLINE, OUTLINE[1:]):
        if height <= t1:
            f = max(height - t0, 0) / (t1 - t0)
            return tuple(round(c0[i] + (c1[i] - c0[i]) * f) for i in range(3))
    return OUTLINE[-1][1]


def strike_image(box, dx, ppem):
    """One strike: the outline gradient over the whole grown silhouette, the
    body in FILL on top, the shading bands on top of that."""
    size = strike_size(box, ppem)
    whole = mask(box, dx, ppem, EDGE)
    body = mask(box, dx, ppem, 0)
    # One color per pixel row, taken at the row's middle.
    rows = Image.new('RGB', (1, size[1]))
    span = (box[3] - box[1]) * ppem / UPM
    rows.putdata([outline_color((size[1] - row - 0.5) / span) for row in range(size[1])])
    im = rows.resize(size, Image.NEAREST)
    im.paste(FILL, mask=body)
    for color, rise in SHADES:
        im.paste(color, mask=ImageChops.subtract(body, mask(box, dx, ppem, 0, rise=rise)))
    im.putalpha(whole)
    return im


def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def shifted(path, dx, dy=0):
    out = pathops.Path()
    path.draw(TransformPen(out.getPen(), (1, 0, 0, 1, dx, dy)))
    return out


def rectangle(x0, y0, x1, y1):
    path = pathops.Path()
    path.moveTo(x0, y0)
    path.lineTo(x1, y0)
    path.lineTo(x1, y1)
    path.lineTo(x0, y1)
    path.close()
    return path


def glyph_from(path):
    pen = TTGlyphPen(None)
    path.draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=False))
    return pen.glyph()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--svg', help='also write an SVG preview of the fallback outline here')
    ap.add_argument('--png', help='also write the largest strike here')
    ap.add_argument('--out', default=OUT)
    args = ap.parse_args()

    plain = silhouette(0)
    grown = silhouette(EDGE)
    # Put the outline's left edge at BEARING.
    dx = BEARING - bounds(grown)[0]
    plain, grown = shifted(plain, dx), shifted(grown, dx)
    ring = pathops.op(grown, plain, pathops.PathOp.DIFFERENCE, clockwise=True)
    advance = math.ceil(bounds(grown)[2] + BEARING)

    if args.svg:
        xmin, ymin, xmax, ymax = bounds(grown)
        pad = 20
        vb = f'{-pad} {-(ymax + pad)} {advance + 2 * pad} {ymax - ymin + 2 * pad}'

        def d(path):
            pen = SVGPathPen(None)
            path.draw(pen)
            return pen.getCommands()

        with open(args.svg, 'w') as f:
            f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{advance + 2 * pad}">'
                    f'<g transform="scale(1,-1)">'
                    f'<rect x="0" y="-250" width="{advance}" height="1050" fill="none" stroke="#9cf" stroke-width="4"/>'
                    f'<line x1="{-pad}" y1="0" x2="{advance + pad}" y2="0" stroke="#f99" stroke-width="4"/>'
                    f'<path d="{d(ring)}" fill="#3a2a1a"/></g></svg>')

    # The same art as vector layers, bottom to top, for the COLR table below:
    # (glyph name, shape, color). Each outline step is the silhouette from its
    # own height up, painted over the step below, so no seam can show between
    # two of them. Steps that repeat a color (the flat top of the gradient)
    # are skipped.
    xmin, ymin, xmax, ymax = bounds(grown)
    layers = []
    for step in range(OUTLINE_STEPS):
        color = outline_color((step + 0.5) / OUTLINE_STEPS)
        if layers and layers[-1][2] == color:
            continue
        above = rectangle(xmin - 10, ymin + (ymax - ymin) * step / OUTLINE_STEPS, xmax + 10, ymax + 10)
        shape = grown if step == 0 else pathops.op(grown, above, pathops.PathOp.INTERSECTION, clockwise=True)
        layers.append((f'cloud.edge{step}', shape, color))
    layers.append(('cloud.body', plain, FILL))
    for i, (color, rise) in enumerate(SHADES):
        band = pathops.op(plain, shifted(plain, 0, rise), pathops.PathOp.DIFFERENCE, clockwise=True)
        layers.append((f'cloud.shade{i}', band, color))

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(['.notdef', 'cloud'] + [name for name, _, _ in layers])
    fb.setupCharacterMap({0x2601: 'cloud'})
    shapes = {'cloud': ring, **{name: shape for name, shape, _ in layers}}
    fb.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), **{name: glyph_from(shape) for name, shape in shapes.items()}})
    fb.setupHorizontalMetrics({
        '.notdef': (500, 0),
        **{name: (advance, round(bounds(shape)[0])) for name, shape in shapes.items()},
    })
    # Small vertical metrics: this font only ever supplies one glyph mid-line,
    # and must never be the reason a line box grows.
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, sTypoLineGap=0,
                usWinAscent=800, usWinDescent=200)
    fb.setupNameTable({'familyName': 'aloud cloud glyph', 'styleName': 'Regular'})
    fb.setupPost()

    # The strikes. Each PNG is exactly the outline's bounding box, placed with
    # its lower-left corner on the box's (zero origin offsets), which is where
    # renderers put an sbix bitmap. flags=1 is bitmap only, see the docstring.
    box = bounds(grown)
    sbix = newTable('sbix')
    sbix.version = 1
    sbix.flags = 1
    sbix.strikes = {}
    for ppem in STRIKES:
        strike = Strike(ppem=ppem, resolution=72)
        strike.glyphs['cloud'] = SbixGlyph(
            glyphName='cloud', graphicType='png ', originOffsetX=0, originOffsetY=0,
            imageData=png_bytes(strike_image(box, dx, ppem)))
        sbix.strikes[ppem] = strike
    fb.font['sbix'] = sbix

    # Firefox strips bitmap tables from a web font, which would leave it the
    # bare outline, but it keeps COLR. Chrome and WebKit draw the strikes when
    # a font has both, and WebKit's stale-color bug only bites when COLR is
    # what it draws, so carrying both is safe (the 2026-10 check covered this).
    fb.setupCOLR({'cloud': [(name, i) for i, (name, _, _) in enumerate(layers)]})
    fb.setupCPAL([[tuple(c / 255 for c in color) + (1.0,) for _, _, color in layers]])
    if args.png:
        strike_image(box, dx, STRIKES[-1]).save(args.png)
    # Fixed timestamps, so rerunning with unchanged geometry (and the same
    # Pillow, which encodes the PNGs) reproduces the committed file byte for byte.
    fb.font['head'].created = fb.font['head'].modified = timestampSinceEpoch(1790726400)  # 2026-09-30
    fb.font.recalcTimestamp = False
    fb.font.flavor = 'woff2'
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    fb.save(args.out)
    print(f'{args.out}: {os.path.getsize(args.out)} bytes, advance {advance}, '
          f'ink y {bounds(grown)[1]:.0f}..{bounds(grown)[3]:.0f}')


if __name__ == '__main__':
    main()
