import type { Container, Graphics } from 'pixi.js';
import { BUILDINGS } from '@fe/defs';
import { TICKS_PER_DAY, TICKS_PER_HOUR, type Condition } from '@fe/sim';
import type { Mirror } from '@fe/protocol';
import { MapBitmap } from './bitmap';

/**
 * Time of day: where the sun is (for shadows), how the whole scene is colour graded, and the
 * night shade with its pools of firelight. Purely visual; the hour comes from the server tick.
 */

/** Colour and strength of the night shade at its darkest (light pools are carved out of it). */
const NIGHT_COLOR = 0x0c1838;
const NIGHT_ALPHA = 0.5;
/** Firelight tint mixed into the light pools, and how strongly at the centre of a pool. */
const WARM = [255, 150, 60] as const;
const WARM_ALPHA = 0.16;
/** Shadow opacity in clear midday sun. */
export const SHADOW_ALPHA = 0.36;

/** Conditions that hide the sun behind cloud, fog or ash: shadows go faint and colours flatten. */
const OVERCAST = new Set(['fog', 'spring_rains', 'thunderstorm', 'blizzard', 'ash_fall']);

export interface Sun {
  /** Shadow offset in cells per cell of caster height (x east, y south). */
  x: number;
  y: number;
  /** Shadow opacity (0 at night). */
  strength: number;
}

/** Hour of the day (0-24, fractional) at a tick. */
export function hourOf(tick: number): number {
  return (tick % TICKS_PER_DAY) / TICKS_PER_HOUR;
}

/** Darkness at an hour: 0 at midday, 1 at deep night (smooth through dusk and dawn), or held dark by an eclipse. */
export function darknessAt(hour: number, active: ReadonlySet<string>): number {
  const dark = hour < 5 || hour > 21 ? 1 : hour < 7 ? (7 - hour) / 2 : hour > 19 ? (hour - 19) / 2 : 0;
  const forcedDark = active.has('eclipse') || active.has('long_night') || active.has('ash_fall');
  return Math.max(forcedDark ? 0.8 : 0, dark);
}

/** How much cloud there is between the ground and the sun: 0 clear, 1 fully overcast. */
export function overcastOf(active: ReadonlySet<string>, precip: string): number {
  for (const k of active) if (OVERCAST.has(k)) return 1;
  return precip === 'snow' || precip === 'rain' ? 0.75 : 0;
}

/**
 * The sun across the day. It rises in the east and sets in the west, always a little north of
 * overhead (the light comes from the top of the screen, like the lit tops of walls), so shadows
 * fall west and long in the morning, short and south at noon, and east and long in the evening.
 */
export function sunAt(hour: number, dark: number, overcast: number): Sun {
  // Daylight runs 5:00 to 21:00; t goes 0 to 1 across it.
  const t = Math.max(0, Math.min(1, (hour - 5) / 16));
  const el = Math.sin(Math.PI * t);
  const east = -Math.cos(Math.PI * t);
  const len = 0.45 + 1.9 * (1 - el) ** 2;
  const dx = east;
  const dy = 0.55;
  const n = Math.hypot(dx, dy);
  return {
    x: (dx / n) * len,
    y: (dy / n) * len,
    // Low sun throws its shadows a little darker; they hold on through golden hour, then fade with the light.
    strength: SHADOW_ALPHA * (1 + 0.2 * (1 - el)) * Math.sqrt(Math.max(0, 1 - dark * 1.15)) * (1 - 0.72 * overcast),
  };
}

/** Grade keyframes: hour, then the multiply tint's r, g, b (0-1). */
const GRADE: [number, number, number, number][] = [
  [0, 0.8, 0.86, 1],
  [4.8, 0.8, 0.86, 1],
  [6, 0.96, 0.8, 0.8],
  [7.5, 1, 0.9, 0.8],
  [10, 1, 0.98, 0.94],
  [13, 1, 1, 0.99],
  [16, 1, 0.97, 0.91],
  [18.4, 1, 0.84, 0.66],
  [19.8, 0.94, 0.7, 0.62],
  [21.3, 0.8, 0.86, 1],
  [24, 0.8, 0.86, 1],
];

