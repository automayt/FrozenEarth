import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { addPlayerFaction, createWorld, hashWorld, serializeWorld, type Pawn, type SaveData } from '@fe/sim';
import { decode, encode, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@fe/protocol';
import { GameServer, type JournalOp } from '../src/game';
import { backupWorld, listBackups, loadWorldWithRecovery, restoreBackup, saveWorldFile, worldPath } from '../src/persistence';
import { readCrashReport, replayJournal } from '../src/replay';
import { staticHandler } from '../src/static';

const dir = mkdtempSync(join(tmpdir(), 'fe-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { log: () => {} };

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  inbox: ServerMsg[] = [];
  send(bytes: Uint8Array): void {
    this.inbox.push(decode<ServerMsg>(bytes));
  }
  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
  }
  terminate(): void {
    this.close();
  }
  say(msg: ClientMsg): void {
    this.emit('message', Buffer.from(encode(msg)), true);
  }
  take<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }>[] {
    const got = this.inbox.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[];
    this.inbox = this.inbox.filter((m) => m.t !== t);
    return got;
  }
  chat(): string[] {
    return this.take('chat').map((m) => m.text);
  }
}

function join_(g: GameServer, name: string, extra: Partial<Extract<ClientMsg, { t: 'hello' }>> = {}, ip = '10.0.0.9'): FakeSocket {
  const ws = new FakeSocket();
  g.onConnect(ws as unknown as WebSocket, ip);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name, ...extra });
  return ws;
}

type Inner = { loop(): void; lastBroadcast: number; checkpoint: { save: SaveData; tick: number } | null; journal: JournalOp[]; acc: number };

describe('save files', () => {
  it('keeps the previous save as world.bak and falls back to it when world.bin is corrupt', () => {
    const path = worldPath(dir, 'corrupt');
    const a = new GameServer({ savePath: path, seed: 3, size: 70, ...quiet });
    a.stepTicks(200);
    a.save();
    const good = a.world.tick;
    a.stepTicks(200);
    a.save();
    expect(existsSync(path.replace(/\.bin$/, '.bak'))).toBe(true);
    // Half-written, then garbage.
    writeFileSync(path, readFileSync(path).subarray(0, 100));
    const b = new GameServer({ savePath: path, ...quiet });
    expect(b.world.tick).toBe(good);
    expect(readdirSync(dirname(path)).some((f) => f.startsWith('world.bin.corrupt-'))).toBe(true);
    // world.bin is whole again, so the next start loads it directly.
    const loaded = loadWorldWithRecovery(path, () => {});
    expect(loaded?.from).toBe(path);
  });

  it('a crash between flushing the new save and renaming it loses nothing', () => {
    const path = worldPath(dir, 'midsave');
    const a = new GameServer({ savePath: path, seed: 4, size: 70, ...quiet });
    a.stepTicks(100);
    a.save();
    const want = hashWorld(a.world);
    // The rotation had moved world.bin to world.bak and died before the temp file moved in.
    const bytes = readFileSync(path);
    rmSync(path);
    writeFileSync(path + '.tmp', bytes);
    const b = new GameServer({ savePath: path, ...quiet });
    expect(hashWorld(b.world)).toBe(want);
    expect(existsSync(path + '.tmp')).toBe(false);
  });

  it('refuses a world from a newer server instead of falling back to an old backup', () => {
    const path = worldPath(dir, 'newer');
    const w = createWorld({ seed: 1, width: 60, height: 60 });
    saveWorldFile(path, { save: serializeWorld(w), players: [], nextPlayerId: 1 });
    backupWorld(path, 'manual');
    saveWorldFile(path, { save: { ...serializeWorld(w), version: 999 }, players: [], nextPlayerId: 1 });
    expect(() => new GameServer({ savePath: path, ...quiet })).toThrow(/newer than this server/);
    expect(existsSync(path)).toBe(true);
  });

  it('loads worlds whose colonists predate skills', () => {
    const w = createWorld({ seed: 12, width: 70, height: 70 });
    addPlayerFaction(w, 'Old');
    const save = serializeWorld(w);
    for (const e of save.ents) if (e.kind === 'pawn') delete (e as Partial<Pawn>).skills;
    const path = worldPath(dir, 'preskills');
    saveWorldFile(path, { save, players: [], nextPlayerId: 1 });
    const g = new GameServer({ savePath: path, ...quiet });
    expect([...g.world.kinds.pawn].every((id) => g.world.get<Pawn>(id)!.skills.stealth)).toBe(true);
  });

  it('stops on an intact world it cannot load instead of hiding the bug behind an older backup', () => {
    const path = worldPath(dir, 'loadbug');
    const a = new GameServer({ savePath: path, seed: 13, size: 60, ...quiet });
    a.backup('manual');
    const save = serializeWorld(a.world);
    (save as { factions: unknown }).factions = null;
    saveWorldFile(path, { save, players: [], nextPlayerId: 1 });
    expect(() => new GameServer({ savePath: path, ...quiet })).toThrow(/intact but this server cannot load it/);
  });

  it('refuses to start over a world it cannot read rather than generating a new one', () => {
    const path = worldPath(dir, 'garbage');
    new GameServer({ savePath: path, seed: 2, size: 60, ...quiet });
    for (const f of readdirSync(dirname(path))) if (f !== 'world.bin' && f !== 'host-key.txt') rmSync(join(dirname(path), f), { recursive: true });
    writeFileSync(path, 'not a world');
    expect(() => new GameServer({ savePath: path, ...quiet })).toThrow(/No loadable world/);
    expect(readFileSync(path, 'utf8')).toBe('not a world');
  });

  it('backs up on startup, prunes automatic backups, and restores one', () => {
    const path = worldPath(dir, 'backups');
    const a = new GameServer({ savePath: path, seed: 5, size: 60, keepBackups: 2, ...quiet });
    const first = a.world.tick;
    const name = a.backup('manual')!;
    a.stepTicks(300);
    a.save();
    for (let i = 0; i < 4; i++) new GameServer({ savePath: path, keepBackups: 2, ...quiet });
    const list = listBackups(path);
    expect(list.filter((b) => b.kind === 'startup')).toHaveLength(2);
    expect(list.some((b) => b.name === name)).toBe(true);
    restoreBackup(path, name);
    const b = new GameServer({ savePath: path, ...quiet });
    expect(b.world.tick).toBe(first);
    expect(listBackups(path).some((x) => x.kind === 'prerestore')).toBe(true);
  });
});

