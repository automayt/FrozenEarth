import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Packr } from 'msgpackr';
import type { SaveData } from '@fe/sim';

export interface StoredPlayer {
  id: number;
  name: string;
  token: string;
  faction: number;
  pauseBudget: number;
  admin: boolean;
  /** Refused at the door (by token and by name). */
  banned?: boolean;
}

/** What the host set at runtime, kept with the world so it survives restarts. */
export interface HostSettings {
  /** scrypt hash of the join password ("scrypt$salt$hash", hex), or absent for an open server. */
  passwordHash?: string;
}

export interface WorldFile {
  save: SaveData;
  players: StoredPlayer[];
  nextPlayerId: number;
  host?: HostSettings;
}

const packr = new Packr({ useRecords: false });

export function worldPath(savesDir: string, name: string): string {
  return join(savesDir, safeName(name), 'world.bin');
}

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_') || '_';
}

export function packGz(value: unknown): Buffer {
  return gzipSync(packr.pack(value));
}

export function unpackGz<T>(bytes: Buffer): T {
  return packr.unpack(gunzipSync(bytes)) as T;
}

function decodeWorldFile(bytes: Buffer): WorldFile {
  const data = unpackGz<WorldFile>(bytes);
  if (!data || typeof data !== 'object' || !data.save || !Array.isArray(data.players)) throw new Error('not a world file');
  fixArrays(data.save);
  return data;
}

/** msgpack gives Buffers back in Node; the sim wants plain Uint8Arrays. */
export function fixArrays(s: SaveData): void {
  for (const k of ['terrain', 'rock', 'desig', 'desigFaction', 'fire'] as const) if (s[k]) s[k] = new Uint8Array(s[k]);
  if (s.roof) s.roof = new Uint8Array(s.roof);
}

export function loadWorldFile(path: string): WorldFile | null {
  if (!existsSync(path)) return null;
  return decodeWorldFile(readFileSync(path));
}

export const backupDir = (path: string) => join(dirname(path), 'backups');
export const crashDir = (path: string) => join(dirname(path), 'crashes');
const bakPath = (path: string) => path.replace(/\.bin$/, '') + '.bak';

/** Windows: a virus scanner or indexer briefly holding the file makes rename fail with EPERM/EBUSY. */
function retry<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 8 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

/** Write bytes so that a crash at any moment leaves either the old file or the new one, never half of one. */
export function writeFileAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  retry(() => renameSync(tmp, path));
}

export interface SaveStats {
  bytes: number;
  packMs: number;
  writeMs: number;
}

/**
 * Save atomically and keep the previous save as world.bak. Order: the new file is complete and
 * flushed (world.bin.tmp) before world.bin moves to world.bak, so every crash point leaves a
 * complete world in world.bin, world.bin.tmp or world.bak, which loadWorldWithRecovery tries in turn.
 */
export function saveWorldFile(path: string, file: WorldFile): number {
  return saveWorldFileStats(path, file).bytes;
}

export function saveWorldFileStats(path: string, file: WorldFile): SaveStats {
  mkdirSync(dirname(path), { recursive: true });
  const t0 = performance.now();
  const bytes = packGz(file);
  const t1 = performance.now();
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(path)) retry(() => renameSync(path, bakPath(path)));
  retry(() => renameSync(tmp, path));
  return { bytes: bytes.length, packMs: t1 - t0, writeMs: performance.now() - t1 };
}

class FatalLoad extends Error {}

export interface Loaded {
  file: WorldFile;
  /** Which file it came from (world.bin unless something was wrong with it). */
  from: string;
  /** Problems met on the way, for the log. */
  problems: string[];
}

/**
 * Load a world, falling back to the in-flight temp file, the previous save, then the newest
 * backups when a file is missing, truncated or corrupt. `check` must throw for a file the server
 * can't run (it deserializes the world). A corrupt world.bin is moved aside, never overwritten.
 * Returns null only when there is no world at all; throws when there are files but none loads.
 */
