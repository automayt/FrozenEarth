import type { Command, GameMessage, Snapshot } from '@fe/sim';
import type { WireDelta } from './packer';

/** Bump when the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 10;

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
  /** Tab in the background: their speed vote doesn't hold anyone back. */
  away?: boolean;
}

export interface TimeState {
  /** Effective speed: 0 when paused. */
  speed: number;
  paused: boolean;
  /** Why the game is paused, for the UI. */
  reason: string;
}

export interface Site {
  x: number;
  y: number;
  region: string;
}

/** A line of chat as the server broadcasts it. `from` is empty for server notices. */
export interface ChatMsg {
  from: string;
  color: number;
  text: string;
  at: number;
}

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; token?: string; password?: string }
  | { t: 'cmd'; cmd: Command }
  | { t: 'speed'; speed: number }
  | { t: 'chat'; text: string }
  /** The tab went to the background (or came back). */
  | { t: 'away'; away: boolean }
  | { t: 'ping'; at: number }
  | { t: 'admin'; action: 'save' | 'kick' | 'event'; target?: number; key?: string }
  /** Found the colony. Without coordinates the server picks a good spot. */
  | { t: 'settle'; x?: number; y?: number };

export type ServerMsg =
  /** faction 0 means the player hasn't settled yet; `sites` are suggestions. */
  | {
      t: 'welcome';
      playerId: number;
      faction: number;
      token: string;
      snap: Snapshot;
      sites?: Site[];
      /** Recent letters for this player (theirs and everyone's), so nothing that happened while they were gone is lost. */
      msgs?: GameMessage[];
      /** Recent chat. */
      chat?: ChatMsg[];
      /** Tick when this player last left, for "while you were away". Absent on a first join. */
      lastSeen?: number;
    }
  | { t: 'settled'; faction: number }
  | { t: 'delta'; d: WireDelta; time: TimeState }
  | { t: 'players'; players: PlayerInfo[]; time: TimeState }
  | { t: 'chat'; from: string; color: number; text: string; at: number }
  | { t: 'error'; msg: string; fatal: boolean }
  | { t: 'pong'; at: number };
