import { ITEMS } from '@fe/defs';
import { tell } from './chronicle';
import { offerChoice, registerChoice } from './choices';
import { RARE_TICK, TICKS_PER_DAY } from './constants';
import { breakRaid, startCamp } from './raids';
import { REWARDS, requestText, shiftGoodwill } from './settlements';
import type { Contract, Faction, Pawn } from './types';
import { spawnAnimal } from './wildlife';
import type { World } from './world';

/**
 * Jobs a town gives a colony beyond fetching goods: clear out a wolf pack that's been taking
 * their animals, or break up a camp of bandits sitting on what they stole. The targets appear
 * when the colony agrees; the town pays once none are left, and remembers if nobody came.
 */

/** Share of a town's requests for help that are a job instead of goods. */
export const CONTRACT_CHANCE = 0.4;

interface JobKind {
  days: number;
  goodwill: number;
  /** What the town pays, in market value, from..to. */
  worth: [number, number];
  why: string[];
}

export const CONTRACTS: Record<Contract['kind'], JobKind> = {
  wolves: { days: 3, goodwill: 15, worth: [110, 170], why: ['a wolf pack has been taking their goats', 'wolves killed a woodcutter on the edge of town', 'a pack has been circling their fields at night'] },
  bandits: { days: 4, goodwill: 22, worth: [180, 260], why: ['bandits robbed their storehouse and are camped on the loot', 'a gang has been stopping their people on the road', 'thieves burned a barn and made off with the stores'] },
};
/** Raid points a bandit camp is bought with, from..to. */
const CAMP_POINTS: [number, number] = [90, 160];
/** Goodwill lost when a colony took the job and nobody dealt with it. */
const FAILED = -8;
/** Where the targets turn up: this far from the town, from..to... */
const SITE_RANGE: [number, number] = [14, 26];
/** ...and this far from any colony (bandits next door would be a raid, not a job) and other towns. */
const SITE_CLEAR_COLONY = 24;
const SITE_CLEAR_TOWN = 14;

const DIRS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

/** "north-east" and so on, from one point to another (y grows south). */
export function compass(dx: number, dy: number): string {
  const a = Math.atan2(dy, dx);
  return DIRS[(Math.round(a / (Math.PI / 4)) + 8) % 8];
}

/** An open spot some way out from the town, reachable from it, and well away from any colony. */
function site(w: World, f: Faction): number {
  const m = w.map;
  const home = m.idx(f.home.x, f.home.y);
  for (let tries = 0; tries < 60; tries++) {
    const a = w.rng.next() * Math.PI * 2;
    const r = SITE_RANGE[0] + w.rng.next() * (SITE_RANGE[1] - SITE_RANGE[0]);
    const x = Math.round(f.home.x + Math.cos(a) * r);
    const y = Math.round(f.home.y + Math.sin(a) * r);
    if (x < 2 || y < 2 || x >= m.w - 2 || y >= m.h - 2) continue;
    const c = m.idx(x, y);
    if (m.solid[c] || m.roomAt[c] || m.component(c) !== m.component(home)) continue;
    if (tries < 40 && w.frostAt(c) > 0.3) continue;
    let clear = true;
    for (const o of w.factions.values()) {
      const gap = o.isPlayer ? SITE_CLEAR_COLONY : o.settlement && o.id !== f.id ? SITE_CLEAR_TOWN : 0;
      if (gap && Math.hypot(o.home.x - x, o.home.y - y) < gap) clear = false;
    }
    if (clear) return c;
  }
  return -1;
}

function rewardFor(w: World, worth: number): [string, number] {
  const affordable = REWARDS.filter((d) => ITEMS[d].marketValue <= worth);
  const def = affordable.length ? w.rng.pick(affordable) : 'gold';
  return [def, Math.max(1, Math.round(worth / ITEMS[def].marketValue))];
}

/** Has this colony a job from this town, or a letter offering one? */
export function hasContract(w: World, f: Faction, faction: number): boolean {
  if (f.settlement?.contracts?.some((c) => c.faction === faction)) return true;
  for (const c of w.choices.values()) if (c.event === 'settlement_contract' && c.faction === faction && Number(w.choiceData.get(c.id)?.settlement) === f.id) return true;
  return false;
}

/** Offer a colony a job. Returns whether a letter went out. */
export function offerContract(w: World, f: Faction, faction: number): boolean {
  const cell = site(w, f);
  if (cell < 0) return false;
  const kind: Contract['kind'] = w.rng.chance(0.5) ? 'wolves' : 'bandits';
  const def = CONTRACTS[kind];
  const reward = rewardFor(w, def.worth[0] + w.rng.next() * (def.worth[1] - def.worth[0]));
  const where = `${Math.round(Math.hypot(w.map.cx(cell) - f.home.x, w.map.cy(cell) - f.home.y))} cells ${compass(w.map.cx(cell) - f.home.x, w.map.cy(cell) - f.home.y)} of town`;
  const what = kind === 'wolves' ? `Drive off or kill the pack, about ${where}` : `Break up their camp, about ${where}: whatever they stole is yours to keep`;
  offerChoice(
    w,
    faction,
    'settlement_contract',
    `${f.name} has a job for you`,
    `${f.name} sends word: ${w.rng.pick(def.why)}. ${what}. Do it within ${def.days} days and they'll give you ${requestText(reward[0], reward[1])}. If you agree and don't, they'll remember.`,
    [
      { key: 'accept', label: kind === 'wolves' ? 'Take the job' : 'Take the job (a fight)' },
      { key: 'decline', label: 'Decline' },
    ],
    12,
    { settlement: f.id, kind, cell, reward },
    cell,
  );
  return true;
}

