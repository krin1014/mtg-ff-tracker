#!/usr/bin/env python3
"""
Generate the app icons for the Final Fantasy MTG Collection Tracker.

Writes PNGs into ../icons/ using nothing but the standard library, so the repo
has no image-library dependency. Re-run this only if you want to change the
icon artwork:

    python tools/make_icons.py

Output:
    icons/icon-192.png            manifest icon
    icons/icon-512.png            manifest icon
    icons/icon-maskable-512.png   manifest icon, full-bleed for Android masking
    icons/apple-touch-icon.png    180x180, iOS "Add to Home Screen"
    icons/icon-32.png             small favicon fallback

The artwork is a crystal on the app's deep-slate background, matching the
palette in style.css.
"""

import os
import struct
import sys
import zlib

# Palette (matches the CSS custom properties in style.css)
BG_TOP = (19, 27, 46)        # --bg-card    #131B2E
BG_BOTTOM = (8, 11, 19)      # slightly darker than --bg-main
GEM_TOP = (125, 211, 252)    # #7DD3FC
GEM_BOTTOM = (99, 102, 241)  # --accent-indigo #6366F1
TABLE_TOP = (224, 242, 254)  # #E0F2FE
TABLE_BOTTOM = (56, 189, 248)  # --accent-cyan #38BDF8
GOLD = (245, 158, 11)        # --accent-gold #F59E0B

SUPERSAMPLE = 3

# Gem outline in normalised coordinates: origin at the icon centre, one unit
# equals the icon's full width, y grows downwards.
GEM = [(-0.26, -0.24), (0.26, -0.24), (0.40, 0.02), (0.00, 0.44), (-0.40, 0.02)]
GEM_TABLE = [(-0.26, -0.24), (0.26, -0.24), (0.16, -0.06), (-0.16, -0.06)]
SPARKLE = [(0.0, -1.0), (0.24, -0.24), (1.0, 0.0), (0.24, 0.24),
           (0.0, 1.0), (-0.24, 0.24), (-1.0, 0.0), (-0.24, -0.24)]


def lerp(a, b, t):
    return a + (b - a) * t


def mix(color_a, color_b, t):
    return (lerp(color_a[0], color_b[0], t),
            lerp(color_a[1], color_b[1], t),
            lerp(color_a[2], color_b[2], t))


def point_in_polygon(x, y, polygon):
    """Ray-casting test. Points exactly on an edge may fall either way, which
    supersampling smooths out anyway."""
    inside = False
    count = len(polygon)
    j = count - 1
    for i in range(count):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def in_rounded_rect(x, y, half, radius):
    """x, y relative to centre; half is half the side length."""
    ax, ay = abs(x), abs(y)
    if ax > half or ay > half:
        return False
    cx, cy = half - radius, half - radius
    if ax <= cx or ay <= cy:
        return True
    dx, dy = ax - cx, ay - cy
    return dx * dx + dy * dy <= radius * radius


def scale_polygon(polygon, factor, offset_x=0.0, offset_y=0.0):
    return [(px * factor + offset_x, py * factor + offset_y) for px, py in polygon]


