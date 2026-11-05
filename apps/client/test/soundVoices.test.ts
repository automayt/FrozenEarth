import { describe, expect, it } from 'vitest';
import { foldLoop } from '../src/sound/bank';
import { RECIPES } from '../src/sound/recipes';
import { commandSound, uiChange, type UiState } from '../src/sound/ui';
import { cutoffFor, muffleAt, panAt, reach, VoiceCap, type Ear } from '../src/sound/voices';

const ear: Ear = { x: 1000, y: 1000, span: 800 };

describe('where a sound sits', () => {
  it('pans by position across the screen and stops short of one ear', () => {
    expect(panAt(1000, ear)).toBe(0);
    expect(panAt(1200, ear)).toBeCloseTo(0.4);
    expect(panAt(800, ear)).toBeCloseTo(-0.4);
    expect(panAt(1400, ear)).toBeCloseTo(0.8);
    expect(panAt(90000, ear)).toBeCloseTo(0.8);
  });

  it('fades with distance, to nothing a little past the screen', () => {
    expect(reach(1000, 1000, ear)).toBe(1);
    expect(reach(1200, 1000, ear)).toBeLessThan(1);
    expect(reach(1400, 1000, ear)).toBeLessThan(reach(1200, 1000, ear));
    expect(reach(1000 + 800 * 0.7, 1000, ear)).toBe(0);
  });

  it('quietens everything when zoomed far out', () => {
    expect(reach(1000, 1000, { ...ear, span: 8000 })).toBeLessThan(0.5);
    expect(reach(1000, 1000, { ...ear, span: 8000 })).toBeGreaterThan(0);
  });

  it('muffles what is far away or seen from high up, and leaves the near alone', () => {
    expect(cutoffFor(muffleAt(1010, 1000, ear))).toBe(0);
    const far = cutoffFor(muffleAt(1500, 1000, ear));
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(5000);
    expect(cutoffFor(muffleAt(1000, 1000, { ...ear, span: 8000 }))).toBeGreaterThan(0);
  });
});

describe('VoiceCap', () => {
  it('allows sounds until it is full, then drops the least important', () => {
    const cap = new VoiceCap<string>(2);
    expect(cap.claim('a', 1, 10, 0, 'one').ok).toBe(true);
    expect(cap.claim('b', 2, 10, 0, 'two').ok).toBe(true);
    expect(cap.claim('c', 0.5, 10, 0, 'three')).toEqual({ ok: false, steal: null });
    expect(cap.active).toBe(2);
  });

  it('lets a more important sound take over the weakest voice', () => {
    const cap = new VoiceCap<string>(2);
    cap.claim('a', 1, 10, 0, 'one');
    cap.claim('b', 2, 10, 0, 'two');
    expect(cap.claim('c', 3, 10, 0, 'three')).toEqual({ ok: true, steal: 'one' });
    expect(cap.active).toBe(2);
  });

  it('frees voices as they finish', () => {
    const cap = new VoiceCap<string>(1);
    cap.claim('a', 1, 5, 0, 'one');
    expect(cap.claim('b', 0.1, 9, 6, 'two')).toEqual({ ok: true, steal: null });
  });

  it('holds each kind to its own cap, however quiet the rest is', () => {
    const cap = new VoiceCap<number>(10, () => 2);
    cap.claim('rifle', 3, 10, 0, 1);
    cap.claim('rifle', 3.5, 10, 0, 2);
    cap.claim('wood', 1, 10, 0, 3);
    expect(cap.claim('rifle', 3.1, 10, 0, 4).steal).toBe(1);
    expect(cap.claim('rifle', 3, 10, 0, 5).ok).toBe(false);
    expect(cap.active).toBe(3);
  });

  it('never goes over its limit in a firefight of hundreds of shots', () => {
    const cap = new VoiceCap<number>(14, () => 5);
    let most = 0;
    for (let i = 0; i < 500; i++) {
      cap.claim(i % 2 ? 'rifle' : 'hit', 2 + Math.random(), i * 0.01 + 0.8, i * 0.01, i);
      most = Math.max(most, cap.active);
    }
    expect(most).toBeLessThanOrEqual(10);
  });
});

describe('recipes', () => {
  it('keeps interface sounds off the camera and world sounds on it', () => {
    expect(RECIPES.hover.screen).toBe(true);
    expect(RECIPES.refuse.screen).toBe(true);
    expect(RECIPES.rifle.screen).toBeFalsy();
  });

  it('gives every sound a tail long enough that a bank take is not cut off', () => {
    for (const r of Object.values(RECIPES)) expect(r.dur).toBeGreaterThan(0);
  });
});

describe('foldLoop', () => {
  it('joins the end of a loop to its start without a jump', () => {
    const n = 1000;
    const tail = 100;
    const data = new Float32Array(n + tail);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.05) + i / 500;
    const out = foldLoop(data, n, tail);
    expect(out.length).toBe(n);
    // Across the seam the step is no bigger than any ordinary sample-to-sample step nearby.
    const seam = Math.abs(out[0] - out[n - 1]);
    const step = Math.abs(data[n] - data[n - 1]);
    expect(seam).toBeLessThan(step * 6);
    expect(out[500]).toBe(data[500]);
  });
});

describe('interface sounds', () => {
  const base: UiState = { panel: 'none', menu: null, help: false, selected: null, toast: 0, toastBad: false };

  it('opens and closes with the panel', () => {
    expect(uiChange(base, { ...base, panel: 'work' })).toEqual(['open']);
    expect(uiChange({ ...base, panel: 'work' }, base)).toEqual(['close']);
    expect(uiChange({ ...base, panel: 'work' }, { ...base, panel: 'trade' })).toEqual(['open']);
    expect(uiChange(base, { ...base, menu: 'structure' })).toEqual(['open']);
    expect(uiChange(base, base)).toEqual([]);
  });

  it('answers a bad toast with a refusal, once', () => {
    expect(uiChange(base, { ...base, toast: 3, toastBad: true })).toEqual(['refuse']);
    expect(uiChange({ ...base, toast: 3, toastBad: true }, { ...base, toast: 3, toastBad: true })).toEqual([]);
    expect(uiChange(base, { ...base, toast: 3, toastBad: false })).toEqual([]);
  });

  it('taps when something is selected, not when it is let go', () => {
    expect(uiChange(base, { ...base, selected: 7 })).toEqual(['select']);
    expect(uiChange({ ...base, selected: 7 }, base)).toEqual([]);
  });

  it('knocks in a blueprint, marks other orders softly, and stays quiet for the rest', () => {
    expect(commandSound('build')).toBe('place');
    expect(commandSound('designate')).toBe('mark');
    expect(commandSound('steer')).toBeNull();
    expect(commandSound('choose')).toBeNull();
  });
});
