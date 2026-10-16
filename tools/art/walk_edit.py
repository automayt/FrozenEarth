"""Pose edits of one walk frame with Qwen-Image-Edit-2509 (fp8) + Lightning 8-step LoRA.

    python walk_edit.py <input.png> <out_dir> <name> <seed> [<seed> ...] --prompt "..." [--batch N]

Uploads <input.png> (should be the character on white, ~1 MP), runs the edit with each seed and
writes <out_dir>/<name>_<seed>_<i>.png (raw) and _mask.png (RMBG-2.0). Waits only on its own
prompt ids; never interrupts or clears the shared queue.
"""
import json
import sys
import time
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate import HOST, post, get, fetch  # noqa: E402


def upload(path):
    boundary = uuid.uuid4().hex
    data = Path(path).read_bytes()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
            f"filename=\"fe_walk_{Path(path).name}\"\r\nContent-Type: image/png\r\n\r\n").encode()
    body += data + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(HOST + "/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["name"]


def build(image_name, prompt, seed, batch=1):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_edit_2509_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors", "strength_model": 1.0}},
        "3": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["2", 0], "shift": 3.0}},
        "4": {"class_type": "CFGNorm", "inputs": {"model": ["3", 0], "strength": 1.0}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "7": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "8": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["7", 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 8}},
        "9": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["5", 0], "prompt": prompt, "vae": ["6", 0], "image1": ["8", 0]}},
        "10": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["5", 0], "prompt": "", "vae": ["6", 0], "image1": ["8", 0]}},
        "11": {"class_type": "VAEEncode", "inputs": {"pixels": ["8", 0], "vae": ["6", 0]}},
        "17": {"class_type": "RepeatLatentBatch", "inputs": {"samples": ["11", 0], "amount": batch}},
        "12": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["9", 0], "negative": ["10", 0], "latent_image": ["17", 0], "seed": seed, "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["6", 0]}},
        "14": {"class_type": "SaveImage", "inputs": {"images": ["13", 0], "filename_prefix": "frozenearth/walk_edit"}},
        "15": {"class_type": "RMBG", "inputs": {"image": ["13", 0], "model": "RMBG-2.0", "sensitivity": 1.0, "process_res": 1024, "mask_blur": 0, "mask_offset": 0, "invert_output": False, "refine_foreground": False, "unload_model": True, "background": "Alpha", "background_color": "#222222"}},
        "16": {"class_type": "SaveImage", "inputs": {"images": ["15", 2], "filename_prefix": "frozenearth/walk_edit_mask"}},
    }


def main():
    args = sys.argv[1:]
    batch = 1
    if "--batch" in args:
        i = args.index("--batch"); batch = int(args[i + 1]); del args[i:i + 2]
    i = args.index("--prompt"); prompt = args[i + 1]; del args[i:i + 2]
    src, out, name, seeds = args[0], Path(args[1]), args[2], [int(s) for s in args[3:]]
    out.mkdir(parents=True, exist_ok=True)
    img = upload(src)
    client = uuid.uuid4().hex
    pending = {}
    for seed in seeds:
        pid = post("/prompt", {"prompt": build(img, prompt, seed, batch), "client_id": client})["prompt_id"]
        pending[pid] = seed
        print("queued", name, seed, pid, flush=True)
    while pending:
        time.sleep(4)
        for pid in list(pending):
            h = get(f"/history/{pid}")
            if pid not in h:
                continue
            seed = pending.pop(pid)
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print("ERROR", seed, json.dumps(st)[:1500], flush=True)
                continue
            outs = h[pid]["outputs"]
            for k, im in enumerate(outs.get("14", {}).get("images", [])):
                fetch(im, out / f"{name}_{seed}_{k}.png")
            for k, im in enumerate(outs.get("16", {}).get("images", [])):
                fetch(im, out / f"{name}_{seed}_{k}_mask.png")
            print("done", name, seed, flush=True)


if __name__ == "__main__":
    main()