def render(size, maskable=False):
    """Return an RGBA bytearray of size*size pixels."""
    supersampled = size * SUPERSAMPLE
    step = 1.0 / supersampled

    # Full bleed for maskable icons (Android crops to its own shape); rounded
    # square otherwise. Shrink the artwork on maskable icons so it survives the
    # crop to the inner safe zone.
    radius = 0.0 if maskable else 0.22
    art_scale = 0.76 if maskable else 1.0

    gem = scale_polygon(GEM, art_scale)
    table = scale_polygon(GEM_TABLE, art_scale)
    sparkle = scale_polygon(SPARKLE, 0.085 * art_scale, 0.30 * art_scale, -0.30 * art_scale)
    sparkle_small = scale_polygon(SPARKLE, 0.05 * art_scale, -0.32 * art_scale, 0.22 * art_scale)

    # Accumulate colour at supersampled resolution, then box-average down.
    acc = [0.0] * (size * size * 4)

    for sy in range(supersampled):
        y = (sy + 0.5) * step - 0.5
        out_y = sy // SUPERSAMPLE
        row_base = out_y * size * 4
        for sx in range(supersampled):
            x = (sx + 0.5) * step - 0.5

            if not in_rounded_rect(x, y, 0.5, radius):
                continue  # transparent outside the rounded square

            # Background vertical gradient
            t = (y + 0.5)
            r, g, b = mix(BG_TOP, BG_BOTTOM, t)

            if point_in_polygon(x, y, gem):
                gt = (y + 0.24 * art_scale) / (0.68 * art_scale)
                gt = 0.0 if gt < 0.0 else (1.0 if gt > 1.0 else gt)
                r, g, b = mix(GEM_TOP, GEM_BOTTOM, gt)

                if point_in_polygon(x, y, table):
                    tt = (y + 0.24 * art_scale) / (0.18 * art_scale)
                    tt = 0.0 if tt < 0.0 else (1.0 if tt > 1.0 else tt)
                    r, g, b = mix(TABLE_TOP, TABLE_BOTTOM, tt)

            if point_in_polygon(x, y, sparkle) or point_in_polygon(x, y, sparkle_small):
                r, g, b = GOLD

            idx = row_base + (sx // SUPERSAMPLE) * 4
            acc[idx] += r
            acc[idx + 1] += g
            acc[idx + 2] += b
            acc[idx + 3] += 255.0

    samples = float(SUPERSAMPLE * SUPERSAMPLE)
    out = bytearray(size * size * 4)
    for i in range(0, len(acc), 4):
        alpha = acc[i + 3] / samples
        if alpha <= 0.5:
            continue
        # acc holds premultiplied-by-coverage colour; divide by the covered
        # sample count so partially covered edge pixels keep their true colour.
        covered = acc[i + 3] / 255.0
        out[i] = min(255, int(acc[i] / covered + 0.5))
        out[i + 1] = min(255, int(acc[i + 1] / covered + 0.5))
        out[i + 2] = min(255, int(acc[i + 2] / covered + 0.5))
        out[i + 3] = min(255, int(alpha + 0.5))
    return out


def write_png(path, size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as handle:
        handle.write(png)


SVG_FAVICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#131B2E"/>
      <stop offset="1" stop-color="#080B13"/>
    </linearGradient>
    <linearGradient id="gem" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7DD3FC"/>
      <stop offset="1" stop-color="#6366F1"/>
    </linearGradient>
    <linearGradient id="table" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#E0F2FE"/>
      <stop offset="1" stop-color="#38BDF8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="113" fill="url(#bg)"/>
  <polygon points="123,133 389,133 461,266 256,481 51,266" fill="url(#gem)"/>
  <polygon points="123,133 389,133 338,225 174,225" fill="url(#table)"/>
  <polygon points="410,102 422,141 461,154 422,166 410,205 397,166 358,154 397,141"
           fill="#F59E0B"/>
  <polygon points="92,369 99,392 122,399 99,406 92,428 84,406 61,399 84,392"
           fill="#F59E0B"/>
</svg>
"""


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(os.path.dirname(here), "icons")
    os.makedirs(out_dir, exist_ok=True)

    targets = [
        ("icon-32.png", 32, False),
        ("apple-touch-icon.png", 180, False),
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ]

    for filename, size, maskable in targets:
        sys.stdout.write(f"  rendering {filename} ({size}x{size})... ")
        sys.stdout.flush()
        write_png(os.path.join(out_dir, filename), size, render(size, maskable))
        sys.stdout.write("done\n")

    with open(os.path.join(out_dir, "favicon.svg"), "w", encoding="utf-8") as handle:
        handle.write(SVG_FAVICON)
    print("  wrote favicon.svg")
    print(f"\nIcons written to {out_dir}")


if __name__ == "__main__":
    main()
