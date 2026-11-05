/**
 * The mixer's numbers: which channels exist and what each is set to, saved in localStorage.
 * Nothing here touches Web Audio, so it runs in tests and with sound blocked.
 */

export const CHANNELS = ['master', 'music', 'ambience', 'effects', 'interface'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Master keeps the key it has always had, so existing players keep their setting. */
const KEYS: Record<Channel, string> = {
  master: 'fe.volume',
  music: 'fe.volume.music',
  ambience: 'fe.volume.ambience',
  effects: 'fe.volume.effects',
  interface: 'fe.volume.interface',
};

/** What a new player hears. Music sits well under everything else. */
export const DEFAULT_VOLUME: Record<Channel, number> = { master: 0.5, music: 0.6, ambience: 0.8, effects: 0.9, interface: 0.7 };

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The page's storage, or null where it is blocked (reading the property can itself throw). */
function pageStorage(): KeyValue | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** One volume per channel, 0..1. A setting that can't be read or saved just falls back or doesn't persist. */
export class Volumes {
  private values = {} as Record<Channel, number>;

  constructor(private storage: () => KeyValue | null = pageStorage) {
    for (const c of CHANNELS) this.values[c] = this.read(c);
  }

  private read(c: Channel): number {
    try {
      const raw = this.storage()?.getItem(KEYS[c]);
      if (raw === null || raw === undefined || raw === '') return DEFAULT_VOLUME[c];
      const v = Number(raw);
      return Number.isFinite(v) ? clamp01(v) : DEFAULT_VOLUME[c];
    } catch {
      return DEFAULT_VOLUME[c];
    }
  }

  get(c: Channel): number {
    return this.values[c];
  }

  set(c: Channel, v: number): void {
    if (!Number.isFinite(v)) return;
    this.values[c] = clamp01(v);
    try {
      this.storage()?.setItem(KEYS[c], String(this.values[c]));
    } catch {
      // Storage blocked: the setting just won't persist.
    }
  }
}
