import { useState } from 'react';
import { BUILDINGS } from '@fe/defs';
import type { Building, Pawn } from '@fe/sim';
import { store, useStore } from '../store';

interface Step {
  done: boolean;
  title: string;
  how: string;
}

/** What a new colony needs to survive its first winter, ticked off from the actual world state. */
function steps(): Step[] {
  const m = store.mirror;
  const me = store.me?.faction ?? 0;
  const pawns: Pawn[] = [];
  const buildings: Building[] = [];
  for (const e of m.entities.values()) {
    if (e.kind === 'pawn' && e.faction === me) pawns.push(e);
    else if (e.kind === 'building' && e.faction === me) buildings.push(e);
  }
  const zones = [...m.zones.values()].filter((z) => z.faction === me);
  const beds = buildings.filter((b) => BUILDINGS[b.def]?.bed);
  const inRoom = (b: Building) => m.roomAt[b.y * m.w + b.x] !== 0;
  return [
    { done: zones.some((z) => z.kind === 'stockpile'), title: 'Make a stockpile', how: 'Zones → Stockpile, then drag near your supplies. Haulers will tidy everything into it.' },
    { done: zones.some((z) => z.kind === 'grow'), title: 'Plant crops', how: 'Zones → Grow potatoes (or rice or corn) on good soil. Crops need warmth to grow.' },
    { done: pawns.length > 0 && beds.length >= pawns.length, title: 'A bed for everyone', how: 'Furniture → Bed. Sleeping on the ground is cold and miserable.' },
    { done: buildings.some(inRoom), title: 'Wall in a room', how: 'Structure → Wood wall, drag a rectangle (it builds the outline), and add a Wood door.' },
    { done: buildings.some((b) => BUILDINGS[b.def]?.recipes?.some((r) => r.startsWith('cook')) && b.bills.length > 0), title: 'Start cooking', how: 'Production → Campfire, then select it and add a "Cook simple meal" bill.' },
    { done: buildings.some((b) => (BUILDINGS[b.def]?.heat ?? 0) > 0 && inRoom(b) && b.def !== 'campfire'), title: 'Heat a room', how: 'Temperature → Wood heater inside an enclosed room. Winter nights kill.' },
    { done: pawns.some((p) => p.apparel.includes('parka')) || buildings.some((b) => b.def === 'tailor_bench'), title: 'Get parkas', how: "Production → Tailor's bench, then a \"Sew a parka\" bill. Parkas let colonists work outside in winter." },
    {
      done: [...m.factions.values()].some((f) => f.settlement?.met.includes(me)),
      title: 'Meet a neighbour',
      how: 'Towns are the diamonds on the minimap: green ones trade gladly, red ones attack. Walk a colonist toward one, then click the town to see what they want.',
    },
    { done: buildings.some((b) => b.def === 'sandbags' || b.def === 'embrasure'), title: 'Build cover', how: 'Defense → Sandbags or Embrasures facing open ground. Raiders will come; colonists behind cover are much harder to hit.' },
  ];
}

const KEY = 'fe.checklist.hidden';

export function Checklist() {
  useStore();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(true);
  if (hidden || !store.me?.faction) return null;
  const list = steps();
  const done = list.filter((s) => s.done).length;
  const next = list.find((s) => !s.done);
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // ignore
    }
  };
  return (
    <div className="panel checklist">
      <div className="checklist-head">
        <button className="link" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'} Getting started <span className="muted">{done}/{list.length}</span>
        </button>
        <button className="link muted" onClick={hide} title="Hide for good">
          ×
        </button>
      </div>
      {open && (
        <ul>
          {list.map((s) => (
            <li key={s.title} className={s.done ? 'done' : ''} title={s.how}>
              <span className="tick">{s.done ? '✓' : '○'}</span>
              <span>
                {s.title}
                {s === next && <small>{s.how}</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
