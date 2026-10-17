import { BufferImageSource, Container, Mesh, MeshGeometry, RendererType, Shader, UniformGroup, type Renderer } from 'pixi.js';
import { TERRAINS } from '@fe/defs';
import { ATLAS_COLS, ATLAS_GUTTER, ATLAS_SLOT, ATLAS_TILE, blitSlot, buildParams, DEPTH_WINDOW, KIND, makeNoise, PARAM_W, planAtlas, proceduralTexture, terrainKind, textureContrast, writeIndex, type Pixels } from './groundData';

/**
 * The ground: one map-sized quad drawn by a WebGL2 shader, instead of a flat colour per cell.
 *
 * Per-cell data lives in a small index texture (one texel a cell: terrain id and water depth), so
 * a changed cell costs a 4-byte write and a one-row upload. The shader samples painted textures
 * from an atlas in world space (seamless, two rotated samples blended by noise so the repeat
 * doesn't show), blends the four cells around each pixel through a noise-warped, height-weighted
 * mix (so edges are organic, not square), and draws water over it: a curvy shoreline with wet
 * sand and foam, shallow to deep colour, slow ripples. Ice keeps the water's outline. Built floors
 * stay crisp to the cell grid.
 *
 * WebGL2 only; GameRenderer keeps its per-cell bitmap when create() returns null (also with
 * ?ground=0 in the URL). Missing texture images fall back to mottled terrain colours.
 */