registerChoice('settlement_contract', (w, c, option, d) => {
  const f = w.factions.get(Number(d.settlement));
  const s = f?.settlement;
  if (!f || !s || s.state !== 'home' || option !== 'accept') return;
  const kind = d.kind as Contract['kind'];
  const def = CONTRACTS[kind];
  const cell = Number(d.cell);
  const until = w.tick + def.days * TICKS_PER_DAY;
  const targets: Pawn[] = [];
  let chief: string | undefined;
  if (kind === 'wolves') {
    const m = w.map;
    const n = 3 + w.rng.int(2);
    for (let k = 0; k < n * 3 && targets.length < n; k++) {
      const x = Math.max(0, Math.min(m.w - 1, m.cx(cell) + w.rng.int(5) - 2));
      const y = Math.max(0, Math.min(m.h - 1, m.cy(cell) + w.rng.int(5) - 2));
      const at = m.idx(x, y);
      if (!m.solid[at] && m.component(at) === m.component(cell)) targets.push(spawnAnimal(w, 'wolf', at));
    }
  } else {
    const camp = startCamp(w, f, cell, CAMP_POINTS[0] + w.rng.int(CAMP_POINTS[1] - CAMP_POINTS[0] + 1), until);
    if (camp) {
      targets.push(...camp.raiders);
      chief = camp.band.raid?.chiefName;
    }
  }
  if (!targets.length) {
    w.message(c.faction, `By the time you answered, the trouble near ${f.name} had moved on.`, 'neutral');
    return;
  }
  const job: Contract = { id: w.nextChoiceId++, faction: c.faction, kind, targets: targets.map((p) => p.id), at: cell, reward: d.reward as [string, number], goodwill: def.goodwill, until };
  if (chief) job.chief = chief;
  (s.contracts ??= []).push(job);
  w.dirty.factions.add(f.id);
  const them = kind === 'wolves' ? `the ${targets.length} wolves` : `the ${targets.length} bandits${chief ? ` and their chief, ${chief}` : ''}`;
  w.message(c.faction, `You took ${f.name}'s job: deal with ${them} within ${def.days} days. Draft a few colonists and go.`, 'neutral', cell);
});

/** Still to be dealt with: not dead, gone, captured or lying downed. */
function remaining(w: World, job: Contract): Pawn[] {
  const out: Pawn[] = [];
  for (const id of job.targets) {
    const p = w.get<Pawn>(id);
    if (p && p.kind === 'pawn' && !p.prisoner && !p.downed) out.push(p);
  }
  return out;
}

/** What the job is about, for letters: "the wolves", "the bandits". */
export function contractText(job: Contract): string {
  return job.kind === 'wolves' ? 'the wolves' : job.chief ? `${job.chief}'s bandits` : 'the bandits';
}

/** Every few seconds: jobs done get paid, jobs left too long lapse. */
export function contractsTick(w: World): void {
  if (w.tick % RARE_TICK !== 0) return;
  for (const f of w.factions.values()) {
    const s = f.settlement;
    if (!s?.contracts?.length) continue;
    const keep: Contract[] = [];
    for (const job of s.contracts) {
      const left = remaining(w, job);
      if (!left.length) {
        paid(w, f, job);
        continue;
      }
      if (w.tick >= job.until) {
        lapsed(w, f, job, left);
        continue;
      }
      const at = w.cellOf(left[0]);
      if (at !== job.at || left.length !== job.targets.length) {
        job.at = at;
        w.dirty.factions.add(f.id);
      }
      keep.push(job);
    }
    if (keep.length !== s.contracts.length) {
      s.contracts = keep;
      w.dirty.factions.add(f.id);
    }
  }
}

function paid(w: World, f: Faction, job: Contract): void {
  const colony = w.factions.get(job.faction);
  if (!colony) return;
  const home = w.map.idx(colony.home.x, colony.home.y);
  const [def, n] = job.reward;
  w.placeItemNear(def, n, home);
  shiftGoodwill(w, f, job.faction, job.goodwill, job.kind === 'wolves' ? 'Cleared the wolves for us' : 'Broke up the bandit camp for us');
  w.message(job.faction, `Job done: ${f.name} thanks you for dealing with ${contractText(job)}. A runner brought ${requestText(def, n)}; it's by your home.`, 'good', home);
  tell(w, job.faction, job.kind === 'wolves' ? `Cleared a wolf pack for ${f.name}.` : `Broke up a bandit camp${job.chief ? ` led by ${job.chief}` : ''} for ${f.name}.`, 'first_contract');
}

function lapsed(w: World, f: Faction, job: Contract, left: Pawn[]): void {
  w.message(job.faction, `You took ${f.name}'s job and ${contractText(job)} are still out there. They won't forget it.`, 'bad', w.map.idx(f.home.x, f.home.y));
  shiftGoodwill(w, f, job.faction, FAILED, `Never dealt with ${contractText(job)}`);
  // Bandits move on; wolves are just wolves now.
  const band = left.map((p) => w.factions.get(p.faction)).find((x) => x?.raid?.camp !== undefined);
  if (band && !band.raid!.fled) breakRaid(w, band, `${band.name} have broken camp and moved on.`);
}

/** A town on the move or gone: its jobs stop counting, with no hard feelings. */
export function voidContracts(w: World, f: Faction): void {
  for (const job of f.settlement?.contracts ?? []) w.message(job.faction, `${f.name} is gone. Their job no longer stands.`, 'neutral');
  if (f.settlement) f.settlement.contracts = [];
  for (const c of [...w.choices.values()]) {
    if (c.event !== 'settlement_contract' || Number(w.choiceData.get(c.id)?.settlement) !== f.id) continue;
    w.choices.delete(c.id);
    w.choiceData.delete(c.id);
    w.dirty.choices = true;
  }
}
