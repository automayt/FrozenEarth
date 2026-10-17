import { BUILD_CATEGORIES, BUILDINGS, ITEMS, SOWABLE_PLANTS, type BuildCategory } from '@fe/defs';
import { store, useStore, type Tool } from '../store';
import { myPlayer, mySquad, toggleDraft } from '../actions';

type Cat = 'orders' | 'zones' | BuildCategory;

const ORDERS: { label: string; tool: Tool; hint: string }[] = [
  { label: 'Mine', tool: { kind: 'designate', what: 'mine' }, hint: 'Drag over rock to mine it for stone and ore' },
  { label: 'Chop wood', tool: { kind: 'designate', what: 'chop' }, hint: 'Drag over trees to cut them for wood' },
  { label: 'Harvest', tool: { kind: 'designate', what: 'harvest' }, hint: 'Harvest wild berries and crops' },
  { label: 'Cut plants', tool: { kind: 'designate', what: 'cut' }, hint: 'Clear any plants' },
  { label: 'Hunt', tool: { kind: 'hunt' }, hint: 'Drag over animals to mark them. Hunters with a bow or rifle bring them down for meat and hides.' },
  { label: 'Deconstruct', tool: { kind: 'deconstruct' }, hint: 'Remove your buildings (refunds 75%)' },
  { label: 'Steal', tool: { kind: 'designate', what: 'steal' }, hint: "Mark goods in a settlement's stores: your haulers sneak in after dark to carry them off. Anyone awake who sees it raises the alarm. To send someone right now, draft them and right-click the goods." },
  { label: 'Move colony', tool: { kind: 'moveHome' }, hint: 'Click a new home site. Colonists gather there; frost warnings follow.' },
  { label: 'Pack up', tool: { kind: 'packUp' }, hint: 'Strip an area: remove zones, take down buildings (75% back), cancel blueprints' },
  { label: 'Cancel', tool: { kind: 'designate', what: 'cancel' }, hint: 'Cancel orders and blueprints' },
];

const ZONES: { label: string; tool: Tool; hint: string }[] = [
  { label: 'Stockpile', tool: { kind: 'zone', zone: 'stockpile' }, hint: 'Haulers bring items here' },
  ...SOWABLE_PLANTS.map((p) => ({ label: `Grow ${p.label.replace(' plant', '')}`, tool: { kind: 'zone', zone: 'grow', plant: p.key } as Tool, hint: `Sow ${p.label.toLowerCase()} (${p.growDays} days)` })),
  { label: 'Remove zone', tool: { kind: 'unzone' }, hint: 'Erase your zones' },
];

function costText(cost: Record<string, number>): string {
  const parts = Object.entries(cost).map(([k, n]) => `${n} ${ITEMS[k]?.label.toLowerCase() ?? k}`);
  return parts.length ? parts.join(', ') : 'free';
}

function sameTool(a: Tool, b: Tool): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Draft or release the selected colonists (or everyone, with nobody selected). */
function DraftButton() {
  const squad = mySquad().filter((p) => !p.downed);
  const allDrafted = squad.length > 0 && squad.every((p) => p.drafted);
  const label = squad.length ? (allDrafted ? 'Undraft' : 'Draft') : 'Draft all';
  return (
    <button className={`draft ${allDrafted ? 'on' : ''}`} onClick={toggleDraft} title="Drafted colonists stop working and follow orders: right-click to move, right-click an enemy to attack (R)">
      {label} <small>R</small>
    </button>
  );
}

export function Architect() {
  const s = useStore();
  const open = s.menu as Cat | null;
  const setOpen = (menu: Cat | null) => store.set({ menu, panel: 'none' });
  const pick = (tool: Tool) => store.set({ tool, selected: null });
  const cats: { key: Cat; label: string }[] = [{ key: 'orders', label: 'Orders' }, { key: 'zones', label: 'Zones' }, ...BUILD_CATEGORIES];
  let items: { label: string; tool: Tool; hint: string }[] = [];
  if (open === 'orders') items = ORDERS;
  else if (open === 'zones') items = ZONES;
  else if (open)
    items = Object.values(BUILDINGS)
      .filter((b) => b.category === open)
      .map((b) => ({ label: b.label, tool: { kind: 'build', def: b.key }, hint: `Costs ${costText(b.cost)}` }));

  return (
    <div className="architect">
      {open && (
        <div className="panel tool-menu">
          {items.map((it) => (
            <button key={it.label} className={sameTool(s.tool, it.tool) ? 'on' : ''} onClick={() => pick(it.tool)} title={it.hint}>
              <span>{it.label}</span>
              <small>{it.hint}</small>
            </button>
          ))}
        </div>
      )}
      <div className="panel bar">
        {cats.map((c) => (
          <button key={c.key} className={open === c.key ? 'on' : ''} onClick={() => setOpen(open === c.key ? null : c.key)}>
            {c.label}
          </button>
        ))}
        <span className="sep" />
        <DraftButton />
        <button className={s.panel === 'work' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'work' ? 'none' : 'work', menu: null })}>
          Work
        </button>
        <button className={s.panel === 'colonists' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'colonists' ? 'none' : 'colonists', menu: null })}>
          Colonists
        </button>
        <button className={s.panel === 'trade' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'trade' ? 'none' : 'trade', menu: null })}>
          Trade
        </button>
        {myPlayer()?.admin && (
          <button className={s.panel === 'events' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'events' ? 'none' : 'events', menu: null })} title="Host tool: trigger events">
            Events
          </button>
        )}
        {s.tool.kind !== 'select' && (
          <span className="tool-hint">{s.tool.kind === 'moveHome' ? 'Click the new home site · right-click or Esc to cancel' : 'Drag to apply · right-click or Esc to stop'}</span>
        )}
        {s.tool.kind === 'select' && mySquad().some((p) => p.drafted) && (
          <span className="tool-hint">Right-click: move · right-click someone else's pawn: attack</span>
        )}
      </div>
    </div>
  );
}