const VERTEX = /* glsl */ `#version 300 es
in vec2 aPosition;
in vec2 aUV;
out vec2 vCell;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vCell = aUV;
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vCell;
out vec4 finalColor;

uniform sampler2D uIndex;
uniform sampler2D uAtlas;
uniform sampler2D uNoise;
uniform sampler2D uParams;
uniform vec4 uColor;
uniform vec2 uMapSize;
uniform vec2 uAtlasSize;
uniform float uTime;
uniform float uBedSlot;

const float SLOT = ${ATLAS_SLOT.toFixed(1)};
const float TILE = ${ATLAS_TILE.toFixed(1)};
const float GUT = ${ATLAS_GUTTER.toFixed(1)};
const float COLS = ${ATLAS_COLS.toFixed(1)};
const vec3 LUMA = vec3(0.3, 0.59, 0.11);

vec4 cellAt(ivec2 c) {
  return texelFetch(uIndex, clamp(c, ivec2(0), ivec2(uMapSize) - 1), 0);
}
int idOf(vec4 v) { return int(v.r * 255.0 + 0.5); }
vec4 par0(int id) { return texelFetch(uParams, ivec2(id, 0), 0); }
vec4 par1(int id) { return texelFetch(uParams, ivec2(id, 1), 0); }
int kindOf(int id) { return int(par0(id).g * 255.0 + 0.5); }

vec3 atlas(float slot, vec2 uv, float lod) {
  vec2 base = vec2(mod(slot, COLS), floor(slot / COLS)) * SLOT + GUT;
  return textureLod(uAtlas, (base + fract(uv) * TILE) / uAtlasSize, lod).rgb;
}

// A terrain's painted colour at cell position p. Natural ground mixes in a second, rotated and
// rescaled sample where mixN is high, so the texture's repeat doesn't line up into a grid.
vec3 terrainColor(int id, vec2 p, float pxCell, float mixN, bool crisp) {
  vec4 a = par0(id);
  float slot = floor(a.r * 255.0 + 0.5);
  float rep = a.a * 32.0;
  float lod = clamp(log2(TILE / rep / pxCell), 0.0, 4.0);
  vec3 c = atlas(slot, p / rep, lod);
  if (!crisp && mixN > 0.01) {
    vec2 r = mat2(0.8, -0.6, 0.6, 0.8) * p * 1.13 + vec2(2.3, 4.1);
    c = mix(c, atlas(slot, r / rep, lod + 0.18), mixN);
  }
  return c * par1(id).rgb * 2.0;
}

// Slow swell (about 0..1) for a faint light and dark drift across open water.
float swell(vec2 p) {
  return textureLod(uNoise, p * 0.09 + uTime * vec2(0.006, 0.004), 0.0).a;
}

// Wavelets: two sets of wave lines bent by noise and drifting, multiplied into small moving glints.
float glints(vec2 p, float n) {
  float s1 = sin(dot(p, vec2(0.8, 0.6)) * 4.7 + n * 7.0 - uTime * 1.3);
  float s2 = sin(dot(p, vec2(-0.45, 0.89)) * 6.1 + n * 5.0 - uTime * 0.9);
  float g = (s1 * 0.5 + 0.5) * (s2 * 0.5 + 0.5);
  return g * g * g * g;
}

void main() {
  vec2 p = vCell;
  vec2 fw = fwidth(p);
  float pxCell = 1.0 / max(max(fw.x, fw.y), 1e-5);
  vec4 nL = texture(uNoise, p * 0.043);
  vec4 nM = texture(uNoise, p * 0.17 + 0.5);
  vec4 nH = texture(uNoise, p * 0.61 + 0.25);
  float mixN = smoothstep(0.3, 0.7, nL.a);

  ivec2 ci = ivec2(floor(p));
  vec4 own = cellAt(ci);
  int ownId = idOf(own);
  int ownKind = kindOf(ownId);
  vec3 col;

  if (ownKind == ${KIND.floor}) {
    // Built floor: crisp to the cell, its pattern on the grid, a dark lip where it meets open ground.
    col = terrainColor(ownId, p, pxCell, 0.0, true);
    col *= 0.95 + 0.1 * texelFetch(uNoise, ci & 255, 0).b;
    vec2 f = fract(p);
    float e = 1.0;
    if (kindOf(idOf(cellAt(ci + ivec2(-1, 0)))) != ${KIND.floor}) e = min(e, f.x);
    if (kindOf(idOf(cellAt(ci + ivec2(1, 0)))) != ${KIND.floor}) e = min(e, 1.0 - f.x);
    if (kindOf(idOf(cellAt(ci + ivec2(0, -1)))) != ${KIND.floor}) e = min(e, f.y);
    if (kindOf(idOf(cellAt(ci + ivec2(0, 1)))) != ${KIND.floor}) e = min(e, 1.0 - f.y);
    col *= mix(0.68, 1.0, smoothstep(0.0, 0.06, e));
    finalColor = vec4(col * uColor.rgb, 1.0) * uColor.a;
    return;
  }

  // The four cells around the pixel, looked up through a noise-warped position.
  // (The noise sits mostly within 0.3..0.7, so this moves edges by up to about 0.4 cell.)
  vec2 warp = (nM.rg - 0.5) * 1.6 + (nH.rg - 0.5) * 0.6;
  vec2 q = p + warp - 0.5;
  ivec2 b = ivec2(floor(q));
  vec2 f = fract(q);
  float w[4];
  w[0] = (1.0 - f.x) * (1.0 - f.y);
  w[1] = f.x * (1.0 - f.y);
  w[2] = (1.0 - f.x) * f.y;
  w[3] = f.x * f.y;
  int ids[4];
  int kd[4];
  float wWater = 0.0;
  float wIce = 0.0;
  float dsum = 0.0;
  int iceId = -1;
  for (int k = 0; k < 4; k++) {
    vec4 v = cellAt(b + ivec2(k & 1, k >> 1));
    int id = idOf(v);
    int kk = kindOf(id);
    // Floors don't bleed into the ground around them: stand in the pixel's own terrain.
    if (kk == ${KIND.floor}) { v = own; id = ownId; kk = ownKind; }
    ids[k] = id;
    kd[k] = kk;
    if (kk >= ${KIND.water}) {
      wWater += w[k];
      dsum += w[k] * v.g;
      if (kk == ${KIND.ice}) { wIce += w[k]; iceId = id; }
    }
  }

  // Land: height-weighted blend of the dry corners, so pebbles and tufts poke through an edge.
  vec3 cs[4];
  float s[4];
  float top = -1.0;
  for (int k = 0; k < 4; k++) {
    s[k] = -1.0;
    if (kd[k] != ${KIND.land}) continue;
    bool dup = false;
    for (int j = 0; j < 4; j++) {
      if (j >= k) break;
      if (kd[j] == ${KIND.land} && ids[j] == ids[k]) { cs[k] = cs[j]; dup = true; break; }
    }
    if (!dup) cs[k] = terrainColor(ids[k], p, pxCell, mixN, false);
    s[k] = w[k] + (dot(cs[k], LUMA) + par0(ids[k]).b) * 0.5;
    top = max(top, s[k]);
  }
  vec3 land = vec3(0.0);
  float wl = 0.0;
  float puddly = 0.0;
  for (int k = 0; k < 4; k++) {
    if (s[k] < 0.0) continue;
    float g = max(s[k] - top + 0.12, 0.0);
    land += cs[k] * g;
    puddly += par1(ids[k]).a * g;
    wl += g;
  }
  if (wl > 0.0) {
    land /= wl;
    puddly /= wl;
  }
  if (wWater > 0.0) {
    // Lake bed: fades in as the dry corners fall away, so there's no seam where the last one goes.
    vec3 bed = atlas(uBedSlot, p / 4.0, clamp(log2(TILE / 4.0 / pxCell), 0.0, 4.0)) * vec3(0.62, 0.66, 0.6);
    land = wl > 0.0 ? mix(bed, land, smoothstep(0.0, 0.5, 1.0 - wWater)) : bed;
  }
  // Broad light and dark patches over everything natural.
  land *= 0.9 + 0.2 * nL.b;
  col = land;

  // Marsh: standing puddles in the low spots.
  if (puddly > 0.01) {
    float pm = smoothstep(0.6, 0.66, nH.b * 0.55 + nM.a * 0.45) * puddly;
    if (pm > 0.0) {
      vec3 pc = mix(land * 0.45, vec3(0.16, 0.22, 0.2), 0.55) + glints(p * 1.7, nH.b) * 0.12;
      col = mix(col, pc, pm * 0.85);
    }
  }

  if (wWater > 0.0) {
    // Water outline: the 0.5 contour of the warped corner mix, broken by fine noise, lapping slowly.
    float m = wWater + (nH.b - 0.5) * 0.22 + (nM.a - 0.5) * 0.12;
    float mw = m + sin(uTime * 1.1 + nM.b * 12.0) * 0.02;
    // Antialias over about a pixel (m runs 0 to 1 across a cell; no derivatives inside a branch).
    float aa = 1.2 / pxCell + 0.005;
    float waterA = smoothstep(0.5 - aa, 0.5 + aa, mw);
    float fi = wIce / wWater;
    // Ragged floe edges, but only along the edge: no false holes out in the ice or the open water.
    float iceF = wIce > 0.0 ? smoothstep(0.42, 0.58, fi + ((nL.g - 0.5) * 1.5 + (nH.a - 0.5) * 0.4) * min(1.0, fi * (1.0 - fi) * 6.0)) : 0.0;
    // Wet ground along the shore.
    float wet = smoothstep(0.2, 0.5, m) * (1.0 - iceF * 0.7);
    col = mix(col, col * vec3(0.6, 0.64, 0.68), wet);

    if (waterA > 0.0) {
      float d = (dsum / wWater) * smoothstep(0.45, 1.0, m);
      d = clamp(d + (nL.r - 0.5) * 0.08, 0.0, 1.0);
      float sw = swell(p);
      float gl = glints(p, nM.a + nH.b * 0.5) * smoothstep(0.35, 0.75, textureLod(uNoise, p * 0.05 - uTime * 0.004, 0.0).r);
      vec3 shallow = vec3(0.32, 0.58, 0.62);
      vec3 deep = vec3(0.07, 0.19, 0.33);
      // The bed shows through the shallows, then fades into deep blue.
      vec3 water = mix(land * vec3(0.55, 0.76, 0.8), shallow, 0.35 + 0.5 * smoothstep(0.0, 0.35, d));
      water = mix(water, deep, smoothstep(0.2, 0.95, d));
      // Gentle movement: a slow swell of light and dark, and small glints riding the wavelets.
      water *= 0.95 + 0.08 * sw;
      water += gl * vec3(0.11, 0.13, 0.14);
      // Foam where it meets the shore.
      float band = 1.0 - smoothstep(0.5, 0.6, mw);
      float fn = textureLod(uNoise, p * 0.9 + uTime * vec2(0.03, 0.021), 0.0).b;
      float foam = band * smoothstep(0.42, 0.72, fn * 0.75 + band * 0.45) * (1.0 - iceF);
      water = mix(water, vec3(0.86, 0.93, 0.94), foam * 0.7);
      if (iceF > 0.0) {
        // Clear ice shows the dark water under it, more so out where it's deep.
        vec3 ice = terrainColor(iceId, p, pxCell, mixN, false);
        ice = mix(ice, vec3(0.2, 0.33, 0.45), 0.3 + 0.35 * d);
        ice += smoothstep(0.55, 0.95, sin(dot(p, vec2(0.7, 0.3)) * 0.9 + nL.r * 7.0) * 0.5 + 0.5) * 0.06;
        ice = mix(ice, vec3(0.9, 0.95, 1.0), band * 0.45);
        water = mix(water, ice, iceF);
      }
      col = mix(col, water, waterA);
    }
  }
  finalColor = vec4(col * uColor.rgb, 1.0) * uColor.a;
}
`;

