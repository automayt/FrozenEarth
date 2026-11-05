/**
 * Camera motion as plain numbers, with nothing from Pixi, so the feel can be tested. Screen pixels
 * and milliseconds throughout. Everything is framerate-independent: velocities integrate exactly
 * (not v * dt), and easings are closed forms of elapsed time.
 */

// ---------------------------------------------------------------- tuning knobs

/** Keyboard and edge pan speed at zoom 1, in screen pixels a second. */
export const PAN_SPEED = 900;
/** Share of PAN_SPEED kept at the closest zoom (fast pans blur up close) and the farthest (the whole map is a few screens). */
export const PAN_NEAR = 0.72;
export const PAN_FAR = 0.85;
/** How quickly pan velocity reaches the held speed, and dies away when the keys let go. */
export const PAN_ACCEL_MS = 85;
export const PAN_STOP_MS = 150;
/** How long a thrown drag coasts. Near enough to the distance covered: release speed x this. */
export const DRAG_COAST_MS = 260;
/** Below this speed a coast is over. */
const PAN_REST = 6;
/** Drag samples older than this at release mean the pointer had stopped: no throw. */
const THROW_WINDOW_MS = 90;
/** Throws slower than this are just a pointer settling. Faster than the cap would lose the map. */
const THROW_MIN = 120;
const THROW_MAX = 2600;
/** Past the map edge: how fast the view springs back, and how soon it stops going further. */
export const EDGE_SPRING_MS = 130;
export const EDGE_SOFT_PX = 70;
/** Mouse this close to the screen edge pans, once it has rested there a moment. */
export const EDGE_SCROLL_PX = 14;
export const EDGE_SCROLL_DELAY_MS = 140;
/** Short flights keep the old quick glide; long ones take up to this long. */
export const FLIGHT_MIN_MS = 340;
export const FLIGHT_MAX_MS = 1150;
/** A flight past this many screens lifts the camera, up to this share of the scale, mid-way. */
export const FLIGHT_LIFT_FROM = 1.2;
export const FLIGHT_LIFT_MAX = 0.42;
/** Follow camera: how tightly it holds the colonist. */
export const FOLLOW_EASE_MS = 150;
/** Big-moment pan: how long it looks, the least gap between two, and how quiet the player must have been. */
export const MOMENT_HOLD_MS = 1500;
export const MOMENT_GAP_MS = 40000;
export const MOMENT_QUIET_MS = 2200;
export const MOMENT_SKIP_MS = 300;
/** Screen shake: pixels at full trauma, and trauma lost per second. */
export const SHAKE_PX = 11;
export const SHAKE_DECAY = 1.9;

// ---------------------------------------------------------------- panning

/** Keyboard pan speed at a given zoom. */
export function panSpeedFor(scale: number, maxZoom = 3, minZoom = 0.15): number {
  const k = scale >= 1 ? 1 - (1 - PAN_NEAR) * Math.min(1, Math.log(scale) / Math.log(maxZoom)) : 1 - (1 - PAN_FAR) * Math.min(1, Math.log(scale) / Math.log(minZoom));
  return PAN_SPEED * k;
}

/**
 * One axis of velocity easing toward a goal over dt, returning the exact distance travelled so the
 * path doesn't depend on how the time was cut into frames.
 */
export function stepVelocity(v: number, goal: number, dt: number, tau: number): { v: number; d: number } {
  const k = Math.exp(-dt / tau);
  return { v: goal + (v - goal) * k, d: (goal * dt + (v - goal) * tau * (1 - k)) / 1000 };
}

/** The pan's velocity, in screen pixels a second: eases toward what the keys ask, or coasts after a throw. */
export class PanBody {
  vx = 0;
  vy = 0;
  private coast = PAN_STOP_MS;

  /** Advance dt with a goal velocity; returns how far to move. */
  step(goalX: number, goalY: number, dt: number): { dx: number; dy: number } {
    const held = goalX !== 0 || goalY !== 0;
    if (held) this.coast = PAN_STOP_MS;
    const tau = held ? PAN_ACCEL_MS : this.coast;
    const x = stepVelocity(this.vx, goalX, dt, tau);
    const y = stepVelocity(this.vy, goalY, dt, tau);
    this.vx = x.v;
    this.vy = y.v;
    if (!held && Math.hypot(this.vx, this.vy) < PAN_REST) this.vx = this.vy = 0;
    return { dx: x.d, dy: y.d };
  }

