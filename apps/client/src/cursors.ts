import { attackRefusal, type Pawn } from '@fe/sim';
import { mySquad } from './actions';
import { store, type Tool } from './store';

/**
 * Hand-drawn cursors, one per kind of thing the mouse is about to do. Each is a 32 px SVG set as a
 * --cur-* custom property; game.css says where each applies. The map's cursor follows the active
 * tool and what's under the mouse, through the data-cursor attribute on <html>.
 */
export type MapCursor = 'pointer' | 'build' | 'attack' | 'haul' | 'grabbing';

const INK = '#11151d';

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

/** A spearhead: the tip is the hotspot. */
const spear = (fill: string, edge: string) => svg(`<path d="M3 3 27 11.5 17.6 15 13.8 26Z" fill="${fill}" stroke="${INK}" stroke-width="2.4"/><path d="M6.4 6.4 16.4 14.6" stroke="${edge}" stroke-width="1.6"/>`);

export const CURSOR_ART = {
  arrow: { art: spear('#eadfc8', '#8a6a2f'), x: 3, y: 3 },
  // Ember means you can act on it, on the cursor as everywhere else.
  act: { art: spear('#ff9a3c', '#7a3d0c'), x: 3, y: 3 },
  build: {
    art: svg(`<path d="M15 14.5 26.5 26" stroke="${INK}" stroke-width="6"/><path d="M15 14.5 26.5 26" stroke="#b98a4e" stroke-width="3"/><path d="m5 11 7.5-7.5 3.5 2-1 2 4.5 4.5-4 4-4.5-4.5-2 1z" fill="#c3ccd4" stroke="${INK}" stroke-width="2.2"/>`),
    x: 5,
    y: 11,
  },
  attack: {
    art: svg(
      `<path d="M3 3 8.5 4 23 18.5l-4.5 4.5L4 8.5z" fill="#eadfc8" stroke="${INK}" stroke-width="2.2"/><path d="M6 6 19 19" stroke="#e0614b" stroke-width="1.6"/><path d="m15.5 24 8.5-8.5M21.5 21.5l5 5" stroke="${INK}" stroke-width="5"/><path d="m15.5 24 8.5-8.5" stroke="#c9a45c" stroke-width="2.4"/><path d="m21.5 21.5 5 5" stroke="#e0614b" stroke-width="2.6"/>`,
    ),
    x: 3,
    y: 3,
  },
  haul: {
    art: svg(
      `<path d="M4 3v5.5a3 3 0 0 0 3 3h3" stroke="${INK}" stroke-width="4.4"/><path d="M4 3v5.5a3 3 0 0 0 3 3h3" stroke="#c9a45c" stroke-width="2"/><path d="M15 8.5c-1.6 2-6.5 6.4-6.5 12.5 0 4 3 6.5 8 6.5s8-2.5 8-6.5c0-6.1-4.9-10.5-6.5-12.5z" fill="#b98a4e" stroke="${INK}" stroke-width="2.2"/><path d="M13 12h6" stroke="#eadfc8" stroke-width="2"/>`,
    ),
    x: 4,
    y: 3,
  },
  grabbing: {
    art: svg(
      `<path d="M8.5 13c0-2 2.6-2.6 3.5-1 0-2.2 3-2.6 3.8-.6.4-2 3.5-1.9 3.9.3.9-1.4 3.6-.8 3.6 1.3v7.5c0 4-3 7-7.2 7-3.7 0-5.6-1.8-7.3-5l-2.3-4.3c-1-2 1.2-3.5 2.6-2.2z" fill="#eadfc8" stroke="${INK}" stroke-width="2.2"/><path d="M12 12v3.5M15.8 11.4v4M19.7 11.8v3.7" stroke="${INK}" stroke-width="1.5"/>`,
    ),
    x: 15,
    y: 16,
  },
};

/** What `cursor:` needs for one piece of art, with the system cursor as a fallback. */
export function cursorValue(name: keyof typeof CURSOR_ART, fallback: string): string {
  const c = CURSOR_ART[name];
  return `url("data:image/svg+xml,${encodeURIComponent(c.art)}") ${c.x} ${c.y}, ${fallback}`;
}

/** What the active tool's cursor is, before looking at what's under the mouse. */
export function cursorForTool(tool: Tool): MapCursor {
  switch (tool.kind) {
    case 'build':
    case 'zone':
    case 'unzone':
    case 'deconstruct':
      return 'build';
    case 'hunt':
      return 'attack';
    case 'packUp':
    case 'moveHome':
      return 'haul';
    case 'designate':
      if (tool.what === 'steal' || tool.what === 'harvest') return 'haul';
      return tool.what === 'cancel' ? 'pointer' : 'build';
    default:
      return 'pointer';
  }
}

/** With drafted colonists selected, the mouse says what a right-click on this cell would do. */
function orderCursor(): MapCursor {
  const cell = store.hoverCell;
  const me = store.me?.faction;
  if (cell === null || !me || !mySquad().some((p) => p.drafted)) return 'pointer';
  const m = store.mirror;
  const x = cell % m.w;
  const y = Math.floor(cell / m.w);
  for (const e of m.entities.values()) {
    if (e.kind !== 'pawn' || e.x !== x || e.y !== y || e.faction === me) continue;
    const p = e as Pawn;
    if (p.downed && m.factions.get(p.faction)?.raid) return 'haul';
    if (!attackRefusal(m, me, p.faction)) return 'attack';
  }
  return m.get(m.itemAt[cell])?.kind === 'item' ? 'haul' : 'pointer';
}

let panning = false;
let shown = '';

function refresh(): void {
  const next = panning ? 'grabbing' : store.tool.kind === 'select' ? orderCursor() : cursorForTool(store.tool);
  if (next === shown) return;
  shown = next;
  document.documentElement.dataset.cursor = next;
}

export function installCursors(): void {
  const root = document.documentElement.style;
  root.setProperty('--cur-arrow', cursorValue('arrow', 'default'));
  root.setProperty('--cur-act', cursorValue('act', 'pointer'));
  root.setProperty('--cur-build', cursorValue('build', 'crosshair'));
  root.setProperty('--cur-attack', cursorValue('attack', 'crosshair'));
  root.setProperty('--cur-haul', cursorValue('haul', 'pointer'));
  root.setProperty('--cur-grabbing', cursorValue('grabbing', 'grabbing'));
  store.subscribe(refresh);
  // The camera drag belongs to render/input.ts; this only watches it to change the picture.
  window.addEventListener('pointerdown', (e) => {
    if ((e.button === 1 || e.button === 2) && (e.target as HTMLElement | null)?.tagName === 'CANVAS') {
      panning = true;
      refresh();
    }
  });
  for (const ev of ['pointerup', 'blur'] as const) {
    window.addEventListener(ev, () => {
      if (!panning) return;
      panning = false;
      refresh();
    });
  }
  refresh();
}
