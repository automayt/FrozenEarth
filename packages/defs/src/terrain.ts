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
  { id: 7, key: 'rough_stone', label: 'Rough stone', color: 0x5d5d5d, moveCost: 1, fertility: 0, buildable: true, passable: true },
  { id: 8, key: 'wood_floor', label: 'Wood floor', color: 0x8b6a43, moveCost: 0.9, fertility: 0, buildable: true, passable: true },
  { id: 9, key: 'stone_tile', label: 'Stone tile', color: 0x7d7a74, moveCost: 0.9, fertility: 0, buildable: true, passable: true },
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
}

export const ROCKS: RockDef[] = [
  { id: 0, key: 'none', label: 'None', color: 0, mineWork: 0, yieldItem: '', yieldCount: 0 },
  { id: 1, key: 'granite', label: 'Granite', color: 0x3c3a38, mineWork: 420, yieldItem: 'stone', yieldCount: 8 },
  { id: 2, key: 'steel_ore', label: 'Steel ore', color: 0x5a6a7a, mineWork: 600, yieldItem: 'steel', yieldCount: 20 },
  { id: 3, key: 'gold_ore', label: 'Gold vein', color: 0x6a5a30, mineWork: 800, yieldItem: 'gold', yieldCount: 8 },
];
