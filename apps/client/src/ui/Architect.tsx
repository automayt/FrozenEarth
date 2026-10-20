import { BUILD_CATEGORIES, BUILDINGS, ITEMS, SOWABLE_PLANTS, type BuildCategory } from '@fe/defs';
import { store, useStore, type Tool } from '../store';
import { myPawnsAll, myPlayer, mySquad, toggleDraft } from '../actions';
import { Icon } from './Icon';

type Cat = 'orders' | 'zones' | BuildCategory;

const ORDERS: { label: string; tool: Tool; hint: string }[] = [
  { label: 'Mine', tool: { kind: 'designate', what: 'mine' }, hint: 'Drag over rock to mine it for stone and ore' },
  { label: 'Chop wood', tool: { kind: 'designate', what: 'chop' }, hint: 'Drag over trees to cut them for wood' },
  { label: 'Harvest', tool: { kind: 'designate', what: 'harvest' }, hint: 'Harvest wild berries and crops' },
  { label: 'Cut plants', tool: { kind: 'designate', what: 'cut' }, hint: 'Clear any plants' },
  { label: 'Hunt', tool: { kind: 'hunt' }, hint: 'Drag over animals to mark them. Hunters with a bow or rifle bring them down for meat and hides.' },
  { label: 'Deconstruct', tool: { kind: 'deconstruct' }, hint: 'Remove your buildings (refunds 75%)' },
  { label: 'Steal', tool: { kind: 'designate', what: 'steal' }, hint: "Mark goods in a settlement's or another colony's stockpile: your haulers sneak in after dark to carry them off. Locked doors keep them out. Anyone awake who sees it raises the alarm. To send someone right now, draft them and right-click the goods." },
  { label: 'Move colony', tool: { kind: 'moveHome' }, hint: 'Plan the journey inward: click where to go (shift-click for waypoints), pick who goes and what they take, then set out. Pack up the old site first to carry beds and benches as kits.' },
  { label: 'Pack up', tool: { kind: 'packUp' }, hint: 'Strip an area before moving: beds, benches and heaters fold into kits to carry; walls and floors come apart (75% back); zones and blueprints go' },
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

/** The panels the bar opens, with their hotkeys. */
const PANELS: { key: 'work' | 'colonists' | 'trade' | 'diplomacy' | 'chronicle' | 'events'; label: string; hotkey?: string; title: string }[] = [
  { key: 'work', label: 'Work', hotkey: 'P', title: 'Who does what: work priorities (P)' },
  { key: 'colonists', label: 'Colonists', hotkey: 'L', title: 'Everyone in your colony (L)' },
  { key: 'trade', label: 'Trade', hotkey: 'T', title: 'Trade with towns and other colonies (T)' },
  { key: 'diplomacy', label: 'Diplomacy', hotkey: 'G', title: 'Alliances, rivalries, war and peace (G)' },
  { key: 'chronicle', label: 'Story', hotkey: 'J', title: "Your colony's story and milestones (J)" },
  { key: 'events', label: 'Events', title: 'Host tool: trigger events' },
];

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
    <button className={`slot draft ${allDrafted ? 'on' : ''}`} onClick={toggleDraft} title="Drafted colonists stop working and follow orders: right-click to move, right-click an enemy to attack (R)">
      <Icon name="draft" />
      <span className="slot-label">{label}</span>
      <kbd className="slot-key">R</kbd>
    </button>
  );
}

export function Architect() {
  const s = useStore();
  const open = s.menu as Cat | null;
  const setOpen = (menu: Cat | null) => store.set({ menu, panel: 'none' });
  // A fresh plan each time the Move colony tool is picked.
  const pick = (tool: Tool) => store.set({ tool, selected: null, journey: null });
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
            ? 'click where the colony should go, shift-click to add a waypoint'
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
      <div className="panel bar" role="toolbar" aria-label="Commands">
        <div className="slots">
          {cats.map((c) => (
            <button key={c.key} className={`slot ${open === c.key ? 'on' : ''}`} onClick={() => setOpen(open === c.key ? null : c.key)} aria-expanded={open === c.key} title={c.hotkey ? `${c.label} (${c.hotkey})` : c.label}>
              <Icon name={c.key} />
              <span className="slot-label">{c.label}</span>
              {c.hotkey && <kbd className="slot-key">{c.hotkey}</kbd>}
            </button>
          ))}
        </div>
        <span className="rivet" aria-hidden="true" />
        <div className="slots">
          <DraftButton />
        </div>
        <span className="rivet" aria-hidden="true" />
        <div className="slots">
          {PANELS.filter((p) => p.key !== 'events' || myPlayer()?.admin).map((p) => (
            <button key={p.key} className={`slot ${s.panel === p.key ? 'on' : ''}`} onClick={() => store.set({ panel: s.panel === p.key ? 'none' : p.key, menu: null })} title={p.title}>
              <Icon name={p.key} />
              <span className="slot-label">{p.label}</span>
              {p.hotkey && <kbd className="slot-key">{p.hotkey}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
