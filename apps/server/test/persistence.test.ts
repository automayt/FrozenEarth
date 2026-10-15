import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addPlayerFaction, createWorld, deserializeWorld, hashWorld, serializeWorld } from '@fe/sim';
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
});
