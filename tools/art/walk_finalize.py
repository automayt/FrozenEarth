"""Turn walk-cycle frames (raw render + RMBG mask each) into 128x128 sprites with ONE shared crop
box and scale, so the character doesn't jitter between frames.

    python walk_finalize.py <out_dir> <prefix> <raw0.png> <raw1.png> ... [--fill 0.9]

Each raw<i>.png needs raw<i>_mask.png next to it. Alpha comes from postprocess.make_alpha (same
clean-up as the static sprites). Frames are aligned on the feet baseline (lowest opaque row) and on
the head's horizontal centre (top 30% of the figure), then all are cut with the union box padded to
a square so the tallest frame fills `fill` of the height, and downscaled to 128x128.
Writes <out_dir>/<prefix>_<i>.png in the given order.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from postprocess import make_alpha, resize_premult, SIZE  # noqa: E402


def load(raw):
    rgb = np.asarray(Image.open(raw).convert("RGB"))
    mask_path = str(raw)[:-4] + "_mask.png"
    mask = np.asarray(Image.open(mask_path).convert("L").resize(rgb.shape[1::-1]))
    a = make_alpha(rgb, mask)
    return np.dstack([rgb, (a * 255).astype(np.uint8)])


def anchor(rgba):
    a = rgba[..., 3] > 12
    ys, xs = np.nonzero(a)
    top, bottom = ys.min(), ys.max()
    head = a[top:top + int((bottom - top) * 0.3)]
    hx = np.nonzero(head.any(axis=0))[0]
    return bottom, (hx.min() + hx.max()) / 2.0


def main():
    args = sys.argv[1:]
    fill = 0.9
    if "--fill" in args:
        i = args.index("--fill"); fill = float(args[i + 1]); del args[i:i + 2]
    out, prefix, raws = Path(args[0]), args[1], args[2:]
    out.mkdir(parents=True, exist_ok=True)
    frames = [load(r) for r in raws]
    anchors = [anchor(f) for f in frames]
    # shift every frame so feet baseline and head centre coincide with frame 0
    by0, hx0 = anchors[0]
    H, W = frames[0].shape[:2]
    pad = 200
    shifted = []
    for f, (by, hx) in zip(frames, anchors):
        c = np.zeros((H + 2 * pad, W + 2 * pad, 4), np.uint8)
        dy, dx = int(round(by0 - by)), int(round(hx0 - hx))
        c[pad + dy:pad + dy + H, pad + dx:pad + dx + W] = f
        shifted.append(c)
    union = np.any([s[..., 3] > 12 for s in shifted], axis=0)
    ys, xs = np.nonzero(union)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    side = int(round(max(y1 - y0, x1 - x0) / fill))
    cy, cx = (y0 + y1) / 2.0, (x0 + x1) / 2.0
    top, left = int(round(cy - side / 2)), int(round(cx - side / 2))
    for i, s in enumerate(shifted):
        canvas = np.zeros((side, side, 4), np.uint8)
        sy0, sx0 = max(top, 0), max(left, 0)
        sy1, sx1 = min(top + side, s.shape[0]), min(left + side, s.shape[1])
        canvas[sy0 - top:sy1 - top, sx0 - left:sx1 - left] = s[sy0:sy1, sx0:sx1]
        dest = out / f"{prefix}_{i}.png"
        resize_premult(canvas, SIZE).save(dest, optimize=True)
        print(dest, "anchor", anchors[i])


if __name__ == "__main__":
    main()
