import { describe, expect, it } from 'vitest';
import { DEFAULT_VOLUME, Volumes, type KeyValue } from '../src/sound/levels';

function memory(seed: Record<string, string> = {}): KeyValue & { data: Record<string, string> } {
  const data = { ...seed };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe('Volumes', () => {
  it('starts from the defaults on a first visit', () => {
    const v = new Volumes(() => memory());
    expect(v.get('master')).toBe(DEFAULT_VOLUME.master);
    expect(v.get('music')).toBe(DEFAULT_VOLUME.music);
  });

  it('keeps each channel across a reload', () => {
    const disk = memory();
    const a = new Volumes(() => disk);
    a.set('music', 0.25);
    a.set('interface', 0);
    const b = new Volumes(() => disk);
    expect(b.get('music')).toBe(0.25);
    expect(b.get('interface')).toBe(0);
    expect(b.get('effects')).toBe(DEFAULT_VOLUME.effects);
  });

  it('reads master from the key the old slider saved to', () => {
    expect(new Volumes(() => memory({ 'fe.volume': '0.3' })).get('master')).toBe(0.3);
  });

  it('clamps out-of-range values and ignores garbage', () => {
    const v = new Volumes(() => memory({ 'fe.volume.music': 'loud', 'fe.volume.ambience': '7' }));
    expect(v.get('music')).toBe(DEFAULT_VOLUME.music);
    expect(v.get('ambience')).toBe(1);
    v.set('effects', -2);
    expect(v.get('effects')).toBe(0);
    v.set('effects', Number.NaN);
    expect(v.get('effects')).toBe(0);
  });

  it('survives blocked storage, keeping the value for this session', () => {
    const blocked: KeyValue = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const v = new Volumes(() => blocked);
    expect(v.get('music')).toBe(DEFAULT_VOLUME.music);
    v.set('music', 0.9);
    expect(v.get('music')).toBe(0.9);
    const none = new Volumes(() => null);
    none.set('master', 0.1);
    expect(none.get('master')).toBe(0.1);
  });
});
