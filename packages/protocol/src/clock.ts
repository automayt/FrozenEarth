import { TICKS_PER_SECOND } from '@fe/sim';

/** How often the server sends a delta, in seconds (BROADCAST_MS on the server). */
export const BROADCAST_S = 0.066;
/** Furthest the drawn tick runs past the newest delta when deltas stop coming. */
const MAX_AHEAD_S = 0.25;
/** Most extra delay a jittery link gets, on top of one broadcast interval. */
const MAX_JITTER_S = 0.25;
/** Off by more than this (a rejoin, a long stall, a server restart) and the clock jumps instead of easing. */
const SNAP_S = 2;

/**
 * The tick the client draws the world at. Pawns walk timed paths, so the client can show them
 * moving smoothly between deltas, but a path only arrives in the delta after it starts. Drawing
 * at the newest tick received (or past it) makes every new walk start with a jump, and pulling
 * the clock back when a delta comes in late makes everyone rubber-band. Instead the drawn tick:
 *
 *   - runs a little behind the newest delta: one broadcast interval plus about twice the link's
 *     jitter, so a walk is nearly always known before it is drawn;
 *   - never goes backwards: when it's ahead it slows down (to 75%), when behind it speeds up
 *     (to 125%), and it only jumps when it's off by seconds;
 *   - stops at most MAX_AHEAD_S past the newest delta when the link stalls;
 *   - while paused, glides on to the paused tick instead of hopping there.
 */
export class TickClock {
  /** Newest server tick received. */
  private latest = 0;
  /** Drawn tick at `baseAt`, and the rate multiplier since then. */
  private base = 0;
  private baseAt = 0;
  private k = 1;
  /** Last value handed out, so it never decreases. */
  private shown = 0;
  private shownAt = 0;
  private started = false;
  /** Smoothed variation in how late deltas arrive, seconds: how jittery the link is. */
  jitter = 0;
  private prevArrival = { tick: 0, at: 0 };
  private speed = 0;
  private paused = true;
  /** Ticks per second at the last running speed, for gliding after a pause. */
  private lastRate = TICKS_PER_SECOND;

  constructor(private now: () => number = () => performance.now()) {}

  /** Real seconds the drawn world runs behind the newest delta. */
  get delay(): number {
    return BROADCAST_S + Math.min(MAX_JITTER_S, 2 * this.jitter);
  }

  private rate(): number {
    return this.paused ? 0 : TICKS_PER_SECOND * this.speed;
  }

  setTime(t: { speed: number; paused: boolean }): void {
    const paused = t.paused || t.speed <= 0;
    if (paused === this.paused && t.speed === this.speed) return;
    // Rebase so the new rate only applies from now on.
    const cur = this.estTick();
    this.base = cur;
    this.baseAt = this.now();
    this.paused = paused;
    this.speed = t.speed;
    this.prevArrival = { tick: 0, at: 0 };
    if (!paused) this.lastRate = TICKS_PER_SECOND * t.speed;
  }

  estTick(): number {
    const now = this.now();
    let t: number;
    if (this.rate() > 0) {
      t = this.base + ((now - this.baseAt) / 1000) * this.rate() * this.k;
      t = Math.min(t, this.latest + MAX_AHEAD_S * this.rate());
    } else {
      // Paused: glide on to where the server stopped.
      t = Math.min(this.latest, this.shown + ((now - this.shownAt) / 1000) * this.lastRate);
    }
    if (t > this.shown) this.shown = t;
    this.shownAt = now;
    return this.shown;
  }

  /** A delta (or snapshot) for `tick` just arrived. */
  setServerTick(tick: number): void {
    const now = this.now();
    const rate = this.rate();
    const snapTicks = Math.max(120, SNAP_S * (rate || this.lastRate));
    if (!this.started || Math.abs(tick - this.estTick()) > snapTicks + this.delay * (rate || this.lastRate)) {
      this.started = true;
      this.latest = tick;
      this.shown = this.base = Math.max(0, tick - this.delay * rate);
      this.baseAt = this.shownAt = now;
      this.k = 1;
      this.prevArrival = { tick, at: now };
      return;
    }
    if (tick < this.latest) return;
    if (rate && this.prevArrival.at && tick > this.prevArrival.tick) {
      // A delta that took longer (or shorter) to come than the ticks it covers: jitter.
      const dev = (now - this.prevArrival.at) / 1000 - (tick - this.prevArrival.tick) / rate;
      this.jitter += (Math.min(1, Math.abs(dev)) - this.jitter) * 0.05;
    }
    this.prevArrival = { tick, at: now };
    this.latest = tick;
    const cur = this.estTick();
    this.base = cur;
    this.baseAt = now;
    if (!rate) return;
    // Where the drawn tick should be now, and how far off it is, in seconds.
    const err = (tick - this.delay * rate - cur) / rate;
    this.k = 1 + Math.max(-0.25, Math.min(0.25, err));
  }
}

/** Below this (plus how far the fastest walker gets in the frame) a pawn's drawn position just follows its walk; above GLIDE_MAX it's a teleport and snaps. In cells. */
const GLIDE_MIN = 0.75;
/** Cells per second a pawn can cover at 3x, diagonally: frames that long may move that far. */
const WALK_MAX = 15;
const GLIDE_MAX = 8;
/** Time constant of the catch-up, ms: a one-cell correction is gone in about three of these. */
const GLIDE_MS = 50;

/**
 * Hides the small corrections a jittery link still causes: a walk that arrived after it started,
 * or a pawn the server moved a cell without a path. A drawn pawn more than GLIDE_MIN cells from
 * where it should be (in one frame) catches up over a few frames instead of popping. Normal
 * walking is followed exactly, and real teleports (a rejoin, a far move) snap.
 */
export class PawnGlide {
  private drawn = new Map<number, { x: number; y: number; at: number }>();

  at(id: number, target: { x: number; y: number }, now: number): { x: number; y: number } {
    const d = this.drawn.get(id);
    if (!d || now - d.at > 500) {
      this.drawn.set(id, { x: target.x, y: target.y, at: now });
      return target;
    }
    const dx = target.x - d.x;
    const dy = target.y - d.y;
    const dist = Math.hypot(dx, dy);
    const dt = Math.max(0, now - d.at);
    if (dist <= GLIDE_MIN + (WALK_MAX * dt) / 1000 || dist > GLIDE_MAX) {
      d.x = target.x;
      d.y = target.y;
    } else {
      const k = 1 - Math.exp(-dt / GLIDE_MS);
      d.x += dx * k;
      d.y += dy * k;
    }
    d.at = now;
    return { x: d.x, y: d.y };
  }

  forget(id: number): void {
    this.drawn.delete(id);
  }
}
