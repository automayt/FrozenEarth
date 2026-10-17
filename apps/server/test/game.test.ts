import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { fireEvent, type Delta, type Pawn } from '@fe/sim';
import { decode, encode, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@fe/protocol';
import { deltaIsEmpty, GameServer } from '../src/game';
import { worldPath } from '../src/persistence';

const dir = mkdtempSync(join(tmpdir(), 'fe-game-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Just enough of a ws socket for GameServer: it records what the server sends. */
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
}

/** One iteration of the server loop, with the broadcast timer forced due. */
function pump(g: GameServer): void {
  const inner = g as unknown as { lastBroadcast: number; loop(): void };
  inner.lastBroadcast = -Infinity;
  inner.loop();
}

function emptyDelta(): Delta {
  return { tick: 1, ents: [], removed: [], cells: [], zones: [], removedZones: [], factions: [], msgs: [] };
}

describe('game server', () => {
  it('counts every kind of change when deciding whether a delta is worth sending', () => {
    expect(deltaIsEmpty(emptyDelta())).toBe(true);
    const changes: Partial<Delta>[] = [
      { ents: [{ kind: 'item', id: 1, x: 0, y: 0, faction: 0, def: 'wood', count: 1, rot: 0 }] },
      { removed: [1] },
      { cells: [0, 0, 0, 0, 0, 1] },
      { zones: [{ id: 1, faction: 1, kind: 'stockpile', cells: [0], plant: '', allow: [] }] },
      { removedZones: [1] },
      { factions: [{ id: 1, name: 'x', color: 0, home: { x: 0, y: 0 }, isPlayer: true }] },
      { msgs: [{ tick: 1, faction: 0, text: 'hi', tone: 'neutral' }] },
      { rooms: [] },
      { roomTemps: [] },
      { conditions: [] },
      { choices: [] },
      { coldOffset: 0 },
      { shots: [1, 2, 0, 0, 1, 1, 1, 0] },
    ];
    // Every optional or list field of a Delta appears above.
    const covered = new Set(changes.flatMap((c) => Object.keys(c)));
    for (const k of Object.keys({ ...emptyDelta(), rooms: 0, roomTemps: 0, conditions: 0, choices: 0, coldOffset: 0, shots: 0 })) if (k !== 'tick') expect(covered, k).toContain(k);
    for (const c of changes) expect(deltaIsEmpty({ ...emptyDelta(), ...c }), Object.keys(c)[0]).toBe(false);
  });

  it('while paused, answering a letter still takes it off every screen', () => {
    const g = new GameServer({ savePath: worldPath(dir, 'letters'), seed: 4, size: 80, log: () => {} });
    const ws = new FakeSocket();
    g.onConnect(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'Ann' });
    expect(ws.take('welcome')).toHaveLength(1);
    ws.say({ t: 'settle' });
    const faction = ws.take('settled')[0].faction;
    ws.say({ t: 'speed', speed: 0 });
    pump(g);
    expect(g.computeTime().paused).toBe(true);
    // A peddler's offer: declining it changes nothing but the letter itself.
    expect(fireEvent(g.world, 'peddler', faction)).toBe(true);
    pump(g);
    const letter = ws.take('delta').flatMap((m) => m.d.choices ?? [])[0];
    expect(letter?.event).toBe('peddler');
    const no = letter.options.find((o) => o.key !== 'accept')!.key;
    ws.say({ t: 'cmd', cmd: { c: 'choose', choice: letter.id, option: no } });
    pump(g);
    const after = ws.take('delta').filter((m) => m.d.choices);
    expect(after.at(-1)?.d.choices).toEqual([]);
    g.stop();
  });

  it('ignores commands from players who have not settled, or for other colonies', () => {
    const g = new GameServer({ savePath: worldPath(dir, 'cmds'), seed: 5, size: 80, log: () => {} });
    const a = new FakeSocket();
    const b = new FakeSocket();
    g.onConnect(a as unknown as WebSocket);
    g.onConnect(b as unknown as WebSocket);
    a.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'Ann' });
    b.say({ t: 'hello', v: PROTOCOL_VERSION, name: 'Bob' });
    a.say({ t: 'settle' });
    const fa = a.take('settled')[0].faction;
    const pawn = [...g.world.kinds.pawn].map((id) => g.world.get<Pawn>(id)!).find((p) => p.faction === fa)!;
    // Bob has no colony yet: his orders must not reach Ann's colonists.
    b.say({ t: 'cmd', cmd: { c: 'possess', pawn: pawn.id, on: true } });
    b.say({ t: 'cmd', cmd: { c: 'draft', pawns: [pawn.id], on: true } });
    pump(g);
    g.world.applyCommands();
    expect(pawn.drafted).toBe(false);
    expect(pawn.possessed).toBeFalsy();
    // A wrong protocol version is turned away.
    const c = new FakeSocket();
    g.onConnect(c as unknown as WebSocket);
    c.say({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Cy' });
    expect(c.take('error')[0]).toMatchObject({ fatal: true });
    expect(c.readyState).toBe(3);
    g.stop();
  });
});
