import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  addPlayerFaction,
  createWorld,
  fireEvent,
  deserializeWorld,
  serializeWorld,
  snapshot,
  MAX_SPEED,
  TICKS_PER_SECOND,
  type Command,
  type World,
} from '@fe/sim';
import { EVENTS } from '@fe/defs';
import { decode, encode, PROTOCOL_VERSION, type ClientMsg, type PlayerInfo, type ServerMsg, type TimeState } from '@fe/protocol';
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

interface Player extends StoredPlayer {
  speed: number;
  /** Speed to restore when a pause ends. */
  resumeSpeed: number;
  ping: number;
  ws: WebSocket | null;
  cmdTokens: number;
}

export interface GameOptions {
  savePath: string;
  password?: string;
  seed?: number;
  size?: number;
  log?: (msg: string) => void;
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

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`[game] ${m}`));
    const file = loadWorldFile(opts.savePath);
    if (file) {
      this.world = deserializeWorld(file.save);
      for (const p of file.players) this.players.set(p.id, { ...p, speed: 1, resumeSpeed: 1, ping: 0, ws: null, cmdTokens: CMD_RATE });
      this.nextPlayerId = file.nextPlayerId;
      this.log(`Loaded world from ${opts.savePath} (day ${this.world.day()}, ${this.players.size} players)`);
    } else {
      const size = opts.size ?? 200;
      this.world = createWorld({ seed: opts.seed, width: size, height: size });
      this.log(`Generated new ${size}x${size} world, seed ${this.world.seed}`);
    }
    this.lastDay = this.world.day();
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
      const empty = !d.ents.length && !d.removed.length && !d.cells.length && !d.zones.length && !d.removedZones.length && !d.factions.length && !d.msgs.length && !d.rooms && !d.roomTemps && !d.conditions && !d.shots;
      if (!empty || timeChanged || !time.paused) this.broadcast({ t: 'delta', d, time });
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
    const speed = Math.min(...online.map((p) => p.speed));
    const slowest = online.filter((p) => p.speed === speed).map((p) => p.name);
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
      if (!player) {
        if (msg.t !== 'hello') return;
        player = this.handleHello(ws, msg);
        return;
      }
      this.handle(player, msg);
    });
    ws.on('close', () => {
      if (player && player.ws === ws) {
        player.ws = null;
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
      const name = String(msg.name ?? '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 20);
      if (!name) return fail('Pick a name.');
      if ([...this.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail('That name is taken on this server.');
      const faction = addPlayerFaction(this.world, `${name}'s colony`);
      p = {
        id: this.nextPlayerId++,
        name,
        token: randomUUID(),
        faction: faction.id,
        pauseBudget: PAUSE_MAX,
        admin: this.players.size === 0,
        speed: 1,
        resumeSpeed: 1,
        ping: 0,
        ws: null,
        cmdTokens: CMD_RATE,
      };
      this.players.set(p.id, p);
      this.log(`New player ${name} (faction ${faction.id})`);
    }
    if (p.ws) {
      this.send(p.ws, { t: 'error', msg: 'You connected from somewhere else.', fatal: true });
      p.ws.close();
    }
    p.ws = ws;
    p.speed = 1;
    this.send(ws, { t: 'welcome', playerId: p.id, faction: p.faction, token: p.token, snap: snapshot(this.world) });
    this.system(`${p.name} joined.`);
    this.broadcastPlayers();
    return p;
  }

  private handle(p: Player, msg: ClientMsg): void {
    switch (msg.t) {
      case 'cmd':
        if (p.cmdTokens < 1 || !msg.cmd || typeof (msg.cmd as Command).c !== 'string') return;
        p.cmdTokens--;
        this.world.enqueue(p.faction, msg.cmd);
        return;
      case 'speed': {
        const s = Math.max(0, Math.min(MAX_SPEED, Math.round(Number(msg.speed) || 0)));
        if (s === 0 && this.connected().length > 1 && p.pauseBudget <= 0) {
          this.send(p.ws!, { t: 'error', msg: 'You have no pause time left today.', fatal: false });
          return;
        }
        if (s !== 0) p.resumeSpeed = s;
        p.speed = s;
        this.broadcastPlayers();
        return;
      }
      case 'chat': {
        const text = String(msg.text ?? '').slice(0, 300).trim();
        if (!text) return;
        const color = this.world.factions.get(p.faction)?.color ?? 0xffffff;
        this.broadcast({ t: 'chat', from: p.name, color, text, at: Date.now() });
        return;
      }
      case 'ping':
        this.send(p.ws!, { t: 'pong', at: msg.at });
        return;
      case 'admin':
        if (!p.admin) return;
        if (msg.action === 'save') {
          this.save();
          this.system('World saved.');
        } else if (msg.action === 'event' && msg.key) {
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
      color: this.world.factions.get(p.faction)?.color ?? 0xffffff,
      connected: !!p.ws,
      speed: p.speed,
      pauseBudget: Math.round(p.pauseBudget),
      ping: p.ping,
      admin: p.admin,
    }));
  }

  private broadcastPlayers(): void {
    this.broadcast({ t: 'players', players: this.playerInfo(), time: this.computeTime() });
  }

  save(): void {
    this.lastSave = performance.now();
    const bytes = saveWorldFile(this.opts.savePath, {
      save: serializeWorld(this.world),
      players: [...this.players.values()].map(({ id, name, token, faction, pauseBudget, admin }) => ({ id, name, token, faction, pauseBudget, admin })),
      nextPlayerId: this.nextPlayerId,
    });
    this.log(`Saved ${(bytes / 1024).toFixed(0)} KB to ${this.opts.savePath}`);
  }
}
