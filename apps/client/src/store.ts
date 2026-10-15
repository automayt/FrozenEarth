import { useSyncExternalStore } from 'react';
import { Mirror, type PlayerInfo, type Site, type TimeState } from '@fe/protocol';
import { TICKS_PER_SECOND, type ZoneKind } from '@fe/sim';

export type Tool =
  | { kind: 'select' }
  | { kind: 'designate'; what: 'mine' | 'chop' | 'cut' | 'harvest' | 'cancel' }
  | { kind: 'build'; def: string }
  | { kind: 'zone'; zone: ZoneKind; plant?: string }
  | { kind: 'unzone' }
  | { kind: 'deconstruct' };

export interface ChatLine {
  from: string;
  color: number;
  text: string;
  at: number;
}

export type Status = 'join' | 'connecting' | 'playing' | 'error';
export type Panel = 'none' | 'work' | 'colonists' | 'events';

/** All client state. React reads it through useStore; the renderer reads it directly. */
class Store {
  mirror = new Mirror();
  status: Status = 'join';
  error = '';
  me: { playerId: number; faction: number } | null = null;
  players: PlayerInfo[] = [];
  time: TimeState = { speed: 0, paused: true, reason: '' };
  chat: ChatLine[] = [];
  tool: Tool = { kind: 'select' };
  selected: number | null = null;
  selectedCell: number | null = null;
  panel: Panel = 'none';
  /** Open architect category, if any. */
  menu: string | null = null;
  hoverCell: number | null = null;
  /** Camera jump requests from UI to renderer. */
  focus: { x: number; y: number } | null = null;
  ping = 0;
  /** Suggested starting spots while unsettled. */
  sites: Site[] = [];
  /** Spot the player clicked while choosing where to settle. */
  settlePick: { x: number; y: number } | null = null;

  private lastTick = 0;
  private lastTickAt = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  private pending = false;

  /** Estimated current server tick, extrapolated between deltas for smooth movement. */
  estTick(): number {
    if (this.time.paused) return this.lastTick;
    const elapsed = (performance.now() - this.lastTickAt) / 1000;
    const ahead = Math.min(elapsed, 0.3) * TICKS_PER_SECOND * this.time.speed;
    return this.lastTick + ahead;
  }

  setServerTick(tick: number): void {
    // Never step backwards visually: blend toward the authoritative tick.
    const est = this.estTick();
    this.lastTick = Math.abs(est - tick) > 120 ? tick : Math.max(tick, Math.min(est, tick + 20));
    this.lastTickAt = performance.now();
  }

  set(patch: Partial<Pick<Store, 'status' | 'error' | 'me' | 'players' | 'time' | 'tool' | 'selected' | 'selectedCell' | 'panel' | 'menu' | 'hoverCell' | 'focus' | 'ping' | 'sites' | 'settlePick'>>): void {
    Object.assign(this, patch);
    this.emit();
  }

  /** Coalesce bursts of updates into one React render per frame. */
  emit(): void {
    if (this.pending) return;
    this.pending = true;
    const flush = () => {
      if (!this.pending) return;
      this.pending = false;
      this.version++;
      for (const l of this.listeners) l();
    };
    // Animation frames stop when the window is hidden or covered; race a timer so state keeps flowing.
    requestAnimationFrame(flush);
    setTimeout(flush, 100);
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = () => this.version;
}

export const store = new Store();

export function useStore(): Store {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}