/** Compile the fragment shader once up front, so a driver that rejects it falls back instead of drawing black. */
function compiles(gl: WebGL2RenderingContext): boolean {
  const sh = gl.createShader(gl.FRAGMENT_SHADER);
  if (!sh) return false;
  gl.shaderSource(sh, FRAGMENT);
  gl.compileShader(sh);
  const ok = !!gl.getShaderParameter(sh, gl.COMPILE_STATUS) || gl.isContextLost();
  if (!ok) console.warn('ground shader failed to compile, using the flat terrain:', gl.getShaderInfoLog(sh));
  gl.deleteShader(sh);
  return ok;
}

interface ArtSource {
  pixels: Map<string, Pixels>;
}

export class Ground {
  readonly mesh: Mesh<MeshGeometry, Shader>;
  private readonly uniforms: UniformGroup<{ uMapSize: { value: Float32Array; type: 'vec2<f32>' }; uAtlasSize: { value: Float32Array; type: 'vec2<f32>' }; uTime: { value: number; type: 'f32' }; uBedSlot: { value: number; type: 'f32' } }>;
  private readonly atlasSource: BufferImageSource;
  private readonly noiseSource: BufferImageSource;
  private readonly paramSource: BufferImageSource;
  private indexSource: BufferImageSource | null = null;
  private index = new Uint8Array(0);
  private w = 0;
  private h = 0;
  private readonly kinds: Uint8Array;
  private readonly deep: Uint8Array;
  private readonly t0 = performance.now();

