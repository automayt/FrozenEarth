/**
 * A seeded generator of plausible player commands, covering every command the client can send.
 * It reads only what a client can see (entities, factions, zones, choices), so the same code
 * drives headless bots (from a Mirror) and the sim's fuzz tests (from a World).
 */
import { BUILDINGS, SOWABLE_PLANTS, WEAPONS, WORK_TYPES } from '@fe/defs';
import type { Choice, Command, Entity, Faction, Item, Pawn, Rect, Zone } from '@fe/sim';

/** The client-visible slice of the world the generator reads. */
export interface ChaosView {
  w: number;
  h: number;
  entities: Map<number, Entity>;
  factions: Map<number, Faction>;
  zones: Map<number, Zone>;
  zoneAt: ArrayLike<number>;
  choices: Iterable<Choice>;
}

/** Anything with a uniform [0, 1) source: the sim's Rng, or a wrapper round Math.random. */
export interface ChaosRng {
  next(): number;
}

const BUILDABLE = Object.values(BUILDINGS)
  .filter((b) => !b.special)
  .map((b) => b.key);
const DESIGNATIONS = ['mine', 'chop', 'cut', 'harvest', 'cancel'] as const;

/** Every command kind the generator can produce, so callers can check coverage. */
export const CHAOS_KINDS = [
  'designate',
  'steal-desig',
  'build',
  'zone',
  'unzone',
  'setPriority',
  'draft',
  'move',
  'attack',
  'capture',
  'equip',
  'release',
  'steal',
  'hunt',
  'possess',
  'steer',
  'sneak',
  'interact',
  'settlementTrade',
  'deliverRequest',
  'offerTrade',
  'choose',
  'zoneSettings',
] as const;
export type ChaosKind = (typeof CHAOS_KINDS)[number];

export class Chaos {
  constructor(
    private rng: ChaosRng,
    private v: ChaosView,
  ) {}

  private int(n: number): number {
    return Math.floor(this.rng.next() * n);
  }

