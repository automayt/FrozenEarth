import { describe, expect, it } from 'vitest';
import { Tweens } from '../src/render/fx';

describe('Tweens', () => {
  it('runs to the end and calls done once', () => {
    const tw = new Tweens();
    const seen: number[] = [];
    let done = 0;
    tw.add(100, (k) => seen.push(k), () => done++);
    const t0 = performance.now();
    tw.update(t0 + 50);
    tw.update(t0 + 200);
    tw.update(t0 + 300);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect(done).toBe(1);
  });

  it('drops a tween whose owner was destroyed, without stepping it or calling done', () => {
    const tw = new Tweens();
    const owner = { destroyed: false };
    let steps = 0;
    let done = 0;
    tw.add(
      100,
      () => {
        // A destroyed Pixi container has no scale any more: touching it would throw every frame.
        if (owner.destroyed) throw new Error('stepped a destroyed view');
        steps++;
      },
      () => done++,
      owner,
    );
    owner.destroyed = true;
    const t0 = performance.now();
    expect(() => tw.update(t0 + 50)).not.toThrow();
    expect(() => tw.update(t0 + 500)).not.toThrow();
    expect(steps).toBe(1);
    expect(done).toBe(0);
  });
});
