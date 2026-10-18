import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Packr } from 'msgpackr';
import type { GameMessage, SaveData } from '@fe/sim';
import type { ChatMsg } from '@fe/protocol';

export interface StoredPlayer {
  id: number;
  name: string;
  token: string;
  faction: number;
  pauseBudget: number;
  admin: boolean;
  /** World tick when they last disconnected. */
  lastSeen?: number;
}

export interface WorldFile {
  save: SaveData;
  players: StoredPlayer[];
  nextPlayerId: number;
  /** Recent letters and chat, replayed to whoever joins. Older files have none. */
  letters?: GameMessage[];
  chat?: ChatMsg[];
}

const packr = new Packr({ useRecords: false });

export function worldPath(savesDir: string, name: string): string {
  return join(savesDir, name.replace(/[^a-zA-Z0-9_-]/g, '_'), 'world.bin');
}

export function loadWorldFile(path: string): WorldFile | null {
  if (!existsSync(path)) return null;
  const data = packr.unpack(gunzipSync(readFileSync(path))) as WorldFile;
  // msgpack gives Buffers back in Node; the sim wants plain Uint8Arrays.
  const s = data.save;
  for (const k of ['terrain', 'rock', 'desig', 'desigFaction'] as const) s[k] = new Uint8Array(s[k]);
  if (s.roof) s.roof = new Uint8Array(s.roof);
  return data;
}

/** Write atomically so a crash mid-save never corrupts the world. */
export function saveWorldFile(path: string, file: WorldFile): number {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = gzipSync(packr.pack(file));
  const tmp = path + '.tmp';
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
  return bytes.length;
}
