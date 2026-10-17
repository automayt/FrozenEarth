"""Post-process picked animal renders into 128x128 side-view sprites, feet on a common baseline.

    python animal_finalize.py <animals.json> <raw_dir> <sprites_out_dir> [key ...]

Expects generate.py output in <raw_dir> (<key>_<seed_offset>_<index>.png and _mask.png); the
pick per key is animals.json[key]["pick"]. Writes <sprites_out_dir>/<key>.png and adds the keys
to manifest.json there (existing entries are kept, nothing else is rewritten).

Differs from postprocess.py's `sprite` mode in two ways:
- Z-Image likes to paint a soft grey ground-shadow ellipse under animals, and RMBG keeps part of
  it. Light, unsaturated pixels flood-connected to the white background (the dark outline stops
  the fill from leaking into white fur) in the bottom 15% of the object are made transparent.
- Small enclosed holes (RMBG sometimes removes white eye highlights) are refilled.
- The animal is not centred vertically: it is scaled so its larger side is `fill` x 128, centred
  horizontally and its lowest pixel (the feet) sits on y = BASELINE, like pawn.png (feet at 122).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from postprocess import SIZE, make_alpha, resize_premult  # noqa: E402

BASELINE = 122  # last opaque row, same as pawn.png / pawn_walk_*.png


def shadow_mask(rgb, alpha, band=0.15, min_val=150, max_chroma=22):
    """Light, unsaturated pixels connected to the already-transparent background, searched only
    in the bottom `band` of the object's bounding box (where the ground shadow is), so pale
    chest/belly fur higher up can never be reached."""
    c = rgb.astype(np.int16)
    light = (c.min(axis=2) >= min_val) & ((c.max(axis=2) - c.min(axis=2)) <= max_chroma)
    ys = np.nonzero((alpha > 0.05).any(axis=1))[0]
    y_top = int(ys.max() - band * (ys.max() - ys.min()))
    light[:y_top] = False
    seed = alpha < 0.05
    seed[:y_top] = False
    lab, _ = ndimage.label(light | seed)
    touching = np.unique(lab[seed])
    touching = touching[touching > 0]
    return np.isin(lab, touching) & light


def animal(raw_path, mask_path, out_path, fill=0.9, shadow=True):
    rgb = np.asarray(Image.open(raw_path).convert("RGB"))
    mask = np.asarray(Image.open(mask_path).convert("L").resize(rgb.shape[1::-1]))
    a = make_alpha(rgb, mask)
    if shadow:
        a[shadow_mask(rgb, a)] = 0.0
    # drop whatever detached bits the shadow removal left behind
    lab, n = ndimage.label(a > 0.5)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(a), lab, range(1, n + 1))
        keep = np.isin(lab, 1 + np.nonzero(sizes >= sizes.max() * 0.04)[0])
        a[~ndimage.binary_dilation(keep, iterations=2)] = 0.0
    # RMBG sometimes punches out white eye highlights / sclera: refill small enclosed holes
    solid = a > 0.5
    holes = ndimage.binary_fill_holes(solid) & ~solid
    lab, n = ndimage.label(holes)
    if n:
        sizes = ndimage.sum(np.ones_like(a), lab, range(1, n + 1))
        small = np.isin(lab, 1 + np.nonzero(sizes <= solid.sum() * 0.01)[0])
        a[small] = 1.0
    ys, xs = np.nonzero(a > 0.05)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgba = np.dstack([rgb, (a * 255).astype(np.uint8)])[y0:y1, x0:x1]
    h, w = rgba.shape[:2]
    side = int(round(max(h, w) / fill))           # source pixels per 128 output pixels
    bottom = int(round((BASELINE + 1) / SIZE * side))
    canvas = np.zeros((side, side, 4), np.uint8)
    oy, ox = max(0, bottom - h), (side - w) // 2
    canvas[oy:oy + h, ox:ox + w] = rgba[: side - oy]
    resize_premult(canvas, SIZE).save(out_path, optimize=True)
    return w, h


def main():
    specs = json.loads(Path(sys.argv[1]).read_text())
    raw, out = Path(sys.argv[2]), Path(sys.argv[3])
    keys = sys.argv[4:] or list(specs)
    for key in keys:
        p = specs[key]["pick"]
        stem = raw / f"{key}_{p['seed_offset']}_{p['index']}"
        print(key, animal(f"{stem}.png", f"{stem}_mask.png", out / f"{key}.png",
                          specs[key].get("fill", 0.9), specs[key].get("shadow", True)))
    mpath = out / "manifest.json"
    manifest = json.loads(mpath.read_text()) if mpath.exists() else {}
    for key in keys:
        manifest[key] = f"{key}.png"
    mpath.write_text(json.dumps(dict(sorted(manifest.items())), indent=2) + "\n")


if __name__ == "__main__":
    main()
