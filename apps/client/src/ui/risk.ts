import { calendar, dispositionOf, goodwillOf, GOODWILL, GUARD_REACH, NOISE, SETTLEMENT_WATCH, type Disposition, type Faction, type Pawn } from '@fe/sim';
import { fog } from '../render/fog';
import { store } from '../store';

/**
 * The stakes of a risky order, worked out from the client's copy of the world with the same
 * rules the sim uses (fog.sees for spotting, the sim's goodwill numbers and guard reach), so
 * the player sees who might notice and what it will cost before they click.
 */

export type Tone = 'good' | 'neutral' | 'bad';
export interface RiskLine {
  text: string;
  tone: Tone;
}

export interface GoodwillShift {
  before: number;
  after: number;
  from: Disposition;
  to: Disposition;
}

/** What a settlement's goodwill toward you would become after a change of `by`. */
export function goodwillShift(f: Faction | undefined, me: number, by: number): GoodwillShift | null {
  const st = f?.settlement;
  if (!st || st.state === 'fallen') return null;
  const before = goodwillOf(st, me);
  const after = Math.max(-100, Math.min(100, Math.round(before + by)));
  return { before, after, from: dispositionOf(st, me), to: dispositionOf({ ...st, goodwill: { ...st.goodwill, [me]: after } }, me) };
}

/** "goodwill 0 → -45: they turn hostile and attack on sight". */
export function shiftText(s: GoodwillShift): string {
  const nums = `goodwill ${s.before} → ${s.after}`;
  if (s.from === s.to) return `${nums} (still ${s.to})`;
  if (s.to === 'hostile') return `${nums}: they turn hostile and attack your people on sight`;
  return `${nums}: ${s.from} → ${s.to}`;
}

/** A stand-in for "someone standing here", for sight checks at a spot with no pawn on it. */
function probe(x: number, y: number, as?: Pawn): Pawn {
  return { ...(as ?? ({ skills: {}, sneaking: false } as unknown as Pawn)), x, y } as Pawn;
}

/** People of `owner` who could see `as` (or anyone) standing at (x, y) right now. The sim's spotting rule, via fog.sees. */
export function watchersAt(owner: number, x: number, y: number, as?: Pawn): Pawn[] {
  const target = probe(x, y, as);
  const out: Pawn[] = [];
  for (const o of store.mirror.entities.values()) {
    if (o.kind !== 'pawn' || o.faction !== owner || o.prisoner || o.species) continue;
    if (Math.abs(o.x - x) > 20 || Math.abs(o.y - y) > 20) continue;
    if (fog.sees(o, target)) out.push(o);
  }
  return out;
}

/** Sleepers of `owner` close enough that the clatter of picking goods up could wake them. */
export function sleepersNear(owner: number, x: number, y: number): number {
  let n = 0;
  for (const o of store.mirror.entities.values()) {
    if (o.kind !== 'pawn' || o.faction !== owner || o.prisoner || o.species || !o.asleep) continue;
    if (Math.hypot(o.x - x, o.y - y) <= NOISE.pickup) n++;
  }
  return n;
}

/** Hours until the next dark (22:00), or 0 if it is night now. */
export function hoursToDark(): number {
  const h = calendar(store.estTick()).hour;
  return h >= 22 || h < 6 ? 0 : 22 - h;
}

/** First names, at most three, then "and N more". */
export function names(ps: Pawn[]): string {
  const first = ps.slice(0, 3).map((p) => p.name.split(' ')[0]);
  return ps.length > 3 ? `${first.join(', ')} and ${ps.length - 3} more` : first.join(', ');
}

/** The owner of a stockpile cell you could steal from, if any. */
export function stealableOwner(x: number, y: number): Faction | undefined {
  const m = store.mirror;
  const me = store.me?.faction;
  if (!me || !m.inBounds(x, y)) return undefined;
  const z = m.zones.get(m.zoneAt[m.idx(x, y)]);
  const owner = z && z.kind === 'stockpile' && z.faction !== me ? m.factions.get(z.faction) : undefined;
  if (!owner || !(owner.isPlayer || (owner.settlement && owner.settlement.state !== 'fallen'))) return undefined;
  return owner;
}

/**
 * Who might see a theft at (x, y) and what being caught costs. `now`: a drafted colonist goes
 * at once (sight as it is now); otherwise haulers go after dark.
 */
export function stealRisk(owner: Faction, x: number, y: number, thief: Pawn | undefined, now: boolean): RiskLine[] {
  const me = store.me?.faction ?? 0;
  const m = store.mirror;
  const out: RiskLine[] = [];
  const who = owner.settlement ? owner.name : `${owner.name}'s colony`;
  // Walking into enemies' land is a fight before it is a theft.
  const land = hostileLandAt(x, y);
  if (land) out.push({ text: hostileLandText(land), tone: 'bad' });
  if (now) {
    const seen = watchersAt(owner.id, x, y, thief);
    out.push(
      seen.length
        ? { text: `${seen.length} of ${who} can see that spot right now: ${names(seen)}`, tone: 'bad' }
        : { text: `Nobody of ${who} can see that spot right now`, tone: 'good' },
    );
  } else {
    const h = hoursToDark();
    out.push({ text: h > 0 ? `Haulers go after dark, in about ${Math.ceil(h)}h, and need a stockpile of yours to carry it to` : 'It is dark: free haulers go now, if you have a stockpile to carry it to', tone: 'neutral' });
    out.push(
      fog.isLit(m.idx(x, y))
        ? { text: 'A fire lights this spot: anyone awake sees it from 13 cells, even at night', tone: 'bad' }
        : { text: 'Unlit: at night people see only 6 cells here', tone: 'good' },
    );
  }
  const sleepers = sleepersNear(owner.id, x, y);
  if (sleepers) out.push({ text: `${sleepers} asleep within earshot: picking goods up can wake them`, tone: 'neutral' });
  const shift = goodwillShift(owner, me, GOODWILL.caughtStealing);
  if (shift) out.push({ text: `If caught: ${shiftText(shift)}`, tone: 'bad' });
  else out.push({ text: 'If caught, the thief drops the goods and everyone hears who it was', tone: 'bad' });
  return out;
}

export interface HostileLand {
  f: Faction;
  /** Close enough that their people come out to fight; otherwise only the walls shoot. */
  guards: boolean;
}

/** A settlement hostile to you whose people would fight someone at (x, y). */
export function hostileLandAt(x: number, y: number): HostileLand | null {
  const me = store.me?.faction;
  if (!me) return null;
  let best: HostileLand | null = null;
  for (const f of store.mirror.factions.values()) {
    const st = f.settlement;
    if (st?.state !== 'home' || dispositionOf(st, me) !== 'hostile') continue;
    const d = Math.hypot(x - f.home.x, y - f.home.y);
    if (d <= st.radius + GUARD_REACH) return { f, guards: true };
    if (d <= st.radius + SETTLEMENT_WATCH && !best) best = { f, guards: false };
  }
  return best;
}

export function hostileLandText(h: HostileLand): string {
  return h.guards ? `${h.f.name}'s land: their guards attack your people on sight` : `Near ${h.f.name}: they man their walls and shoot at your people`;
}

/** Compass direction from one point to another: "north-east". */
export function direction(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 3) return 'here';
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  const dirs = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  return dirs[(Math.round(a / 45) + 8) % 8];
}
