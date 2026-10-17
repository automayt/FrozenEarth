import { ITEMS } from '@fe/defs';
import { offerChoice, registerChoice } from './choices';
import { giveNearHome, storedCount, takeStored } from './eventHandlers';
import type { World } from './world';

export type TradeLine = [item: string, count: number];

const MAX_LINES = 4;
const MAX_PENDING = 3;
const OFFER_HOURS = 8;

function text(lines: TradeLine[]): string {
  return lines.length ? lines.map(([d, n]) => `${n} ${ITEMS[d]?.label.toLowerCase() ?? d}`).join(', ') : 'nothing';
}

function clean(lines: unknown): TradeLine[] | null {
  if (!Array.isArray(lines) || lines.length > MAX_LINES) return null;
  const out: TradeLine[] = [];
  for (const l of lines) {
    if (!Array.isArray(l) || typeof l[0] !== 'string' || !Object.hasOwn(ITEMS, l[0])) return null;
    const n = Math.round(Number(l[1]));
    if (!(n >= 1 && n <= 999)) return null;
    out.push([String(l[0]), n]);
  }
  return out;
}

function canPay(w: World, faction: number, lines: TradeLine[]): boolean {
  return lines.every(([d, n]) => storedCount(w, faction, d) >= n);
}

/** One colony proposes a swap of stockpiled goods to another. The other side gets a letter. */
export function offerTrade(w: World, from: number, to: number, give: unknown, want: unknown, note: unknown): void {
  const a = w.factions.get(from);
  const b = w.factions.get(to);
  const g = clean(give);
  const wa = clean(want);
  if (!a || !b || !b.isPlayer || from === to || !g || !wa || (!g.length && !wa.length)) return;
  if ([...w.choices.values()].filter((c) => c.event === 'trade' && c.faction === to).length >= MAX_PENDING) {
    w.message(from, `${b.name} already has too many offers waiting.`, 'neutral');
    return;
  }
  if (!canPay(w, from, g)) {
    w.message(from, `You don't have ${text(g)} in your stockpiles to offer.`, 'neutral');
    return;
  }
  const msg = typeof note === 'string' && note.trim() ? ` "${note.trim().slice(0, 140)}"` : '';
  offerChoice(
    w,
    to,
    'trade',
    `Trade offer from ${a.name}`,
    `${a.name} offers ${text(g)} in exchange for ${text(wa)}.${msg}`,
    [
      { key: 'accept', label: 'Accept' },
      { key: 'decline', label: 'Decline' },
    ],
    OFFER_HOURS,
    { from, give: g, want: wa },
  );
  w.message(from, `Your offer to ${b.name} has been sent.`, 'neutral');
}

registerChoice('trade', (w, c, option, d) => {
  const from = Number(d.from);
  const give = d.give as TradeLine[];
  const want = d.want as TradeLine[];
  const a = w.factions.get(from);
  const b = w.factions.get(c.faction);
  if (!a || !b) return;
  if (option !== 'accept') {
    w.message(from, `${b.name} declined your trade offer.`, 'neutral');
    return;
  }
  // Goods only move if both sides can still pay right now.
  if (!canPay(w, from, give)) {
    w.message(c.faction, `${a.name} no longer has what they offered. The deal is off.`, 'bad');
    w.message(from, `${b.name} accepted, but you no longer had ${text(give)}. The deal is off.`, 'bad');
    return;
  }
  if (!canPay(w, c.faction, want)) {
    w.message(c.faction, `You don't have ${text(want)} in your stockpiles. The deal is off.`, 'bad');
    w.message(from, `${b.name} accepted but couldn't pay. The deal is off.`, 'neutral');
    return;
  }
  for (const [d2, n] of give) giveNearHome(w, c.faction, d2, takeStored(w, from, d2, n));
  for (const [d2, n] of want) giveNearHome(w, from, d2, takeStored(w, c.faction, d2, n));
  w.message(c.faction, `Trade done with ${a.name}: you received ${text(give)}.`, 'good');
  w.message(from, `Trade done with ${b.name}: you received ${text(want)}.`, 'good');
});