/** The scene's colour grade at an hour as [r, g, b] in 0-1: warm dawn, neutral noon, orange dusk, blue night. */
export function gradeAt(hour: number, overcast: number): [number, number, number] {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < GRADE.length - 2 && GRADE[i + 1][0] <= h) i++;
  const a = GRADE[i];
  const b = GRADE[i + 1];
  const k = (h - a[0]) / (b[0] - a[0] || 1);
  let r = a[1] + (b[1] - a[1]) * k;
  let g = a[2] + (b[2] - a[2]) * k;
  let bl = a[3] + (b[3] - a[3]) * k;
  if (overcast > 0) {
    // Cloud flattens the colour toward a cool grey and takes a little light.
    const l = (r + g + bl) / 3;
    const o = overcast * 0.7;
    r = (r + (l * 0.92 - r) * o) * (1 - 0.06 * overcast);
    g = (g + (l * 0.95 - g) * o) * (1 - 0.06 * overcast);
    bl = (bl + (l - bl) * o) * (1 - 0.06 * overcast);
  }
  return [r, g, bl];
}

export function packRgb(r: number, g: number, b: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

/** What the renderer gives the lighting each frame. */
export interface LightInput {
  tick: number;
  mirror: Mirror;
  /** Current precipitation ('none', 'snow', 'rain'...). */
  precip: string;
  /** Changes whenever what light sources can be seen may have changed (fog cadence). */
  version: number;
  /** Where your colonist is drawn, in cells, for their personal light. */
  pawnCell(id: number): { x: number; y: number } | null;
  faction: number | undefined;
}

/**
 * Night shade, firelight pools, colour grading and weather tints. The grade is a multiply tint on
 * each world layer (free: render groups apply it as a uniform), blended with the night shade.
 */
export class Lighting {
  sun: Sun = { x: 0, y: 0.3, strength: 0 };
  dark = 0;
  overcast = 0;
  /** Debug: force an hour (0-24) for screenshots; null follows the game clock. */
  hourOverride: number | null = null;
  private nightMap: MapBitmap | null = null;
  private lightLevel = new Float32Array(0);
  private warmth = new Float32Array(0);
  private lightVersion = -1;
  private grade = -1;
  private pawnTint = -1;
  private active = new Set<string>();

  /**
   * @param layers world layers to grade (the ui layer is skipped)
   * @param nightLayer where the night shade sprite goes
   * @param tints full-screen Graphics for weather tints (screen space)
   */
  constructor(
    private layers: Record<string, Container>,
    private nightLayer: Container,
    private tints: Graphics,
  ) {}

  update(o: LightInput, screenW: number, screenH: number): void {
    const m = o.mirror;
    const active = this.active;
    active.clear();
    for (const c of m.conditions as Condition[]) active.add(c.key);
    const hour = this.hourOverride ?? hourOf(o.tick);
    const dark = darknessAt(hour, active);
    this.dark = dark;
    this.overcast = overcastOf(active, o.precip);
    this.sun = sunAt(hour, dark, this.overcast);

    const shade = this.nightMap?.sprite;
    if (dark > 0.01) {
      // The light map follows the fog cadence (a few times a second), not every frame.
      if (this.lightVersion !== o.version || !shade) this.drawLights(o);
      this.nightMap!.sprite.visible = true;
      this.nightMap!.sprite.alpha = dark * NIGHT_ALPHA;
    } else if (shade) shade.visible = false;

    // Colour grade on the world layers; pawns also take a slight moonlit cast at night.
    const [r, g, b] = gradeAt(hour, this.overcast);
    const grade = packRgb(r, g, b);
    const k = 1 - 0.22 * dark;
    const pawnTint = packRgb(r * k, g * (k + 0.04 * dark), b);
    if (grade !== this.grade || pawnTint !== this.pawnTint) {
      this.grade = grade;
      this.pawnTint = pawnTint;
      for (const [name, layer] of Object.entries(this.layers)) {
        if (name === 'ui') continue;
        layer.tint = name === 'pawns' ? pawnTint : grade;
      }
    }

    // Weather tints, over the whole screen.
    const t = this.tints;
    t.clear();
    const tintAll = (color: number, alpha: number) => alpha > 0.01 && t.rect(0, 0, screenW, screenH).fill({ color, alpha });
    if (active.has('fog')) tintAll(0xc8d0d8, 0.28);
    if (active.has('blizzard')) tintAll(0xe8f0ff, 0.25);
    if (active.has('ash_fall')) tintAll(0x3a3634, 0.3);
    if (active.has('spring_rains') || active.has('thunderstorm')) tintAll(0x203048, 0.15);
    if (active.has('blood_moon')) tintAll(0x900a0a, 0.08 + 0.2 * dark);
    if (active.has('aurora')) tintAll(0x20c080, 0.03 + 0.12 * dark);
    if (active.has('heat_wave') || active.has('drought')) tintAll(0xffa040, 0.07);
    if (active.has('false_spring') || active.has('warm_spell')) tintAll(0xfff0a0, 0.06);
    if (active.has('cold_wind') || active.has('cold_snap') || active.has('early_frost')) tintAll(0xa8d8ff, 0.1);
  }

  /** Bake the night shade at one pixel per cell: opaque in the dark, clear and warm where something gives light. */
  private drawLights(o: LightInput): void {
    const m = o.mirror;
    this.lightVersion = o.version;
    const n = m.w * m.h;
    if (!this.nightMap || this.nightMap.width !== m.w || this.nightMap.height !== m.h) {
      this.nightMap?.destroy();
      // Linear filtering turns the per-cell map into soft pools.
      this.nightMap = new MapBitmap(m.w, m.h, 32, { linear: true });
      this.nightLayer.addChild(this.nightMap.sprite);
    }
    if (this.lightLevel.length !== n) {
      this.lightLevel = new Float32Array(n);
      this.warmth = new Float32Array(n);
    }
    const light = this.lightLevel;
    const warm = this.warmth;
    light.fill(0);
    warm.fill(0);
    const stamp = (x0: number, y0: number, r: number, strength: number, heat: number) => {
      const ri = Math.ceil(r);
      for (let y = Math.max(0, y0 - ri); y <= Math.min(m.h - 1, y0 + ri); y++) {
        for (let x = Math.max(0, x0 - ri); x <= Math.min(m.w - 1, x0 + ri); x++) {
          const d2 = ((x - x0) ** 2 + (y - y0) ** 2) / (r * r);
          if (d2 >= 1) continue;
          const l = strength * (1 - d2);
          const i = y * m.w + x;
          if (l > light[i]) light[i] = l;
          if (l * heat > warm[i]) warm[i] = l * heat;
        }
      }
    };
    for (const e of m.entities.values()) {
      if (e.kind === 'building') {
        const d = BUILDINGS[e.def];
        if (d?.radiant) stamp(e.x, e.y, d.radiant[1] + 4, 1, 1);
        else if (d?.heat && d.heat > 0) stamp(e.x, e.y, 4.5, 0.85, 0.8);
      } else if (e.kind === 'pawn' && e.faction === o.faction && !e.species && !e.downed) {
        // Your people carry a little light (and you can always find them).
        const p = o.pawnCell(e.id);
        stamp(p ? p.x : e.x, p ? p.y : e.y, 3.5, 0.6, 0.35);
      }
    }
    for (const f of m.fireCells) stamp(f % m.w, (f / m.w) | 0, 4 + m.fire[f], 1, 1);
    const d = this.nightMap.data;
    const r = (NIGHT_COLOR >> 16) & 255;
    const g = (NIGHT_COLOR >> 8) & 255;
    const b = NIGHT_COLOR & 255;
    for (let i = 0; i < n; i++) {
      const o4 = i * 4;
      const a = 1 - light[i];
      // Premultiplied: the night colour where it's dark, plus a glaze of firelight inside the pools.
      const w = warm[i] * WARM_ALPHA;
      d[o4] = r * a + WARM[0] * w;
      d[o4 + 1] = g * a + WARM[1] * w;
      d[o4 + 2] = b * a + WARM[2] * w;
      d[o4 + 3] = 255 * Math.min(1, a + w);
    }
    this.nightMap.update();
  }
}

