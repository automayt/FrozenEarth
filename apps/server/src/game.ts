import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WebSocket } from 'ws';
import {
  addPlayerFaction,
  createWorld,
  placeSettlements,
  populateWildlife,
  fireEvent,
  siteProblem,
  suggestSites,
  deserializeWorld,
  serializeWorld,
  snapshot,
  MAX_SPEED,
  TICKS_PER_SECOND,
  type Command,
  type Delta,
  type Pawn,
  type SaveData,
  type World,
} from '@fe/sim';
import { EVENTS } from '@fe/defs';
import { decode, encode, PROTOCOL_VERSION, type ClientMsg, type PlayerInfo, type ServerMsg, type TimeState } from '@fe/protocol';
import {
  backupWorld,
  crashDir,
  listBackups,
  loadWorldWithRecovery,
  packGz,
  saveWorldFileStats,
  stamp,
  findBackup,
  loadWorldFile,
  type HostSettings,
  type StoredPlayer,
  type WorldFile,
} from './persistence';

/** Real seconds of pause each player gets per in-game day, and the most they can bank. */
export const PAUSE_REFILL = 60;
export const PAUSE_MAX = 120;
const BROADCAST_MS = 66;
const PLAYERS_MS = 1000;
/** Saves are cheap (tens of ms) and a hard kill skips shutdown hooks, so save often. */
const AUTOSAVE_MS = 60_000;
/** An in-memory restore point a sim crash rolls back to (also taken at every save). */
const CHECKPOINT_MS = 15_000;
/** A copy of world.bin goes into backups/ this often while the world is running. */
const BACKUP_MS = 60 * 60_000;
/** Sim crashes within CRASH_WINDOW_MS before the server stops running the world. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
/** Most ticks run in one loop iteration, so a stall never snowballs. */
const MAX_TICKS_PER_LOOP = 60;
const MAX_BUFFERED = 16 * 1024 * 1024;
const CMD_RATE = 40;
/** Chat lines per second a player can send (with a small burst). */
const CHAT_RATE = 2;
const CHAT_BURST = 6;
/** A socket sending more than this many messages in a second is not a game client. */
const HARD_MSG_LIMIT = 2000;
/** A connection that hasn't said hello by then is dropped. */
const HELLO_TIMEOUT_MS = 15_000;
const STATS_MS = 30_000;
/** Distinct players a world will register (each new name gets a colony that is kept forever). */
const MAX_PLAYERS = 64;
/** Wrong passwords (or host keys) before an address is shut out for a while, and the server-wide cap. */
const AUTH_FAILS_PER_IP = 5;
const AUTH_FAILS_GLOBAL = 40;
const AUTH_WINDOW_MS = 10 * 60_000;
/** How long a released name waits for its owner to come back from a new browser. */
const RELEASE_MS = 15 * 60_000;
/** Most journal entries kept between checkpoints (a crash report replays them). */
const JOURNAL_MAX = 200_000;

interface Player extends StoredPlayer {
  speed: number;
  /** Speed to restore when a pause ends. */
  resumeSpeed: number;
  ping: number;
  ws: WebSocket | null;
  cmdTokens: number;
  chatTokens: number;
  /** Their tab is in the background. */
  away?: boolean;
  ip?: string;
  /** Until then, anyone joining with this name (and the server password) takes this colony over. */
  releasedUntil?: number;
}

export interface GameOptions {
  savePath: string;
  /** Sets (and stores) the join password; '' clears it. Undefined keeps what the world has stored. */
  password?: string;
  seed?: number;
  size?: number;
  /** New worlds only: days before the frost line moves, and its speed multiplier. */
  frostStart?: number;
  frostPace?: number;
  /** Most distinct players this world registers. Default MAX_PLAYERS. */
  maxPlayers?: number;
  /** Host key for /claim. Default: read or create host-key.txt next to the world. */
  hostKey?: string;
  /** Automatic backups kept of each kind. */
  keepBackups?: number;
  log?: (msg: string) => void;
}

/** One thing that changed the world, in order, since the last checkpoint: replaying them reproduces a crash. */
export type JournalOp =
  | ['c', number, Command]
  | ['s', number]
  | ['a']
  | ['e', string, number]
  | ['f', string, { x: number; y: number } | undefined];

export interface CrashReport {
  error: string;
  at: string;
  tick: number;
  /** World at the last checkpoint, and everything done to it since; replay with `npm run replay`. */
  checkpoint: SaveData;
  journal: JournalOp[];
  journalComplete: boolean;
}

/** True when a delta carries nothing, so a paused server can skip sending it. Taking it clears the changes, so this must see every field. */
export function deltaIsEmpty(d: Delta): boolean {
  return (
    !d.ents.length &&
    !d.removed.length &&
    !d.cells.length &&
    !d.zones.length &&
    !d.removedZones.length &&
    !d.factions.length &&
    !d.msgs.length &&
    !d.rooms &&
    !d.roomTemps &&
    !d.conditions &&
    !d.choices &&
    d.coldOffset === undefined &&
    !d.shots
  );
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}

