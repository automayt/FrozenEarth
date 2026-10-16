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

## Colonist walk cycle (`pawn_walk_0..3`)
Four frames, in cycle order, facing right (the game mirrors them for left):
`0` stride (contact), `1` stride with arms down, `2` passing (feet together, body ~2 px higher),
`3` stride opening again. They are drawn in side view and are the same character as `pawn.png`:
big head, brown hair, white collared shirt, light grey trousers and dark grey shoes. The clothing
stays light so the faction tint still works.

### What didn't work
`walk_generate.py` tried Z-Image Turbo sprite sheets (a 4-frame row, a 2x2 grid and a 3-frame row,
seeds 7001/7002, 7101/7102 and 7201/7202). Each sheet kept one character consistent, but almost
every frame copied the same stride pose, so they weren't a walk cycle. The 2x2 grids also mixed
left- and right-facing frames. That character also didn't match `pawn.png` (no collar, boots).

### Method used: Qwen-Image-Edit-2509 pose edits (`walk_edit.py`)
- Model: `qwen_image_edit_2509_fp8_e4m3fn` + `Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16`
  LoRA (strength 1), text encoder `qwen_2.5_vl_7b_fp8_scaled` (type `qwen_image`), VAE
  `qwen_image_vae`. ModelSamplingAuraFlow shift 3, CFGNorm 1, KSampler euler/simple, 8 steps,
  cfg 1. The input is scaled to 1 MP (1024x1024) and encoded as the latent (denoise 1). RMBG-2.0
  mask as for the other sprites.
- Base frame: `pawn.png` upscaled to 768 px (LANCZOS) on a 1024x1024 white canvas, edited with
  seed **62** and this prompt:
  > Turn this cartoon character to a side view, facing and walking to the right, in a calm walking
  > pose mid-stride with one leg forward and one leg back, arms swinging gently opposite to the
  > legs, full body. Keep exactly the same character design, face, big head, brown hair, white
  > collared shirt, light grey trousers, dark grey shoes, colours, proportions and size, same
  > smooth flat cartoon art style with thin dark outline. Plain pure white background, no motion
  > lines, no ground line, no shadow.
- The other frames are edits of that base frame's raw render. Each prompt is `<pose>. <KEEP>`,
  where KEEP = "Keep exactly the same character design, face, hair, clothes, colours,
  proportions, size, position, flat cartoon art style and line thickness, still facing right in
  side view. Plain pure white background, no motion lines, no ground line, no shadow."
  - frame 1, seed **91**: "Change the pose of this cartoon character to the passing position of
    a slow walk: he stands on one straight leg directly under his body while the other leg is
    bent with the knee forward and the foot lifted a little off the ground beside the standing
    leg, arms close to the body. Walking slowly, not running."
  - frame 2, seed **71**: "Change the pose of this cartoon character so he stands upright with
    both feet together side by side on the ground, both legs straight and parallel, arms relaxed
    hanging at his sides."
  - frame 3, seed **83**: "Change the pose of this cartoon character to a calm walking pose
    halfway between two steps: both legs are close together under the body, the back foot is
    just lifting off the ground with the heel raised and the knee slightly bent, the front foot
    is flat on the ground, the arms hang close to the body with a small swing. Walking slowly,
    not running."
- The edit keeps scale and position almost exactly: head width stays within 1% across frames.
  "Running"-style passing prompts added motion lines and a kicked-up leg, so I rejected those
  seeds.

### Regenerate
```sh
python tools/art/walk_edit.py <scratch>/pawn_white.png <scratch>/edit pside 62 --prompt "<base prompt>"
python tools/art/walk_edit.py <scratch>/edit/pside_62_0.png <scratch>/edit2 pass 91 --prompt "<frame 1>. <KEEP>"
python tools/art/walk_edit.py <scratch>/edit/pside_62_0.png <scratch>/edit2 stand 71 --prompt "<frame 2>. <KEEP>"
python tools/art/walk_edit.py <scratch>/edit/pside_62_0.png <scratch>/edit2 mid 83 --prompt "<frame 3>. <KEEP>"
python tools/art/walk_finalize.py apps/client/public/sprites pawn_walk \
    <scratch>/edit/pside_62_0.png <scratch>/edit2/pass_91_0.png \
    <scratch>/edit2/stand_71_0.png <scratch>/edit2/mid_83_0.png
```
`walk_finalize.py` gives every frame the same alpha clean-up as `postprocess.py`. It aligns the
frames on the feet baseline and the head's horizontal centre, then cuts them all with one
shared, square-padded union box (fill 0.9) and downscales them to 128x128, so the character
doesn't jitter or change scale. It doesn't rewrite `manifest.json`; the `pawn_walk_*` keys were
added by hand. Note that `finalize.py` regenerates the manifest from every PNG in the folder, so
it keeps them. Generated on ComfyUI 0.39.0.
