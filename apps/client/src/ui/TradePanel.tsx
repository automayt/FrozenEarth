import { useState } from 'react';
import { ITEMS } from '@fe/defs';
import { dispositionOf, goodwillOf, lineValue, priceFactor, TRADE_RANGE, type Item } from '@fe/sim';
import { DISPOSITION_COLOR } from '../render/renderer';
import { command } from '../net';
import { store, useStore } from '../store';
import { hex } from './util';

type Line = { item: string; count: number };

/** What a colony has in its stockpiles. Everyone can see the whole map, so this is public. */
function stockOf(faction: number): Map<string, number> {
  const m = store.mirror;
  const out = new Map<string, number>();
  for (const e of m.entities.values()) {
    if (e.kind !== 'item') continue;
    const z = m.zoneAt[e.y * m.w + e.x];
    if (z && m.zones.get(z)?.faction === faction && m.zones.get(z)?.kind === 'stockpile') out.set((e as Item).def, (out.get((e as Item).def) ?? 0) + (e as Item).count);
  }
  return out;
}

function LineEditor({ title, lines, setLines, stock, empty }: { title: string; lines: Line[]; setLines: (l: Line[]) => void; stock: Map<string, number>; empty: string }) {
  const options = [...stock.entries()].sort((a, b) => ITEMS[a[0]].label.localeCompare(ITEMS[b[0]].label));
  return (
    <div className="trade-side">
      <h4>{title}</h4>
      {lines.map((l, i) => (
        <div key={i} className="trade-line">
          <select value={l.item} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, item: e.target.value } : x)))}>
            {options.map(([d, n]) => (
              <option key={d} value={d}>
                {ITEMS[d].label} ({n})
              </option>
            ))}
          </select>
          <input type="number" min={1} max={999} value={l.count} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, count: Number(e.target.value) } : x)))} />
          <button onClick={() => setLines(lines.filter((_, k) => k !== i))} title="Remove">
            ×
          </button>
        </div>
      ))}
      {lines.length < 4 && options.length > 0 && <button onClick={() => setLines([...lines, { item: options[0][0], count: 10 }])}>+ Add item</button>}
      {options.length === 0 && <p className="muted small">{empty}</p>}
    </div>
  );
}

/** Your colonist close enough to a settlement to trade there, if any. */
function traderNear(faction: number, home: { x: number; y: number }): string | null {
  for (const e of store.mirror.entities.values()) {
    if (e.kind !== 'pawn' || e.faction !== faction || e.downed || e.prisoner) continue;
    if (Math.hypot(e.x - home.x, e.y - home.y) <= TRADE_RANGE) return e.name.split(' ')[0];
  }
  return null;
}

type Partner = { faction: number; name: string; color: number; settlement: boolean };

export function TradePanel() {
  const s = useStore();
  const me = s.me?.faction ?? 0;
  const colonies: Partner[] = s.players.filter((p) => p.faction && p.faction !== me).map((p) => ({ faction: p.faction, name: p.name, color: p.color, settlement: false }));
  const settlements: Partner[] = [...s.mirror.factions.values()]
    .filter((f) => f.settlement && f.settlement.state !== 'fallen')
    .map((f) => ({ faction: f.id, name: f.name, color: f.color, settlement: true }));
  const partners = [...colonies, ...settlements];
  const [to, setTo] = useState<number>(partners[0]?.faction ?? 0);
  const [give, setGive] = useState<Line[]>([]);
  const [want, setWant] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  if (!partners.length) {
    return (
      <div className="panel trade-panel">
        <h3>Trade</h3>
        <p className="muted">Nobody to trade with yet.</p>
      </div>
    );
  }
  const target = partners.find((p) => p.faction === to) ?? partners[0];
  const fac = s.mirror.factions.get(target.faction);
  const st = fac?.settlement;
  const lines = (l: Line[]): [string, number][] => l.map((x) => [x.item, x.count]);
  const send = () => {
    if (st) command({ c: 'settlementTrade', settlement: target.faction, give: lines(give), want: lines(want) });
    else command({ c: 'offerTrade', to: target.faction, give: lines(give), want: lines(want), note });
    setGive([]);
    setWant([]);
    setNote('');
  };
  const pick = (p: Partner) => {
    setTo(p.faction);
    setWant([]);
  };
  let settlementInfo: React.ReactNode = null;
  let blocked = false;
  if (st && fac) {
    const mood = dispositionOf(st, me);
    const factor = priceFactor(st, me);
    const trader = traderNear(me, fac.home);
    const giveV = lineValue(lines(give));
    const wantV = lineValue(lines(want)) * factor;
    blocked = mood === 'hostile' || st.state !== 'home' || !trader || giveV + 1e-9 < wantV;
    settlementInfo = (
      <div className="settlement-info">
        <p>
          <b style={{ color: hex(DISPOSITION_COLOR[mood]) }}>{mood[0].toUpperCase() + mood.slice(1)}</b>
          <span className="muted"> · goodwill {goodwillOf(st, me)} · prices ×{factor.toFixed(2)}</span>
          <button className="link" onClick={() => store.set({ focus: { x: fac.home.x, y: fac.home.y } })}>
            Show on map
          </button>
        </p>
        {mood === 'hostile' ? (
          <p className="bad small">They won't trade with you. Their guards attack your colonists on sight.</p>
        ) : st.state !== 'home' ? (
          <p className="muted small">They're on the move, fleeing the frost.</p>
        ) : trader ? (
          <p className="small">{trader} is there to make the trade. Your goods leave your stockpiles; theirs are left with {trader}.</p>
        ) : (
          <p className="muted small">Send a colonist within {TRADE_RANGE} cells of {fac.name} to trade.</p>
        )}
        {(give.length > 0 || want.length > 0) && (
          <p className={`small ${giveV + 1e-9 >= wantV ? 'good' : 'bad'}`}>
            You offer {Math.round(giveV)} worth; they ask {Math.round(wantV)}.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="panel trade-panel">
      <h3>Trade</h3>
      <div className="partners">
        {partners.map((p) => {
          const pst = s.mirror.factions.get(p.faction)?.settlement;
          const mood = pst ? dispositionOf(pst, me) : null;
          return (
            <button key={p.faction} className={p.faction === target.faction ? 'on' : ''} onClick={() => pick(p)} title={pst ? `Settlement (${mood})` : 'Player colony'}>
              <i style={{ background: hex(mood ? DISPOSITION_COLOR[mood] : p.color) }} /> {p.name}
              {pst && <small className="muted"> settlement</small>}
            </button>
          );
        })}
      </div>
      {st ? (
        settlementInfo
      ) : (
        <p className="muted small">Goods move between stockpiles only if they accept and both sides can still pay. Offers expire after 8 in-game hours.</p>
      )}
      <div className="trade-sides">
        <LineEditor title="You give" lines={give} setLines={setGive} stock={stockOf(me)} empty="Nothing in your stockpiles yet." />
        <LineEditor title="You want" lines={want} setLines={setWant} stock={stockOf(target.faction)} empty="Nothing in their stockpiles yet." />
      </div>
      {!st && <input className="trade-note" placeholder="Add a note (optional)" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />}
      <button className="primary" disabled={(!give.length && !want.length) || blocked} onClick={send}>
        {st ? 'Trade' : 'Send offer'}
      </button>
    </div>
  );
}
