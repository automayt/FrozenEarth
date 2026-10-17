"""Post-process the picked candidate for every key in sprites.json and write the manifest.

    python finalize.py <sprites.json> <raw_dir> <sprites_out_dir> [key ...]

Expects the raw renders from generate.py in <raw_dir> (<key>_<seed_offset>_<index>.png and
_mask.png). The pick for each key is sprites.json[key]["pick"]; extra postprocess.py flags come
from sprites.json[key]["post"]. manifest.json lists every PNG and WebP present in the output folder
(a WebP wins over a PNG of the same name: the ground textures from ground_finalize.py are WebP).
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    specs = json.loads(Path(sys.argv[1]).read_text())
    raw, out = Path(sys.argv[2]), Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    for key in sys.argv[4:] or list(specs):
        s = specs[key]
        p = s.get("pick", {"seed_offset": 0, "index": 0})
        stem = raw / f"{key}_{p['seed_offset']}_{p['index']}"
        extra = s.get("post", "").split()
        if s.get("kind") == "terrain":
            cmd = ["terrain", f"{stem}.png", str(out / f"{key}.png"), *extra]
        else:
            cmd = ["sprite", f"{stem}.png", f"{stem}_mask.png", str(out / f"{key}.png"), *extra]
        subprocess.run([sys.executable, str(HERE / "postprocess.py"), *cmd], check=True)
        print("ok", key)
    manifest = {f.stem: f.name for f in sorted(out.glob("*.png"))}
    manifest.update({f.stem: f.name for f in sorted(out.glob("*.webp"))})
    manifest = dict(sorted(manifest.items()))
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