describe('players who never settle', () => {
  it('are not the host; the first to found a colony is', () => {
    const g = new GameServer({ savePath: worldPath(dir, 'firsthost'), seed: 7, size: 70, ...quiet });
    const tab = join_(g, 'Tab');
    const ann = join_(g, 'Ann');
    const bob = join_(g, 'Bob');
    const admin = (n: string) => g.playerInfo().find((p) => p.name === n)!.admin;
    expect(admin('Tab')).toBe(false);
    ann.say({ t: 'settle' });
    ann.take('settled');
    bob.say({ t: 'settle' });
    bob.take('settled');
    expect(admin('Ann')).toBe(true);
    expect(admin('Bob')).toBe(false);
    expect(admin('Tab')).toBe(false);
    tab.close();
    g.stop();
  });

  it('are forgotten a while after they leave, and on restart', () => {
    const path = worldPath(dir, 'forget');
    const g = new GameServer({ savePath: path, seed: 7, size: 70, ...quiet });
    const tab = join_(g, 'Tab');
    const ann = join_(g, 'Ann');
    ann.say({ t: 'settle' });
    ann.take('settled');
    const names = () => g.playerInfo().map((p) => p.name).sort();
    tab.close();
    (g as unknown as { forgetUnsettled(): void }).forgetUnsettled();
    expect(names()).toEqual(['Ann', 'Tab']);
    const players = (g as unknown as { players: Map<number, { name: string; offlineSince?: number }> }).players;
    for (const p of players.values()) if (p.name === 'Tab') p.offlineSince = Date.now() - 31 * 60_000;
    (g as unknown as { forgetUnsettled(): void }).forgetUnsettled();
    expect(names()).toEqual(['Ann']);
    // Another stray, then a restart: only colonies (and bans) come back.
    join_(g, 'Stray');
    g.save();
    g.stop();
    const again = new GameServer({ savePath: path, ...quiet });
    expect(again.playerInfo().map((p) => p.name)).toEqual(['Ann']);
    again.stop();
  });
});