  throwAt(vx: number, vy: number): void {
    this.vx = vx;
    this.vy = vy;
    this.coast = DRAG_COAST_MS;
  }

  stop(): void {
    this.vx = this.vy = 0;
  }

  get moving(): boolean {
    return this.vx !== 0 || this.vy !== 0;
  }
}

/** Remembers the last moments of a drag, to tell how fast it was going when let go. */
export class DragTracker {
  private s: { t: number; x: number; y: number }[] = [];
  private x = 0;
  private y = 0;

  reset(t: number): void {
    this.s.length = 0;
    this.x = this.y = 0;
    this.s.push({ t, x: 0, y: 0 });
  }

  add(dx: number, dy: number, t: number): void {
    this.x += dx;
    this.y += dy;
    this.s.push({ t, x: this.x, y: this.y });
    while (this.s.length > 2 && t - this.s[0].t > THROW_WINDOW_MS) this.s.shift();
  }

  /** Pixels a second at release, or zero if the pointer had stopped or barely moved. */
  release(t: number): { vx: number; vy: number } {
    const last = this.s[this.s.length - 1];
    const first = this.s[0];
    if (!last || last === first || t - last.t > THROW_WINDOW_MS * 0.7) return { vx: 0, vy: 0 };
    const span = Math.max(8, last.t - first.t);
    let vx = ((last.x - first.x) / span) * 1000;
    let vy = ((last.y - first.y) / span) * 1000;
    const speed = Math.hypot(vx, vy);
    if (speed < THROW_MIN) return { vx: 0, vy: 0 };
    if (speed > THROW_MAX) {
      vx *= THROW_MAX / speed;
      vy *= THROW_MAX / speed;
    }
    return { vx, vy };
  }
}

/**
 * The range of world.x (or y) that keeps the view centre on the map. When the view is wider than
 * the map the range closes in, so a zoomed-out map settles in the middle of the screen.
 */
export function panRange(viewPx: number, mapPx: number, scale: number): { lo: number; hi: number } {
  const inset = Math.max(0, Math.min(mapPx / 2, viewPx / (2 * scale) - mapPx / 2));
  return { lo: viewPx / 2 - (mapPx - inset) * scale, hi: viewPx / 2 - inset * scale };
}

/** How much of a push outward survives past the edge: 1 inside, falling away the further out. */
export function edgeResist(pos: number, lo: number, hi: number, push: number): number {
  const over = push > 0 ? pos - hi : lo - pos;
  return over > 0 ? 1 / (1 + over / EDGE_SOFT_PX) : 1;
}

/** One frame of the spring that brings a view past the edge back to it. */
export function edgeSpring(pos: number, lo: number, hi: number, dt: number): number {
  const target = pos < lo ? lo : pos > hi ? hi : pos;
  return pos + (target - pos) * (1 - Math.exp(-dt / EDGE_SPRING_MS));
}

/** Where the mouse is pushing on the edges of the screen: -1..1 on each axis, deeper is faster. */
export function edgePush(px: number, py: number, w: number, h: number, margin = EDGE_SCROLL_PX): { x: number; y: number } {
  const axis = (p: number, size: number) => (p <= margin ? -(1 - Math.max(0, p) / margin) * 0.6 - 0.4 : p >= size - margin ? (1 - Math.max(0, size - p) / margin) * 0.6 + 0.4 : 0);
  return { x: axis(px, w), y: axis(py, h) };
}

// ---------------------------------------------------------------- flights

export interface Flight {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  /** Scale at the start, and the scale it should land at. */
  fs: number;
  ts: number;
  /** Share of the scale given up at the middle of the flight. */
  lift: number;
  ms: number;
  t0: number;
}

const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (k: number) => 1 - (1 - k) * (1 - k) * (1 - k);

/**
 * Plan a move from one cell to another. `perCell` is screen pixels a cell, and `viewPx` the smaller
 * side of the screen: distance counts in screens, so long flights take longer but not much longer,
 * and those over a screen or so lift the camera in the middle.
 */
