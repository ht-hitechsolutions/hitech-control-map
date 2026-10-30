"""Remove the red callout lines baked into the HOTAS photos.
Lines are thin, straight, pure red; the red buttons are thick blobs and are kept."""
import sys, numpy as np, cv2
from PIL import Image

def clean(src, dst):
    a0 = np.array(Image.open(src).convert("RGBA"))
    P = 24  # pad so lines running along the image border are seen whole
    a = np.pad(a0, ((P, P), (P, P), (0, 0)))
    r, g, b, al = [a[..., i].astype(int) for i in range(4)]
    red = (((r > 150) & (g < 100) & (b < 100) & (r - np.maximum(g, b) > 110)) & (al > 0)).astype(np.uint8)
    thin = np.zeros_like(red)
    for k in (np.ones((1, 31), np.uint8), np.ones((31, 1), np.uint8)):   # straight runs only
        thin |= cv2.morphologyEx(red, cv2.MORPH_OPEN, k)
    blobs = cv2.morphologyEx(red, cv2.MORPH_OPEN, np.ones((13, 13), np.uint8))  # buttons
    blobs = cv2.dilate(blobs, np.ones((7, 7), np.uint8))
    mask = thin & (1 - blobs)
    # grow to the line ends and anti-aliased edges, but stay off the buttons
    grown = cv2.dilate(mask, np.ones((5, 5), np.uint8))
    for _ in range(3):  # extend along remaining red line pixels (corners, ends)
        grown = cv2.dilate(grown, np.ones((3, 3), np.uint8)) & np.maximum(red, grown) & (1 - blobs)
    grown = cv2.dilate(grown, np.ones((5, 5), np.uint8)) & (1 - blobs)
    m = (grown * 255).astype(np.uint8)
    rgb = cv2.inpaint(np.ascontiguousarray(a[..., :3]), m, 6, cv2.INPAINT_TELEA)
    alpha = cv2.inpaint(np.ascontiguousarray(a[..., 3]), m, 6, cv2.INPAINT_TELEA)
    alpha = np.where(alpha > 128, 255, 0).astype(np.uint8)
    alpha = np.where(m > 0, alpha, a[..., 3])
    out = np.dstack([rgb, alpha])[P:-P, P:-P]
    m = m[P:-P, P:-P]
    Image.fromarray(out, "RGBA").save(dst, optimize=True)
    return int(m.astype(bool).sum())

if __name__ == "__main__":
    for s in sys.argv[2:]:
        print(s, clean(f"{sys.argv[1]}/{s}", f"{sys.argv[1]}-out/{s}" if False else sys.argv[1] + "/../out/" + s))
