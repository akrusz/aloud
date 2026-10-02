#!/usr/bin/env python3
"""
Build the ☁ credit glyph as a one-glyph font: ts/ui/src/assets/aloud-cloud.woff2
(and aloud-cloud.svg next to it).

☁ IS the aloud cloud credit (ui/src/credit-rate.ts), the one thing aloud sells,
so it's drawn as a cloud you'd want: white puffs with sky blue in their
shadows and an outline in the logo's colors, amber over the top. As the system emoji it
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
the magenta of the outline blends in, leaving the white cloud under its amber.

The font also keeps a plain outline glyph: the cloud's ring. A renderer
with no color font support at all draws that in the text color instead. The sbix "draw the outline
over the bitmap" flag stays off: Chrome honors it and WebKit doesn't, so the
two would disagree about the outline's color.

Beside the font it writes the same art as a picture, aloud-cloud.svg, for a
cloud drawn larger than the top strike: as text that one would be a scaled-up
bitmap, soft everywhere but Firefox.

The UI loads it with unicode-range: U+2601, first in --font, so every ☁ in
page text uses it: badges, balances, copy, and a <select>, whose open menu the
browser draws in the page (appearance: base-select in app-base.css). OS-drawn
surfaces still use the system glyph: tooltips, and that menu on a browser
without base-select (Firefox, Safari before 27). The strings carry a bare
U+2601, never the emoji-presentation form U+2601 U+FE0F, which a browser may
send straight to the color-emoji font.

The shape is a union of circles over a capsule base, grown by EDGE for the
outline. Growing a circle or a capsule is exact, so the outline is even all
the way round rather than a stroke approximation. The strikes are rasterized
from the same paths the layers and the picture use, so all three coincide.

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
from fontTools.pens.basePen import BasePen
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

# The cloud's body: white puffs, sky blue in their shadows. The only cool
# color in the app, which makes the glyph read as a cloud and as its own
# thing beside warm text. On a light surface the white has nothing to stand
# against, and the shadows are what make the cloud look filled.
FILL = (255, 255, 255)
SHADE = (190, 213, 244)
# The shadows are drawn per puff. Bands across the whole body stack into tiers
# under the dome, and that reads as soft-serve, not a cloud.
#
# The underside: a row of puffs along the base, as (cx, cy, r). The base below
# them is in shadow, so its top edge is scalloped. Lower them for a thinner
# shadow. Light comes from the upper left, like the outline's amber, so the
# shadow runs up the right end and not the left.
LOBES = [
    (215, 238, 150),
    (520, 268, 190),
    (815, 243, 160),
]
# The crooks: a tapered shadow where one bump sits in front of the next, as
# (front bump, bump behind, length along the front bump's edge, thickness at
# the middle). Each starts at the dip between the two in the outline.
CROOKS = [
    (0, 1, 200, 40),
    (1, 2, 270, 48),
]
# The outline: the logo's colors, magenta under the cloud, up through orange,
# to amber over the top, like a cloud lit from above. Stops are (position,
# color) along OUTLINE_ANGLE, position 0 where the outline starts in that
# direction and 1 where it ends. They're evenly spaced on purpose: the flat
# bottom edge is about a third of the outline's area and all of it sits at the
# start, so with orange any lower the end color takes most of what rises.
# Amber on a white input is the weakest pairing, the one to look at after
# changing the top color.
OUTLINE = [
    (0, (231, 31, 117)),
    (1 / 2, (237, 115, 38)),
    (1, (255, 184, 5)),
]
# The direction the gradient runs in, in degrees counterclockwise from
# rightward: 90 is straight up, 100 leans its top end a little to the left.
OUTLINE_ANGLE = 100
# The COLR copy is flat layers, which can't hold a gradient, so its outline is
# cut into this many steps along the angle (main). Small enough to pass for
# smooth.
OUTLINE_STEPS = 24

# Strike sizes in pixels per em. A renderer picks the nearest and scales, so
# these step by ~1.4x from the smallest text at 1x to a pack price at 3x:
# never more than a mild downscale, which keeps the outline crisp. The PNGs
# are most of the file and the top strike is the biggest of them, so go past
# 96 only for a glyph that really is drawn larger as text. A cloud shown large
# on its own is the SVG's job.
STRIKES = [16, 24, 32, 48, 64, 96]
# Each strike is drawn this many times oversize and filtered down.
SUPERSAMPLE = 8
# Straight pieces per curve segment when a strike is drawn. A segment is at
# most a quarter circle, which this keeps within a fraction of an oversize
# pixel at the top strike.
FLATTEN = 24

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


def disc(cx, cy, r):
    path = pathops.Path()
    add_circle(path, cx, cy, r)
    return path


def crook(front, back, length, depth):
    """The shadow in the crook between two bumps: a crescent on the front
    bump's edge, from the dip where the two circles cross in the outline,
    `length` along the edge into the bump behind, `depth` thick at its middle
    and pointed at both ends. It's a second circle through the two end points,
    less the front bump."""
    (cx, cy, r), (bx, by, br) = front, back
    # The dip: the upper of the two points where the circles cross.
    d = math.hypot(bx - cx, by - cy)
    a = (d * d + r * r - br * br) / (2 * d)
    h = math.sqrt(r * r - a * a)
    ux, uy = (bx - cx) / d, (by - cy) / d
    dip = max((cx + a * ux - h * uy, cy + a * uy + h * ux),
              (cx + a * ux + h * uy, cy + a * uy - h * ux), key=lambda p: p[1])
    start = math.atan2(dip[1] - cy, dip[0] - cx)
    half = length / r / 2
    # The crescent's middle, on whichever side of the dip is inside the bump behind.
    for middle in (start + half, start - half):
        if math.hypot(cx + r * math.cos(middle) - bx, cy + r * math.sin(middle) - by) < br:
            break
    # The second circle's center, this far from the front bump's toward the middle.
    t = (depth * depth + 2 * depth * r) / (2 * (depth + r - r * math.cos(half)))
    outer = disc(cx + t * math.cos(middle), cy + t * math.sin(middle), depth + r - t)
    return pathops.op(outer, disc(cx, cy, r), pathops.PathOp.DIFFERENCE, clockwise=True)


def shading(body):
    """Everything in SHADE: the base under the LOBES, and the CROOKS."""
    lit = pathops.Path()
    for cx, cy, r in LOBES:
        add_circle(lit, cx, cy, r)
    # Everything above the line through the lobes' centers is lit too, so the
    # gaps between lobes are shadow only below the row. Past the end lobes
    # it's their circles alone, which is what brings the shadow to a point up
    # each end. Counterclockwise like the circles: wound the other way, the
    # two would cancel where they overlap.
    lit.moveTo(LOBES[0][0], LOBES[0][1])
    for cx, cy, _ in LOBES[1:]:
        lit.lineTo(cx, cy)
    lit.lineTo(LOBES[-1][0], UPM)
    lit.lineTo(LOBES[0][0], UPM)
    lit.close()
    base = pathops.Path()
    add_capsule(base, *BASE)
    out = pathops.op(base, lit, pathops.PathOp.DIFFERENCE, clockwise=True)
    for front, back, length, depth in CROOKS:
        out = pathops.op(out, crook(BUMPS[front], BUMPS[back], length, depth), pathops.PathOp.UNION, clockwise=True)
    return pathops.op(out, body, pathops.PathOp.INTERSECTION, clockwise=True)


def bounds(path):
    return path.bounds  # (xMin, yMin, xMax, yMax)


def strike_size(box, ppem):
    xmin, ymin, xmax, ymax = box
    return (math.ceil((xmax - xmin) * ppem / UPM), math.ceil((ymax - ymin) * ppem / UPM))


class FlattenPen(BasePen):
    """Collects a path as polygons, one list of points per contour."""

    def __init__(self):
        super().__init__(None)
        self.contours = []

    def _moveTo(self, pt):
        self.contours.append([pt])

    def _lineTo(self, pt):
        self.contours[-1].append(pt)

    def _curveToOne(self, p1, p2, p3):
        p0 = self._getCurrentPoint()
        for i in range(1, FLATTEN + 1):
            t = i / FLATTEN
            s = 1 - t
            self.contours[-1].append(tuple(
                s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d
                for a, b, c, d in zip(p0, p1, p2, p3)))


def mask(path, box, ppem):
    """Coverage mask of a path on the pixel grid of a strike whose lower-left
    corner is the box's. The path must be the result of a pathops.op: its
    contours don't overlap, which is what lets even-odd fill it."""
    xmin, ymin, _, _ = box
    w, h = strike_size(box, ppem)
    k = ppem / UPM * SUPERSAMPLE
    pen = FlattenPen()
    path.draw(pen)
    im = Image.new('L', (w * SUPERSAMPLE, h * SUPERSAMPLE), 0)
    for contour in pen.contours:
        one = Image.new('L', im.size, 0)
        ImageDraw.Draw(one).polygon(
            [((x - xmin) * k, h * SUPERSAMPLE - (y - ymin) * k) for x, y in contour], fill=255)
        im = ImageChops.difference(im, one)
    return im.resize((w, h), Image.LANCZOS)