export function loadWorldWithRecovery(path: string, check: (f: WorldFile) => void): Loaded | null {
  const candidates = [path, path + '.tmp', bakPath(path), ...listBackups(path).map((b) => b.path)];
  const problems: string[] = [];
  let found = false;
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    found = true;
    try {
      const file = decodeWorldFile(readFileSync(c));
      try {
        check(file);
      } catch (e) {
        // The file is whole (gzip checks every byte), so this is the server failing to load a good
        // world: a migration bug, or a world from a newer server. An older backup would only hide it
        // (or quietly throw away progress), so stop and say so.
        const msg = e instanceof Error ? e.message : String(e);
        const hint = /newer than this server/.test(msg) ? ' Update the server (git pull, npm install, npm run build).' : ' This is a server bug: report it with the file. Older backups are in backups/.';
        throw new FatalLoad(`${basename(c)} is intact but this server cannot load it: ${msg}.${hint}`, { cause: e });
      }
      if (c !== path && existsSync(path)) {
        const aside = `${path}.corrupt-${stamp()}`;
        retry(() => renameSync(path, aside));
        problems.push(`moved the unreadable world.bin aside to ${basename(aside)}`);
      }
      if (c === path + '.tmp') {
        // A crash after the new save was flushed but before it was renamed in: it is the newest world.
        if (existsSync(path)) retry(() => renameSync(path, bakPath(path)));
        retry(() => renameSync(c, path));
      } else if (c !== path) {
        // Put it in place, so the next save's rotation keeps it as world.bak.
        copyFileSync(c, path);
      }
      return { file, from: c, problems };
    } catch (e) {
      if (e instanceof FatalLoad) throw e;
      problems.push(`${basename(c)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!found) return null;
  throw new Error(`No loadable world at ${path}. Tried:\n  ${problems.join('\n  ')}`);
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface BackupInfo {
  name: string;
  path: string;
  kind: string;
  bytes: number;
  mtime: number;
}

/** Backups, newest first. */
export function listBackups(path: string): BackupInfo[] {
  const dir = backupDir(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.bin'))
    .map((name) => {
      const p = join(dir, name);
      const st = statSync(p);
      return { name, path: p, kind: /-([a-z]+)\.bin$/.exec(name)?.[1] ?? 'other', bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
}

/**
 * Copy the current world.bin into backups/ as <stamp>-<kind>.bin, then prune: keep the newest
 * `keep` of each automatic kind ("auto" hourly, "startup"). Manual and pre-restore backups stay.
 */
export function backupWorld(path: string, kind: string, keep = 48): string | null {
  if (!existsSync(path)) return null;
  const dir = backupDir(path);
  mkdirSync(dir, { recursive: true });
  let name = `${stamp()}-${kind}.bin`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${stamp()}.${i}-${kind}.bin`;
  copyFileSync(path, join(dir, name));
  if (kind === 'auto' || kind === 'startup') {
    for (const old of listBackups(path).filter((b) => b.kind === kind).slice(keep)) {
      try {
        unlinkSync(old.path);
      } catch {
        // Locked or gone: try again next time.
      }
    }
  }
  return name;
}

/** Find a backup by exact name, or the newest whose name contains `query`. */
export function findBackup(path: string, query: string): BackupInfo | null {
  const all = listBackups(path);
  return all.find((b) => b.name === query || b.name === `${query}.bin`) ?? all.find((b) => b.name.includes(query)) ?? null;
}

/** Put a backup in place of world.bin (the server must not be running this world). The current world is backed up first. */
export function restoreBackup(path: string, query: string): string {
  const b = findBackup(path, query);
  if (!b) throw new Error(`No backup matching "${query}" in ${backupDir(path)}`);
  decodeWorldFile(readFileSync(b.path));
  backupWorld(path, 'prerestore');
  writeFileAtomic(path, readFileSync(b.path));
  return b.name;
}
