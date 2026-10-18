import { randomUUID } from 'node:crypto';
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
  type GameMessage,
  type Pawn,
  type World,
} from '@fe/sim';
import { EVENTS } from '@fe/defs';
import { decode, encode, PROTOCOL_VERSION, type ChatMsg, type ClientMsg, type PlayerInfo, type ServerMsg, type TimeState } from '@fe/protocol';
import { loadWorldFile, saveWorldFile, type StoredPlayer } from './persistence';

/** Real seconds of pause each player gets per in-game day, and the most they can bank. */
export const PAUSE_REFILL = 60;
export const PAUSE_MAX = 120;
const BROADCAST_MS = 66;
const PLAYERS_MS = 1000;
/** Saves are cheap (tens of ms) and a hard kill skips shutdown hooks, so save often. */
const AUTOSAVE_MS = 60_000;
/** Most ticks run in one loop iteration, so a stall never snowballs. */
const MAX_TICKS_PER_LOOP = 60;
const MAX_BUFFERED = 16 * 1024 * 1024;
const CMD_RATE = 40;
const STATS_MS = 30_000;
/** Distinct players a world will register (each new name gets a colony that is kept forever). */
const MAX_PLAYERS = 64;
/** Letters and chat lines kept to replay to players who join or come back. */
const KEEP_LETTERS = 400;
const KEEP_CHAT = 40;
/** How many of them a joining player is sent. */
const SEND_LETTERS = 100;

interface Player extends StoredPlayer {
  speed: number;
  /** Speed to restore when a pause ends. */
  resumeSpeed: number;
  ping: number;
  ws: WebSocket | null;
  cmdTokens: number;
  /** Their tab is in the background. */
  away?: boolean;
}

