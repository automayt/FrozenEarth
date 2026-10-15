"""Generate FrozenEarth sprite candidates through a local ComfyUI HTTP API.

Usage (any Python 3, stdlib only):
    python generate.py <sprites.json> <out_dir> [key ...] [--batch N] [--seed-offset K]

sprites.json maps key -> {"prompt": str, "seed": int, optional "kind": "sprite"|"terrain",
optional "style": str (replaces the shared style suffix)}.

For each key it enqueues workflow_api.json (Z-Image Turbo, 9 steps, + RMBG-2.0 mask for sprites)
with seed = seed + offset, waits for its own prompt ids only (never interrupts or clears the
queue), and downloads <out_dir>/<key>_<offset>_<i>.png (raw render) and
<out_dir>/<key>_<offset>_<i>_mask.png (RMBG mask). Pick the best candidate per key, then run
postprocess.py on it.
"""
import copy
import json
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HOST = "http://127.0.0.1:8188"
HERE = Path(__file__).resolve().parent

STYLE_SPRITE = (
    "Smooth hand-painted 2D cartoon game art in the style of RimWorld, clean flat shading, "
    "thin dark outline, muted earthy colour palette, not pixel art. One single object in the "
    "middle of the image. The entire background is flat solid pure white from edge to edge, "
    "no frame, no card, no ground patch, no drop shadow, no text"
)
STYLE_TERRAIN = (
    "Seamless tileable 2D game ground texture viewed from directly above, flat orthographic, "
    "hand-painted RimWorld game art style, muted earthy palette, even flat lighting, uniform "
    "pattern filling the whole frame edge to edge, no objects, no shadows, no text, no border, "
    "no vignette"
)


def build_workflow(prompt, seed, batch=2, kind="sprite", style=None, width=1024, height=1024):
    wf = copy.deepcopy(json.loads((HERE / "workflow_api.json").read_text()))
    if style is None:
        style = STYLE_TERRAIN if kind == "terrain" else STYLE_SPRITE
    wf["5"]["inputs"]["text"] = f"{prompt}. {style}"
    wf["6"]["inputs"]["text"] = ""  # cfg 1.0: negative is ignored by Z-Image Turbo
    wf["7"]["inputs"].update(width=width, height=height, batch_size=batch)
    wf["8"]["inputs"]["seed"] = seed
    if kind == "terrain":  # opaque textures: no background removal
        wf.pop("12"); wf.pop("14")
    return wf


def post(path, payload):
    req = urllib.request.Request(HOST + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def get(path):
    return json.loads(urllib.request.urlopen(HOST + path, timeout=60).read())


def fetch(img, dest):
    q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img["subfolder"],
                                "type": img["type"]})
    dest.write_bytes(urllib.request.urlopen(f"{HOST}/view?{q}", timeout=60).read())


def main():
    args = sys.argv[1:]
    batch, offset = 2, 0
    if "--batch" in args:
        i = args.index("--batch"); batch = int(args[i + 1]); del args[i:i + 2]
    if "--seed-offset" in args:
        i = args.index("--seed-offset"); offset = int(args[i + 1]); del args[i:i + 2]
    specs = json.loads(Path(args[0]).read_text())
    out = Path(args[1]); out.mkdir(parents=True, exist_ok=True)
    keys = args[2:] or list(specs)
    client = uuid.uuid4().hex
    pending = {}
    for key in keys:
        s = specs[key]
        wf = build_workflow(s["prompt"], s["seed"] + offset, batch, s.get("kind", "sprite"),
                            s.get("style"))
        pid = post("/prompt", {"prompt": wf, "client_id": client})["prompt_id"]
        pending[pid] = key
        print("queued", key, pid, flush=True)
    while pending:
        time.sleep(4)
        for pid in list(pending):
            h = get(f"/history/{pid}")
            if pid not in h:
                continue
            key = pending.pop(pid)
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print("ERROR", key, json.dumps(st)[:800], flush=True)
                continue
            outs = h[pid]["outputs"]
            for i, img in enumerate(outs.get("10", {}).get("images", [])):
                fetch(img, out / f"{key}_{offset}_{i}.png")
            for i, img in enumerate(outs.get("14", {}).get("images", [])):
                fetch(img, out / f"{key}_{offset}_{i}_mask.png")
            print("done", key, flush=True)


if __name__ == "__main__":
    main()