  private pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)];
  }

  private chance(p: number): boolean {
    return this.rng.next() < p;
  }

  private pawnsOf(faction: number): Pawn[] {
    const out: Pawn[] = [];
    for (const e of this.v.entities.values()) if (e.kind === 'pawn' && e.faction === faction) out.push(e);
    return out;
  }

  private able(faction: number): Pawn[] {
    return this.pawnsOf(faction).filter((p) => !p.downed && !p.prisoner);
  }

  private rectNear(x: number, y: number, spread: number, size: number): Rect {
    const x0 = x + this.int(spread * 2 + 1) - spread;
    const y0 = y + this.int(spread * 2 + 1) - spread;
    return { x0, y0, x1: x0 + this.int(size + 1), y1: y0 + this.int(size + 1) };
  }

  /** Items in another faction's stockpile (a settlement's or a colony's): what thieves go for. */
  private foreignStock(faction: number): Item[] {
    const out: Item[] = [];
    for (const e of this.v.entities.values()) {
      if (e.kind !== 'item') continue;
      const z = this.v.zones.get(this.v.zoneAt[e.y * this.v.w + e.x]);
      if (z && z.kind === 'stockpile' && z.faction !== faction) out.push(e);
    }
    return out;
  }

  /** What a faction has stored, by item. */
  private stock(faction: number): [string, number][] {
    const n = new Map<string, number>();
    for (const e of this.v.entities.values()) {
      if (e.kind !== 'item') continue;
      const z = this.v.zones.get(this.v.zoneAt[e.y * this.v.w + e.x]);
      if (z && z.kind === 'stockpile' && z.faction === faction) n.set(e.def, (n.get(e.def) ?? 0) + e.count);
    }
    return [...n];
  }

  private lines(stock: [string, number][]): [string, number][] {
    if (!stock.length) return [];
    const out: [string, number][] = [];
    for (let k = 1 + this.int(2); k > 0; k--) {
      const [d, n] = this.pick(stock);
      if (!out.some(([o]) => o === d)) out.push([d, 1 + this.int(Math.max(1, Math.min(n, 30)))]);
    }
    return out;
  }

  /** One command of the given kind for this faction, or null if there is nothing sensible to do. */
  make(faction: number, kind: ChaosKind): Command | null {
    const v = this.v;
    const f = v.factions.get(faction);
    if (!f) return null;
    const { x, y } = f.home;
    const pawns = this.able(faction);
    const towns = [...v.factions.values()].filter((t) => t.settlement && t.settlement.state !== 'fallen');
    const others = [...v.factions.values()].filter((o) => o.isPlayer && o.id !== faction);
    const foreignPawns = [...v.entities.values()].filter((e): e is Pawn => e.kind === 'pawn' && e.faction !== faction);
    switch (kind) {
      case 'designate':
        return { c: 'designate', kind: this.pick(DESIGNATIONS), ...this.rectNear(x, y, 18, 8) };
      case 'steal-desig': {
        const loot = this.foreignStock(faction);
        if (!loot.length) return null;
        const it = this.pick(loot);
        return { c: 'designate', kind: 'steal', x0: it.x - 1, y0: it.y - 1, x1: it.x + 1, y1: it.y + 1 };
      }
      case 'build':
        return { c: 'build', def: this.pick(BUILDABLE), hollow: this.chance(0.7), ...this.rectNear(x, y, 10, 5) };
      case 'zone':
        return this.chance(0.5)
          ? { c: 'zone', kind: 'stockpile', ...this.rectNear(x, y, 6, 4) }
          : { c: 'zone', kind: 'grow', plant: this.pick(SOWABLE_PLANTS).key, ...this.rectNear(x, y, 10, 4) };
      case 'unzone':
        return { c: 'unzone', ...this.rectNear(x, y, 8, 2) };
      case 'zoneSettings': {
        const mine = [...v.zones.values()].filter((z) => z.faction === faction);
        if (!mine.length) return null;
        const z = this.pick(mine);
        return z.kind === 'grow'
          ? { c: 'zoneSettings', zone: z.id, plant: this.pick(SOWABLE_PLANTS).key }
          : { c: 'zoneSettings', zone: z.id, allow: this.chance(0.8) ? ['resource', 'raw_food', 'meal', 'apparel', 'weapon'] : ['resource'] };
      }
      case 'setPriority':
        return pawns.length ? { c: 'setPriority', pawn: this.pick(pawns).id, work: this.pick(WORK_TYPES), prio: this.int(5) } : null;
      case 'draft':
        return pawns.length ? { c: 'draft', pawns: pawns.slice(0, 1 + this.int(pawns.length)).map((p) => p.id), on: this.chance(0.5) } : null;
      case 'move': {
        if (!pawns.length) return null;
        // Now and then, off to a settlement: that's where trading and stealing happen.
        const to = towns.length && this.chance(0.4) ? this.pick(towns).home : { x, y };
        const r = this.rectNear(to.x, to.y, 6, 0);
        return { c: 'move', pawns: pawns.map((p) => p.id), x: r.x0, y: r.y0 };
      }
      case 'attack':
        return pawns.length && foreignPawns.length ? { c: 'attack', pawns: pawns.map((p) => p.id), target: this.pick(foreignPawns).id } : null;
      case 'capture': {
        const downed = foreignPawns.filter((p) => p.downed);
        return pawns.length && downed.length ? { c: 'capture', pawns: pawns.map((p) => p.id), target: this.pick(downed).id } : null;
      }
      case 'equip': {
        if (!pawns.length) return null;
        const weapons = [...v.entities.values()].filter((e): e is Item => e.kind === 'item' && !!WEAPONS[e.def]);
        return { c: 'equip', pawn: this.pick(pawns).id, item: weapons.length && this.chance(0.8) ? this.pick(weapons).id : 0 };
      }
      case 'release': {
        const held = this.pawnsOf(faction).filter((p) => p.prisoner === 'held');
        return held.length ? { c: 'release', pawn: this.pick(held).id } : null;
      }
      case 'steal': {
        const loot = this.foreignStock(faction);
        return pawns.length && loot.length ? { c: 'steal', pawn: this.pick(pawns).id, item: this.pick(loot).id } : null;
      }
      case 'hunt': {
        const animals = foreignPawns.filter((p) => p.species);
        return animals.length ? { c: 'hunt', pawns: animals.slice(0, 1 + this.int(3)).map((a) => a.id), on: this.chance(0.8) } : null;
      }
      case 'possess':
        return pawns.length ? { c: 'possess', pawn: this.pick(pawns).id, on: this.chance(0.6) } : null;
      case 'steer': {
        const held = pawns.filter((p) => p.possessed);
        return held.length ? { c: 'steer', pawn: this.pick(held).id, dx: this.int(3) - 1, dy: this.int(3) - 1 } : null;
      }
      case 'sneak':
        return pawns.length ? { c: 'sneak', pawn: this.pick(pawns).id, on: this.chance(0.5) } : null;
      case 'interact': {
        const held = pawns.filter((p) => p.possessed);
        return held.length ? { c: 'interact', pawn: this.pick(held).id } : null;
      }
      case 'settlementTrade': {
        if (!towns.length) return null;
        const t = this.pick(towns);
        const give = this.lines(this.stock(faction));
        const want = this.chance(0.7) ? this.lines(this.stock(t.id)) : [];
        return give.length || want.length ? { c: 'settlementTrade', settlement: t.id, give, want } : null;
      }
      case 'deliverRequest': {
        for (const t of towns) {
          const r = t.settlement!.requests?.find((q) => q.faction === faction);
          if (r) return { c: 'deliverRequest', settlement: t.id, request: r.id };
        }
        return null;
      }
      case 'offerTrade': {
        if (!others.length) return null;
        const give = this.lines(this.stock(faction));
        const want = this.lines(this.stock(others[0].id));
        return give.length || want.length ? { c: 'offerTrade', to: this.pick(others).id, give, want, note: 'fuzz' } : null;
      }
      case 'choose': {
        const mine = [...v.choices].filter((c) => c.faction === faction);
        if (!mine.length) return null;
        const c = this.pick(mine);
        return { c: 'choose', choice: c.id, option: this.pick(c.options).key };
      }
    }
  }

  /** A command of a random kind, trying a few kinds until one makes sense. */
  random(faction: number): { kind: ChaosKind; cmd: Command } | null {
    for (let tries = 0; tries < 6; tries++) {
      const kind = this.pick(CHAOS_KINDS);
      const cmd = this.make(faction, kind);
      if (cmd) return { kind, cmd };
    }
    return null;
  }
}
