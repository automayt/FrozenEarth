import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_MS, ring, RING_DEAD, RING_OUTER, ringCenter, wedgeAngle, wedgeAt, wedgePath, type RingPlan } from '../src/render/ring';

const plan = (over: Partial<RingPlan['options'][number]>[] = []): RingPlan => ({
  title: 'Target',
  quick: null,
  options: ['a', 'b', 'c', 'd'].map((key, i) => ({ key, label: key, icon: 'walk', run: vi.fn(), ...over[i] })),
});

describe('ring layout', () => {
  it('stays at the cursor in the open, and is nudged in at the edges', () => {
    expect(ringCenter(600, 300, 1280, 720)).toEqual({ x: 600, y: 300 });
    const c = ringCenter(4, 716, 1280, 720);
    expect(c.x - RING_OUTER).toBeGreaterThanOrEqual(0);
    expect(c.y + RING_OUTER).toBeLessThanOrEqual(720);
  });

  it('holds together on a screen smaller than the ring', () => {
    const c = ringCenter(10, 10, 200, 200);
    expect(c.x).toBe(100);
  });

  it('starts at twelve o\'clock and goes clockwise', () => {
    expect(wedgeAngle(0, 4)).toBeCloseTo(-Math.PI / 2);
    expect(wedgeAngle(1, 4)).toBeCloseTo(0);
    expect(wedgeAt(0, -80, 4)).toBe(0);
    expect(wedgeAt(80, 0, 4)).toBe(1);
    expect(wedgeAt(0, 80, 4)).toBe(2);
    expect(wedgeAt(-80, 0, 4)).toBe(3);
  });

  it('wedges cover the whole circle, with no gaps and no strays, for every size', () => {
    for (let n = 1; n <= 8; n++) {
      const seen = new Set<number>();
      for (let a = 0; a < Math.PI * 2; a += 0.01) {
        const w = wedgeAt(Math.cos(a) * 90, Math.sin(a) * 90, n);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThan(n);
        seen.add(w);
      }
      expect(seen.size).toBe(n);
    }
  });

  it('has a dead hub', () => {
    expect(wedgeAt(RING_DEAD - 1, 0, 4)).toBe(-1);
    expect(wedgeAt(RING_DEAD + 1, 0, 4)).toBe(1);
  });

  it('draws a closed path for each wedge', () => {
    expect(wedgePath(0, 6, 0, 0)).toMatch(/^M.*Z$/);
    expect(wedgePath(0, 1, 0, 0)).toMatch(/A112 112 0 1 1/);
  });
});

describe('ring state', () => {
  beforeEach(() => ring.close());

  it('opens lit on the first choice, and a second click takes it', () => {
    const p = plan();
    ring.open(300, 300, 1280, 720, p, false);
    expect(ring.state?.active).toBe(0);
    expect(ring.pick()).toBe(true);
    expect(p.options[0].run).toHaveBeenCalledOnce();
    expect(ring.state).toBeNull();
  });

  it('follows the mouse round the ring, and keeps its choice back in the hub', () => {
    ring.open(300, 300, 1280, 720, plan(), false);
    ring.aim(80, 0);
    expect(ring.state?.active).toBe(1);
    ring.aim(2, 2);
    expect(ring.state?.active).toBe(1);
  });

  it('knows whether the mouse has aimed at all, for a hold let go in the hub', () => {
    ring.open(300, 300, 1280, 720, plan(), true);
    expect(ring.state?.aimed).toBe(false);
    ring.aim(1, 1);
    expect(ring.state?.aimed).toBe(false);
    ring.aim(0, -80);
    expect(ring.state?.aimed).toBe(true);
  });

  it('will not run a refused choice', () => {
    const p = plan([{ refused: 'They are your allies.' }]);
    ring.open(300, 300, 1280, 720, p, false);
    expect(ring.pick()).toBe(false);
    expect(p.options[0].run).not.toHaveBeenCalled();
    expect(ring.state).not.toBeNull();
  });

  it('a choice with consequences must have been lit a moment first, so a double-click cannot start a war', () => {
    const p = plan([{ confirm: true }]);
    ring.open(300, 300, 1280, 720, p, false, 1000);
    expect(ring.pick(0, 1000 + CONFIRM_MS - 50)).toBe(false);
    expect(p.options[0].run).not.toHaveBeenCalled();
    expect(ring.pick(0, 1000 + CONFIRM_MS + 1)).toBe(true);
    expect(p.options[0].run).toHaveBeenCalledOnce();
  });

  it('flicking onto a choice with consequences only lights it', () => {
    const p = plan([{}, { confirm: true }]);
    ring.open(300, 300, 1280, 720, p, false, 1000);
    expect(ring.pick(1, 5000)).toBe(false);
    expect(ring.state?.active).toBe(1);
    expect(ring.pick(1, 5000 + CONFIRM_MS + 1)).toBe(true);
  });

  it('works from the keys', () => {
    const p = plan();
    ring.open(300, 300, 1280, 720, p, false);
    expect(ring.key('arrowright')).toBe(true);
    expect(ring.state?.active).toBe(1);
    expect(ring.key('arrowleft')).toBe(true);
    expect(ring.key('arrowleft')).toBe(true);
    expect(ring.state?.active).toBe(3);
    expect(ring.key('enter')).toBe(true);
    expect(p.options[3].run).toHaveBeenCalledOnce();
  });

  it('takes a numbered choice directly, within range', () => {
    const p = plan();
    ring.open(300, 300, 1280, 720, p, false);
    expect(ring.key('3')).toBe(true);
    expect(p.options[2].run).toHaveBeenCalledOnce();
  });

  it('closes on Esc, and hands any other key on after closing', () => {
    ring.open(300, 300, 1280, 720, plan(), false);
    expect(ring.key('escape')).toBe(true);
    expect(ring.state).toBeNull();
    ring.open(300, 300, 1280, 720, plan(), false);
    expect(ring.key('w')).toBe(false);
    expect(ring.state).toBeNull();
    expect(ring.key('w')).toBe(false);
  });

  it('tells its listeners, and stops when they leave', () => {
    const fn = vi.fn();
    const off = ring.subscribe(fn);
    ring.open(300, 300, 1280, 720, plan(), false);
    ring.close();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    ring.open(300, 300, 1280, 720, plan(), false);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