describe('sim crashes', () => {
  it('a throw inside World.step rolls back to the restore point, writes a report, and keeps serving', () => {
    const path = worldPath(dir, 'crash');
    const g = new GameServer({ savePath: path, seed: 6, size: 80, ...quiet });
    const ann = join_(g, 'Ann');
    ann.say({ t: 'settle' });
    ann.say({ t: 'speed', speed: 3 });
    const inner = g as unknown as Inner;
    g.stepTicks(50);
    const cp = inner.checkpoint!;
    const at = g.world.tick;
    // A sim bug: the next tick throws.
    const real = g.world.step.bind(g.world);
    let armed = true;
    g.world.step = () => {
      real();
      if (armed) {
        armed = false;
        throw new Error('boom in tickPawn');
      }
    };
    inner.acc = 5;
    ann.inbox = [];
    expect(() => inner.loop()).not.toThrow();
    expect(g.world.tick).toBe(cp.tick);
    expect(g.world.tick).toBeLessThan(at + 1);
    expect(ann.take('welcome')).toHaveLength(1);
    expect(ann.chat().some((t) => /hit a bug and went back/.test(t))).toBe(true);
    const reports = readdirSync(join(dirname(path), 'crashes'));
    expect(reports.some((f) => f.endsWith('.txt'))).toBe(true);
    const report = readCrashReport(join(dirname(path), 'crashes', reports.find((f) => f.endsWith('.bin'))!));
    expect(report.error).toMatch(/boom in tickPawn/);
    // Ann's colony was founded after... no: settling saved, so it is in the restore point and survives.
    expect(g.playerInfo()[0].faction).toBeGreaterThan(0);
    // The world still runs.
    g.stepTicks(10);
    expect(g.halted).toBeNull();
  });

  it('stops the world after repeated crashes, and /resume starts it again', () => {
    const g = new GameServer({ savePath: worldPath(dir, 'crashloop'), seed: 7, size: 70, ...quiet });
    const ann = join_(g, 'Ann');
    // Founding the first colony makes Ann the host.
    ann.say({ t: 'settle' });
    ann.take('settled');
    const inner = g as unknown as Inner;
    for (let i = 0; i < 3; i++) {
      g.world.step = () => {
        throw new Error('always');
      };
      inner.acc = 5;
      inner.loop();
    }
    expect(g.halted).toMatch(/stopped the game/);
    expect(g.computeTime()).toMatchObject({ paused: true });
    ann.inbox = [];
    ann.say({ t: 'chat', text: '/resume' });
    expect(ann.chat()).toContain('Resumed.');
    expect(g.halted).toBeNull();
  });

  it('the journal replays from the restore point to exactly the same world', () => {
    const g = new GameServer({ savePath: worldPath(dir, 'journal'), seed: 8, size: 80, ...quiet });
    const ann = join_(g, 'Ann');
    const bob = join_(g, 'Bob');
    ann.say({ t: 'settle' });
    const fa = ann.take('settled')[0].faction;
    const inner = g as unknown as Inner;
    // Restore point after Ann settled; Bob settles inside the journal.
    g.save();
    bob.say({ t: 'settle' });
    const pawns = [...g.world.kinds.pawn].map((id) => g.world.get<Pawn>(id)!).filter((p) => p.faction === fa);
    for (let i = 0; i < 20; i++) {
      ann.say({ t: 'cmd', cmd: { c: 'draft', pawns: [pawns[i % pawns.length].id], on: i % 2 === 0 } });
      ann.say({ t: 'cmd', cmd: { c: 'move', pawns: [pawns[0].id], x: 10 + i, y: 12 } });
      g.stepTicks(30);
    }
    ann.say({ t: 'admin', action: 'event', key: 'raid' });
    g.stepTicks(400);
    // Orders given while paused are applied by the loop without a tick.
    for (const p of g.players.values()) (p as unknown as { cmdTokens: number }).cmdTokens = 40;
    ann.say({ t: 'speed', speed: 0 });
    expect(g.computeTime().paused).toBe(true);
    ann.say({ t: 'cmd', cmd: { c: 'draft', pawns: [pawns[2].id], on: true } });
    inner.loop();
    expect(inner.journal.filter((op) => op[0] === 'a')).toHaveLength(1);
    for (let i = 0; i < 5; i++) inner.loop();
    expect(inner.journal.filter((op) => op[0] === 'a')).toHaveLength(1);
    g.stepTicks(100);
    const out = replayJournal(inner.checkpoint!.save, inner.journal);
    expect(out.error).toBeUndefined();
    expect(hashWorld(out.world)).toBe(hashWorld(g.world));
  });
});

