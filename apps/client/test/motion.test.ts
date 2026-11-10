import { describe, expect, it } from 'vitest';
import { breathGap, FELL_MS, fellAngle, fellPose, footingOf, grazeDip, heavySwing, HEAVY_STRIKE, passed, REBOUND_MS, RISE_STEPS, riseStep, SETTLE_MS, siteStage } from '../src/render/motion';

describe('the swing of a tool', () => {
  it('winds up, then lands at the strike and comes back to rest', () => {
    expect(heavySwing(0)).toBeCloseTo(0);
    expect(heavySwing(0.62)).toBeCloseTo(-1);
    expect(heavySwing(HEAVY_STRIKE)).toBeCloseTo(1);
    expect(heavySwing(0.9999)).toBeCloseTo(0, 2);
  });

  it('catches the strike once a loop, across the wrap too', () => {
    expect(passed(0.7, 0.8, 0.78)).toBe(true);
    expect(passed(0.79, 0.9, 0.78)).toBe(false);
    expect(passed(0.95, 0.05, 0.78)).toBe(false);
    expect(passed(0.95, 0.3, 0.25)).toBe(true);
    expect(passed(0.9, 0.8, 0.78)).toBe(true);
  });
});

describe('a falling tree', () => {
  it('starts slowly and reaches the ground when the crash comes', () => {
    expect(fellPose(0).reach).toBe(0);
    expect(fellPose(FELL_MS * 0.5).reach).toBeLessThan(0.4);
    expect(fellPose(FELL_MS - 1).reach).toBeGreaterThan(0.99);
  });

  it('bounces a little, then fades out completely', () => {
    expect(fellPose(FELL_MS + REBOUND_MS / 2).reach).toBeLessThan(1);
    expect(fellPose(FELL_MS + REBOUND_MS).reach).toBeCloseTo(1);
    expect(fellPose(FELL_MS + REBOUND_MS + 50).alpha).toBe(1);
    expect(fellPose(FELL_MS + REBOUND_MS + SETTLE_MS).alpha).toBeCloseTo(0);
  });

  it('falls away from whoever cut it, or any way if nobody did', () => {
    expect(fellAngle(10, 0, { x: 0, y: 0 }, 0.3)).toBeCloseTo(0);
    expect(fellAngle(0, 10, { x: 0, y: 0 }, 0.3)).toBeCloseTo(Math.PI / 2);
    expect(fellAngle(5, 5, null, 0.25)).toBeCloseTo(Math.PI / 2);
    expect(fellAngle(5, 5, { x: 5, y: 5 }, 0.5)).toBeCloseTo(Math.PI);
  });
});

describe('a building site', () => {
  it('piles goods up in three steps while it waits for them', () => {
    expect(siteStage(30, 0, 0, 100)).toEqual({ ready: false, pile: 0, rise: 0 });
    expect(siteStage(30, 5, 0, 100).pile).toBe(1);
    expect(siteStage(30, 15, 0, 100).pile).toBe(2);
    expect(siteStage(30, 29, 0, 100).pile).toBe(3);
  });

  it('then rises with the work, and the pile is gone', () => {
    expect(siteStage(30, 30, 25, 100)).toEqual({ ready: true, pile: 0, rise: 0.25 });
    expect(siteStage(30, 30, 500, 100).rise).toBe(1);
  });

  it('counts a site that needs nothing as ready', () => {
    expect(siteStage(0, 0, 0, 100).ready).toBe(true);
  });

  it('always has something to draw, and tops out at the whole building', () => {
    expect(riseStep(0)).toBe(1);
    expect(riseStep(0.5)).toBe(RISE_STEPS / 2);
    expect(riseStep(1)).toBe(RISE_STEPS);
    expect(riseStep(7)).toBe(RISE_STEPS);
  });
});

describe('what a foot leaves', () => {
  it('prints in frost whatever is under it, even shallow water frozen over', () => {
    expect(footingOf('gravel', 0.6, false, false)).toBe('snow');
    expect(footingOf('shallow_water', 0.6, false, false)).toBe('snow');
  });

  it('leaves nothing indoors, even with frost outside', () => {
    expect(footingOf('wood_floor', 1, true, false)).toBeNull();
  });

  it('rings on open water, prints in sand and marsh, and in soil only when it is wet', () => {
    expect(footingOf('shallow_water', 0, false, false)).toBe('water');
    expect(footingOf('sand', 0, false, false)).toBe('sand');
    expect(footingOf('marsh', 0, false, false)).toBe('mud');
    expect(footingOf('soil', 0, false, false)).toBeNull();
    expect(footingOf('soil', 0, false, true)).toBe('dirt');
    expect(footingOf('gravel', 0, false, true)).toBeNull();
  });
});

describe('small rhythms', () => {
  it('breathes faster at work than at rest, and slowest asleep', () => {
    expect(breathGap(true, false, 0)).toBeLessThan(breathGap(false, false, 0));
    expect(breathGap(false, false, 0)).toBeLessThan(breathGap(false, true, 0));
  });

  it('keeps each animal to its own grazing rhythm, and mostly with its head up', () => {
    let down = 0;
    for (let t = 0; t < 60; t += 0.1) if (grazeDip(t, 3) > 0) down++;
    expect(down / 600).toBeGreaterThan(0.1);
    expect(down / 600).toBeLessThan(0.4);
    expect(grazeDip(1, 0)).not.toBe(grazeDip(1, 1));
  });
});
