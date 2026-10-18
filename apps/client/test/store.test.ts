import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICKS_PER_SECOND } from '@fe/sim';
import { store } from '../src/store';

/** Smooth time: the client draws just behind the server tick, gliding between deltas, and never jumps backwards for small corrections. */
describe('client store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] });
    // Node has no animation frames; a 60 Hz timer stands in.
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16));
    store.time = { speed: 1, paused: true, reason: '' };
    // Two calls: the first may blend from whatever an earlier test left behind.
    store.setServerTick(0);
    store.setServerTick(1000);
    store.setServerTick(1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds still while paused', () => {
    expect(store.estTick()).toBe(1000);
    vi.advanceTimersByTime(5000);
    expect(store.estTick()).toBe(1000);
  });

  // The clock itself (lag behind the newest delta, jitter, pauses) is tested in packages/protocol/test/clock.test.ts.
  it('runs on at about the game speed between deltas, but stops a quarter second past the newest one', () => {
    store.time = { speed: 2, paused: false, reason: '' };
    store.setServerTick(1000);
    vi.advanceTimersByTime(100);
    const t = store.estTick();
    expect(t).toBeGreaterThan(1000 + 0.1 * TICKS_PER_SECOND * 2 * 0.7);
    expect(t).toBeLessThan(1000 + 0.1 * TICKS_PER_SECOND * 2 * 1.3);
    vi.advanceTimersByTime(5000);
    expect(store.estTick()).toBeCloseTo(1000 + 0.25 * TICKS_PER_SECOND * 2, 5);
  });

  it('never steps back for small corrections, and snaps to big ones', () => {
    store.time = { speed: 1, paused: false, reason: '' };
    store.setServerTick(1000);
    vi.advanceTimersByTime(200);
    const ahead = store.estTick();
    expect(ahead).toBeGreaterThan(1000);
    // The server says we're slightly ahead of it: slow down, don't step back.
    store.setServerTick(1001);
    expect(store.estTick()).toBeGreaterThanOrEqual(ahead);
    // Way off (a reload, a long stall): take the server's word, less the usual small lag.
    store.setServerTick(50_000);
    expect(Math.abs(store.estTick() - 50_000)).toBeLessThan(10);
    store.setServerTick(10);
    expect(Math.abs(store.estTick() - 10)).toBeLessThan(10);
  });

  it('coalesces bursts of updates into one notification', () => {
    const seen = vi.fn();
    const off = store.subscribe(seen);
    const v = store.getVersion();
    store.set({ panel: 'trade' });
    store.set({ panel: 'work' });
    store.set({ hoverCell: 5 });
    expect(seen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBe(v + 1);
    expect(store.panel).toBe('work');
    off();
    store.set({ panel: 'none' });
    vi.advanceTimersByTime(150);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
