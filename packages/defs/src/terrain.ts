export interface TerrainDef {
  id: number;
  key: string;
  label: string;
  color: number;
  /** Multiplier on ticks per cell. Lower is faster. */
  moveCost: number;
  fertility: number;
  buildable: boolean;
  passable: boolean;
}

export const TERRAINS: TerrainDef[] = [
  { id: 0, key: 'soil', label: 'Soil', color: 0x6b5a3e, moveCost: 1, fertility: 1, buildable: true, passable: true },
  { id: 1, key: 'rich_soil', label: 'Rich soil', color: 0x4f4128, moveCost: 1, fertility: 1.4, buildable: true, passable: true },
  { id: 2, key: 'sand', label: 'Sand', color: 0xc2b280, moveCost: 1.2, fertility: 0.1, buildable: true, passable: true },
  { id: 3, key: 'gravel', label: 'Gravel', color: 0x8a8378, moveCost: 1, fertility: 0.7, buildable: true, passable: true },
  { id: 4, key: 'marsh', label: 'Marsh', color: 0x4a5a3a, moveCost: 2.2, fertility: 0, buildable: false, passable: true },
  { id: 5, key: 'shallow_water', label: 'Shallow water', color: 0x4a7a9a, moveCost: 3, fertility: 0, buildable: false, passable: true },
  { id: 6, key: 'deep_water', label: 'Deep water', color: 0x2a4a6a, moveCost: 99, fertility: 0, buildable: false, passable: false },
  /** The floor left where granite was mined (and under meteorite lumps). */
  { id: 7, key: 'rough_stone', label: 'Rough granite', color: 0x5d5a58, moveCost: 1, fertility: 0, buildable: true, passable: true },
  { id: 8, key: 'wood_floor', label: 'Wood floor', color: 0x8b6a43, moveCost: 0.9, fertility: 0, buildable: true, passable: true },
  { id: 9, key: 'stone_tile', label: 'Stone tile', color: 0x7d7a74, moveCost: 0.9, fertility: 0, buildable: true, passable: true },
  /** Water the frost has frozen solid. Slippery to cross, too thin to build on. */
  { id: 10, key: 'ice', label: 'Ice', color: 0xb4cfe2, moveCost: 1.6, fertility: 0, buildable: false, passable: true },
  // Floors left by mining the other stone types (see RockDef.floor).
  { id: 11, key: 'rough_limestone', label: 'Rough limestone', color: 0x857c68, moveCost: 1, fertility: 0, buildable: true, passable: true },
  { id: 12, key: 'rough_slate', label: 'Rough slate', color: 0x4c5056, moveCost: 1, fertility: 0, buildable: true, passable: true },
  { id: 13, key: 'rough_marble', label: 'Rough marble', color: 0x9c9a92, moveCost: 1, fertility: 0, buildable: true, passable: true },
];

export const TERRAIN_BY_KEY: Record<string, TerrainDef> = Object.fromEntries(TERRAINS.map((t) => [t.key, t]));
export const T = Object.fromEntries(TERRAINS.map((t) => [t.key, t.id])) as Record<string, number>;
export const MIN_MOVE_COST = Math.min(...TERRAINS.map((t) => t.moveCost));

/** Natural rock walls (mountains). 0 means no rock. */
export interface RockDef {
  id: number;
  key: string;
  label: string;
  color: number;
  mineWork: number;
  yieldItem: string;
  yieldCount: number;
  /** A stone mountains are made of (as opposed to an ore vein inside one). */
  stone: boolean;
  /** Terrain key of the floor a stone leaves when mined. Veins leave their host stone's floor. */
  floor: string;
}

/**
 * Rock ids 1-3 predate the stone types and stay put for old saves. Every stone yields the same
 * stone blocks item (buildings cost plain "stone"); they differ in colour, toughness and yield.
 */
export const ROCKS: RockDef[] = [
  { id: 0, key: 'none', label: 'None', color: 0, mineWork: 0, yieldItem: '', yieldCount: 0, stone: false, floor: '' },
  { id: 1, key: 'granite', label: 'Granite', color: 0x4d4542, mineWork: 420, yieldItem: 'stone', yieldCount: 8, stone: true, floor: 'rough_stone' },
  { id: 2, key: 'steel_ore', label: 'Steel ore', color: 0x7f93a8, mineWork: 600, yieldItem: 'steel', yieldCount: 20, stone: false, floor: 'rough_stone' },
  { id: 3, key: 'gold_ore', label: 'Gold vein', color: 0xe0b23a, mineWork: 800, yieldItem: 'gold', yieldCount: 8, stone: false, floor: 'rough_stone' },
  { id: 4, key: 'limestone', label: 'Limestone', color: 0x6f6757, mineWork: 360, yieldItem: 'stone', yieldCount: 9, stone: true, floor: 'rough_limestone' },
  { id: 5, key: 'slate', label: 'Slate', color: 0x393d44, mineWork: 390, yieldItem: 'stone', yieldCount: 8, stone: true, floor: 'rough_slate' },
  { id: 6, key: 'marble', label: 'Marble', color: 0x8d8b86, mineWork: 520, yieldItem: 'stone', yieldCount: 7, stone: true, floor: 'rough_marble' },
];

export const ROCK_BY_KEY: Record<string, RockDef> = Object.fromEntries(ROCKS.map((r) => [r.key, r]));
/** Rock ids of the stones mountains are made of. */
export const STONE_IDS: number[] = ROCKS.filter((r) => r.stone).map((r) => r.id);

/** Roof over a cell: open sky, the rock roof under a mountain's flanks, or overhead mountain deep inside. */
export const ROOF = { none: 0, rock: 1, thick: 2 } as const;
