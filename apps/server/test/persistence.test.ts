import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addPlayerFaction, createWorld, deserializeWorld, fireEvent, hashWorld, Rng, serializeWorld, TICKS_PER_HOUR, type World } from '@fe/sim';
import { Chaos } from '../../../tools/bots/src/chaos';
import { loadWorldFile, saveWorldFile, worldPath } from '../src/persistence';
import { GameServer } from '../src/game';

const dir = mkdtempSync(join(tmpdir(), 'fe-saves-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('persistence', () => {
  it('round-trips a world through the save file', () => {
    const w = createWorld({ seed: 5, width: 80, height: 80 });
    addPlayerFaction(w, 'A');
    for (let i = 0; i < 3000; i++) w.step();
    const path = worldPath(dir, 'round trip!');
    saveWorldFile(path, { save: serializeWorld(w), players: [], nextPlayerId: 1 });
    const back = deserializeWorld(loadWorldFile(path)!.save);
    expect(hashWorld(back)).toBe(hashWorld(w));
  });

  it('a restarted server reloads the same world and players', () => {
    const path = worldPath(dir, 'server');
    const a = new GameServer({ savePath: path, seed: 9, size: 80, log: () => {} });
    addPlayerFaction(a.world, 'Host');
    for (let i = 0; i < 500; i++) a.world.step();
    a.save();
    const b = new GameServer({ savePath: path, log: () => {} });
    expect(b.world.seed).toBe(9);
    expect(hashWorld(b.world)).toBe(hashWorld(a.world));
  });

  it('a world mid-raid, mid-theft and mid-trade saves to disk, loads, and carries on identically', () => {
    const w = createWorld({ seed: 31, width: 100, height: 100 });
    w.tick += 15 * TICKS_PER_HOUR;
    w.frost = { startDay: 0, pace: 60, minRadius: 0.18 };
    const players = ['A', 'B'].map((n) => addPlayerFaction(w, n).id);
    const rng = new Rng(8);
    const chaos = new Chaos(rng, { w: 100, h: 100, entities: w.entities, factions: w.factions, zones: w.zones, zoneAt: w.map.zoneAt, choices: [] });
    const play = (worlds: World[], ticks: number) => {
      for (let t = 0; t < ticks; t++) {
        const who = rng.pick(players);
        const got = rng.chance(0.15) ? chaos.random(who) : null;
        for (const x of worlds) {
          if (got) x.enqueue(who, got.cmd);
          x.step();
        }
      }
    };
    play([w], 1000);
    fireEvent(w, 'raid', players[0]);
    fireEvent(w, 'settlement_raid', 0);
    play([w], 2000);
    const path = worldPath(dir, 'mid-raid');
    saveWorldFile(path, { save: serializeWorld(w), players: [], nextPlayerId: 1 });
    const back = deserializeWorld(loadWorldFile(path)!.save);
    expect(hashWorld(back)).toBe(hashWorld(w));
    play([w, back], 3000);
    expect(hashWorld(back)).toBe(hashWorld(w));
  });
});
