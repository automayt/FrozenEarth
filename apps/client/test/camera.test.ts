import { describe, expect, it } from 'vitest';
import {
  DragTracker,
  EDGE_SCROLL_PX,
  edgePush,
  edgeResist,
  edgeSpring,
  flightPose,
  followStep,
  keepOnMap,
  mayTakeCamera,
  MOMENT_GAP_MS,
  MOMENT_QUIET_MS,
  PAN_SPEED,
  PanBody,
  panRange,
  panSpeedFor,
  planFlight,
  Shake,
  shakeFalloff,
  stepVelocity,
  type PlayerState,
} from '../src/render/camera';

/** Run a pan for `total` ms cut into frames of `frame` ms; returns the distance covered. */
function ride(body: PanBody, goal: number, total: number, frame: number): number {
  let x = 0;
  for (let t = 0; t < total - 1e-6; t += frame) x += body.step(goal, 0, Math.min(frame, total - t)).dx;
  return x;
}

describe('panning', () => {
  it('covers the same ground at any frame rate', () => {
    const fast = ride(new PanBody(), 800, 1000, 1000 / 144);
    const slow = ride(new PanBody(), 800, 1000, 1000 / 20);
    expect(Math.abs(fast - slow)).toBeLessThan(0.01);
  });

  it('winds up rather than starting at full speed', () => {
    const b = new PanBody();
    b.step(900, 0, 16);
    expect(b.vx).toBeGreaterThan(0);
    expect(b.vx).toBeLessThan(450);
    for (let i = 0; i < 40; i++) b.step(900, 0, 16);
    expect(b.vx).toBeCloseTo(900, 0);
  });

  it('coasts to a full stop after a throw, the same way at any frame rate', () => {
    const coast = (frame: number) => {
      const b = new PanBody();
      b.throwAt(1200, 0);
      let x = 0;
      for (let t = 0; t < 2000; t += frame) x += b.step(0, 0, frame).dx;
      return { x, moving: b.moving };
    };
    const a = coast(1000 / 144);
    const c = coast(1000 / 30);
    expect(a.moving).toBe(false);
    expect(c.moving).toBe(false);
    expect(a.x).toBeGreaterThan(200);
    expect(Math.abs(a.x - c.x) / a.x).toBeLessThan(0.03);
  });

  it('integrates a velocity change exactly', () => {
    const whole = stepVelocity(100, 500, 300, 90);
    const a = stepVelocity(100, 500, 120, 90);
    const b = stepVelocity(a.v, 500, 180, 90);
    expect(a.d + b.d).toBeCloseTo(whole.d, 8);
    expect(b.v).toBeCloseTo(whole.v, 8);
  });

  it('goes a little slower up close and far out, never faster than the base speed', () => {
    expect(panSpeedFor(1)).toBe(PAN_SPEED);
    expect(panSpeedFor(3)).toBeLessThan(PAN_SPEED * 0.8);
    expect(panSpeedFor(0.15)).toBeLessThan(PAN_SPEED);
    expect(panSpeedFor(0.15)).toBeGreaterThan(PAN_SPEED * 0.8);
    expect(panSpeedFor(2)).toBeGreaterThan(panSpeedFor(3));
  });
});

describe('a drag let go', () => {
  it('throws at the speed it was going', () => {
    const d = new DragTracker();
    d.reset(0);
    for (let t = 16; t <= 96; t += 16) d.add(16, -8, t);
    const v = d.release(100);
    expect(v.vx).toBeCloseTo(1000, -2);
    expect(v.vy).toBeCloseTo(-500, -2);
  });

  it('does not throw if the pointer had stopped before letting go', () => {
    const d = new DragTracker();
    d.reset(0);
    for (let t = 16; t <= 96; t += 16) d.add(16, 0, t);
    expect(d.release(300)).toEqual({ vx: 0, vy: 0 });
  });

  it('does not throw for a nudge, and caps a wild flick', () => {
    const d = new DragTracker();
    d.reset(0);
    d.add(1, 0, 40);
    expect(d.release(50)).toEqual({ vx: 0, vy: 0 });
    d.reset(0);
    d.add(800, 0, 16);
    expect(Math.hypot(d.release(20).vx, d.release(20).vy)).toBeLessThanOrEqual(2600);
  });
});

describe('the map edge', () => {
  it('lets the view centre reach the edge, and no further', () => {
    const { lo, hi } = panRange(1000, 3200, 1);
    expect(hi).toBe(500);
    expect(lo).toBe(500 - 3200);
  });

  it('holds a map much smaller than the view in the middle', () => {
    const { lo, hi } = panRange(1000, 3200, 0.1);
    expect(lo).toBe(hi);
    expect(lo).toBeCloseTo(1000 / 2 - 160);
  });

  it('pushes back softly, not at a wall', () => {
    expect(edgeResist(100, -50, 200, 1)).toBe(1);
    const near = edgeResist(230, -50, 200, 1);
    const far = edgeResist(400, -50, 200, 1);
    expect(near).toBeLessThan(1);
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThan(0);
    // Pushing back in is free.
    expect(edgeResist(400, -50, 200, -1)).toBe(1);
  });

  it('springs back to the edge, the same way at any frame rate', () => {
    const run = (frame: number) => {
      let p = 300;
      for (let t = 0; t < 400; t += frame) p = edgeSpring(p, -50, 200, frame);
      return p;
    };
    expect(run(4)).toBeLessThan(250);
    expect(Math.abs(run(4) - run(40))).toBeLessThan(0.01);
    expect(edgeSpring(100, -50, 200, 16)).toBe(100);
  });

  it('reads the mouse against the screen edge, deeper being stronger, and nothing mid-screen', () => {
    expect(edgePush(600, 300, 1200, 800)).toEqual({ x: 0, y: 0 });
    expect(edgePush(0, 300, 1200, 800).x).toBeCloseTo(-1);
    expect(edgePush(EDGE_SCROLL_PX, 300, 1200, 800).x).toBeCloseTo(-0.4);
    expect(edgePush(1199, 799, 1200, 800).y).toBeGreaterThan(0.8);
  });
});

