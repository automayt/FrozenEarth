import { BUILDINGS, CONDITIONS, ITEM_CATEGORIES, ITEMS, PLANTS, RECIPES, ROCKS, SOWABLE_PLANTS, TERRAINS, TRAITS } from '@fe/defs';
import { describeJob, outdoorTempAt, stageOf, TICKS_PER_HOUR, type Building, type Construct, type Entity, type Pawn, type Zone } from '@fe/sim';
import { command } from '../net';
import { store, useStore } from '../store';
import { hex, pct } from './util';

export function Inspect() {
  const s = useStore();
  const m = s.mirror;
  const e = s.selected ? m.get(s.selected) : undefined;
  const cell = s.selectedCell;
  if (!e && cell === null) return null;
  return (
    <div className="panel inspect">
      <button className="close" onClick={() => store.set({ selected: null, selectedCell: null })}>
        ×
      </button>
      {e ? <EntityInfo e={e} /> : null}
      {cell !== null && <CellInfo cell={cell} />}
    </div>
  );
}

function factionTag(id: number) {
  const f = store.mirror.factions.get(id);
  if (!f) return null;
  return (
    <span className="faction">
      <i style={{ background: hex(f.color) }} />
      {f.name}
      {id === store.me?.faction ? ' (you)' : ''}
    </span>
  );
}

function Bar({ label, v, warn = 0.25 }: { label: string; v: number; warn?: number }) {
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="meter">
        <div className={v < warn ? 'low' : ''} style={{ width: pct(v) }} />
      </div>
      <small>{pct(v)}</small>
    </div>
  );
}

function EntityInfo({ e }: { e: Entity }) {
  switch (e.kind) {
    case 'pawn':
      return <PawnInfo p={e} />;
    case 'building':
      return <BuildingInfo b={e} />;
    case 'construct':
      return <ConstructInfo c={e} />;
    case 'item': {
      const d = ITEMS[e.def];
      return (
        <>
          <h3>
            {d.label} ×{e.count}
          </h3>
          {d.spoilDays ? <p className="muted">Freshness {pct(1 - e.rot)} · spoils in about {Math.max(0, (1 - e.rot) * d.spoilDays).toFixed(1)} days at room temperature</p> : null}
        </>
      );
    }
    case 'plant': {
      const d = PLANTS[e.def];
      return (
        <>
          <h3>{d.label}</h3>
          <Bar label="Growth" v={e.growth} warn={0} />
          {e.blighted && <p className="bad">Blighted: it will die soon.</p>}
          {d.yieldItem && <p className="muted">Yields {ITEMS[d.yieldItem].label.toLowerCase()} when {d.tree ? 'cut' : 'harvested'}.</p>}
        </>
      );
    }
  }
}

