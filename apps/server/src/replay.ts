/**
 * Reproduce a sim crash from the report the server wrote (saves/<world>/crashes/crash-*.bin): load
 * the restore point and redo everything the server did to the world since, in order. The sim is
 * deterministic, so the same tick throws the same way, here, under a debugger if you like.
 *
 *   npm run replay -- saves/myworld/crashes/crash-2026-10-18_120000-t123456.bin
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { addPlayerFaction, deserializeWorld, fireEvent, hashWorld, type SaveData, type World } from '@fe/sim';
import type { CrashReport, JournalOp } from './game';
import { fixArrays, unpackGz } from './persistence';

export interface ReplayResult {
  world: World;
  /** The error the replay hit, if it reproduced one. */
  error?: unknown;
  /** Ticks stepped before the end (or the throw). */
  ticks: number;
}

export function replayJournal(save: SaveData, journal: JournalOp[]): ReplayResult {
  const world = deserializeWorld(save);
  let ticks = 0;
  try {
    for (const op of journal) {
      switch (op[0]) {
        case 'c':
          world.enqueue(op[1], op[2]);
          break;
        case 'a':
          world.applyCommands();
          break;
        case 's':
          for (let i = 0; i < op[1]; i++) {
            world.step();
            ticks++;
          }
          break;
        case 'e':
          fireEvent(world, op[1], op[2]);
          break;
        case 'f':
          addPlayerFaction(world, op[1], 3, op[2]);
          break;
      }
    }
  } catch (error) {
    return { world, error, ticks };
  }
  return { world, ticks };
}

export function readCrashReport(path: string): CrashReport {
  const r = unpackGz<CrashReport>(readFileSync(path));
  fixArrays(r.checkpoint);
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: npm run replay -- <crash-report.bin>');
    process.exit(2);
  }
  const r = readCrashReport(path);
  console.log(`Crash at tick ${r.tick} (${r.at}); replaying ${r.journal.length} ops from tick ${r.checkpoint.tick}${r.journalComplete ? '' : ' (journal INCOMPLETE: it overflowed, so this may not reproduce)'}`);
  console.log(`Original error:\n${r.error}\n`);
  const out = replayJournal(r.checkpoint, r.journal);
  if (out.error) {
    console.log(`Reproduced at tick ${out.world.tick} after ${out.ticks} ticks:`);
    console.log(out.error);
    process.exit(0);
  }
  console.log(`Did not reproduce: ran ${out.ticks} ticks to tick ${out.world.tick} without a throw (world hash ${hashWorld(out.world)}).`);
  process.exit(1);
}
