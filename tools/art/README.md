# FrozenEarth placeholder art

Placeholder sprites in `apps/client/public/sprites/` were generated on the local ComfyUI
(`http://127.0.0.1:8188`, RTX 3090) and post-processed with PIL.

## Model and settings
- **Z-Image Turbo** (`z_image_turbo_bf16.safetensors`), text encoder `qwen_3_4b.safetensors`
  (CLIPLoader type `lumina2`), VAE `ae.safetensors`.
- ModelSamplingAuraFlow shift 3.0, KSampler `res_multistep` / `simple`, 9 steps, cfg 1.0, 1024x1024,
  batch 2. There's no negative prompt because cfg 1 ignores it.
- Sprites: background removed with **RMBG-2.0** (ComfyUI-RMBG `RMBG` node). Its mask is saved next
  to the raw render.
- The full graph is in `workflow_api.json` (API format). `generate.py` fills in the prompt, seed and
  batch, and drops the RMBG nodes for terrain.
- I tried other models first. Qwen-Image (+Lightning LoRA) kept producing pixel art, isometric
  dioramas and "sticker card" backgrounds. Flux Krea was slower, painted frames and once wrote
  "RimWorld" on the image. Z-Image gave clean, readable top-down art on pure white.

## Prompts and seeds
`sprites.json` holds, per key: `prompt`, base `seed`, `kind` (sprite or terrain), an optional
`style` override, the `pick` (seed_offset and batch index of the chosen candidate) and extra
`post` flags. The final prompt sent is `<prompt>. <style>`, using the shared style suffix in
`generate.py`:

> Smooth hand-painted 2D cartoon game art in the style of RimWorld, clean flat shading, thin dark
> outline, muted earthy colour palette, not pixel art. One single object in the middle of the image.
> The entire background is flat solid pure white from edge to edge, no frame, no card, no ground
> patch, no drop shadow, no text

The seed actually used is `seed + seed_offset`.

## Regenerate
```sh
# 1. raw candidates (raw renders + masks), outside the repo
python tools/art/generate.py tools/art/sprites.json <scratch>/raw                       # offset 0
python tools/art/generate.py tools/art/sprites.json <scratch>/raw --seed-offset 100 \
    building_chair building_heater building_stove building_workbench terrain_stone_tile terrain_wood_floor
# 2. post-process the picks into the game folder and rewrite manifest.json
python tools/art/finalize.py tools/art/sprites.json <scratch>/raw apps/client/public/sprites
```
To try new variants of a sprite, run `generate.py ... <key> --seed-offset N`, look at the
candidates, and update its `pick` in `sprites.json`. Any Python 3 with Pillow, numpy and scipy
can run the scripts. `generate.py` uses only the standard library and only waits on its own
prompt ids. It never clears or interrupts the shared queue.

## Post-processing (`postprocess.py`)
- **sprite**: alpha comes from the RMBG mask. Near-white regions touching the border are removed,
  specks are dropped and the 1px fringe is trimmed. The image is then cropped to the bounding box,
  padded to a square with the object filling about 90%, and downscaled to 128x128 RGBA (LANCZOS
  with premultiplied alpha).
- **terrain**: centre 80% crop, made seamless by cross-fading with a half-offset copy along each
  axis. For regular grids (`--grid x|y|xy`) the crop instead runs from one grout line to another
  so the lines stay crisp. The tile is downscaled with wrap-around to an opaque 128x128 RGB image.

## Notes
- Items and some furniture (cooler, heater front, door) are drawn at a slight 3/4 angle or front
  view, in the RimWorld manner. Plants and the bed, campfire, stove, workbench, table and crafting
  spot are true top-down. The door is a front-view door, chosen because it reads more clearly than
  the top-down attempts.
- `pawn` wears a white shirt and light grey trousers so it can be tinted. Hair and skin are
  untinted.
