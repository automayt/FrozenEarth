"""Turn the picked ground renders into the game's seamless terrain textures.

Usage: python ground_finalize.py <ground.json> <raw_dir> <sprites_dir> [--size 512] [--quality 82]

For each texture in ground.json, takes <raw_dir>/<key>_<seed_offset>_<index>.png (or the file
named by "file", relative to raw_dir), resizes it to size x size with wrap-around filtering (so
the seams stay seamless), saves <sprites_dir>/<key>.webp and points manifest.json at it.
The ground shader samples these in world space, six cells a repeat.
"""
import json
import sys
from pathlib import Path

from PIL import Image


def wrap_resize(im, size):
    w, h = im.size
    big = Image.new("RGB", (w * 3, h * 3))
    for i in range(3):
        for j in range(3):
            big.paste(im, (i * w, j * h))
    big = big.resize((size * 3, size * 3), Image.LANCZOS)
    return big.crop((size, size, size * 2, size * 2))


def main():
    args = sys.argv[1:]
    size, quality = 512, 82
    if "--size" in args:
        i = args.index("--size"); size = int(args[i + 1]); del args[i:i + 2]
    if "--quality" in args:
        i = args.index("--quality"); quality = int(args[i + 1]); del args[i:i + 2]
    spec = json.loads(Path(args[0]).read_text())
    raw, out = Path(args[1]), Path(args[2])
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for key, s in spec["textures"].items():
        pick = s.get("pick", {})
        src = raw / (pick["file"] if "file" in pick else f"{key}_{pick.get('seed_offset', 0)}_{pick.get('index', 0)}.png")
        tile = wrap_resize(Image.open(src).convert("RGB"), size)
        dest = out / f"{key}.webp"
        tile.save(dest, "WEBP", quality=quality, method=6)
        old = manifest.get(key)
        manifest[key] = dest.name
        if old and old != dest.name and (out / old).exists():
            (out / old).unlink()
        print(f"{key}: {src.name} -> {dest.name} ({dest.stat().st_size // 1024} KB)")
    manifest_path.write_text(json.dumps(dict(sorted(manifest.items())), indent=2) + "\n")


if __name__ == "__main__":
    main()
