import { describe, expect, it } from 'vitest';
import { DAYS_PER_SEASON, START_TICK, startRaid, TICKS_PER_DAY, type Pawn, type World } from '../src';
import { chronicleTick, milestone, tell } from '../src/chronicle';
import { killPawn } from '../src/health';
import { setPact } from '../src/pacts';
import { raiderGone } from '../src/raids';
import { addPawn, flatWorld } from './helpers';

function colony(): { w: World; hero: Pawn } {
  const w = flatWorld(80, 80);
  w.tick = START_TICK;
  w.factions.set(2, { id: 2, name: 'Colony', color: 0xff0000, home: { x: 40, y: 40 }, isPlayer: true });
  const hero = addPawn(w, 40, 40, 2);
  hero.name = 'Yara Crane';
  return { w, hero };
}

const story = (w: World, f = 2) => w.factions.get(f)?.chronicle ?? [];

describe("a colony's story", () => {
  it('a milestone is reached once; later lines for it are plain or skipped', () => {
    const { w } = colony();
    tell(w, 2, 'First thing.', 'first_trade');
    tell(w, 2, 'Again.', 'first_trade');
    milestone(w, 2, 'first_trade', 'Would not be told.');
    expect(story(w).map((t) => t.text)).toEqual(['First thing.', 'Again.']);
    expect(story(w).filter((t) => t.milestone).length).toBe(1);
    expect(w.factions.get(2)!.milestones).toEqual(['first_trade']);
    // Towns and raiders have no story.
    tell(w, 1, 'Nobody hears this.');
    expect(w.factions.get(1)!.chronicle).toBeUndefined();
  });

  it('remembers its dead', () => {
    const { w, hero } = colony();
    killPawn(w, hero, 'blood loss');
    expect(story(w).at(-1)?.text).toBe('Yara Crane died of blood loss.');
  });

  it('a raid driven off names who did the most', () => {
    const { w, hero } = colony();
    const raiders = startRaid(w, 2, 150, 'raid')!;
    const raid = w.factions.get(raiders[0].faction)!;
    raid.raid!.heroes = { [hero.id]: 2.5 };
    for (const r of raiders) w.despawn(r.id);
    raiderGone(w, raid.id, true);
    const last = story(w).at(-1)!;
    expect(last.milestone).toBe('first_raid');
    expect(last.text).toContain('were driven off');
    expect(last.text).toContain('Yara Crane did the most');
  });

  it('alliances go into both stories', () => {
    const { w } = colony();
    w.factions.set(3, { id: 3, name: 'Neighbours', color: 0x00ff00, home: { x: 10, y: 10 }, isPlayer: true });
    setPact(w, 2, 3, 'ally');
    expect(story(w, 2).at(-1)?.text).toBe('Swore an alliance with Neighbours.');
    expect(story(w, 3).at(-1)?.text).toBe('Swore an alliance with Colony.');
    // Renewing it doesn't retell it.
    setPact(w, 2, 3, 'ally');
    expect(story(w, 2).length).toBe(1);
  });

  it('a colony standing as winter turns to spring has lived through it', () => {
    const { w } = colony();
    // A year is four seasons of DAYS_PER_SEASON days; the first day after the year is spring again.
    w.tick = 4 * DAYS_PER_SEASON * TICKS_PER_DAY;
    chronicleTick(w);
    expect(story(w).at(-1)?.milestone).toBe('first_winter');
  });
});
