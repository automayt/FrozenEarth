import { useState } from 'react';
import { ITEMS } from '@fe/defs';
import type { Item } from '@fe/sim';
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

export function TradePanel() {
  const s = useStore();
  const me = s.me?.faction ?? 0;
  const partners = s.players.filter((p) => p.faction && p.faction !== me);
  const [to, setTo] = useState<number>(partners[0]?.faction ?? 0);
  const [give, setGive] = useState<Line[]>([]);
  const [want, setWant] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  if (!partners.length) {
    return (
      <div className="panel trade-panel">
        <h3>Trade</h3>
        <p className="muted">No other colonies to trade with yet.</p>
      </div>
    );
  }
  const target = to || partners[0].faction;
  const send = () => {
    command({ c: 'offerTrade', to: target, give: give.map((l) => [l.item, l.count]), want: want.map((l) => [l.item, l.count]), note });
    setGive([]);
    setWant([]);
    setNote('');
  };
  return (
    <div className="panel trade-panel">
      <h3>Trade with another colony</h3>
      <p className="muted small">Goods move between stockpiles only if they accept and both sides can still pay. Offers expire after 8 in-game hours.</p>
      <div className="partners">
        {partners.map((p) => (
          <button key={p.id} className={p.faction === target ? 'on' : ''} onClick={() => setTo(p.faction)}>
            <i style={{ background: hex(p.color) }} /> {p.name}
          </button>
        ))}
      </div>
      <div className="trade-sides">
        <LineEditor title="You give" lines={give} setLines={setGive} stock={stockOf(me)} empty="Nothing in your stockpiles yet." />
        <LineEditor title="You want" lines={want} setLines={setWant} stock={stockOf(target)} empty="Nothing in their stockpiles yet." />
      </div>
      <input className="trade-note" placeholder="Add a note (optional)" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="primary" disabled={!give.length && !want.length} onClick={send}>
        Send offer
      </button>
    </div>
  );
}