  /** The ground shader, or null where it can't run (not WebGL2): keep the old per-cell bitmap then. */
  static create(renderer: Renderer, art: ArtSource, tile: number): Ground | null {
    try {
      // ?ground=0 keeps the old flat look (for comparison, or a driver that draws it wrong).
      if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('ground') === '0') return null;
      if (renderer.type !== RendererType.WEBGL) return null;
      const gl = (renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
      if (!gl || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return null;
      if (!compiles(gl)) return null;
      return new Ground(art, tile);
    } catch (e) {
      console.warn('ground shader unavailable, using the flat terrain', e);
      return null;
    }
  }

  private constructor(art: ArtSource, private readonly tile: number) {
    const plan = planAtlas(TERRAINS);
    const N = 256;
    const noise = makeNoise(N, 7);
    const slots = plan.keys.length;
    const rows = Math.ceil(slots / ATLAS_COLS);
    const aw = ATLAS_COLS * ATLAS_SLOT;
    const ah = rows * ATLAS_SLOT;
    const atlas = new Uint8Array(aw * ah * 4);
    const means: (number[] | undefined)[] = [];
    plan.keys.forEach((key, s) => {
      const px = art.pixels.get(key);
      if (px) means[s] = blitSlot(atlas, aw, s, px, textureContrast(key));
      else {
        // No art for it: mottled terrain colour (first terrain using the slot).
        const t = TERRAINS.find((d) => plan.slotOf[d.id] === s)!;
        blitSlot(atlas, aw, s, proceduralTexture(t.color, noise, N));
      }
    });
    const bedSlot = Math.max(0, plan.keys.indexOf('terrain_sand'));
    this.kinds = new Uint8Array(256);
    this.deep = new Uint8Array(256);
    for (const t of TERRAINS) {
      this.kinds[t.id] = terrainKind(t.key);
      this.deep[t.id] = t.key.startsWith('deep') ? 1 : 0;
    }

    this.atlasSource = new BufferImageSource({
      resource: atlas,
      width: aw,
      height: ah,
      format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'linear',
      mipmapFilter: 'linear',
      autoGenerateMipmaps: true,
    });
    this.noiseSource = new BufferImageSource({
      resource: noise,
      width: N,
      height: N,
      format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'linear',
      addressMode: 'repeat',
    });
    this.paramSource = new BufferImageSource({
      resource: buildParams(TERRAINS, plan, means, bedSlot),
      width: PARAM_W,
      height: 2,
      format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'nearest',
    });
    this.uniforms = new UniformGroup({
      uMapSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
      uAtlasSize: { value: new Float32Array([aw, ah]), type: 'vec2<f32>' },
      uTime: { value: 0, type: 'f32' },
      uBedSlot: { value: bedSlot, type: 'f32' },
    });
    const shader = Shader.from({
      gl: { vertex: VERTEX, fragment: FRAGMENT, name: 'fe-ground' },
      resources: {
        groundUniforms: this.uniforms,
        uAtlas: this.atlasSource,
        uNoise: this.noiseSource,
        uParams: this.paramSource,
        uIndex: this.paramSource, // replaced by setup()
      },
    });
    const geometry = new MeshGeometry({ positions: new Float32Array(8), uvs: new Float32Array(8), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
    this.mesh = new Mesh({ geometry, shader });
    this.mesh.label = 'ground';
  }

  /** Size the quad and index texture for a w x h map, under everything else in `layer`. */
  setup(w: number, h: number, layer: Container): void {
    this.w = w;
    this.h = h;
    this.index = new Uint8Array(w * h * 4);
    this.indexSource?.destroy();
    this.indexSource = new BufferImageSource({ resource: this.index, width: w, height: h, format: 'rgba8unorm',
      alphaMode: 'no-premultiply-alpha', scaleMode: 'nearest' });
    this.mesh.shader!.resources.uIndex = this.indexSource;
    const W = w * this.tile;
    const H = h * this.tile;
    const g = this.mesh.geometry;
    g.positions = new Float32Array([0, 0, W, 0, W, H, 0, H]);
    g.uvs = new Float32Array([0, 0, w, 0, w, h, 0, h]);
    this.uniforms.uniforms.uMapSize[0] = w;
    this.uniforms.uniforms.uMapSize[1] = h;
    this.uniforms.update();
    if (this.mesh.parent !== layer) layer.addChildAt(this.mesh, 0);
  }

  /** Refresh the index texels of changed cells (all with null), and upload just their rows. */
  update(terrain: ArrayLike<number>, cells: Iterable<number> | null): void {
    if (!this.indexSource) return;
    const { w, h } = this;
    if (!cells) {
      writeIndex(this.index, terrain, w, h, this.kinds, this.deep, 0, 0, w - 1, h - 1);
      this.indexSource.update();
      return;
    }
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let wet = false;
    for (const c of cells) {
      const x = c % w;
      const y = (c / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      // Depth around a cell depends on where the shore is: widen the rewrite when it moved (water
      // freezing to ice, or the other way, leaves the shore where it was).
      const k = this.kinds[terrain[c]] >= KIND.water;
      const was = this.kinds[this.index[c * 4]] >= KIND.water;
      if (k !== was) wet = true;
    }
    if (x1 < 0) return;
    const r = wet ? DEPTH_WINDOW : 0;
    writeIndex(this.index, terrain, w, h, this.kinds, this.deep, x0 - r, y0 - r, x1 + r, y1 + r);
    const ya = Math.max(0, y0 - r);
    const yb = Math.min(h, y1 + r + 1);
    if (ya === 0 && yb === h) this.indexSource.update();
    else this.indexSource.update(ya * w, yb * w);
  }

  /** Advance the ripples. */
  tick(now: number): void {
    // Wrap well before float precision suffers; the pattern is slow enough that the jump is unseen.
    this.uniforms.uniforms.uTime = ((now - this.t0) / 1000) % 2000;
    this.uniforms.update();
  }

  destroy(): void {
    this.mesh.destroy();
    this.indexSource?.destroy();
    this.atlasSource.destroy();
    this.noiseSource.destroy();
    this.paramSource.destroy();
  }
}
