import { T } from '@fe/defs';
import { tell } from './chronicle';
import { bearing } from './landmarks';
import type { World } from './world';

/**
 * The frost as a character that changes the map: when most of a lake has frozen, the colonies
 * near it hear that the ice will bear them now, a new way across. Lakes are worked out from the
 * map when first needed (not saved): ice already there counts as frozen, so nothing repeats
 * after a restart.
 */

/** Lakes smaller than this aren't worth a letter. */
const MIN_LAKE = 60;
/** Share of a lake that must be ice before it counts as a crossing. */
const FROZEN_SHARE = 0.7;
/** Colonies with a home this close to a lake hear about it. */
const NEWS_RANGE = 90;

interface Lakes {
  of: Int32Array;
  size: number[];
  ice: number[];
  sx: number[];
  sy: number[];
}

const lakes = new WeakMap<World, Lakes>();

const isWater = (t: number) => t === T.deep_water || t === T.shallow_water || t === T.ice;

function findLakes(w: World): Lakes {
  const m = w.map;
  const of = new Int32Array(m.n).fill(-1);
  const out: Lakes = { of, size: [], ice: [], sx: [], sy: [] };
  const stack: number[] = [];
  for (let s = 0; s < m.n; s++) {
    if (of[s] >= 0 || !isWater(m.terrain[s])) continue;
    const id = out.size.length;
    let size = 0;
    let ice = 0;
    let sx = 0;
    let sy = 0;
    of[s] = id;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      if (m.terrain[c] === T.ice) ice++;
      const x = c % m.w;
      const y = (c / m.w) | 0;
      sx += x;
      sy += y;
      for (const d of [x > 0 ? c - 1 : -1, x < m.w - 1 ? c + 1 : -1, y > 0 ? c - m.w : -1, y < m.h - 1 ? c + m.w : -1]) {
        if (d < 0 || of[d] >= 0 || !isWater(m.terrain[d])) continue;
        of[d] = id;
        stack.push(d);
      }
    }
    out.size.push(size);
    out.ice.push(ice);
    out.sx.push(sx / size);
    out.sy.push(sy / size);
  }
  return out;
}

/** A water cell just froze. */
export function iceFormed(w: World, cell: number): void {
  let l = lakes.get(w);
  if (!l) {
    // Worked out now, with this cell already ice.
    l = findLakes(w);
    lakes.set(w, l);
  } else {
    const id = l.of[cell];
    if (id < 0) return;
    l.ice[id]++;
  }
  const id = l.of[cell];
  if (id < 0) return;
  const size = l.size[id];
  const after = l.ice[id];
  const at = Math.ceil(size * FROZEN_SHARE);
  if (size < MIN_LAKE || after !== at) return;
  const x = Math.round(l.sx[id]);
  const y = Math.round(l.sy[id]);
  const where = w.map.idx(Math.max(0, Math.min(w.map.w - 1, x)), Math.max(0, Math.min(w.map.h - 1, y)));
  for (const f of w.factions.values()) {
    if (!f.isPlayer) continue;
    const d = Math.hypot(f.home.x - x, f.home.y - y);
    if (d > NEWS_RANGE) continue;
    w.message(f.id, `The lake ${bearing(f.home.x, f.home.y, x, y).replace(/^\d+ cells /, '')} has frozen over. The ice will bear a caravan now: a new way across.`, 'neutral', where);
    if (d <= NEWS_RANGE * 0.6) tell(w, f.id, `The frost froze the lake ${bearing(f.home.x, f.home.y, x, y).replace(/^\d+ cells /, '').replace(/ of home$/, '')} solid, opening a way across the ice.`);
  }
}
