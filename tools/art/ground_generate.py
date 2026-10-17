"""Generate seamless ground textures for the terrain shader through a local ComfyUI HTTP API.

Usage (any Python 3, stdlib only):
    python ground_generate.py <ground.json> <out_dir> [key ...] [--batch N] [--seed-offset K]

Unlike generate.py (Z-Image, cross-faded afterwards), this uses an SDXL checkpoint with the
"Model Patch Seamless (mtb)" node, which switches the UNet's convolutions to circular padding so
the render itself wraps around. Only its own prompt ids are waited on; the shared queue is never
cleared or interrupted. Post-process the picks with ground_finalize.py.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HOST = "http://127.0.0.1:8188"

STYLE = (
    "seamless tileable texture, top-down orthographic view looking straight down at the ground, "
    "hand-painted stylized 2D game texture like RimWorld, painterly, soft even daylight, no shadows "
    "from objects, uniform detail across the whole image, no horizon, no perspective, no text"
)
NEGATIVE = "perspective, horizon, sky, vignette, border, frame, text, watermark, objects, people, 3d render, photo frame"


def build(prompt, seed, batch, ckpt, steps, cfg, negative=""):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "2": {"class_type": "Model Patch Seamless (mtb)",
              "inputs": {"model": ["1", 0], "startStep": 0, "stopStep": 999, "tilingX": True, "tilingY": True}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": f"{prompt}, {STYLE}"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": f"{NEGATIVE}, {negative}" if negative else NEGATIVE}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": batch}},
        "6": {"class_type": "KSampler", "inputs": {"model": ["2", 0], "positive": ["3", 0], "negative": ["4", 0],
                                                   "latent_image": ["5", 0], "seed": seed, "steps": steps, "cfg": cfg,
                                                   "sampler_name": "dpmpp_sde", "scheduler": "karras", "denoise": 1.0}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "frozenearth/ground"}},
    }


def post(path, payload):
    req = urllib.request.Request(HOST + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def get(path):
    return json.loads(urllib.request.urlopen(HOST + path, timeout=60).read())


def fetch(img, dest):
    q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img["subfolder"], "type": img["type"]})
    dest.write_bytes(urllib.request.urlopen(f"{HOST}/view?{q}", timeout=60).read())


def main():
    args = sys.argv[1:]
    batch, offset = 2, 0
    if "--batch" in args:
        i = args.index("--batch"); batch = int(args[i + 1]); del args[i:i + 2]
    if "--seed-offset" in args:
        i = args.index("--seed-offset"); offset = int(args[i + 1]); del args[i:i + 2]
    spec = json.loads(Path(args[0]).read_text())
    out = Path(args[1]); out.mkdir(parents=True, exist_ok=True)
    keys = args[2:] or list(spec["textures"])
    m = spec["model"]
    client = uuid.uuid4().hex
    pending = {}
    for key in keys:
        s = spec["textures"][key]
        wf = build(s["prompt"], s["seed"] + offset, batch, m["ckpt"], m["steps"], m["cfg"], s.get("negative", ""))
        pending[post("/prompt", {"prompt": wf, "client_id": client})["prompt_id"]] = key
        print("queued", key, flush=True)
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
            for i, img in enumerate(h[pid]["outputs"].get("8", {}).get("images", [])):
                fetch(img, out / f"{key}_{offset}_{i}.png")
            print("done", key, flush=True)


if __name__ == "__main__":
    main()