def along(x, y):
    """How far a point lies along the outline gradient's direction."""
    a = math.radians(OUTLINE_ANGLE)
    return x * math.cos(a) + y * math.sin(a)


def outline_span(dx):
    """Where the outline starts and ends along the gradient's direction, with
    the glyph moved right by dx. Exact, from the primitives: the capsule
    reaches no further than its two end circles in any direction."""
    x0, x1, cy, r = BASE
    discs = [(x0, cy, r), (x1, cy, r)] + BUMPS
    return (min(along(cx + dx, cy) - r - EDGE for cx, cy, r in discs),
            max(along(cx + dx, cy) + r + EDGE for cx, cy, r in discs))


def outline_color(position):
    """OUTLINE at a position from 0 (where the outline starts along the
    gradient's direction) to 1 (where it ends)."""
    for (t0, c0), (t1, c1) in zip(OUTLINE, OUTLINE[1:]):
        if position <= t1:
            f = max(position - t0, 0) / (t1 - t0)
            return tuple(round(c0[i] + (c1[i] - c0[i]) * f) for i in range(3))
    return OUTLINE[-1][1]


def strike_image(grown, fills, dx, ppem):
    """One strike: the outline gradient over the whole grown silhouette, then
    each of `fills` on top, in order."""
    box = bounds(grown)
    size = strike_size(box, ppem)
    # One color per pixel, taken at the pixel's middle.
    start, end = outline_span(dx)
    px = UPM / ppem
    im = Image.new('RGB', size)
    im.putdata([
        outline_color((along(box[0] + (col + 0.5) * px, box[1] + (size[1] - row - 0.5) * px) - start)
                      / (end - start))
        for row in range(size[1]) for col in range(size[0])])
    for _, shape, color in fills:
        im.paste(color, mask=mask(shape, box, ppem))
    im.putalpha(mask(grown, box, ppem))
    return im