export function checkPassword(pw: unknown, hash: string): boolean {
  if (typeof pw !== 'string' || pw.length > 200) return false;
  const [kind, salt, want] = hash.split('$');
  if (kind !== 'scrypt' || !salt || !want) return false;
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  const w = Buffer.from(want, 'hex');
  return w.length === got.length && timingSafeEqual(got, w);
}

function sameSecret(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Counts failed password and host-key attempts per address and server-wide. */
class AuthLimiter {
  private fails = new Map<string, number[]>();
  private all: number[] = [];
  blocked(ip: string, now = Date.now()): boolean {
    this.prune(now);
    return (this.fails.get(ip)?.length ?? 0) >= AUTH_FAILS_PER_IP || this.all.length >= AUTH_FAILS_GLOBAL;
  }
  fail(ip: string, now = Date.now()): void {
    const list = this.fails.get(ip) ?? [];
    list.push(now);
    this.fails.set(ip, list);
    this.all.push(now);
  }
  private prune(now: number): void {
    const cut = now - AUTH_WINDOW_MS;
    this.all = this.all.filter((t) => t > cut);
    for (const [ip, list] of this.fails) {
      const keep = list.filter((t) => t > cut);
      if (keep.length) this.fails.set(ip, keep);
      else this.fails.delete(ip);
    }
  }
}

export class GameServer {
  world: World;
  players = new Map<number, Player>();
  nextPlayerId = 1;
  private opts: GameOptions;
  private host: HostSettings = {};
  private hostKey: string;
  private acc = 0;
  private lastLoop = performance.now();
  private lastBroadcast = 0;
  private lastPlayers = 0;
  private lastSave = performance.now();
  private lastBackup = performance.now();
  private lastCheckpoint = performance.now();
  private lastStats = performance.now();
  private bytesOut = 0;
  private lastDay: number;
  private timer: NodeJS.Timeout | null = null;
  private time: TimeState = { speed: 0, paused: true, reason: 'No players online' };
  private log: (msg: string) => void;
  private auth = new AuthLimiter();
  private checkpoint: { save: SaveData; tick: number; at: number } | null = null;
  private journal: JournalOp[] = [];
  private journalComplete = true;
  private crashes: number[] = [];
  /** Set when the server has stopped running the world after repeated sim crashes. */
  halted: string | null = null;
  /** Unauthenticated sockets, for the hello timeout. */
  private pending = new Set<WebSocket>();
  /** Rolling tick cost, for monitoring. */
  tickMs = 0;
  /** Last save: compressed size and how long it blocked the loop. */
  lastSaveStats = { bytes: 0, ms: 0, serializeMs: 0 };
  saveFailures = 0;
  private savedTick = -1;
  /** Commands enqueued since the queue was last applied. */
  private queued = false;
  private backupTick = -1;

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`[game] ${m}`));
    const loaded = loadWorldWithRecovery(opts.savePath, (f) => {
      deserializeWorld(f.save);
    });
    if (loaded) {
      const file = loaded.file;
      for (const msg of loaded.problems) this.log(`WARNING: ${msg}`);
      if (loaded.from !== opts.savePath) this.log(`WARNING: world.bin could not be loaded; recovered the world from ${loaded.from}`);
      // A copy from before this version touched it, so an upgrade that goes wrong can be undone.
      backupWorld(opts.savePath, 'startup', opts.keepBackups ?? 48);
      this.world = deserializeWorld(file.save);
      for (const p of file.players) this.players.set(p.id, this.livePlayer(p));
      this.nextPlayerId = file.nextPlayerId;
      this.host = file.host ?? {};
      this.log(`Loaded world from ${opts.savePath} (day ${this.world.day()}, ${this.players.size} players)`);
      // Worlds from before settlements existed get some now.
      if (![...this.world.factions.values()].some((f) => f.settlement)) {
        const n = placeSettlements(this.world);
        if (n) this.log(`Founded ${n} settlements in an older world`);
      }
      if (![...this.world.factions.values()].some((f) => f.wild)) {
        populateWildlife(this.world);
        this.log('Brought wildlife to an older world');
      }
    } else {
      const size = opts.size ?? 200;
      this.world = createWorld({ seed: opts.seed, width: size, height: size });
      if (opts.frostStart !== undefined && Number.isFinite(opts.frostStart)) this.world.frost.startDay = Math.max(0, opts.frostStart);
      if (opts.frostPace !== undefined && Number.isFinite(opts.frostPace)) this.world.frost.pace = Math.max(0, opts.frostPace);
      this.log(`Generated new ${size}x${size} world, seed ${this.world.seed}`);
    }
    if (opts.password !== undefined) this.host.passwordHash = opts.password ? hashPassword(opts.password) : undefined;
    this.hostKey = opts.hostKey || this.readHostKey();
    this.lastDay = this.world.day();
    // Nobody is online after a restart, so nobody is steering anyone.
    for (const f of this.world.factions.values()) if (f.isPlayer) this.releaseControl(f.id);
    // On disk straight away, so a crash or dev-server restart doesn't roll a different world (and a
    // changed password is stored). This is also the first restore point.
    this.save();
  }

  private livePlayer(p: StoredPlayer): Player {
    return { ...p, speed: 1, resumeSpeed: 1, ping: 0, ws: null, cmdTokens: CMD_RATE, chatTokens: CHAT_BURST };
  }

  get passwordProtected(): boolean {
    return !!this.host.passwordHash;
  }

  /** host-key.txt next to the world: whoever can read the server's files is the host. */
  private readHostKey(): string {
    const file = join(dirname(this.opts.savePath), 'host-key.txt');
    try {
      if (existsSync(file)) {
        const k = readFileSync(file, 'utf8').trim();
        if (k.length >= 16) return k;
      }
      const k = randomBytes(18).toString('base64url');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, k + '\n', { mode: 0o600 });
      return k;
    } catch (e) {
      this.log(`Could not read or write ${file}: ${e instanceof Error ? e.message : e}. /claim is disabled.`);
      return '';
    }
  }

  get hostKeyPath(): string {
    return join(dirname(this.opts.savePath), 'host-key.txt');
  }

  /**
   * A player who goes away lets go of any colonist they were steering. Otherwise it keeps walking
   * the last held direction (into the frost, off to the enemy) and, drafted, never eats or sleeps.
   * Done as commands, so it lands in order with everything else.
   */
  private releaseControl(faction: number): void {
    if (!faction) return;
    for (const id of this.world.kinds.pawn) {
      const p = this.world.get<Pawn>(id)!;
      if (p.faction !== faction || !p.possessed) continue;
      this.enqueue(faction, { c: 'possess', pawn: p.id, on: false });
      this.enqueue(faction, { c: 'draft', pawns: [p.id], on: false });
    }
  }

  // ---------------------------------------------------------------- journal (for crash reports)

  private record(op: JournalOp): void {
    if (!this.journalComplete) return;
    if (this.journal.length >= JOURNAL_MAX) {
      this.journalComplete = false;
      this.journal = [];
      return;
    }
    const last = this.journal[this.journal.length - 1];
    if (op[0] === 's' && last?.[0] === 's') last[1] += op[1];
    else this.journal.push(op);
  }

  private enqueue(faction: number, cmd: Command): void {
    this.record(['c', faction, cmd]);
    this.queued = true;
    this.world.enqueue(faction, cmd);
  }

  private takeCheckpoint(save = serializeWorld(this.world)): void {
    this.checkpoint = { save, tick: this.world.tick, at: Date.now() };
    this.journal = [];
    this.journalComplete = true;
    this.lastCheckpoint = performance.now();
  }

  // ---------------------------------------------------------------- loop

  start(): void {
    this.lastLoop = performance.now();
    this.timer = setInterval(() => this.loop(), 5);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ws of this.pending) ws.close();
  }

  private loop(): void {
    try {
      this.loopInner();
    } catch (e) {
      // A bug in the sim (or the delta code reading it). Commands are already guarded one by one in
      // World.applyCommands, so this is the world itself throwing: roll back rather than die.
      this.simCrashed(e);
    }
  }

  /** Run n ticks, journaled, as the loop does. Throws whatever the sim throws. */
  stepTicks(n: number): void {
    this.queued = false;
    for (let i = 0; i < n; i++) {
      this.record(['s', 1]);
      this.world.step();
    }
  }

  private loopInner(): void {
    const now = performance.now();
    const dtMs = Math.min(250, now - this.lastLoop);
    this.lastLoop = now;
    this.updatePause(dtMs);
    const time = this.computeTime();
    const timeChanged = time.speed !== this.time.speed || time.reason !== this.time.reason;
    this.time = time;

    if (this.halted) {
      this.acc = 0;
    } else if (time.paused) {
      this.acc = 0;
      // Applying an empty queue does nothing, so the journal only notes the ones that had commands.
      if (this.queued) this.record(['a']);
      this.queued = false;
      this.world.applyCommands();
    } else {
      this.acc += (dtMs / 1000) * TICKS_PER_SECOND * time.speed;
      const n = Math.min(MAX_TICKS_PER_LOOP, Math.floor(this.acc));
      this.acc -= n;
      if (n > 0) {
        const t0 = performance.now();
        this.stepTicks(n);
        this.tickMs = this.tickMs * 0.9 + ((performance.now() - t0) / n) * 0.1;
      }
    }

    const day = this.world.day();
    if (day !== this.lastDay) {
      this.lastDay = day;
      for (const p of this.players.values()) p.pauseBudget = Math.min(PAUSE_MAX, p.pauseBudget + PAUSE_REFILL);
    }

    if (now - this.lastBroadcast >= BROADCAST_MS) {
      this.lastBroadcast = now;
      const d = this.world.takeDelta();
      if (!deltaIsEmpty(d) || timeChanged || !time.paused) this.broadcast({ t: 'delta', d, time });
    }
    if (timeChanged || now - this.lastPlayers >= PLAYERS_MS) {
      this.lastPlayers = now;
      this.broadcastPlayers();
    }
    for (const p of this.players.values()) {
      p.cmdTokens = Math.min(CMD_RATE, p.cmdTokens + (dtMs / 1000) * CMD_RATE);
      p.chatTokens = Math.min(CHAT_BURST, p.chatTokens + (dtMs / 1000) * CHAT_RATE);
    }
    // An empty server sits paused: nothing to save, restore or back up until someone comes back.
    const idle = this.connected().length === 0 && this.world.tick === this.savedTick && !this.journal.length;
    if (now - this.lastSave >= AUTOSAVE_MS) {
      if (idle) this.lastSave = now;
      else this.save();
    } else if (!this.halted && now - this.lastCheckpoint >= CHECKPOINT_MS) {
      if (this.journal.length || this.world.tick !== this.checkpoint?.tick) this.takeCheckpoint();
      else this.lastCheckpoint = now;
    }
    if (now - this.lastBackup >= BACKUP_MS) {
      this.lastBackup = now;
      if (this.world.tick !== this.backupTick) {
        this.backupTick = this.world.tick;
        this.backup('auto');
      }
    }
    if (now - this.lastStats >= STATS_MS) {
      this.lastStats = now;
      const online = this.connected().length;
      if (online) this.log(this.statsLine());
      this.bytesOut = 0;
    }
  }

  statsLine(): string {
    const mem = process.memoryUsage();
    const s = this.lastSaveStats;
    return (
      `day ${this.world.day()} · ${this.connected().length} online · ${this.world.entities.size} entities · ${this.tickMs.toFixed(2)} ms/tick · ` +
      `${(this.bytesOut / 1024 / (STATS_MS / 1000)).toFixed(1)} KB/s out · rss ${(mem.rss / 1048576).toFixed(0)} MB heap ${(mem.heapUsed / 1048576).toFixed(0)} MB · ` +
      `save ${(s.bytes / 1024).toFixed(0)} KB in ${s.ms.toFixed(0)} ms · ${process.getActiveResourcesInfo().length} handles`
    );
  }

  private simCrashed(e: unknown): void {
    const err = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const badTick = this.world.tick;
    this.log(`SIM CRASH at tick ${badTick} (day ${this.world.day()}): ${err}`);
    this.writeCrashReport(err, badTick);
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => t > now - CRASH_WINDOW_MS), now];
    const cp = this.checkpoint;
    if (!cp) {
      // No restore point is a server bug of its own; nothing to roll back to, so stop the world.
      this.halted = 'The server hit a bug and stopped the game. The host needs to restart it.';
      this.system(this.halted);
      return;
    }
    try {
      this.world = deserializeWorld(cp.save);
    } catch (e2) {
      this.halted = 'The server hit a bug and could not roll back. The host needs to restart it.';
      this.log(`Rollback failed: ${e2 instanceof Error ? e2.stack : e2}`);
      this.system(this.halted);
      return;
    }
    this.journal = [];
    this.journalComplete = true;
    this.acc = 0;
    this.lastDay = this.world.day();
    // Colonies founded since the restore point are gone again: their players choose a site anew.
    for (const p of this.players.values()) if (p.faction && !this.world.factions.has(p.faction)) p.faction = 0;
    const lost = Math.max(0, Math.round((badTick - cp.tick) / TICKS_PER_SECOND));
    if (this.crashes.length >= CRASH_LIMIT) {
      this.halted = `The server hit the same kind of bug ${this.crashes.length} times and stopped the game to keep the world safe. The host can try /resume or restart the server.`;
      this.log(`Halted after ${this.crashes.length} sim crashes in ${CRASH_WINDOW_MS / 60000} minutes. Crash reports are in ${crashDir(this.opts.savePath)}`);
      this.save();
    }
    this.system(`The server hit a bug and went back ${lost} game-seconds. The host has a crash report.${this.halted ? ' ' + this.halted : ''}`);
    this.resync();
  }

  private writeCrashReport(error: string, tick: number): void {
    try {
      const dir = crashDir(this.opts.savePath);
      mkdirSync(dir, { recursive: true });
      const name = `crash-${stamp()}-t${tick}`;
      if (this.checkpoint) {
        const report: CrashReport = {
          error,
          at: new Date().toISOString(),
          tick,
          checkpoint: this.checkpoint.save,
          journal: this.journal,
          journalComplete: this.journalComplete,
        };
        writeFileSync(join(dir, `${name}.bin`), packGz(report));
      }
      writeFileSync(
        join(dir, `${name}.txt`),
        `FrozenEarth sim crash at tick ${tick}, ${new Date().toISOString()}\n` +
          `Checkpoint tick: ${this.checkpoint?.tick ?? 'none'}, journal ${this.journal.length} ops${this.journalComplete ? '' : ' (incomplete)'}\n` +
          `Reproduce: npm run replay -- "${join(dir, `${name}.bin`)}"\n\n${error}\n`,
      );
      this.log(`Crash report written to ${join(dir, name)}.txt`);
    } catch (e) {
      this.log(`Could not write a crash report: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** After a rollback or restore: everyone gets the world afresh, on the socket they have. */
  private resync(): void {
    const snap = snapshot(this.world);
    const sites = suggestSites(this.world);
    for (const p of this.players.values()) {
      if (!p.ws) continue;
      this.send(p.ws, { t: 'welcome', playerId: p.id, faction: p.faction, token: p.token, snap, sites: p.faction ? undefined : sites });
    }
    this.broadcastPlayers();
  }

  private connected(): Player[] {
    return [...this.players.values()].filter((p) => p.ws);
  }

  /** Drain pause budgets of players currently holding the game paused. */
  private updatePause(dtMs: number): void {
    const online = this.connected();
    if (online.length <= 1) return;
    for (const p of online) {
      if (p.speed !== 0) continue;
      p.pauseBudget = Math.max(0, p.pauseBudget - dtMs / 1000);
      if (p.pauseBudget <= 0) {
        p.speed = p.resumeSpeed || 1;
        this.system(`${p.name} ran out of pause time. Resuming.`);
      }
    }
  }

  computeTime(): TimeState {
    if (this.halted) return { speed: 0, paused: true, reason: 'Stopped by a server error' };
    const online = this.connected();
    if (online.length === 0) return { speed: 0, paused: true, reason: 'No players online' };
    const pausers = online.filter((p) => p.speed === 0);
    if (pausers.length > 0) return { speed: 0, paused: true, reason: `Paused by ${pausers.map((p) => p.name).join(', ')}` };
    // A tab left in the background doesn't hold everyone at its speed (pauses still count: they are deliberate and budgeted).
    const voters = online.some((p) => !p.away) ? online.filter((p) => !p.away) : online;
    const speed = Math.min(...voters.map((p) => p.speed));
    const slowest = voters.filter((p) => p.speed === speed).map((p) => p.name);
    return { speed, paused: false, reason: online.length > 1 && speed < MAX_SPEED ? `Speed ${speed} set by ${slowest.join(', ')}` : '' };
  }

  // ---------------------------------------------------------------- connections

  onConnect(ws: WebSocket, ip = 'local'): void {
    let player: Player | null = null;
    this.pending.add(ws);
    const helloTimer = setTimeout(() => {
      if (!player) ws.close();
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    let windowStart = Date.now();
    let inWindow = 0;
    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > HARD_MSG_LIMIT) {
        this.log(`Dropped a connection from ${player?.name ?? 'a new client'} for flooding`);
        ws.terminate();
        return;
      }
      if (!isBinary) return;
      let msg: ClientMsg;
      try {
        msg = decode<ClientMsg>(raw as Buffer);
      } catch {
        return;
      }
      // Anything can come off the wire: nil, a number, an array, fields of the wrong type.
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      // One bad message must never bring the server down for everyone else.
      try {
        if (!player) {
          if (msg.t !== 'hello') return;
          player = this.handleHello(ws, msg, ip);
          if (player) {
            this.pending.delete(ws);
            clearTimeout(helloTimer);
          }
          return;
        }
        this.handle(player, msg);
      } catch (e) {
        this.log(`Dropped a bad ${msg.t} message from ${player?.name ?? 'a new connection'}: ${e instanceof Error ? e.message : e}`);
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.pending.delete(ws);
      if (player && player.ws === ws) {
        player.ws = null;
        this.releaseControl(player.faction);
        this.system(`${player.name} left.`);
        this.broadcastPlayers();
        if (this.connected().length === 0) this.save();
      }
    });
  }

  private handleHello(ws: WebSocket, msg: Extract<ClientMsg, { t: 'hello' }>, ip: string): Player | null {
    const fail = (text: string) => {
      this.send(ws, { t: 'error', msg: text, fatal: true });
      ws.close();
      return null;
    };
    if (msg.v !== PROTOCOL_VERSION) return fail('Client and server versions differ. Refresh the page.');
    let p = typeof msg.token === 'string' && msg.token ? [...this.players.values()].find((x) => sameSecret(msg.token, x.token)) : undefined;
    if (p?.banned) return fail('You are banned from this server.');
    if (!p) {
      if (this.host.passwordHash) {
        if (this.auth.blocked(ip)) return fail('Too many wrong passwords. Try again in a few minutes.');
        if (!checkPassword(msg.password, this.host.passwordHash)) {
          this.auth.fail(ip);
          this.log(`Wrong password from ${ip}`);
          return fail('Wrong server password.');
        }
      }
      const name = (typeof msg.name === 'string' ? msg.name : '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 20);
      if (!name) return fail('Pick a name.');
      const existing = [...this.players.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (existing && existing.releasedUntil && existing.releasedUntil > Date.now() && !existing.banned) {
        // The host freed this name for its owner on a new browser: hand the colony over.
        p = existing;
        p.releasedUntil = undefined;
        p.token = randomUUID();
        this.log(`${p.name} took their colony back from a new browser`);
      } else {
        if (existing) return fail('That name is taken on this server.');
        if (this.players.size >= (this.opts.maxPlayers ?? MAX_PLAYERS)) return fail('This server is full.');
        // New players pick where to settle before their colony exists.
        p = {
          ...this.livePlayer({ id: this.nextPlayerId++, name, token: randomUUID(), faction: 0, pauseBudget: PAUSE_MAX, admin: this.players.size === 0 }),
        };
        this.players.set(p.id, p);
        this.log(`New player ${name}`);
      }
    }
    if (p.ws) {
      this.send(p.ws, { t: 'error', msg: 'You connected from somewhere else.', fatal: true });
      p.ws.close();
    }
    p.ws = ws;
    p.ip = ip;
    p.speed = 1;
    p.away = false;
    this.send(ws, {
      t: 'welcome',
      playerId: p.id,
      faction: p.faction,
      token: p.token,
      snap: snapshot(this.world),
      sites: p.faction ? undefined : suggestSites(this.world),
    });
    this.system(`${p.name} joined.`);
    if (this.halted && p.admin) this.tell(p, `${this.halted} Crash reports are in ${crashDir(this.opts.savePath)}.`);
    this.broadcastPlayers();
    return p;
  }

  private handle(p: Player, msg: ClientMsg): void {
    // Everything but pings draws on the same allowance as commands: chat and speed changes are
    // broadcast to every player, so an unthrottled client could flood them all.
    if (msg.t !== 'ping') {
      if (p.cmdTokens < 1) return;
      p.cmdTokens--;
    }
    switch (msg.t) {
      case 'settle': {
        if (p.faction || this.halted) return;
        let at: { x: number; y: number } | undefined;
        if (msg.x !== undefined && msg.y !== undefined) {
          if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
          at = { x: Math.round(msg.x), y: Math.round(msg.y) };
          const problem = siteProblem(this.world, at.x, at.y);
          if (problem) {
            this.send(p.ws!, { t: 'error', msg: problem, fatal: false });
            return;
          }
        }
        const name = `${p.name}'s colony`;
        this.record(['f', name, at]);
        const faction = addPlayerFaction(this.world, name, 3, at);
        p.faction = faction.id;
        this.log(`${p.name} settled at ${faction.home.x},${faction.home.y} (faction ${faction.id})`);
        this.send(p.ws!, { t: 'settled', faction: faction.id });
        this.broadcastPlayers();
        // A new colony is worth keeping even if the server dies before the next autosave.
        this.save();
        return;
      }
      case 'cmd':
        if (!msg.cmd || typeof (msg.cmd as Command).c !== 'string' || this.halted) return;
        this.enqueue(p.faction, msg.cmd);
        return;
      case 'speed': {
        const s = Math.max(0, Math.min(MAX_SPEED, Math.round(typeof msg.speed === 'number' ? msg.speed : 0) || 0));
        if (s === 0 && this.connected().length > 1 && p.pauseBudget <= 0) {
          this.send(p.ws!, { t: 'error', msg: 'You have no pause time left today.', fatal: false });
          return;
        }
        if (s !== 0) p.resumeSpeed = s;
        p.speed = s;
        this.broadcastPlayers();
        return;
      }
      case 'away': {
        const away = msg.away === true;
        if (away === !!p.away) return;
        p.away = away;
        this.broadcastPlayers();
        return;
      }
      case 'chat': {
        const text = (typeof msg.text === 'string' ? msg.text : '').slice(0, 300).trim();
        if (!text) return;
        // Slash commands are never broadcast: they can carry a password or the host key.
        if (text.startsWith('/')) {
          for (const line of this.command(text.slice(1), p)) this.tell(p, line);
          return;
        }
        if (p.chatTokens < 1) return;
        p.chatTokens--;
        const color = this.world.factions.get(p.faction)?.color ?? 0xffffff;
        this.broadcast({ t: 'chat', from: p.name, color, text, at: Date.now() });
        return;
      }
      case 'ping':
        this.send(p.ws!, { t: 'pong', at: typeof msg.at === 'number' ? msg.at : 0 });
        return;
      case 'admin':
        if (!p.admin) return;
        if (msg.action === 'save') {
          this.save();
          this.system('World saved.');
        } else if (msg.action === 'event' && typeof msg.key === 'string' && msg.key) {
          if (this.halted) return;
          const key = String(msg.key);
          this.record(['e', key, p.faction]);
          const ok = fireEvent(this.world, key, p.faction);
          if (ok) this.system(`The host triggered an event: ${EVENTS[key]?.label ?? key}.`);
          else this.send(p.ws!, { t: 'error', msg: 'That event had nothing to act on right now.', fatal: false });
        } else if (msg.action === 'kick' && typeof msg.target === 'number') {
          const target = this.players.get(msg.target);
          if (target && target !== p) this.kick(target, `You were kicked by ${p.name}.`);
        }
        return;
    }
  }

  // ---------------------------------------------------------------- host commands

  private findPlayer(name: string): Player | undefined {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    const all = [...this.players.values()];
    return all.find((p) => p.name.toLowerCase() === n) ?? (all.filter((p) => p.name.toLowerCase().startsWith(n)).length === 1 ? all.find((p) => p.name.toLowerCase().startsWith(n)) : undefined);
  }

  private kick(target: Player, why: string): void {
    if (!target.ws) return;
    this.send(target.ws, { t: 'error', msg: why, fatal: true });
    target.ws.close();
  }

  /**
   * A host command, from the server console (by = null) or an in-game chat line starting with "/".
   * Returns the reply lines. Only /help, /who and /claim work for players who aren't hosts.
   */
  command(line: string, by: Player | null): string[] {
    const [verb = '', ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    const cmd = verb.toLowerCase();
    const isAdmin = by === null || by.admin;
    const ip = by?.ip ?? 'console';
    const who = by ? by.name : 'The server console';
    const HELP = [
      'who: players and who is online',
      'claim <host key>: become a host (the key is in host-key.txt next to the world)',
      ...(isAdmin
        ? [
            'save | backup: save now | copy the world into backups/',
            'backups: list backups | restore <name>: load a backup (players are kept)',
            'kick <name> | ban <name> | unban <name>',
            'op <name> | deop <name>: give or take host rights',
            'password <new> | password off: change the join password',
            'release <name>: let a player rejoin their colony from a new browser for 15 minutes',
            'say <text> | resume (after a server error)',
          ]
        : []),
    ];
    switch (cmd) {
      case '':
      case 'help':
      case '?':
        return HELP;
      case 'who':
      case 'players':
        return [...this.players.values()].map((p) => {
          const f = this.world.factions.get(p.faction);
          const pawns = f ? [...this.world.kinds.pawn].filter((id) => this.world.get<Pawn>(id)!.faction === p.faction).length : 0;
          const bits = [p.ws ? `online${p.away ? ' (away)' : ''}, ${p.ping} ms` : 'offline', p.faction ? `${pawns} colonists` : 'not settled'];
          if (p.admin) bits.push('host');
          if (p.banned) bits.push('banned');
          // Addresses are for the console only, never sent to other players.
          if (by === null && p.ws && p.ip) bits.push(p.ip);
          return `${p.name}: ${bits.join(', ')}`;
        });
      case 'claim': {
        if (!by) return ['The console is already the host.'];
        if (by.admin) return ['You are already a host.'];
        if (!this.hostKey) return ['Host keys are disabled on this server.'];
        if (this.auth.blocked(ip)) return ['Too many wrong keys. Try again in a few minutes.'];
        if (!sameSecret(arg, this.hostKey)) {
          this.auth.fail(ip);
          this.log(`Wrong host key from ${by.name} (${ip})`);
          return ['That is not the host key.'];
        }
        by.admin = true;
        this.log(`${by.name} claimed host rights with the host key`);
        this.system(`${by.name} is now a host.`);
        this.broadcastPlayers();
        this.save();
        return ['You are now a host. Type /help for host commands.'];
      }
    }
    if (!isAdmin) return [`Unknown command "/${cmd}". Type /help.`];
    const target = () => this.findPlayer(arg);
    switch (cmd) {
      case 'save':
        return [this.save() ? `Saved (${(this.lastSaveStats.bytes / 1024).toFixed(0)} KB).` : 'Save FAILED, see the server log.'];
      case 'backup': {
        this.save();
        const name = this.backup('manual');
        return [name ? `Backed up as ${name}` : 'Backup FAILED, see the server log.'];
      }
      case 'backups': {
        const list = listBackups(this.opts.savePath).slice(0, 15);
        return list.length ? list.map((b) => `${b.name} (${(b.bytes / 1024).toFixed(0)} KB)`) : ['No backups yet.'];
      }
      case 'restore': {
        if (!arg) return ['restore <backup name>: see /backups'];
        const b = findBackup(this.opts.savePath, arg);
        if (!b) return [`No backup matching "${arg}".`];
        try {
          this.restore(b.path);
        } catch (e) {
          return [`Could not restore ${b.name}: ${e instanceof Error ? e.message : e}`];
        }
        this.system(`${who} restored the world from the backup ${b.name}.`);
        return [`Restored ${b.name}. The world before it is in backups/ as a "prerestore" backup.`];
      }
      case 'kick':
      case 'ban':
      case 'unban':
      case 'op':
      case 'deop':
      case 'release': {
        const t = target();
        if (!t) return [`No player called "${arg}". Try /who.`];
        if (cmd === 'kick') {
          if (t === by) return ['You cannot kick yourself.'];
          if (!t.ws) return [`${t.name} is not online.`];
          this.kick(t, `You were kicked by ${by?.name ?? 'the host'}.`);
          return [`Kicked ${t.name}.`];
        }
        if (cmd === 'ban') {
          if (t === by) return ['You cannot ban yourself.'];
          t.banned = true;
          t.admin = false;
          this.kick(t, 'You are banned from this server.');
          this.save();
          this.log(`${who} banned ${t.name}`);
          return [`Banned ${t.name}. Their colony stays in the world. If they could join under a new name, change the password too.`];
        }
        if (cmd === 'unban') {
          t.banned = false;
          this.save();
          return [`Unbanned ${t.name}.`];
        }
        if (cmd === 'op' || cmd === 'deop') {
          if (t.banned) return [`${t.name} is banned.`];
          t.admin = cmd === 'op';
          this.broadcastPlayers();
          this.save();
          this.log(`${who} ${cmd === 'op' ? 'made' : 'removed'} ${t.name} ${cmd === 'op' ? 'a host' : 'as a host'}`);
          return [`${t.name} ${t.admin ? 'is now a host' : 'is no longer a host'}.`];
        }
        t.releasedUntil = Date.now() + RELEASE_MS;
        return [`For the next 15 minutes, joining as "${t.name}" (with the server password) takes over their colony. Their old browser stops working once they do.`];
      }
      case 'password': {
        if (!arg) return [this.host.passwordHash ? 'The server has a password. password <new> changes it, password off removes it.' : 'The server is open. password <new> sets one.'];
        if (arg === 'off') {
          this.host.passwordHash = undefined;
          this.save();
          this.log(`${who} removed the join password`);
          return ['Password removed: anyone who can reach the server can join.'];
        }
        if (arg.length < 4 || arg.length > 200) return ['Use 4 to 200 characters.'];
        this.host.passwordHash = hashPassword(arg);
        this.save();
        this.log(`${who} changed the join password`);
        return ['Password changed. Players already in keep their colonies; new players need the new password.'];
      }
      case 'say':
        if (!arg) return ['say <text>'];
        this.broadcast({ t: 'chat', from: '', color: 0xe0c060, text: `[host] ${arg.slice(0, 300)}`, at: Date.now() });
        return [];
      case 'resume':
        if (!this.halted) return ['The game is not stopped.'];
        this.halted = null;
        this.crashes = [];
        this.takeCheckpoint();
        this.system(`${who} restarted the game after the server error.`);
        return ['Resumed.'];
    }
    return [`Unknown command "${cmd}". Type help.`];
  }

  /** Replace the running world with a saved one. Players and their tokens are kept; their colonies follow the file. */
  restore(file: string): void {
    const data = loadWorldFile(file);
    if (!data) throw new Error('file not found');
    const world = deserializeWorld(data.save);
    this.save();
    this.backup('prerestore');
    this.world = world;
    const was = new Map(data.players.map((p) => [p.id, p]));
    for (const p of this.players.values()) {
      const then = was.get(p.id);
      p.faction = then && world.factions.has(then.faction) ? then.faction : 0;
    }
    this.halted = null;
    this.crashes = [];
    this.acc = 0;
    this.lastDay = world.day();
    for (const f of world.factions.values()) if (f.isPlayer) this.releaseControl(f.id);
    this.save();
    this.resync();
  }

  // ---------------------------------------------------------------- output

  private send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(encode(msg));
  }

  /** A private system line in one player's chat. */
  private tell(p: Player, text: string): void {
    if (p.ws) this.send(p.ws, { t: 'chat', from: '', color: 0x9ad0ff, text, at: Date.now() });
  }

  broadcast(msg: ServerMsg): void {
    const bytes = encode(msg);
    for (const p of this.players.values()) {
      const ws = p.ws;
      if (!ws || ws.readyState !== ws.OPEN) continue;
      // A client this far behind would miss deltas; drop it so it reconnects with a fresh snapshot.
      if (ws.bufferedAmount > MAX_BUFFERED) {
        ws.terminate();
        continue;
      }
      ws.send(bytes);
      this.bytesOut += bytes.length;
    }
  }

  private system(text: string): void {
    this.broadcast({ t: 'chat', from: '', color: 0x9aa4b0, text, at: Date.now() });
  }

  playerInfo(): PlayerInfo[] {
    return [...this.players.values()]
      .filter((p) => !p.banned)
      .map((p) => ({
        id: p.id,
        name: p.name,
        faction: p.faction,
        color: this.world.factions.get(p.faction)?.color ?? 0x8a96a6,
        connected: !!p.ws,
        speed: p.speed,
        pauseBudget: Math.round(p.pauseBudget),
        ping: p.ping,
        admin: p.admin,
        away: !!p.ws && !!p.away,
      }));
  }

  private broadcastPlayers(): void {
    this.broadcast({ t: 'players', players: this.playerInfo(), time: this.computeTime() });
  }

  private worldFile(save: SaveData): WorldFile {
    return {
      save,
      players: [...this.players.values()].map(({ id, name, token, faction, pauseBudget, admin, banned }) => ({ id, name, token, faction, pauseBudget, admin, ...(banned ? { banned } : {}) })),
      nextPlayerId: this.nextPlayerId,
      host: this.host,
    };
  }

  /** Save to disk (and make it the restore point). Never throws: a full disk must not take the game down. */
  save(): boolean {
    this.lastSave = performance.now();
    try {
      const t0 = performance.now();
      const save = serializeWorld(this.world);
      const serializeMs = performance.now() - t0;
      if (!this.halted) this.takeCheckpoint(save);
      const st = saveWorldFileStats(this.opts.savePath, this.worldFile(save));
      this.lastSaveStats = { bytes: st.bytes, ms: serializeMs + st.packMs + st.writeMs, serializeMs };
      this.savedTick = this.world.tick;
      this.saveFailures = 0;
      this.log(`Saved ${(st.bytes / 1024).toFixed(0)} KB to ${this.opts.savePath} in ${this.lastSaveStats.ms.toFixed(0)} ms`);
      return true;
    } catch (e) {
      this.saveFailures++;
      this.log(`SAVE FAILED (${this.saveFailures} in a row): ${e instanceof Error ? e.stack : e}`);
      for (const p of this.players.values()) if (p.admin) this.tell(p, 'The server could not save the world (see its log). Is the disk full?');
      return false;
    }
  }

  /** Copy world.bin into backups/. */
  backup(kind: string): string | null {
    try {
      const name = backupWorld(this.opts.savePath, kind, this.opts.keepBackups ?? 48);
      if (name) this.log(`Backup ${name}`);
      return name;
    } catch (e) {
      this.log(`Backup failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
}
