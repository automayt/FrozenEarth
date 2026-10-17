import { BUILD_CATEGORIES, BUILDINGS, ITEMS, SOWABLE_PLANTS, type BuildCategory } from '@fe/defs';
import { store, useStore, type Tool } from '../store';
import { myPawnsAll, myPlayer, mySquad, toggleDraft } from '../actions';

type Cat = 'orders' | 'zones' | BuildCategory;

const ORDERS: { label: string; tool: Tool; hint: string }[] = [
  { label: 'Mine', tool: { kind: 'designate', what: 'mine' }, hint: 'Drag over rock to mine it for stone and ore' },
  { label: 'Chop wood', tool: { kind: 'designate', what: 'chop' }, hint: 'Drag over trees to cut them for wood' },
  { label: 'Harvest', tool: { kind: 'designate', what: 'harvest' }, hint: 'Harvest wild berries and crops' },
  { label: 'Cut plants', tool: { kind: 'designate', what: 'cut' }, hint: 'Clear any plants' },
  { label: 'Hunt', tool: { kind: 'hunt' }, hint: 'Drag over animals to mark them. Hunters with a bow or rifle bring them down for meat and hides.' },
  { label: 'Deconstruct', tool: { kind: 'deconstruct' }, hint: 'Remove your buildings (refunds 75%)' },
  { label: 'Steal', tool: { kind: 'designate', what: 'steal' }, hint: "Mark goods in a settlement's or another colony's stockpile: your haulers sneak in after dark to carry them off. Locked doors keep them out. Anyone awake who sees it raises the alarm. To send someone right now, draft them and right-click the goods." },
  { label: 'Move colony', tool: { kind: 'moveHome' }, hint: 'Pick a new home further in, away from the frost: hover to compare how long each spot stays warm, then click. Afterwards, Pack up the old site.' },
  { label: 'Pack up', tool: { kind: 'packUp' }, hint: 'Strip an area: remove zones, take down buildings (75% back), cancel blueprints' },
  { label: 'Cancel', tool: { kind: 'designate', what: 'cancel' }, hint: 'Cancel orders and blueprints' },
];

const ZONES: { label: string; tool: Tool; hint: string }[] = [
  { label: 'Stockpile', tool: { kind: 'zone', zone: 'stockpile' }, hint: 'Haulers bring items here' },
  ...SOWABLE_PLANTS.map((p) => ({ label: `Grow ${p.label.replace(' plant', '')}`, tool: { kind: 'zone', zone: 'grow', plant: p.key } as Tool, hint: `Sow ${p.label.toLowerCase()} (${p.growDays} days)` })),
  { label: 'Remove zone', tool: { kind: 'unzone' }, hint: 'Erase your zones' },
];

/** What each building is for, shown under its name in the build menu. */
const BUILD_HINTS: Record<string, string> = {
  wood_wall: 'Encloses rooms. Drag a rectangle: only the outline is built.',
  stone_wall: 'Tougher than wood. Drag a rectangle for the outline.',
  door: 'The way into a room. Counts as wall for keeping heat in, and keeps strangers out.',
  sandbags: 'Low cover: colonists crouched behind it are much harder to hit. Can be seen and stepped over.',
  embrasure: 'A wall with a firing slit: shoot and see through it, nobody walks through.',
  bed: 'One per colonist. Prisoners need one too.',
  campfire: 'Cook simple meals (add a bill) and warm yourselves outdoors.',
  stove: 'Cooks meals, four at a time if you like.',
  crafting_spot: 'Free. Stone blocks, cloth and clubs.',
  workbench: 'Tools and weapons: knives, bows for hunting, rifles.',
  tailor_bench: 'Clothes, including parkas for winter.',
  heater: 'Heats an enclosed room. Winter nights kill.',
  cooler: 'Cools an enclosed room in a heat wave.',
};

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
  // With nobody selected the button acts on everyone, so it says what it will do to everyone.
  const who = squad.length ? squad : myPawnsAll().filter((p) => !p.downed);
  const allDrafted = who.length > 0 && who.every((p) => p.drafted);
  const label = squad.length ? (allDrafted ? 'Undraft' : 'Draft') : allDrafted ? 'Undraft all' : 'Draft all';
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
  const cats: { key: Cat; label: string; hotkey?: string }[] = [
    { key: 'orders', label: 'Orders', hotkey: 'O' },
    { key: 'zones', label: 'Zones', hotkey: 'Z' },
    ...BUILD_CATEGORIES.map((c) => ({ ...c, hotkey: c.key === 'structure' ? 'B' : undefined })),
  ];
  const toolLabel = s.tool.kind === 'select' ? '' : [...ORDERS, ...ZONES].find((it) => sameTool(it.tool, s.tool))?.label ?? (s.tool.kind === 'build' ? BUILDINGS[s.tool.def]?.label : '');
  let items: { label: string; tool: Tool; hint: string }[] = [];
  if (open === 'orders') items = ORDERS;
  else if (open === 'zones') items = ZONES;
  else if (open)
    items = Object.values(BUILDINGS)
      .filter((b) => b.category === open)
      .map((b) => ({ label: b.label, tool: { kind: 'build', def: b.key }, hint: `${BUILD_HINTS[b.key] ? BUILD_HINTS[b.key] + ' ' : ''}Costs ${costText(b.cost)}.` }));

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
      {s.tool.kind !== 'select' && (
        <div className="panel tool-hint" role="status">
          <b>{toolLabel}</b> · {s.tool.kind === 'moveHome'
            ? 'click the new home site'
            : s.tool.kind === 'build'
              ? 'drag to place'
              : s.tool.kind === 'hunt'
                ? 'drag over animals'
                : s.tool.kind === 'designate' && s.tool.what === 'steal'
                  ? 'drag over goods; haulers go after dark'
                  : 'drag over an area'} · right-click or Esc to stop
          <button className="link" onClick={() => store.set({ tool: { kind: 'select' } })}>
            Done
          </button>
        </div>
      )}
      {s.tool.kind === 'select' && mySquad().some((p) => p.drafted) && (
        <div className="panel tool-hint">Right-click: move · on someone: attack · on goods: steal or pick up · R: back to work</div>
      )}
      <div className="panel bar">
        {cats.map((c) => (
          <button key={c.key} className={open === c.key ? 'on' : ''} onClick={() => setOpen(open === c.key ? null : c.key)} aria-expanded={open === c.key} title={c.hotkey ? `${c.label} (${c.hotkey})` : c.label}>
            {c.label}
            {c.hotkey && <small className="hotkey">{c.hotkey}</small>}
          </button>
        ))}
        <span className="sep" />
        <DraftButton />
        <button className={s.panel === 'work' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'work' ? 'none' : 'work', menu: null })}>
          Work <small className="hotkey">P</small>
        </button>
        <button className={s.panel === 'colonists' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'colonists' ? 'none' : 'colonists', menu: null })}>
          Colonists <small className="hotkey">L</small>
        </button>
        <button className={s.panel === 'trade' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'trade' ? 'none' : 'trade', menu: null })}>
          Trade <small className="hotkey">T</small>
        </button>
        <button className={s.panel === 'diplomacy' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'diplomacy' ? 'none' : 'diplomacy', menu: null })} title="Alliances, rivalries, war and peace (G)">
          Diplomacy <small className="hotkey">G</small>
        </button>
        {myPlayer()?.admin && (
          <button className={s.panel === 'events' ? 'on' : ''} onClick={() => store.set({ panel: s.panel === 'events' ? 'none' : 'events', menu: null })} title="Host tool: trigger events">
            Events
          </button>
        )}
      </div>
    </div>
  );
}
