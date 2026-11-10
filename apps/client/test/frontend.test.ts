import { describe, expect, it } from 'vitest';
import { cursorForTool, cursorValue, CURSOR_ART } from '../src/cursors';
import { effectiveUiScale, QUALITY, qualityOf, sanitize, UI_SCALE_MAX, UI_SCALE_MIN, type Settings } from '../src/settings';
import { drawName, joinMessage, joinTrouble } from '../src/ui/joinFlow';
import { rollCells } from '../src/ui/Roll';
import { tabTitle } from '../src/ui/TabTitle';
import { splitHotkey } from '../src/ui/Tooltip';

const base: Settings = { uiScale: 1, ...QUALITY.high, screenShake: true, reducedMotion: false, details: true, edgeScroll: true, bigMoments: true, fullscreen: false };

describe('settings', () => {
  it('survives anything found in storage', () => {
    for (const junk of [null, 3, 'x', [], {}, { uiScale: 'big', weather: 'hail', shadows: 'yes' }]) expect(sanitize(junk, base)).toEqual(base);
  });

  it('keeps good values and clamps the scale', () => {
    expect(sanitize({ uiScale: 9, weather: 'off', shadows: false, nonsense: 1 }, base)).toEqual({ ...base, uiScale: UI_SCALE_MAX, weather: 'off', shadows: false });
    expect(sanitize({ uiScale: 0.1 }, base).uiScale).toBe(UI_SCALE_MIN);
  });

  it('names the quality preset, or none once options are mixed by hand', () => {
    expect(qualityOf(sanitize(QUALITY.low, base))).toBe('low');
    expect(qualityOf(base)).toBe('high');
    expect(qualityOf({ ...base, plantSway: false })).toBeNull();
  });

  it('caps the interface size in small windows, but never shrinks what was chosen', () => {
    expect(effectiveUiScale(1.4, 2560, 1440)).toBe(1.4);
    expect(effectiveUiScale(1.4, 1280, 720)).toBeCloseTo(1.28);
    expect(effectiveUiScale(1, 800, 450)).toBe(1);
    expect(effectiveUiScale(0.8, 800, 450)).toBe(0.8);
  });
});

describe('joining', () => {
  it('recognises the refusals the title screen has an answer to', () => {
    expect(joinTrouble('Wrong server password.')).toBe('password');
    expect(joinTrouble('Too many wrong passwords. Try again in a few minutes.')).toBe('password');
    expect(joinTrouble('That name is taken on this server. If it is yours…')).toBe('name-taken');
    expect(joinTrouble('This server is full.')).toBeNull();
    expect(joinTrouble('')).toBeNull();
  });

  it('asks for a password quietly the first time, and complains once one was wrong', () => {
    expect(joinMessage('Wrong server password.', false)).toBe('');
    expect(joinMessage('Wrong server password.', true)).toBe('Wrong server password.');
    expect(joinMessage('Too many wrong passwords. Try again in a few minutes.', false)).toMatch(/too many/i);
    expect(joinMessage('This server is full.', false)).toBe('This server is full.');
  });

  it('never draws the same name twice running', () => {
    const first = drawName('', () => 0);
    expect(drawName(first, () => 0)).not.toBe(first);
    expect(drawName('', () => 0.999)).toBeTruthy();
  });
});

describe('rolling numbers', () => {
  const texts = (c: ReturnType<typeof rollCells>) => c.map((x) => x.ch).join('');

  it('leaves the first showing and unchanged digits alone', () => {
    const a = rollCells('12', null, 'up');
    expect(a.every((c) => !c.dir)).toBe(true);
    const b = rollCells('13', a, 'up');
    expect(texts(b)).toBe('13');
    expect(b[0].key).toBe(a[0].key);
    expect(b[1]).toMatchObject({ ch: '3', was: '2', dir: 'up' });
  });

  it('keeps place value when the length changes', () => {
    const b = rollCells('10', rollCells('9', null, 'up'), 'up');
    expect(b[1]).toMatchObject({ ch: '0', was: '9' });
    expect(b[0].was).toBeUndefined();
  });

  it('does not roll symbols', () => {
    const b = rollCells('-3°', rollCells('12°', null, 'down'), 'down');
    expect(b[2].dir).toBeUndefined();
    expect(b[0].was).toBeUndefined();
  });
});

describe('tooltips', () => {
  it('engraves a trailing hotkey and leaves other brackets alone', () => {
    expect(splitHotkey('Orders (O)')).toEqual({ text: 'Orders', key: 'O' });
    expect(splitHotkey('Request pause (Space)')).toEqual({ text: 'Request pause', key: 'Space' });
    expect(splitHotkey('Who does what: work priorities (P)')).toEqual({ text: 'Who does what: work priorities', key: 'P' });
    expect(splitHotkey('Votes 2× (away: tab in the background)')).toEqual({ text: 'Votes 2× (away: tab in the background)' });
  });
});

describe('cursors', () => {
  it('follow the tool', () => {
    expect(cursorForTool({ kind: 'select' })).toBe('pointer');
    expect(cursorForTool({ kind: 'build', def: 'wood_wall' })).toBe('build');
    expect(cursorForTool({ kind: 'hunt' })).toBe('attack');
    expect(cursorForTool({ kind: 'designate', what: 'steal' })).toBe('haul');
    expect(cursorForTool({ kind: 'designate', what: 'cancel' })).toBe('pointer');
  });

  it('stay within the size browsers accept, with a fallback', () => {
    for (const name of Object.keys(CURSOR_ART) as (keyof typeof CURSOR_ART)[]) {
      const c = CURSOR_ART[name];
      expect(c.art).toContain('width="32"');
      expect(c.x).toBeLessThan(32);
      expect(c.y).toBeLessThan(32);
      expect(cursorValue(name, 'default')).toMatch(/^url\("data:image\/svg\+xml,.*"\) \d+ \d+, default$/);
    }
  });
});

describe('tab title', () => {
  it('shows the day, with what is urgent first', () => {
    expect(tabTitle(null, [])).toBe('FrozenEarth');
    expect(tabTitle(12, [])).toBe('Day 12 - FrozenEarth');
    expect(tabTitle(12, ['Fire near your colony', 'Low food'])).toBe('(2) Fire near your colony - Day 12 - FrozenEarth');
  });
});
