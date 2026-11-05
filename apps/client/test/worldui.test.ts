import { describe, expect, it } from 'vitest';
import type { Job } from '@fe/sim';
import { BAR_FADE_MS, BAR_HOLD_MS, barAlpha, barColor, jobTag, ringStep, screenSize, workShare } from '../src/render/worldui';
import { GLYPHS, RING_STEPS } from '../src/render/worldAtlas';

describe('in-world marks', () => {
  it('a health bar holds after the last blow, then fades out', () => {
    expect(barAlpha(0)).toBe(1);
    expect(barAlpha(BAR_HOLD_MS)).toBe(1);
    expect(barAlpha(BAR_HOLD_MS + BAR_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(barAlpha(BAR_HOLD_MS + BAR_FADE_MS)).toBe(0);
    expect(barAlpha(Infinity)).toBe(0);
  });

  it('a health bar goes from green through amber to red, and bright while bleeding', () => {
    expect(barColor(1, false)).not.toBe(barColor(0.5, false));
    expect(barColor(0.5, false)).not.toBe(barColor(0.1, false));
    expect(barColor(1, true)).toBe(barColor(0.1, true));
  });

  it('marks hold their size on screen across the zoom range', () => {
    expect(screenSize(26, 0.15, 20, 34)).toBe(20);
    expect(screenSize(26, 1, 20, 34)).toBe(26);
    expect(screenSize(26, 3, 20, 34)).toBe(34);
  });

  it('a work ring runs on from the last figure the server sent, and never quite finishes on its own', () => {
    expect(workShare(100, 0, 1, 400)).toBe(0.25);
    expect(workShare(100, 100, 1, 400)).toBe(0.5);
    expect(workShare(100, 100, 2, 400)).toBe(0.75);
    expect(workShare(100, 10000, 1, 400)).toBe(0.99);
    expect(workShare(0, 10, 1, 0)).toBe(0);
  });

  it('ring steps cover empty to full', () => {
    expect(ringStep(0)).toBe(0);
    expect(ringStep(1)).toBe(RING_STEPS);
    expect(ringStep(2)).toBe(RING_STEPS);
    expect(ringStep(-1)).toBe(0);
  });

  it('every job has a tag that exists, or deliberately none', () => {
    const jobs: Partial<Job>[] = ['build', 'mine', 'sow', 'haul', 'deliver', 'eat', 'sleep', 'attack', 'tend', 'bill', 'extinguish', 'tame', 'shelter', 'flee', 'trek', 'goto', 'repair', 'rescue', 'feed', 'equip', 'hold'].map((type) => ({ type }) as Partial<Job>);
    for (const j of jobs) expect(GLYPHS[jobTag(j as Job)!]).toBeTruthy();
    expect(jobTag(null)).toBeNull();
    expect(jobTag({ type: 'wander' } as Job)).toBeNull();
    expect(jobTag({ type: 'cut', harvest: true } as Job)).toBe('plant');
    expect(jobTag({ type: 'cut', harvest: false } as Job)).toBe('chop');
  });
});
