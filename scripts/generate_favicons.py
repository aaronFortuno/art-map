"""
Generate favicon-192.png and favicon-512.png from the same design as
favicon.svg (rounded parchment square + two canonical nodes + one
secondary node, connected by subtle edges).

Run once when the SVG design changes; both PNGs are committed to the
repo for PWA installability and legacy (iOS Safari) support.
"""

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Colours copied from favicon.svg
BG       = (242, 238, 227, 255)   # #f2eee3
EDGE     = (168, 162, 150, 255)   # pre-blended: 55% #6b6458 over #f2eee3
SECOND   = (163, 157, 146, 255)   # #a39d92
CANON_BG = ( 28,  25,  23, 255)   # #1c1917
CANON_EDGE = (184, 134, 11, 255)  # #b8860b


def make_favicon(size: int, out_path: str) -> None:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def s(v):  # scale from the 64-unit SVG viewport to this raster size
        return v * size / 64.0

    # Rounded square background
    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1],
        radius=int(round(s(10))),
        fill=BG,
    )

    # Two edges (muted lines)
    line_w = max(1, int(round(s(1.6))))
    draw.line([(s(20), s(22)), (s(44), s(34))], fill=EDGE, width=line_w)
    draw.line([(s(44), s(34)), (s(26), s(50))], fill=EDGE, width=line_w)

    # Secondary node (grey circle)
    cx, cy, r = s(26), s(50), s(5)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=SECOND)

    # Canonical satellite (small, black + gold ring)
    cx, cy, r = s(20), s(22), s(6)
    draw.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        fill=CANON_BG,
        outline=CANON_EDGE,
        width=max(1, int(round(s(2)))),
    )

    # Canonical hub (bigger, thicker gold ring)
    cx, cy, r = s(44), s(34), s(8.5)
    draw.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        fill=CANON_BG,
        outline=CANON_EDGE,
        width=max(1, int(round(s(2.5)))),
    )

    img.save(out_path, 'PNG', optimize=True)
    print(f"  {out_path}  ({os.path.getsize(out_path) // 1024} KB)")


if __name__ == '__main__':
    for size in (192, 512):
        out = os.path.join(ROOT, f'favicon-{size}.png')
        make_favicon(size, out)
