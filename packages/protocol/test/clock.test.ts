import { describe, expect, it } from 'vitest';
import { Rng } from '@fe/sim';
import { TickClock } from '../src';

/**
 * A server at 3x (180 ticks/s) sending a delta every 66 ms over a link with this one-way latency
 * and jitter (TCP: in order), and a client drawing at 60 fps.
 */
function simulate(latencyMs: number, jitterMs: number, seconds = 20, seed = 3) {
  const rng = new Rng(seed);
  let now = 0;
  const clock = new TickClock(() => now);
  clock.setTime({ speed: 3, paused: false });
  const arrivals: { at: number; tick: number }[] = [];
  let last = 0;
  for (let sent = 0; sent < seconds * 1000; sent += 66) {
    last = Math.max(last, sent + latencyMs + rng.next() * jitterMs);
    arrivals.push({ at: last, tick: 100_000 + Math.round((sent / 1000) * 180) });
  }
  let next = 0;
  let newest = 0;
  let prev = -Infinity;
  const out = { backsteps: 0, frames: 0, beyondData: 0, lagSum: 0, frozen: 0 };
  for (now = 0; now < seconds * 1000; now += 1000 / 60) {
    while (next < arrivals.length && arrivals[next].at <= now) {
      newest = arrivals[next].tick;
      clock.setServerTick(newest);
      next++;
    }
    if (!newest) continue;
    const t = clock.estTick();
    if (now < 2000) {
      prev = t;
      continue;
    }
    out.frames++;
    if (t < prev) out.backsteps++;
    if (t === prev) out.frozen++;
    // Drawing a tick no delta has covered yet: a walk that started since would pop in mid-stride.
    if (t > newest + 1) out.beyondData++;
    out.lagSum += (100_000 + (now / 1000) * 180 - t) / 180;
    prev = t;
  }
  return { ...out, lagMs: (out.lagSum / out.frames) * 1000 };
}

describe('client tick clock', () => {
  it('never runs backwards, even on a jittery link', () => {
    for (const [lat, jit] of [
      [2, 1],
      [40, 10],
      [60, 120],
      [250, 200],
    ]) {
      const r = simulate(lat, jit);
      expect(r.backsteps, `latency ${lat} jitter ${jit}`).toBe(0);
      expect(r.frozen / r.frames, `latency ${lat} jitter ${jit}: frozen frames`).toBeLessThan(0.05);
    }
  });

  it('draws behind the newest delta, so walks are known before they are drawn, without lagging far', () => {
    const lan = simulate(2, 1);
    expect(lan.beyondData / lan.frames).toBeLessThan(0.02);
    expect(lan.lagMs).toBeLessThan(150);
    const wifi = simulate(60, 120);
    expect(wifi.beyondData / wifi.frames).toBeLessThan(0.1);
    expect(wifi.lagMs).toBeLessThan(60 + 120 + 400);
  });

  it('glides to the paused tick, carries on smoothly after, and jumps only when far off', () => {
    let now = 0;
    const c = new TickClock(() => now);
    c.setServerTick(5000);
    c.setTime({ speed: 1, paused: false });
    for (; now < 3000; now += 16) if (now % 66 < 16) c.setServerTick(5000 + Math.round((now / 1000) * 60));
    const before = c.estTick();
    expect(before).toBeLessThan(5180);
    expect(before).toBeGreaterThan(5160);
    c.setServerTick(5180);
    c.setTime({ speed: 0, paused: true });
    let prev = c.estTick();
    for (let i = 0; i < 60; i++) {
      now += 16;
      const t = c.estTick();
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    expect(c.estTick()).toBe(5180);
    c.setTime({ speed: 1, paused: false });
    now += 16;
    expect(c.estTick()).toBeGreaterThanOrEqual(5180);
    // A rejoin into a world far ahead (or a server that restarted behind) snaps straight there.
    c.setServerTick(90_000);
    expect(Math.abs(c.estTick() - 90_000)).toBeLessThan(10);
    c.setServerTick(1_000);
    expect(Math.abs(c.estTick() - 1_000)).toBeLessThan(10);
  });
});