export interface GameOptions {
  savePath: string;
  password?: string;
  seed?: number;
  size?: number;
  /** New worlds only: days before the frost line moves, and its speed multiplier. */
  frostStart?: number;
  frostPace?: number;
  /** Most distinct players this world registers. Default MAX_PLAYERS. */
  maxPlayers?: number;
  log?: (msg: string) => void;
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

export class GameServer {
  world: World;
  players = new Map<number, Player>();
  nextPlayerId = 1;
  private opts: GameOptions;
  private acc = 0;
  private lastLoop = performance.now();
  private lastBroadcast = 0;
  private lastPlayers = 0;
  private lastSave = performance.now();
  private lastStats = performance.now();
  private bytesOut = 0;
  private lastDay: number;
  private timer: NodeJS.Timeout | null = null;
  private time: TimeState = { speed: 0, paused: true, reason: 'No players online' };
  private log: (msg: string) => void;
  /** Rolling tick cost, for monitoring. */
  tickMs = 0;
  /** Recent letters (every faction's) and chat, so a player who was away can catch up. */
  private letters: GameMessage[] = [];
  private chatLog: ChatMsg[] = [];

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`[game] ${m}`));
    const file = loadWorldFile(opts.savePath);
    if (file) {
      this.world = deserializeWorld(file.save);
      for (const p of file.players) this.players.set(p.id, { ...p, speed: 1, resumeSpeed: 1, ping: 0, ws: null, cmdTokens: CMD_RATE });
      this.nextPlayerId = file.nextPlayerId;
      this.letters = file.letters ?? [];
      this.chatLog = file.chat ?? [];
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
      // On disk straight away, so a crash or dev-server restart doesn't roll a different world.
      this.save();
    }
    this.lastDay = this.world.day();
    this.refreshOnline();
    // Nobody is online after a restart, so nobody is steering anyone.
    for (const f of this.world.factions.values()) if (f.isPlayer) this.releaseControl(f.id);
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
      this.world.enqueue(faction, { c: 'possess', pawn: p.id, on: false });
      this.world.enqueue(faction, { c: 'draft', pawns: [p.id], on: false });
    }
  }

  /** Tell the sim whose players are here, so offers from friends wait for an absent recipient. */
  private refreshOnline(): void {
    this.world.online = new Set(this.connected().map((p) => p.faction).filter((f) => f > 0));
  }

  /** Keep a delta's letters for players who join later. */
  private remember(msgs: GameMessage[]): void {
    if (!msgs.length) return;
    this.letters.push(...msgs);
    if (this.letters.length > KEEP_LETTERS) this.letters.splice(0, this.letters.length - KEEP_LETTERS);
  }

  start(): void {
    this.lastLoop = performance.now();
    this.timer = setInterval(() => this.loop(), 5);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------- loop

  private loop(): void {
    const now = performance.now();
    const dtMs = Math.min(250, now - this.lastLoop);
    this.lastLoop = now;
    this.updatePause(dtMs);
    const time = this.computeTime();
    const timeChanged = time.speed !== this.time.speed || time.reason !== this.time.reason;
    this.time = time;

    if (time.paused) {
      this.acc = 0;
      this.world.applyCommands();
    } else {
      this.acc += (dtMs / 1000) * TICKS_PER_SECOND * time.speed;
      const n = Math.min(MAX_TICKS_PER_LOOP, Math.floor(this.acc));
      this.acc -= n;
      if (n > 0) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) this.world.step();
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
      this.remember(d.msgs);
      if (!deltaIsEmpty(d) || timeChanged || !time.paused) this.broadcast({ t: 'delta', d, time });
    }
    if (timeChanged || now - this.lastPlayers >= PLAYERS_MS) {
      this.lastPlayers = now;
      this.broadcastPlayers();
    }
    for (const p of this.players.values()) p.cmdTokens = Math.min(CMD_RATE, p.cmdTokens + (dtMs / 1000) * CMD_RATE);
    if (now - this.lastSave >= AUTOSAVE_MS) this.save();
    if (now - this.lastStats >= STATS_MS) {
      this.lastStats = now;
      const online = this.connected().length;
      if (online) {
        this.log(
          `day ${this.world.day()} · ${online} online · ${this.world.entities.size} entities · ${this.tickMs.toFixed(2)} ms/tick · ${(this.bytesOut / 1024 / (STATS_MS / 1000)).toFixed(1)} KB/s out`,
        );
      }
      this.bytesOut = 0;
    }
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

  onConnect(ws: WebSocket): void {
    let player: Player | null = null;
    ws.on('message', (raw, isBinary) => {
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
          player = this.handleHello(ws, msg);
          return;
        }
        this.handle(player, msg);
      } catch (e) {
        this.log(`Dropped a bad ${msg.t} message from ${player?.name ?? 'a new connection'}: ${e instanceof Error ? e.message : e}`);
      }
    });
    ws.on('close', () => {
      if (player && player.ws === ws) {
        player.ws = null;
        player.lastSeen = this.world.tick;
        this.refreshOnline();
        this.releaseControl(player.faction);
        this.system(`${player.name} left.`);
        this.broadcastPlayers();
        if (this.connected().length === 0) this.save();
      }
    });
  }

  private handleHello(ws: WebSocket, msg: Extract<ClientMsg, { t: 'hello' }>): Player | null {
    const fail = (text: string) => {
      this.send(ws, { t: 'error', msg: text, fatal: true });
      ws.close();
      return null;
    };
    if (msg.v !== PROTOCOL_VERSION) return fail('Client and server versions differ. Refresh the page.');
    let p = msg.token ? [...this.players.values()].find((x) => x.token === msg.token) : undefined;
    if (!p) {
      if (this.opts.password && msg.password !== this.opts.password) return fail('Wrong server password.');
      const name = (typeof msg.name === 'string' ? msg.name : '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 20);
      if (!name) return fail('Pick a name.');
      if (this.players.size >= (this.opts.maxPlayers ?? MAX_PLAYERS)) return fail('This server is full.');
      if ([...this.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail('That name is taken on this server. If it is yours, enter your rejoin code (in the game on your first device: ? then "Play on another device").');
      // New players pick where to settle before their colony exists.
      p = {
        id: this.nextPlayerId++,
        name,
        token: randomUUID(),
        faction: 0,
        pauseBudget: PAUSE_MAX,
        admin: this.players.size === 0,
        speed: 1,
        resumeSpeed: 1,
        ping: 0,
        ws: null,
        cmdTokens: CMD_RATE,
      };
      this.players.set(p.id, p);
      this.log(`New player ${name}`);
    }
    if (p.ws) {
      this.send(p.ws, { t: 'error', msg: 'You connected from somewhere else.', fatal: true });
      p.ws.close();
    }
    p.ws = ws;
    p.speed = 1;
    p.away = false;
    this.refreshOnline();
    const mine = p.faction;
    this.send(ws, {
      t: 'welcome',
      playerId: p.id,
      faction: p.faction,
      token: p.token,
      snap: snapshot(this.world),
      sites: p.faction ? undefined : suggestSites(this.world),
      msgs: this.letters.filter((m) => m.faction === 0 || (mine && m.faction === mine)).slice(-SEND_LETTERS),
      chat: this.chatLog,
      lastSeen: p.lastSeen,
    });
    this.system(`${p.name} joined.`);
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
        if (p.faction) return;
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
        // "Let fate decide": one of the good spots, never frozen or crowding someone (the plain fallback
        // spawn picks the outer band, which a late joiner would find already frozen).
        if (!at) {
          const sites = suggestSites(this.world, 5);
          if (sites.length) {
            const s = sites[Math.floor(Math.random() * sites.length)];
            at = { x: s.x, y: s.y };
          }
        }
        const faction = addPlayerFaction(this.world, `${p.name}'s colony`, 3, at);
        p.faction = faction.id;
        this.refreshOnline();
        this.log(`${p.name} settled at ${faction.home.x},${faction.home.y} (faction ${faction.id})`);
        this.send(p.ws!, { t: 'settled', faction: faction.id });
        this.broadcastPlayers();
        // A new colony is worth keeping even if the server dies before the next autosave.
        this.save();
        return;
      }
      case 'cmd':
        if (!msg.cmd || typeof (msg.cmd as Command).c !== 'string') return;
        this.world.enqueue(p.faction, msg.cmd);
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
        const color = this.world.factions.get(p.faction)?.color ?? 0xffffff;
        const line: ChatMsg = { from: p.name, color, text, at: Date.now() };
        this.chatLog.push(line);
        if (this.chatLog.length > KEEP_CHAT) this.chatLog.shift();
        this.broadcast({ t: 'chat', ...line });
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
          const ok = fireEvent(this.world, String(msg.key), p.faction);
          if (ok) this.system(`The host triggered an event: ${EVENTS[String(msg.key)]?.label ?? msg.key}.`);
          else this.send(p.ws!, { t: 'error', msg: 'That event had nothing to act on right now.', fatal: false });
        } else if (msg.action === 'kick' && msg.target) {
          const target = this.players.get(msg.target);
          if (target?.ws && target !== p) {
            this.send(target.ws, { t: 'error', msg: 'You were kicked by the host.', fatal: true });
            target.ws.close();
          }
        }
        return;
    }
  }

  // ---------------------------------------------------------------- output

  private send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(encode(msg));
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
    return [...this.players.values()].map((p) => ({
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

  save(): void {
    this.lastSave = performance.now();
    const bytes = saveWorldFile(this.opts.savePath, {
      save: serializeWorld(this.world),
      players: [...this.players.values()].map(({ id, name, token, faction, pauseBudget, admin, lastSeen }) => ({ id, name, token, faction, pauseBudget, admin, lastSeen })),
      nextPlayerId: this.nextPlayerId,
      letters: this.letters,
      chat: this.chatLog,
    });
    this.log(`Saved ${(bytes / 1024).toFixed(0)} KB to ${this.opts.savePath}`);
  }
}
