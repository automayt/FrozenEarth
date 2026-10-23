import { useEffect, useState } from 'react';
import { ANIMALS, ITEMS, WEAPONS, weaponOf } from '@fe/defs';
import { pawnPosition } from '@fe/protocol';
import { daysUntilFrost, dispositionOf, GOODWILL, tameChance, type Item, type Pawn } from '@fe/sim';
import { helpers, mySquad, myPawnsAll } from '../actions';
import { store, useStore } from '../store';
import { goodwillShift, hostileLandAt, hostileLandText, shiftText, stealableOwner, stealRisk, type RiskLine, type Tone } from './risk';

interface Preview {
  title: string;
  tone: Tone;
  lines: RiskLine[];
}

/** The pawn drawn on this cell, preferring other people's (what a right-click would target). */
function pawnOn(x: number, y: number): Pawn | undefined {
  const m = store.mirror;
  const tick = store.estTick();
  let best: Pawn | undefined;
  let bestD = 0.8;
  for (const e of m.entities.values()) {
    if (e.kind !== 'pawn') continue;
    const pos = pawnPosition(e, tick, m.w);
    const d = Math.hypot(pos.x - x, pos.y - y) - (e.faction !== store.me?.faction ? 0.1 : 0);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export function frostDays(x: number, y: number): number {
  const m = store.mirror;
  return daysUntilFrost(x, y, m.w, m.h, store.estTick(), m.frost, 60);
}

export const daysText = (d: number) => (d === 0 ? 'already frozen' : d === Infinity ? 'over 60 days away' : `about ${d} day${d === 1 ? '' : 's'} away`);

/** What a right-click (or the active tool) would do on this cell, and what it risks. Mirrors Input.order. */
function preview(x: number, y: number): Preview | null {
  const m = store.mirror;
  const me = store.me?.faction;
  if (!me || !m.inBounds(x, y)) return null;
  const tool = store.tool;
  if (tool.kind === 'moveHome') {
    const f = m.factions.get(me);
    const there = frostDays(x, y);
    const here = f ? frostDays(f.home.x, f.home.y) : Infinity;
    const lines: RiskLine[] = [{ text: `Frost here: ${daysText(there)}`, tone: there === 0 ? 'bad' : there > here ? 'good' : 'neutral' }];
    if (f) lines.push({ text: `At your colony now: ${daysText(here)}`, tone: 'neutral' });
    if (there !== Infinity && there <= here) lines.push({ text: 'No further from the frost than where you are. The map centre stays warm longest.', tone: 'bad' });
    const land = hostileLandAt(x, y);
    if (land) lines.push({ text: hostileLandText(land), tone: 'bad' });
    return { title: 'New home here', tone: there === 0 || land ? 'bad' : 'neutral', lines };
  }
  if (tool.kind === 'designate' && tool.what === 'steal') {
    const it = m.get<Item>(m.itemAt[m.idx(x, y)]);
    const owner = stealableOwner(x, y);
    if (!owner || !it || it.kind !== 'item') return { title: 'Steal', tone: 'neutral', lines: [{ text: "Drag over goods in a settlement's or another colony's stockpile", tone: 'neutral' }] };
    return { title: `Steal ${it.count} ${ITEMS[it.def]?.label.toLowerCase() ?? 'goods'} after dark`, tone: 'bad', lines: stealRisk(owner, x, y, undefined, false) };
  }
  if (tool.kind === 'hunt') {
    const a = pawnOn(x, y);
    if (!a?.species) return null;
    const def = ANIMALS[a.species];
    const hunters = myPawnsAll().filter((p) => !p.downed && p.weapon && !weaponOf(p.weapon).melee).length;
    const lines: RiskLine[] = [hunters ? { text: `${hunters} colonist${hunters > 1 ? 's' : ''} with a bow or rifle can hunt`, tone: 'good' } : { text: 'Nobody has a bow or rifle yet: make one at a workbench', tone: 'bad' }];
    if (def?.predator) lines.push({ text: 'Predator: it fights back', tone: 'bad' });
    else if (def?.defends) lines.push({ text: 'Turns on whoever attacks it', tone: 'neutral' });
    return { title: `Hunt ${def?.label.toLowerCase() ?? a.name}`, tone: def?.predator ? 'bad' : 'neutral', lines };
  }
  if (tool.kind === 'tame') {
    const a = pawnOn(x, y);
    if (!a?.species) return null;
    const def = ANIMALS[a.species];
    if (a.tamed) return { title: a.name, tone: 'good', lines: [{ text: a.tamed === me ? 'Already yours' : "Another colony's animal", tone: 'neutral' }] };
    if (!def?.tame) return { title: `${def?.label ?? a.name} can't be tamed`, tone: 'bad', lines: [{ text: 'Only deer, muskox and hares will come round', tone: 'neutral' }] };
    const tamers = myPawnsAll().filter((p) => !p.downed && p.priorities.hunt > 0);
    const best = Math.max(0, ...tamers.map((p) => p.skills?.social?.level ?? 0));
    const lines: RiskLine[] = [
      tamers.length ? { text: `${tamers.length} colonist${tamers.length > 1 ? 's' : ''} on Hunt work can go · about ${Math.round(tameChance(def, best) * 100)}% a try`, tone: 'good' } : { text: 'Nobody has Hunt work turned on', tone: 'bad' },
    ];
    if (def.draft) lines.push({ text: `Carries ${def.pack} on a journey, or pulls a sledge`, tone: 'good' });
    else if (def.pack) lines.push({ text: `Carries ${def.pack} on a journey`, tone: 'good' });
    else lines.push({ text: 'A companion: good company, no load', tone: 'neutral' });
    if (def.defends) lines.push({ text: 'May lose patience and charge', tone: 'bad' });
    return { title: `Tame ${def.label.toLowerCase()}`, tone: 'neutral', lines };
  }
  if (tool.kind !== 'select') return null;
  const squad = mySquad().filter((p) => p.drafted && !p.downed);
  if (!squad.length) return null;
  const t = pawnOn(x, y);
  if (t && t.faction !== me) {
    const f = m.factions.get(t.faction);
    const st = f?.settlement;
    if (t.downed && f?.raid) return { title: `Capture ${t.name.split(' ')[0]}`, tone: 'neutral', lines: [{ text: 'Carried to a free bed and held prisoner', tone: 'neutral' }] };
    if (t.species) {
      const def = ANIMALS[t.species];
      return def?.predator ? { title: `Attack the ${def.label.toLowerCase()}`, tone: 'bad', lines: [{ text: 'Predator: it fights back', tone: 'bad' }] } : null;
    }
    const peaceful = !f?.raid && !t.prisoner && (!!f?.isPlayer || (!!st && st.state !== 'fallen' && dispositionOf(st, me) !== 'hostile'));
    // Enemies are fair game: nothing to warn about.
    if (!peaceful) return null;
    const lines: RiskLine[] = [];
    if (st) {
      const miss = goodwillShift(f, me, GOODWILL.attackMiss);
      const hit = goodwillShift(f, me, GOODWILL.attackHit);
      if (hit) lines.push({ text: `Each wound: ${shiftText(hit)}`, tone: 'bad' });
      if (miss) lines.push({ text: `Each miss: ${GOODWILL.attackMiss} goodwill`, tone: 'bad' });
    } else lines.push({ text: `${t.name.split(' ')[0]} belongs to another player's colony`, tone: 'bad' });
    lines.push({ text: 'Right-click twice to confirm', tone: 'neutral' });
    return { title: `Attack ${t.name.split(' ')[0]} of ${f?.name ?? 'a peaceful colony'}?`, tone: 'bad', lines };
  }
  const it = m.get<Item>(m.itemAt[m.idx(x, y)]);
  const owner = stealableOwner(x, y);
  if (it && it.kind === 'item' && owner) {
    const who = squad.reduce((a, b) => (Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a));
    return { title: `${who.name.split(' ')[0]} steals ${it.count} ${ITEMS[it.def]?.label.toLowerCase() ?? 'goods'} now`, tone: 'bad', lines: stealRisk(owner, x, y, who, true) };
  }
  if (it && it.kind === 'item' && WEAPONS[it.def]) {
    const who = helpers(x, y).find((s) => s.drafted) ?? squad[0];
    return { title: `${who.name.split(' ')[0]} picks up the ${ITEMS[it.def]?.label.toLowerCase() ?? 'weapon'}`, tone: 'neutral', lines: [] };
  }
  const land = hostileLandAt(x, y);
  if (land) return { title: 'Move here', tone: 'bad', lines: [{ text: hostileLandText(land), tone: 'bad' }] };
  return null;
}

/**
 * A small card beside the cursor saying what a right-click (or the active tool) will do there,
 * shown only when the order is risky or not obvious: theft, attacking someone peaceful,
 * walking into a hostile town's land, a new home site, a hunt.
 */
export function OrderPreview() {
  const s = useStore();
  const [pos, setPos] = useState<{ x: number; y: number; over: boolean; view: string } | null>(null);
  useEffect(() => {
    let raf = 0;
    let last: PointerEvent | null = null;
    const onMove = (e: PointerEvent) => {
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!last) return;
        const over = (last.target as HTMLElement | null)?.tagName === 'CANVAS' && !!(last.target as HTMLElement).closest('.game');
        const v = store.view;
        setPos({ x: last.clientX, y: last.clientY, over, view: v ? `${v.x0.toFixed(1)},${v.y0.toFixed(1)}` : '' });
      });
    };
    const onLeave = () => setPos(null);
    window.addEventListener('pointermove', onMove);
    document.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);
  // The camera moved under a still cursor (keys, a jump): the hovered cell is stale until it moves.
  const v = s.view;
  if (!pos?.over || s.hoverCell === null || s.help || (v ? `${v.x0.toFixed(1)},${v.y0.toFixed(1)}` : '') !== pos.view) return null;
  const m = s.mirror;
  const p = preview(s.hoverCell % m.w, Math.floor(s.hoverCell / m.w));
  if (!p) return null;
  // Beside the cursor, flipped to stay on screen.
  const W = 290;
  const left = pos.x + 18 + W > window.innerWidth ? pos.x - 18 - W : pos.x + 18;
  // In the lower half it sits above the cursor, so it never runs under the bottom bar.
  const below = pos.y < window.innerHeight * 0.55;
  const style = below ? { left: Math.max(4, left), top: pos.y + 18, width: W } : { left: Math.max(4, left), bottom: window.innerHeight - pos.y + 14, width: W };
  return (
    <div className={`panel order-preview ${p.tone}`} style={style} role="status" aria-live="polite">
      <b>{p.title}</b>
      {p.lines.map((l, i) => (
        <span key={i} className={`op-line ${l.tone}`}>
          {l.text}
        </span>
      ))}
    </div>
  );
}
