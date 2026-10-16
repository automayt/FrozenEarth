"""Generate walk-cycle sprite-sheet candidates for the colonist (Z-Image Turbo, same graph as
generate.py, but with a sprite-sheet style suffix instead of "one single object").

    python walk_generate.py <out_dir> <seed> [--batch N] [--variant NAME]

Writes <out_dir>/sheet_<variant>_<seed>_<i>.png (raw) and _mask.png (RMBG-2.0). Waits only on
its own prompt ids; never interrupts or clears the shared queue.
"""
import json
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate import build_workflow, post, get, fetch  # noqa: E402

CHAR = ("the same single colonist character in every frame: cute chibi proportions with a large "
        "head, short messy brown hair, plain white long-sleeve shirt, light grey trousers, dark "
        "brown boots")

PROMPTS = {
    # 4 frames in one row
    "row4": ("A 2D game character sprite sheet: a horizontal row of exactly four frames of a walk "
             "cycle animation, evenly spaced, same size, all on one line. " + CHAR + ". Seen from "
             "a slight three-quarter top-down angle, side view walking to the right, full body. "
             "Frame 1 left leg forward, frame 2 legs together passing, frame 3 right leg forward, "
             "frame 4 legs together passing. Arms swing opposite to the legs"),
    # 2x2 grid gives bigger frames
    "grid4": ("A 2D game character sprite sheet arranged as a two by two grid of four frames of a "
              "walk cycle animation, evenly spaced, same size. " + CHAR + ". Seen from a slight "
              "three-quarter top-down angle, side view walking to the right, full body. "
              "Top left: left leg forward. Top right: legs passing. Bottom left: right leg "
              "forward. Bottom right: legs passing. Arms swing opposite to the legs"),
    # 3 frames in one row: step, neutral, step
    "row3": ("A 2D game character sprite sheet: a horizontal row of exactly three frames of a walk "
             "cycle animation, evenly spaced, same size. " + CHAR + ". Seen from a slight "
             "three-quarter top-down angle, side view walking to the right, full body. Left frame "
             "mid-stride with left leg forward, middle frame standing with legs together, right "
             "frame mid-stride with right leg forward. Arms swing opposite to the legs"),
}

STYLE_SHEET = (
    "Smooth hand-painted 2D cartoon game art in the style of RimWorld, clean flat shading, thin "
    "dark outline, muted earthy colour palette, not pixel art. Identical character design, "
    "colours and size in every frame, only the pose changes. The entire background is flat solid "
    "pure white from edge to edge, no frame lines, no grid lines, no ground, no drop shadow, no "
    "text, no numbers"
)


def main():
    args = sys.argv[1:]
    batch, variant = 2, "row4"
    if "--batch" in args:
        i = args.index("--batch"); batch = int(args[i + 1]); del args[i:i + 2]
    if "--variant" in args:
        i = args.index("--variant"); variant = args[i + 1]; del args[i:i + 2]
    out = Path(args[0]); out.mkdir(parents=True, exist_ok=True)
    seeds = [int(s) for s in args[1:]]
    client = uuid.uuid4().hex
    pending = {}
    for seed in seeds:
        wf = build_workflow(PROMPTS[variant], seed, batch, "sprite", STYLE_SHEET)
        pid = post("/prompt", {"prompt": wf, "client_id": client})["prompt_id"]
        pending[pid] = seed
        print("queued", variant, seed, pid, flush=True)
    while pending:
        time.sleep(4)
        for pid in list(pending):
            h = get(f"/history/{pid}")
            if pid not in h:
                continue
            seed = pending.pop(pid)
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print("ERROR", seed, json.dumps(st)[:800], flush=True)
                continue
            outs = h[pid]["outputs"]
            for i, img in enumerate(outs.get("10", {}).get("images", [])):
                fetch(img, out / f"sheet_{variant}_{seed}_{i}.png")
            for i, img in enumerate(outs.get("14", {}).get("images", [])):
                fetch(img, out / f"sheet_{variant}_{seed}_{i}_mask.png")
            print("done", variant, seed, flush=True)


if __name__ == "__main__":
    main()
