/**
 * The ring menu's geometry and state, apart from any drawing, so both can be tested. Screen pixels.
 *
 * How it works, in one place: a plain right-click on open ground with drafted colonists still just
 * moves them. A right-click on something with orders to give opens the ring at the cursor, with the
 * first choice lit, so a second right-click takes it (attack, capture, pick up). Holding the right
 * button still for HOLD_MS opens the ring anywhere, even on open ground, and letting go over a
 * wedge takes that choice, so it can all be one flick; a drag before then is still a pan.
 * Esc, a click away from the ring or the wheel closes it; arrows, Enter and 1-8 work from the keys.
 */

/** Band of the ring, and how far from the middle the mouse must be to point at a wedge. */
export const RING_INNER = 46;
export const RING_OUTER = 112;
export const RING_DEAD = 24;
/** A click further out than this closes the ring rather than choosing. */
export const RING_REACH = RING_OUTER + 46;
/** Clear space kept around the ring at the edge of the screen; more below for the caption. */
const EDGE_MARGIN = 10;
const CAPTION_ROOM = 62;
/** Holding the right button this long, without moving, opens the ring. */
export const HOLD_MS = 230;
/** A choice that needs confirming must have been lit this long, so a double-click can't start a war. */
export const CONFIRM_MS = 320;
export const MAX_OPTIONS = 8;

export interface RingOption {
  key: string;
  label: string;
  /** Glyph name from render/worldAtlas.ts. */
  icon: string;
  /** One line about what it does, shown under the ring while it's lit. */
  detail?: string;
  danger?: boolean;
  /** Why it can't be done; shown and not run. */
  refused?: string;
  /** Has a serious consequence: won't run the instant it's lit. */
  confirm?: boolean;
  run: () => void;
}

export interface RingPlan {
  title: string;
  options: RingOption[];
  /** What a plain right-click does at once, instead of opening the ring. */
  quick: RingOption | null;
}

export interface RingState {
  x: number;
  y: number;
  title: string;
  options: RingOption[];
  active: number;
  activeSince: number;
  /** Opened by holding the button: letting go over a wedge chooses it. */
  held: boolean;
  /** The mouse has left the hub since opening. */
  aimed: boolean;
}

/** Where the ring goes for a click at (x, y): at the cursor, nudged in to fit on the screen. */
export function ringCenter(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const r = RING_OUTER + EDGE_MARGIN;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
  return { x: clamp(x, r, w - r), y: clamp(y, r, h - r - CAPTION_ROOM) };
}

/** Middle of wedge `i` of `n`, in radians: the first at twelve o'clock, then clockwise. */
export function wedgeAngle(i: number, n: number): number {
  return -Math.PI / 2 + (i / n) * Math.PI * 2;
}

/** The wedge a pointer offset from the centre is aiming at, or -1 in the hub. */
export function wedgeAt(dx: number, dy: number, n: number): number {
  if (!n || Math.hypot(dx, dy) < RING_DEAD) return -1;
  const turn = (Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2);
  return Math.floor(((turn + 1 / (2 * n)) % 1 + 1) % 1 * n) % n;
}

/** An SVG path for wedge `i` of `n`, around (cx, cy), with a small gap either side. */
export function wedgePath(i: number, n: number, cx: number, cy: number, inner = RING_INNER, outer = RING_OUTER, gap = 0.022): string {
  const half = Math.PI / n;
  const mid = wedgeAngle(i, n);
  const a0 = mid - half + (n > 1 ? gap : 0);
  // A lone wedge is the whole ring, which an arc can't draw in one piece.
  const a1 = mid + half - (n > 1 ? gap : 0.001);
  const pt = (r: number, a: number) => `${(cx + Math.cos(a) * r).toFixed(2)} ${(cy + Math.sin(a) * r).toFixed(2)}`;
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${pt(inner, a0)}L${pt(outer, a0)}A${outer} ${outer} 0 ${big} 1 ${pt(outer, a1)}L${pt(inner, a1)}A${inner} ${inner} 0 ${big} 0 ${pt(inner, a0)}Z`;
}

/** The open ring, if any, for the renderer's input and the React menu to share. */
class Ring {
  state: RingState | null = null;
  private seen = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.seen.add(fn);
    return () => this.seen.delete(fn);
  };

  private changed(): void {
    for (const fn of this.seen) fn();
  }

  open(x: number, y: number, w: number, h: number, plan: RingPlan, held: boolean, now = performance.now()): void {
    const c = ringCenter(x, y, w, h);
    this.state = { x: c.x, y: c.y, title: plan.title, options: plan.options.slice(0, MAX_OPTIONS), active: 0, activeSince: now, held, aimed: false };
    this.changed();
  }

  close(): void {
    if (!this.state) return;
    this.state = null;
    this.changed();
  }

  /** Light a wedge. */
  light(i: number, now = performance.now()): void {
    const s = this.state;
    if (!s || s.active === i || i < 0 || i >= s.options.length) return;
    this.state = { ...s, active: i, activeSince: now };
    this.changed();
  }

  /** A hold let go in the hub: the ring stays open, to click. */
  letGo(): void {
    if (this.state) this.state = { ...this.state, held: false };
  }

  /** The pointer moved, at an offset from the ring's middle. */
  aim(dx: number, dy: number, now = performance.now()): void {
    const s = this.state;
    if (!s) return;
    const i = wedgeAt(dx, dy, s.options.length);
    if (i < 0) return;
    if (!s.aimed) this.state = { ...s, aimed: true };
    if (i !== s.active) this.light(i, now);
    else if (!s.aimed) this.changed();
  }

  /** Take a wedge (the lit one by default). True if the ring is done with. */
  pick(i = this.state?.active ?? -1, now = performance.now()): boolean {
    const s = this.state;
    const o = s?.options[i];
    if (!s || !o) return false;
    if (o.refused) return false;
    if (o.confirm && (i !== s.active || now - s.activeSince < CONFIRM_MS)) {
      this.light(i, now);
      return false;
    }
    this.close();
    o.run();
    return true;
  }

  /** A key while it's open. True if the ring took it; anything else closes the ring and carries on. */
  key(k: string, now = performance.now()): boolean {
    const s = this.state;
    if (!s) return false;
    const n = s.options.length;
    if (k === 'escape') this.close();
    else if (k === 'arrowright' || k === 'arrowdown') this.light((s.active + 1) % n, now);
    else if (k === 'arrowleft' || k === 'arrowup') this.light((s.active + n - 1) % n, now);
    else if (k === 'enter' || k === ' ') this.pick(s.active, now);
    else if (k >= '1' && k <= String(n) && k.length === 1) this.pick(Number(k) - 1, now);
    else {
      this.close();
      return false;
    }
    return true;
  }
}

export const ring = new Ring();
