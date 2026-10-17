import { describe, expect, it } from 'vitest';
import { foundSettlement, Rng, snapshot, START_TICK, TRADE_RANGE, World, type Item } from '@fe/sim';
import { Mirror } from '@fe/protocol';
import { settlementDeal, traderNear } from '../src/ui/trade';

/**
 * The trade panel greys out Send when a settlement would refuse. That prediction has to match
 * what the server actually does, or players either can't send fair offers or keep sending ones
 * that bounce.
 */

const ME = 2;

function setup(rng: Rng) {
  const w = new World(rng.int(1e6), 80, 80);
  for (let i = 0; i < w.map.n; i++) w.refreshCell(i);
  w.tick = START_TICK;
  w.factions.set(1, { id: 1, name: 'Nobody', color: 0, home: { x: 5, y: 5 }, isPlayer: false });
  w.factions.set(ME, { id: ME, name: 'Colony', color: 0xff0000, home: { x: 10, y: 10 }, isPlayer: true });
  const town = foundSettlement(w, { x: 40, y: 40 }, [-60, 0, 45][rng.int(3)], 4);
  const z = w.createZone(ME, 'stockpile');
  for (let x = 2; x < 30; x++) w.addZoneCell(z, w.map.idx(x, 12));
  for (const [def, n] of [['wood', 120], ['steel', 60], ['gold', 8], ['cloth', 40]] as const) w.placeItemNear(def, n, w.map.idx(10, 12));
  return { w, town };
}

function stockOf(w: World, faction: number): [string, number][] {
  const out = new Map<string, number>();
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    const z = w.zoneAt(w.cellOf(it));
    if (z?.kind === 'stockpile' && z.faction === faction) out.set(it.def, (out.get(it.def) ?? 0) + it.count);
  }
  return [...out];
}

function lines(rng: Rng, stock: [string, number][], max: number, cap: number): [string, number][] {
  const out: [string, number][] = [];
  for (let k = rng.int(max + 1); k > 0 && stock.length; k--) {
    const [d, n] = rng.pick(stock);
    if (!out.some(([o]) => o === d)) out.push([d, 1 + rng.int(Math.min(n, cap))]);
  }
  return out;
}

describe('settlement trade preview', () => {
  it("predicts the server's yes or no for random offers, moods, and trader positions", () => {
    const rng = new Rng(77);
    const outcomes = { done: 0, refused: 0 };
    for (let k = 0; k < 120; k++) {
      const { w, town } = setup(rng);
      const s = town.settlement!;
      if (rng.chance(0.85)) s.goodwill[ME] = rng.int(201) - 100;
      if (rng.chance(0.1)) s.state = 'leaving';
      // A colonist somewhere around the edge of trading range, or nowhere near.
      const d = rng.chance(0.8) ? TRADE_RANGE - 3 + rng.next() * 6 : 30;
      const a = rng.next() * Math.PI * 2;
      const px = Math.round(town.home.x + Math.cos(a) * d);
      const py = Math.round(town.home.y + Math.sin(a) * d);
      if (!w.map.solid[w.map.idx(px, py)]) w.spawnPawn(ME, w.map.idx(px, py), 'Trader Joe');
      const give = lines(rng, stockOf(w, ME), 3, 60);
      const want = lines(rng, stockOf(w, town.id), 2, 12);
      if (!give.length && !want.length) continue;

      const m = new Mirror();
      m.applySnapshot(snapshot(w));
      const deal = settlementDeal(m.factions.get(town.id)!.settlement!, ME, give, want, !!traderNear(m, ME, town.home));

      w.dirty.msgs = [];
      w.enqueue(ME, { c: 'settlementTrade', settlement: town.id, give, want });
      w.applyCommands();
      const done = w.dirty.msgs.some((msg) => msg.tone === 'good' && (msg.text.startsWith('Trade done') || msg.text.includes('accepts your gift')));
      expect(!deal.blocked, `case ${k}: ${JSON.stringify({ give, want, goodwill: s.goodwill[ME], state: s.state, d, deal, msgs: w.dirty.msgs.map((x) => x.text) })}`).toBe(done);
      outcomes[done ? 'done' : 'refused']++;
    }
    // Both answers came up plenty of times.
    expect(outcomes.done).toBeGreaterThan(15);
    expect(outcomes.refused).toBeGreaterThan(15);
  });

  it('prices: strangers pay half again, close friends pay face value', () => {
    const s = { temper: 0, goodwill: {} as Record<number, number>, radius: 10, state: 'home' as const, dest: -1, until: 0, met: [] };
    expect(settlementDeal(s, ME, [['gold', 1]], [['gold', 1]], true)).toMatchObject({ factor: 1.5, blocked: true, mood: 'wary' });
    s.goodwill[ME] = 100;
    expect(settlementDeal(s, ME, [['gold', 1]], [['gold', 1]], true)).toMatchObject({ factor: 1, blocked: false, mood: 'friendly' });
    expect(settlementDeal(s, ME, [['gold', 1]], [['gold', 1]], false).blocked).toBe(true);
    s.goodwill[ME] = -100;
    // Enemies take gifts but won't sell.
    expect(settlementDeal(s, ME, [['gold', 1]], [], true).blocked).toBe(false);
    expect(settlementDeal(s, ME, [['gold', 9]], [['wood', 1]], true).blocked).toBe(true);
  });
});
