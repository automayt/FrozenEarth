import { BUILDINGS, type BuildCategory } from './buildings';
import { ITEMS } from './items';

/**
 * Packed buildings. A colony on the move folds its beds, benches, stoves and heaters into kits:
 * carried like goods, worth what the building cost, and set up again at the new site in a
 * fraction of the build time. Walls and floors don't pack; they come apart into materials.
 */

const PACKABLE_CATEGORIES = new Set<BuildCategory>(['furniture', 'production', 'temperature']);

/** Share of the normal build work it takes to set a kit up again. */
export const KIT_WORK = 0.25;

export const kitKey = (building: string) => `kit_${building}`;

/** The building a kit item unpacks into, or undefined if it isn't a kit. */
export function kitBuilding(item: string): string | undefined {
  if (!item.startsWith('kit_')) return undefined;
  const def = item.slice(4);
  return Object.hasOwn(BUILDINGS, def) && packable(def) ? def : undefined;
}

export function packable(building: string): boolean {
  const d = BUILDINGS[building];
  return !!d && !d.special && !d.wall && !d.floorTerrain && PACKABLE_CATEGORIES.has(d.category);
}

for (const d of Object.values(BUILDINGS)) {
  if (!packable(d.key)) continue;
  const value = Object.entries(d.cost).reduce((a, [k, n]) => a + (ITEMS[k]?.marketValue ?? 1) * n, 0);
  ITEMS[kitKey(d.key)] = { key: kitKey(d.key), label: `${d.label} (packed)`, category: 'kit', stackLimit: 4, color: d.color, marketValue: Math.round(value) };
}