export function planFlight(fx: number, fy: number, tx: number, ty: number, scale: number, perCell: number, viewPx: number, t0: number, ts = scale, minScale = 0.15): Flight {
  const screens = (Math.hypot(tx - fx, ty - fy) * perCell) / viewPx;
  const ms = Math.min(FLIGHT_MAX_MS, FLIGHT_MIN_MS + 300 * Math.sqrt(screens));
  const wanted = screens <= FLIGHT_LIFT_FROM ? 0 : Math.min(FLIGHT_LIFT_MAX, 0.16 * Math.log2(screens / FLIGHT_LIFT_FROM + 1));
  // Never lift past the zoom limit.
  const lift = Math.min(wanted, Math.max(0, 1 - minScale / Math.min(scale, ts)));
  return { fx, fy, tx, ty, fs: scale, ts, lift, ms, t0 };
}

/** Where a flight is at `now`: a pure function of time, so frame rate can't change the path. */
export function flightPose(f: Flight, now: number): { x: number; y: number; scale: number; done: boolean } {
  const k = Math.max(0, Math.min(1, (now - f.t0) / f.ms));
  // Short hops start at speed, like the old glide; long flights wind up.
  const e = f.lift > 0 ? easeInOut(k) : easeOut(k);
  const lift = 1 - f.lift * Math.sin(Math.PI * k) ** 2;
  const scale = f.fs * Math.pow(f.ts / f.fs, e) * lift;
  return { x: f.fx + (f.tx - f.fx) * e, y: f.fy + (f.ty - f.fy) * e, scale, done: k >= 1 };
}

/** One frame of the follow camera closing on where it should be. */
export function followStep(from: number, to: number, dt: number): number {
  return from + (to - from) * (1 - Math.exp(-dt / FOLLOW_EASE_MS));
}

// ---------------------------------------------------------------- big moments

/** What the player is up to, as far as being interrupted goes. */
export interface PlayerState {
  /** A tool other than select: placing, designating, zoning. */
  tool: boolean;
  /** Holding a button down on the map, or a ring menu open. */
  busyPointer: boolean;
  /** An open build menu or panel, or the help. */
  overlay: boolean;
  steering: boolean;
  following: boolean;
  /** The camera is already moving. */
  cameraBusy: boolean;
  sinceInput: number;
  sinceMoment: number;
}

/** A big moment may only take the camera from someone who isn't doing anything with it. */
export function mayTakeCamera(p: PlayerState): boolean {
  return !p.tool && !p.busyPointer && !p.overlay && !p.steering && !p.following && !p.cameraBusy && p.sinceInput >= MOMENT_QUIET_MS && p.sinceMoment >= MOMENT_GAP_MS;
}

/** Big moments asked for by the UI (the banner); the renderer takes them on its next frame. */
export const cameraRequests: { moment: { x: number; y: number } | null } = { moment: null };

// ---------------------------------------------------------------- shake

/** Share of a shake felt at some distance from the middle of the view, in view half-diagonals. */
export function shakeFalloff(dist: number, halfDiagonal: number): number {
  const d = dist / Math.max(1, halfDiagonal);
  if (d <= 1) return 1;
  return Math.max(0, 1 - (d - 1) / 1.5) ** 2;
}

/**
 * Trauma-style shake: blows add to a level that decays, and the offset goes with its square, so
 * small knocks barely register and a big one rattles. The offset is sampled from time, not
 * accumulated, so it looks the same at any frame rate.
 */
export class Shake {
  trauma = 0;

  add(power: number): void {
    this.trauma = Math.min(1, this.trauma + power);
  }

  step(dt: number): void {
    this.trauma = Math.max(0, this.trauma - (SHAKE_DECAY * dt) / 1000);
  }

  /** Offset in pixels at `now`, with `amount` the SCREEN_SHAKE setting. */
  offset(now: number, amount: number): { x: number; y: number } {
    const a = this.trauma * this.trauma * SHAKE_PX * amount;
    if (a <= 0.01) return { x: 0, y: 0 };
    const t = now / 1000;
    return { x: a * (Math.sin(t * 47.3) * 0.6 + Math.sin(t * 91.1 + 1.3) * 0.4), y: a * (Math.sin(t * 53.9 + 2.1) * 0.6 + Math.sin(t * 83.7 + 0.4) * 0.4) };
  }
}