describe('flights', () => {
  const far = planFlight(10, 10, 170, 150, 1, 32, 720, 1000);
  const near = planFlight(10, 10, 14, 12, 1, 32, 720, 1000);

  it('start where they are and land exactly on target, at the scale they set out with', () => {
    const a = flightPose(far, 1000);
    expect(a.x).toBeCloseTo(10);
    expect(a.scale).toBeCloseTo(1);
    const b = flightPose(far, 1000 + far.ms);
    expect(b).toEqual({ x: 170, y: 150, scale: 1, done: true });
  });

  it('lift mid-way when long, and not when short', () => {
    expect(flightPose(far, 1000 + far.ms / 2).scale).toBeLessThan(0.85);
    expect(near.lift).toBe(0);
    expect(flightPose(near, 1000 + near.ms / 2).scale).toBe(1);
  });

  it('take longer the further they go, up to a limit', () => {
    expect(far.ms).toBeGreaterThan(near.ms);
    expect(planFlight(0, 0, 5000, 0, 1, 32, 720, 0).ms).toBeLessThanOrEqual(1150);
  });

  it('a look at the map edge stops short of the void', () => {
    expect(keepOnMap(0, 40, 200)).toBe(20);
    expect(keepOnMap(199, 40, 200)).toBe(180);
    expect(keepOnMap(100, 40, 200)).toBe(100);
    expect(keepOnMap(3, 300, 200)).toBe(100);
  });

  it('do not lift past the zoom limit', () => {
    const low = planFlight(0, 0, 190, 190, 0.16, 5, 720, 0);
    expect(flightPose(low, low.ms / 2).scale).toBeGreaterThanOrEqual(0.15);
  });

  it('can land at a new scale', () => {
    const f = planFlight(0, 0, 100, 0, 0.4, 13, 720, 0, 1);
    expect(flightPose(f, f.ms).scale).toBeCloseTo(1);
  });

  it('follow closes the gap the same way at any frame rate', () => {
    const run = (frame: number) => {
      let p = 0;
      for (let t = 0; t < 300; t += frame) p = followStep(p, 100, frame);
      return p;
    };
    expect(Math.abs(run(4) - run(30))).toBeLessThan(0.01);
    expect(run(16)).toBeGreaterThan(80);
  });
});

describe('big moments', () => {
  const idle: PlayerState = { tool: false, busyPointer: false, overlay: false, steering: false, following: false, cameraBusy: false, sinceInput: MOMENT_QUIET_MS, sinceMoment: MOMENT_GAP_MS };

  it('take the camera from an idle player', () => {
    expect(mayTakeCamera(idle)).toBe(true);
  });

  it.each(['tool', 'busyPointer', 'overlay', 'steering', 'following', 'cameraBusy'] as const)('leave the camera alone while %s', (k) => {
    expect(mayTakeCamera({ ...idle, [k]: true })).toBe(false);
  });

  it('wait for the player to go quiet, and leave a gap between moments', () => {
    expect(mayTakeCamera({ ...idle, sinceInput: 500 })).toBe(false);
    expect(mayTakeCamera({ ...idle, sinceMoment: 1000 })).toBe(false);
  });
});

describe('shake', () => {
  it('is felt in full on view and fades to nothing far off', () => {
    expect(shakeFalloff(100, 700)).toBe(1);
    expect(shakeFalloff(1000, 700)).toBeLessThan(1);
    expect(shakeFalloff(1000, 700)).toBeGreaterThan(0);
    expect(shakeFalloff(5000, 700)).toBe(0);
  });

  it('dies away, stacks up to a limit, and small knocks barely register', () => {
    const s = new Shake();
    s.add(0.2);
    const small = Math.hypot(s.offset(137, 1).x, s.offset(137, 1).y);
    s.add(2);
    expect(s.trauma).toBe(1);
    expect(Math.hypot(s.offset(137, 1).x, s.offset(137, 1).y)).toBeGreaterThan(small * 10);
    s.step(1000);
    expect(s.trauma).toBe(0);
    expect(s.offset(137, 1)).toEqual({ x: 0, y: 0 });
  });

  it('is off when the setting is zero', () => {
    const s = new Shake();
    s.add(1);
    expect(s.offset(137, 0)).toEqual({ x: 0, y: 0 });
  });
});