describe('host tools and auth', () => {
  it('stores the password hashed, counts wrong guesses, and lets token holders back in', () => {
    const path = worldPath(dir, 'pw');
    const g = new GameServer({ savePath: path, seed: 9, size: 60, password: 'hunter22', ...quiet });
    expect(gunzipSync(readFileSync(path)).includes(Buffer.from('hunter22'))).toBe(false);
    const ann = join_(g, 'Ann', { password: 'hunter22' });
    const token = ann.take('welcome')[0].token;
    for (let i = 0; i < 5; i++) expect(join_(g, `Eve${i}`, { password: 'guess' + i }, '6.6.6.6').take('error')[0].msg).toBe('Wrong server password.');
    // Shut out now, even with the right password, from that address; others are fine.
    expect(join_(g, 'Eve', { password: 'hunter22' }, '6.6.6.6').take('error')[0].msg).toMatch(/Too many/);
    expect(join_(g, 'Bob', { password: 'hunter22' }, '7.7.7.7').take('welcome')).toHaveLength(1);
    ann.close();
    expect(join_(g, 'Ann', { token }).take('welcome')).toHaveLength(1);
    // The password survives a restart without the flag.
    const h = new GameServer({ savePath: path, ...quiet });
    expect(h.passwordProtected).toBe(true);
    expect(join_(h, 'Cy', {}, '8.8.8.8').take('error')[0].msg).toBe('Wrong server password.');
  });

  it('slash commands stay private, and only hosts can use the host ones', () => {
    const g = new GameServer({ savePath: worldPath(dir, 'cmds'), seed: 10, size: 60, hostKey: 'k'.repeat(24), ...quiet });
    const ann = join_(g, 'Ann'); // first player: host
    const bob = join_(g, 'Bob');
    ann.inbox = [];
    bob.inbox = [];
    bob.say({ t: 'chat', text: '/kick Ann' });
    expect(bob.chat()[0]).toMatch(/Unknown command/);
    bob.say({ t: 'chat', text: '/claim wrong' });
    expect(bob.chat()).toEqual(['That is not the host key.']);
    expect(ann.chat()).toEqual([]);
    bob.say({ t: 'chat', text: `/claim ${'k'.repeat(24)}` });
    expect(g.playerInfo().find((p) => p.name === 'Bob')!.admin).toBe(true);
    expect(ann.chat().some((t) => t.includes('k'.repeat(24)))).toBe(false);
    // Password change from chat never reaches anyone else's screen.
    ann.inbox = [];
    bob.say({ t: 'chat', text: '/password s3cret!' });
    expect(ann.chat()).toEqual([]);
    expect(g.passwordProtected).toBe(true);
    expect(g.command('who', null).join('\n')).toMatch(/Bob: online.*host.*10\.0\.0\.9/);
    expect(g.command('who', g.players.get(2)!).join('\n')).not.toMatch(/10\.0\.0\.9/);
  });

  it('ban keeps a player out by token and by name; release lets a player move browsers', () => {
    const g = new GameServer({ savePath: worldPath(dir, 'ban'), seed: 11, size: 60, ...quiet });
    join_(g, 'Ann');
    const bob = join_(g, 'Bob');
    const bobToken = bob.take('welcome')[0].token;
    expect(g.command('ban bob', null)[0]).toMatch(/Banned Bob/);
    expect(bob.readyState).toBe(3);
    expect(join_(g, 'Bob', { token: bobToken }).take('error')[0].msg).toMatch(/banned/);
    expect(join_(g, 'bob').take('error')[0].msg).toMatch(/taken/);
    expect(g.playerInfo().some((p) => p.name === 'Bob')).toBe(false);
    g.command('unban Bob', null);
    // Bob lost his browser: the host frees his name, and the next "Bob" gets the colony and a new token.
    expect(join_(g, 'Bob').take('error')[0].msg).toMatch(/taken/);
    g.command('release Bob', null);
    const again = join_(g, 'Bob');
    const w = again.take('welcome')[0];
    expect(w.playerId).toBe(2);
    expect(w.token).not.toBe(bobToken);
    expect(join_(g, 'Bob', { token: bobToken }).take('error')[0].msg).toMatch(/taken/);
  });
});

describe('static files', () => {
  let server: Server;
  const site = mkdtempSync(join(tmpdir(), 'fe-site-'));
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>x</title>' + 'x'.repeat(5000));
  const start = (base?: string) =>
    new Promise<string>((res) => {
      server = createServer(staticHandler(site, { base }));
      server.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
  afterAll(() => rmSync(site, { recursive: true, force: true }));

  it('survives bad paths, compresses, and serves under a base path', async () => {
    const url = await start('/frozen/');
    try {
      expect((await fetch(`${url}/%E0%A4%A`)).status).toBe(400);
      expect((await fetch(`${url}/..%2f..%2fetc%2fpasswd`)).status).toBe(403);
      const page = await fetch(`${url}/frozen/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-encoding')).toBe('gzip');
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await fetch(`${url}/frozen`, { redirect: 'manual' })).status).toBe(301);
      expect((await fetch(`${url}/frozen/sprites/missing.png`)).status).toBe(404);
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
      expect((await fetch(`${url}/`, { method: 'POST' })).status).toBe(405);
    } finally {
      server.close();
    }
  });
});
