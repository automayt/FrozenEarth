import type { Command, Delta, Snapshot } from '@fe/sim';

/** Bump when the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 3;

export interface PlayerInfo {
  id: number;
  name: string;
  faction: number;
  color: number;
  connected: boolean;
  /** 0 = wants pause, 1-3 = desired speed. */
  speed: number;
  /** Real seconds of pause this player has left. */
  pauseBudget: number;
  ping: number;
  admin: boolean;
}

export interface TimeState {
  /** Effective speed: 0 when paused. */
  speed: number;
  paused: boolean;
  /** Why the game is paused, for the UI. */
  reason: string;
}

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; token?: string; password?: string }
  | { t: 'cmd'; cmd: Command }
  | { t: 'speed'; speed: number }
  | { t: 'chat'; text: string }
  | { t: 'ping'; at: number }
  | { t: 'admin'; action: 'save' | 'kick' | 'event'; target?: number; key?: string };

export type ServerMsg =
  | { t: 'welcome'; playerId: number; faction: number; token: string; snap: Snapshot }
  | { t: 'delta'; d: Delta; time: TimeState }
  | { t: 'players'; players: PlayerInfo[]; time: TimeState }
  | { t: 'chat'; from: string; color: number; text: string; at: number }
  | { t: 'error'; msg: string; fatal: boolean }
  | { t: 'pong'; at: number };
