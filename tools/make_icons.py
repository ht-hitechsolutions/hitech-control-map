"""Build every icon from the HiTech Control Map logo (tools/logo-source.png):
the full logo on a black rounded square, and the HT part alone for the tiny sizes.

usage: python3 make_icons.py tools/logo-source.png server/web server
"""
import sys
import numpy as np
from PIL import Image, ImageDraw

def artwork(src):
    """Returns (image, box) pairs. `box` is the part that gets centred:
    full logo - from the H's left edge to the bottom of the C (the p's descender
    may hang into the margin), and the full height; HT alone - its own outline."""
    im = Image.open(src).convert("RGB")
    white = np.array(im).min(axis=2) > 128
    ys, xs = np.where(white)
    top, bottom, left = ys.min(), ys.max() + 1, xs.min()
    cols = white.any(axis=0)
    x = left
    while cols[x]:              # the HT ends at the first empty column; the text follows
        x += 1
    ht_right = x
    text = white[:, ht_right:]
    rows = text.any(axis=1)
    y = bottom - 1              # the C is the lowest letter (text reads bottom-to-top)
    while not rows[y]:
        y -= 1
    c_bottom = y
    while rows[y]:
        y -= 1
    c_xs = np.where(text[y + 1:c_bottom + 1].any(axis=0))[0]
    c_right = ht_right + c_xs.max() + 1
    return (im, (left, top, c_right, bottom)), (im, (left, top, ht_right, bottom))

def on_square(art, size, fill=0.80, radius=0.13):
    """Centre art[1] (box) on a black rounded square; anything outside the box
    (like the p's descender) is drawn too, hanging into the margin."""
    im, (l, t, r, b) = art
    k = 4
    S = size * k
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * radius, fill=255)
    sc = S * fill / max(r - l, b - t)
    big = im.resize((round(im.width * sc), round(im.height * sc)), Image.LANCZOS)
    ox = round(S / 2 - (l + r) / 2 * sc)          # box centre -> square centre
    oy = round(S / 2 - (t + b) / 2 * sc)
    bg = Image.new("RGB", (S, S), (0, 0, 0))
    bg.paste(big, (ox, oy))
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)

if __name__ == "__main__":
    src, web, server = sys.argv[1:4]
    full, ht = artwork(src)
    icon = lambda n: on_square(full if n >= 48 else ht, n, fill=0.80 if n >= 48 else 0.74)
    icon(512).save(f"{web}/icon-512.png")
    icon(192).save(f"{web}/icon-192.png")
    on_square(full, 256).save(f"{web}/logo.png")
    on_square(ht, 64, fill=0.74).save(f"{web}/favicon.png")
    sizes = (16, 24, 32, 48, 64, 128, 256)
    icon(256).save(f"{server}/app.ico", sizes=[(n, n) for n in sizes], append_images=[icon(n) for n in sizes[:-1]])
    print("icons written")
