"""Post-process raw ComfyUI renders into 128x128 game sprites.

Sprites:  python postprocess.py sprite <raw.png> <mask.png> <out.png> [--fill 0.9]
Terrain:  python postprocess.py terrain <raw.png> <out.png> [--grid x|y|xy] [--crop 0.8]

Sprite pipeline: alpha = RMBG-2.0 mask, minus any near-white region flood-connected to the
image border (catches leftover white "cards"), small specks removed, edge fringe trimmed,
cropped to the object's bounding box, padded to a square so the object fills ~90% of the
frame, downscaled (premultiplied alpha) to 128x128.

Terrain pipeline: centre crop, made seamless by cross-fading with a half-offset copy along
each axis separately, downscaled with wrap-around so it still tiles, fully opaque.
"""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

SIZE = 128


def white_bg_mask(rgb, tol=28):
    """True where pixel is near-white AND connected to the image border."""
    near = (rgb.astype(np.int16) >= 255 - tol).all(axis=2)
    lab, n = ndimage.label(near)
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    border = border[border > 0]
    return np.isin(lab, border)


def make_alpha(rgb, mask):
    a = mask.astype(np.float32) / 255.0
    a[white_bg_mask(rgb)] = 0.0
    a[a < 0.08] = 0.0
    # drop specks: keep components with >= 4% of the largest component's area
    lab, n = ndimage.label(a > 0.5)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(a), lab, range(1, n + 1))
        keep = np.isin(lab, 1 + np.nonzero(sizes >= sizes.max() * 0.04)[0])
        keep = ndimage.binary_dilation(keep, iterations=3)
        a[~keep] = 0.0
    # trim a 1px light fringe left over from the white background
    hard = ndimage.binary_erosion(a > 0.5, iterations=1)
    a = np.where(hard, a, np.minimum(a, 0.6) * (a > 0.5))
    return a


def resize_premult(rgba, size):
    arr = rgba.astype(np.float32) / 255.0
    arr[..., :3] *= arr[..., 3:4]
    chans = [Image.fromarray(arr[..., i]).resize((size, size), Image.LANCZOS) for i in range(4)]
    out = np.stack([np.asarray(c) for c in chans], axis=2)
    out = np.clip(out, 0, 1)
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-4, out[..., :3] / np.maximum(a, 1e-4), 0)
    out[..., 3] = np.where(out[..., 3] < 0.03, 0, out[..., 3])
    return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")


def sprite(raw_path, mask_path, out_path, fill=0.9):
    rgb = np.asarray(Image.open(raw_path).convert("RGB"))
    mask = np.asarray(Image.open(mask_path).convert("L").resize(rgb.shape[1::-1]))
    a = make_alpha(rgb, mask)
    ys, xs = np.nonzero(a > 0.05)
    if len(xs) == 0:
        raise SystemExit(f"empty alpha for {raw_path}")
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgba = np.dstack([rgb, (a * 255).astype(np.uint8)])[y0:y1, x0:x1]
    h, w = rgba.shape[:2]
    side = int(round(max(h, w) / fill))
    canvas = np.zeros((side, side, 4), np.uint8)
    oy, ox = (side - h) // 2, (side - w) // 2
    canvas[oy:oy + h, ox:ox + w] = rgba
    resize_premult(canvas, SIZE).save(out_path, optimize=True)
    return (x1 - x0, y1 - y0)


def _seam_axis(img, axis, band=0.22):
    n = img.shape[axis]
    t = (np.arange(n) + 0.5) / n
    d = np.minimum(t, 1 - t)                       # distance to nearest edge (0..0.5)
    w = np.clip(d / band, 0, 1)
    w = w * w * (3 - 2 * w)                        # smoothstep: 0 at edges, 1 inside
    shape = [1, 1, 1]; shape[axis] = n
    w = w.reshape(shape)
    rolled = np.roll(img, n // 2, axis=axis)
    return img * w + rolled * (1 - w)


def _grid_span(lum, axis, target):
    """For a regular pattern with dark grout lines perpendicular to `axis`, return (start, end)
    so that [start, end) runs from one strong grout line to another, close to `target` long.
    Wrapping the crop then puts the seam exactly on a grout line."""
    prof = lum.mean(axis=1 - axis)
    prof = prof - ndimage.uniform_filter1d(prof, 61)
    n = len(prof)
    ac = np.correlate(prof, prof, "full")[n - 1:]
    lags = np.arange(16, n // 2)
    peak = ac[lags].max()
    period = int(lags[np.argmax(ac[lags] >= 0.7 * peak)])
    # strong local minima = grout lines / gaps between boards
    mins = [i for i in range(2, n - 2)
            if prof[i] == prof[max(0, i - period // 3):i + period // 3 + 1].min()
            and prof[i] < 0.5 * prof.min()]
    best = None
    for a in mins:
        for b in mins:
            if b - a < 0.5 * target:
                continue
            score = abs((b - a) - target) + 0.3 * abs((a + b) / 2 - n / 2)
            if best is None or score < best[0]:
                best = (score, a, b)
    print(f"axis {axis}: period ~{period}px, span {best[1]}..{best[2]}")
    return best[1], best[2]


def terrain(raw_path, out_path, crop=0.8, grid_axes=()):
    """grid_axes: axes (0=y, 1=x) with a regular grout/plank pattern; those are cropped to whole
    periods instead of cross-faded so the lines stay crisp across the seam."""
    im = Image.open(raw_path).convert("RGB")
    W, H = im.size
    c = int(min(W, H) * crop)
    box = [(W - c) // 2, (H - c) // 2, (W + c) // 2, (H + c) // 2]
    lum = np.asarray(im.convert("L")).astype(np.float32)
    for ax in grid_axes:
        a, b = _grid_span(lum, ax, c)
        if ax == 1:
            box[0], box[2] = a, b
        else:
            box[1], box[3] = a, b
    arr = np.asarray(im.crop(tuple(box))).astype(np.float32)
    for ax in (1, 0):
        if ax not in grid_axes:
            arr = _seam_axis(arr, ax)
    tile = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    tw, th = tile.size
    # resize a 3x3 tiling, keep the centre, so the filter wraps around the edges
    big = Image.new("RGB", (tw * 3, th * 3))
    for i in range(3):
        for j in range(3):
            big.paste(tile, (i * tw, j * th))
    big = big.resize((SIZE * 3, SIZE * 3), Image.LANCZOS)
    big.crop((SIZE, SIZE, SIZE * 2, SIZE * 2)).save(out_path, optimize=True)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "sprite":
        fill = 0.9
        if "--fill" in sys.argv:
            fill = float(sys.argv[sys.argv.index("--fill") + 1])
        print(sprite(sys.argv[2], sys.argv[3], sys.argv[4], fill))
    elif mode == "terrain":
        axes = ()
        if "--grid" in sys.argv:  # e.g. --grid xy (tiles) or --grid y (horizontal planks)
            g = sys.argv[sys.argv.index("--grid") + 1]
            axes = tuple(a for a, ch in ((1, "x"), (0, "y")) if ch in g)
        crop = float(sys.argv[sys.argv.index("--crop") + 1]) if "--crop" in sys.argv else 0.8
        terrain(sys.argv[2], sys.argv[3], crop=crop, grid_axes=axes)
    else:
        raise SystemExit(__doc__)