function PawnInfo({ p }: { p: Pawn }) {
  const lookup = (id: number) => store.mirror.get(id);
  return (
    <>
      <h3>{p.name}</h3>
      {factionTag(p.faction)}
      <p className="job">{describeJob(p.job, lookup)}</p>
      <Bar label="Food" v={p.needs.food} />
      <Bar label="Rest" v={p.needs.rest} />
      <Bar label="Mood" v={p.needs.mood} warn={0.3} />
      {p.carrying && (
        <p className="muted">
          Carrying {p.carrying.count} {ITEMS[p.carrying.def]?.label.toLowerCase()}
        </p>
      )}
      {p.traits.length > 0 && (
        <div className="traits">
          {p.traits.map((t) => (
            <span key={t} className="chip" title={TRAITS[t]?.description}>
              {TRAITS[t]?.label ?? t}
            </span>
          ))}
        </div>
      )}
      {p.conditions.length > 0 && (
        <div className="health">
          <h4>Health</h4>
          {p.conditions.map((c) => {
            const def = CONDITIONS[c.key];
            if (!def) return null;
            const st = stageOf(def, c.severity);
            const timed = !!def.hours;
            const tone = def.kind === 'buff' || (def.kind === 'mood' && (st.mood ?? 0) > 0) ? 'good' : 'bad';
            return (
              <div key={c.key} className={`condition ${tone}`} title={def.description}>
                <span>
                  {def.label}
                  {st.label ? ` (${st.label})` : ''}
                </span>
                {timed ? (
                  <small>{Math.max(0, Math.ceil((c.until - store.mirror.tick) / TICKS_PER_HOUR))}h left</small>
                ) : def.immunityPerDay ? (
                  <small>
                    severity {Math.round(c.severity * 100)}% · immunity {Math.round(c.immunity * 100)}%
                  </small>
                ) : (
                  <small>{Math.round(c.severity * 100)}%</small>
                )}
              </div>
            );
          })}
        </div>
      )}
      {p.thoughts.length > 0 && (
        <ul className="thoughts">
          {p.thoughts.map((t) => (
            <li key={t} className={t.includes('+') ? 'good' : 'bad'}>
              {t}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ConstructInfo({ c }: { c: Construct }) {
  const d = BUILDINGS[c.def];
  return (
    <>
      <h3>{d.label} (blueprint)</h3>
      {factionTag(c.faction)}
      {Object.entries(d.cost).map(([k, n]) => (
        <p key={k} className="muted">
          {ITEMS[k].label}: {c.delivered[k] ?? 0} / {n}
        </p>
      ))}
      <Bar label="Built" v={c.progress / d.work} warn={0} />
    </>
  );
}

function BuildingInfo({ b }: { b: Building }) {
  const d = BUILDINGS[b.def];
  const mine = b.faction === store.me?.faction;
  const owner = b.owner ? store.mirror.get<Pawn>(b.owner) : undefined;
  return (
    <>
      <h3>{d.label}</h3>
      {factionTag(b.faction)}
      {d.bed && <p className="muted">{owner ? `Owned by ${owner.name}` : 'Unclaimed'}</p>}
      {d.heat ? <p className="muted">{d.heat > 0 ? 'Heats' : 'Cools'} an enclosed room toward {d.targetTemp}°C</p> : null}
      {d.recipes && mine && <Bills b={b} />}
    </>
  );
}

function Bills({ b }: { b: Building }) {
  const recipes = BUILDINGS[b.def].recipes ?? [];
  return (
    <div className="bills">
      <h4>Bills</h4>
      {b.bills.length === 0 && <p className="muted small">No bills. Add one to start production.</p>}
      {b.bills.map((bill) => (
        <div key={bill.id} className={`bill ${bill.suspended ? 'suspended' : ''}`}>
          <span>{RECIPES[bill.recipe].label}</span>
          <select value={bill.mode} onChange={(e) => command({ c: 'updateBill', bench: b.id, bill: bill.id, mode: e.target.value as 'count' })}>
            <option value="count">Do X times</option>
            <option value="until">Until you have X</option>
            <option value="forever">Forever</option>
          </select>
          {bill.mode !== 'forever' && (
            <input type="number" min={0} max={999} value={bill.target} onChange={(e) => command({ c: 'updateBill', bench: b.id, bill: bill.id, target: Number(e.target.value) })} />
          )}
          <button title="Pause or resume this bill" onClick={() => command({ c: 'updateBill', bench: b.id, bill: bill.id, suspended: !bill.suspended })}>
            {bill.suspended ? '▶' : '❚❚'}
          </button>
          <button title="Delete bill" onClick={() => command({ c: 'removeBill', bench: b.id, bill: bill.id })}>
            ×
          </button>
        </div>
      ))}
      <div className="add-bill">
        {recipes.map((r) => (
          <button key={r} onClick={() => command({ c: 'addBill', bench: b.id, recipe: r, mode: 'count', target: 5 })}>
            + {RECIPES[r].label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CellInfo({ cell }: { cell: number }) {
  const m = store.mirror;
  const rock = m.rock[cell];
  const room = m.roomAt[cell] ? m.rooms.get(m.roomAt[cell]) : undefined;
  const temp = room ? room.temp : outdoorTempAt(store.estTick(), m.coldOffset, m.conditions);
  const zone = m.zoneAt[cell] ? m.zones.get(m.zoneAt[cell]) : undefined;
  const t = TERRAINS[m.terrain[cell]];
  return (
    <div className="cell-info">
      <p className="muted small">
        {rock ? ROCKS[rock].label : t.label}
        {!rock && t.fertility > 0 ? ` · fertility ${Math.round(t.fertility * 100)}%` : ''} · {temp.toFixed(1)}°C {room ? `indoors (${room.cells.length} cells)` : 'outdoors'}
      </p>
      {zone && <ZoneInfo z={zone} />}
    </div>
  );
}

function ZoneInfo({ z }: { z: Zone }) {
  const mine = z.faction === store.me?.faction;
  return (
    <div className="zone">
      <h4>
        {z.kind === 'grow' ? 'Growing zone' : 'Stockpile'} · {z.cells.length} cells
      </h4>
      {factionTag(z.faction)}
      {mine && z.kind === 'grow' && (
        <select value={z.plant} onChange={(e) => command({ c: 'zoneSettings', zone: z.id, plant: e.target.value })}>
          {SOWABLE_PLANTS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label} ({p.growDays} days)
            </option>
          ))}
        </select>
      )}
      {mine && z.kind === 'stockpile' && (
        <div className="allow">
          {ITEM_CATEGORIES.map((c) => (
            <label key={c.key}>
              <input
                type="checkbox"
                checked={z.allow.includes(c.key)}
                onChange={(e) =>
                  command({ c: 'zoneSettings', zone: z.id, allow: e.target.checked ? [...z.allow, c.key] : z.allow.filter((a) => a !== c.key) })
                }
              />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
