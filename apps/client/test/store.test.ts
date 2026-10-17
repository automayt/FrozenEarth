import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICKS_PER_SECOND } from '@fe/sim';
import { store } from '../src/store';

/** Smooth time: the client guesses the server tick between deltas, and never jumps backwards for small corrections. */
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

  it('runs ahead at the game speed between deltas, but at most 0.3 s worth', () => {
    store.time = { speed: 2, paused: false, reason: '' };
    store.setServerTick(1000);
    vi.advanceTimersByTime(100);
    expect(store.estTick()).toBeCloseTo(1000 + 0.1 * TICKS_PER_SECOND * 2, 5);
    vi.advanceTimersByTime(5000);
    expect(store.estTick()).toBeCloseTo(1000 + 0.3 * TICKS_PER_SECOND * 2, 5);
  });

  it('blends small corrections without stepping back, and snaps to big ones', () => {
    store.time = { speed: 1, paused: false, reason: '' };
    store.setServerTick(1000);
    vi.advanceTimersByTime(200);
    const ahead = store.estTick();
    expect(ahead).toBeGreaterThan(1000);
    // The server says we're slightly behind our guess: keep the guess (no backwards step).
    store.setServerTick(1001);
    expect(store.estTick()).toBeCloseTo(Math.min(ahead, 1001 + 20), 5);
    // Way off (a reload, a long stall): take the server's word.
    store.setServerTick(50_000);
    expect(store.estTick()).toBe(50_000);
    store.setServerTick(10);
    expect(store.estTick()).toBe(10);
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