def png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def shifted(path, dx):
    out = pathops.Path()
    path.draw(TransformPen(out.getPen(), (1, 0, 0, 1, dx, 0)))
    return out


def beyond(distance):
    """Everything at least `distance` along the outline gradient's direction:
    a square on that line, far larger than the glyph."""
    a = math.radians(OUTLINE_ANGLE)
    ux, uy = math.cos(a), math.sin(a)
    far = 10 * UPM
    path = pathops.Path()
    path.moveTo(distance * ux + far * uy, distance * uy - far * ux)
    path.lineTo(distance * ux - far * uy, distance * uy + far * ux)
    path.lineTo((distance + far) * ux - far * uy, (distance + far) * uy + far * ux)
    path.lineTo((distance + far) * ux + far * uy, (distance + far) * uy - far * ux)
    path.close()
    return path


def glyph_from(path):
    pen = TTGlyphPen(None)
    path.draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=False))
    return pen.glyph()


def svg_path(path):
    pen = SVGPathPen(None, ntos=lambda v: f'{v:.1f}'.rstrip('0').rstrip('.'))
    path.draw(pen)
    return pen.getCommands()


def hex_color(color):
    return '#%02x%02x%02x' % color


def art_svg(grown, fills, dx):
    """The art as a picture cropped to the outline, with a real gradient where
    the font has pixels or steps. `fills` is what's painted over the outline,
    as (name, shape, color)."""
    xmin, ymin, xmax, ymax = bounds(grown)
    start, end = outline_span(dx)
    a = math.radians(OUTLINE_ANGLE)
    ux, uy = math.cos(a), math.sin(a)
    stops = ''.join(f'<stop offset="{t:g}" stop-color="{hex_color(color)}"/>' for t, color in OUTLINE)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{xmin:g} {-ymax:g} {xmax - xmin:g} {ymax - ymin:g}">'
            f'<linearGradient id="outline" gradientUnits="userSpaceOnUse" x1="{start * ux:.1f}" '
            f'y1="{start * uy:.1f}" x2="{end * ux:.1f}" y2="{end * uy:.1f}">{stops}</linearGradient>'
            f'<g transform="scale(1,-1)"><path fill="url(#outline)" d="{svg_path(grown)}"/>'
            + ''.join(f'<path fill="{hex_color(color)}" d="{svg_path(shape)}"/>' for _, shape, color in fills)
            + '</g></svg>\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--svg', help='also write an SVG preview of the fallback outline here')
    ap.add_argument('--png', help='also write the largest strike here')
    ap.add_argument('--out', default=OUT)
    args = ap.parse_args()

    plain = silhouette(0)
    grown = silhouette(EDGE)
    shade = shading(plain)
    # Put the outline's left edge at BEARING.
    dx = BEARING - bounds(grown)[0]
    plain, grown, shade = shifted(plain, dx), shifted(grown, dx), shifted(shade, dx)
    ring = pathops.op(grown, plain, pathops.PathOp.DIFFERENCE, clockwise=True)
    advance = math.ceil(bounds(grown)[2] + BEARING)

    if args.svg:
        xmin, ymin, xmax, ymax = bounds(grown)
        pad = 20
        vb = f'{-pad} {-(ymax + pad)} {advance + 2 * pad} {ymax - ymin + 2 * pad}'
        with open(args.svg, 'w') as f:
            f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{advance + 2 * pad}">'
                    f'<g transform="scale(1,-1)">'
                    f'<rect x="0" y="-250" width="{advance}" height="1050" fill="none" stroke="#9cf" stroke-width="4"/>'
                    f'<line x1="{-pad}" y1="0" x2="{advance + pad}" y2="0" stroke="#f99" stroke-width="4"/>'
                    f'<path d="{svg_path(ring)}" fill="#3a2a1a"/></g></svg>')

    # The same art as vector layers, bottom to top, for the COLR table below:
    # (glyph name, shape, color). Each outline step is the silhouette from its
    # own start onward along the gradient, painted over the step before, so no
    # seam can show between two of them. Steps that repeat a color (a flat
    # stretch of the gradient) are skipped.
    start, end = outline_span(dx)
    layers = []
    for step in range(OUTLINE_STEPS):
        color = outline_color((step + 0.5) / OUTLINE_STEPS)
        if layers and layers[-1][2] == color:
            continue
        rest = beyond(start + (end - start) * step / OUTLINE_STEPS)
        shape = grown if step == 0 else pathops.op(grown, rest, pathops.PathOp.INTERSECTION, clockwise=True)
        layers.append((f'cloud.edge{step}', shape, color))
    fills = [('cloud.body', plain, FILL), ('cloud.shade', shade, SHADE)]
    layers += fills

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
    sbix = newTable('sbix')
    sbix.version = 1
    sbix.flags = 1
    sbix.strikes = {}
    for ppem in STRIKES:
        strike = Strike(ppem=ppem, resolution=72)
        strike.glyphs['cloud'] = SbixGlyph(
            glyphName='cloud', graphicType='png ', originOffsetX=0, originOffsetY=0,
            imageData=png_bytes(strike_image(grown, fills, dx, ppem)))
        sbix.strikes[ppem] = strike
    fb.font['sbix'] = sbix

    # Firefox strips bitmap tables from a web font, which would leave it the
    # bare outline, but it keeps COLR. Chrome and WebKit draw the strikes when
    # a font has both, and WebKit's stale-color bug only bites when COLR is
    # what it draws, so carrying both is safe (the 2026-10 check covered this).
    fb.setupCOLR({'cloud': [(name, i) for i, (name, _, _) in enumerate(layers)]})
    fb.setupCPAL([[tuple(c / 255 for c in color) + (1.0,) for _, _, color in layers]])
    if args.png:
        strike_image(grown, fills, dx, STRIKES[-1]).save(args.png)
    # Fixed timestamps, so rerunning with unchanged geometry (and the same
    # Pillow, which encodes the PNGs) reproduces the committed file byte for byte.
    fb.font['head'].created = fb.font['head'].modified = timestampSinceEpoch(1790726400)  # 2026-09-30
    fb.font.recalcTimestamp = False
    fb.font.flavor = 'woff2'
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    fb.save(args.out)
    print(f'{args.out}: {os.path.getsize(args.out)} bytes, advance {advance}, '
          f'ink y {bounds(grown)[1]:.0f}..{bounds(grown)[3]:.0f}')
    art = os.path.splitext(args.out)[0] + '.svg'
    with open(art, 'w') as f:
        f.write(art_svg(grown, fills, dx))
    print(f'{art}: {os.path.getsize(art)} bytes')


if __name__ == '__main__':
    main()
