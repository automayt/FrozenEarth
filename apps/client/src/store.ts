import { useSyncExternalStore } from 'react';
import { Mirror, TickClock, type PlayerInfo, type Site, type TimeState } from '@fe/protocol';
import type { ZoneKind } from '@fe/sim';

export type Tool =
  | { kind: 'select' }
  | { kind: 'designate'; what: 'mine' | 'chop' | 'cut' | 'harvest' | 'steal' | 'cancel' }
  | { kind: 'build'; def: string }
  | { kind: 'zone'; zone: ZoneKind; plant?: string }
  | { kind: 'unzone' }
  | { kind: 'deconstruct' }
  | { kind: 'packUp' }
  | { kind: 'moveHome' }
  | { kind: 'hunt' };

export interface ChatLine {
  from: string;
  color: number;
  text: string;
  at: number;
}

export type ToastTone = 'good' | 'neutral' | 'bad';

/** A short-lived notice: the answer to something the player just did. */
export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  /** Where clicking it jumps the camera. */
  at?: { x: number; y: number };
}

const TOAST_MS = 6000;

export type Status = 'join' | 'connecting' | 'playing' | 'error';
export type Panel = 'none' | 'work' | 'colonists' | 'events' | 'trade' | 'diplomacy';

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
  /** Own pawns selected together (click or drag-box), for drafting and orders. */
  squad: number[] = [];
  selectedCell: number | null = null;
  panel: Panel = 'none';
  /** Open architect category, if any. */
  menu: string | null = null;
  hoverCell: number | null = null;
  /** Camera jump requests from UI to renderer. */
  focus: { x: number; y: number } | null = null;
  ping = 0;
  /** Visible cell rectangle, written by the renderer each frame (no re-render). */
  view: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Suggested starting spots while unsettled. */
  sites: Site[] = [];
  /** Spot the player clicked while choosing where to settle. */
  settlePick: { x: number; y: number } | null = null;
  /** Feedback for the player's own actions, newest last. */
  toasts: Toast[] = [];
  /** Keyboard and how-to overlay. */
  help = false;
  /** Partner the Trade panel opens on. */
  tradeWith: number | null = null;
  /** Faction the Diplomacy panel shows. */
  diploWith: number | null = null;
  private nextToast = 1;

  private clock = new TickClock();
  private version = 0;
  private listeners = new Set<() => void>();
  private pending = false;

  /** The tick the world is drawn at: just behind the newest delta, extrapolated smoothly, never backwards (see TickClock). */
  estTick(): number {
    this.clock.setTime(this.time);
    return this.clock.estTick();
  }

  setServerTick(tick: number): void {
    this.clock.setTime(this.time);
    this.clock.setServerTick(tick);
  }

  set(patch: Partial<Pick<Store, 'status' | 'error' | 'me' | 'players' | 'time' | 'tool' | 'selected' | 'squad' | 'selectedCell' | 'panel' | 'menu' | 'hoverCell' | 'focus' | 'ping' | 'sites' | 'settlePick' | 'help' | 'tradeWith' | 'diploWith'>>): void {
    Object.assign(this, patch);
    this.emit();
  }

  /** Show a toast for a few seconds. The same text again just refreshes it. */
  toast(text: string, tone: ToastTone = 'neutral', at?: { x: number; y: number }): void {
    const id = this.nextToast++;
    this.toasts = [...this.toasts.filter((t) => t.text !== text), { id, text, tone, at }].slice(-4);
    this.emit();
    setTimeout(() => this.dismissToast(id), TOAST_MS + text.length * 30);
  }

  dismissToast(id: number): void {
    if (!this.toasts.some((t) => t.id === id)) return;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }

  /** Open the Trade panel on a partner. */
  openTrade(faction: number): void {
    this.set({ panel: 'trade', menu: null, tradeWith: faction });
  }

  /** Open the Diplomacy panel on a faction. */
  openDiplomacy(faction: number): void {
    this.set({ panel: 'diplomacy', menu: null, diploWith: faction });
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
