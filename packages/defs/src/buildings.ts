export type BuildCategory = 'structure' | 'defense' | 'furniture' | 'production' | 'temperature' | 'floors' | 'special';

export interface BuildingDef {
  key: string;
  label: string;
  category: BuildCategory;
  color: number;
  cost: Record<string, number>;
  /** Ticks of construction work. */
  work: number;
  blocksMovement: boolean;
  /** Building blocks light and heat, so it can enclose a room. */
  wall?: boolean;
  door?: boolean;
  /** Building turns the floor into this terrain instead of placing a thing. */
  floorTerrain?: string;
  bed?: boolean;
  table?: boolean;
  chair?: boolean;
  /** Recipes this workbench can make. */
  recipes?: string[];
  /** Heat pushed into the room per rare tick, in °C·cells. Negative cools. */
  heat?: number;
  /** Target temperature for heaters and coolers. */
  targetTemp?: number;
  /** Can't be placed by players; only spawned by events. */
  special?: boolean;
  /** Mood bonus for colonists standing within this many cells. */
  aweRadius?: number;
  /** Warms the air around it even outdoors: [degrees at the source, radius in cells]. */
  radiant?: [number, number];
  /** Hit points. Defaults from the build work (see maxHp). */
  hp?: number;
  /**
   * Share of shots it stops for someone right behind it (0-1). Walls default to WALL_COVER.
   * Low cover (sandbags) can be walked over slowly and seen across.
   */
  cover?: number;
  /** A wall you can see and shoot through (an embrasure): still encloses a room, still blocks movement. */
  seeThrough?: boolean;
  /** A landmark (see LANDMARKS): placed at map generation, searched by walking up to it. */
  landmark?: boolean;
}

/** Cover a wall or rock gives when nothing more specific is set. */
export const WALL_COVER = 0.75;
/** Cover from a tree trunk. */
export const TREE_COVER = 0.25;

export const BUILDINGS: Record<string, BuildingDef> = {
  wood_wall: { key: 'wood_wall', label: 'Wood wall', category: 'structure', color: 0x7a5530, cost: { wood: 5 }, work: 240, blocksMovement: true, wall: true, hp: 350 },
  stone_wall: { key: 'stone_wall', label: 'Stone wall', category: 'structure', color: 0x8a8580, cost: { stone: 5 }, work: 480, blocksMovement: true, wall: true, hp: 900 },
  door: { key: 'door', label: 'Wood door', category: 'structure', color: 0xa07040, cost: { wood: 15 }, work: 360, blocksMovement: false, wall: true, door: true, hp: 400, cover: 0.5 },
  sandbags: { key: 'sandbags', label: 'Sandbags', category: 'defense', color: 0xa89470, cost: { cloth: 4, stone: 6 }, work: 200, blocksMovement: false, hp: 300, cover: 0.55 },
  embrasure: { key: 'embrasure', label: 'Embrasure', category: 'defense', color: 0x6a6660, cost: { stone: 8 }, work: 520, blocksMovement: true, wall: true, seeThrough: true, hp: 700, cover: 0.8 },
  wood_floor: { key: 'wood_floor', label: 'Wood floor', category: 'floors', color: 0x8b6a43, cost: { wood: 2 }, work: 90, blocksMovement: false, floorTerrain: 'wood_floor' },
  stone_tile: { key: 'stone_tile', label: 'Stone tile', category: 'floors', color: 0x7d7a74, cost: { stone: 3 }, work: 200, blocksMovement: false, floorTerrain: 'stone_tile' },
  bed: { key: 'bed', label: 'Bed', category: 'furniture', color: 0x5a7aa0, cost: { wood: 25 }, work: 500, blocksMovement: false, bed: true },
  table: { key: 'table', label: 'Table', category: 'furniture', color: 0x8a6a40, cost: { wood: 15 }, work: 400, blocksMovement: true, table: true },
  chair: { key: 'chair', label: 'Chair', category: 'furniture', color: 0x7a5a38, cost: { wood: 8 }, work: 240, blocksMovement: false, chair: true },
  campfire: { key: 'campfire', label: 'Campfire', category: 'production', color: 0xd06a2a, cost: { wood: 20 }, work: 240, blocksMovement: false, recipes: ['cook_simple_meal'], heat: 6, targetTemp: 28, radiant: [14, 2] },
  stove: { key: 'stove', label: 'Wood stove', category: 'production', color: 0x5a5050, cost: { steel: 60, wood: 20 }, work: 900, blocksMovement: true, recipes: ['cook_simple_meal', 'cook_simple_meal_x4'] },
  crafting_spot: { key: 'crafting_spot', label: 'Crafting spot', category: 'production', color: 0x9a8a6a, cost: {}, work: 30, blocksMovement: false, recipes: ['stone_blocks', 'cloth_from_plants', 'make_club'] },
  workbench: { key: 'workbench', label: 'Workbench', category: 'production', color: 0x6a5a40, cost: { wood: 50, steel: 20 }, work: 900, blocksMovement: true, recipes: ['stone_blocks', 'cloth_from_plants', 'survival_meal', 'make_sledge', 'make_club', 'make_knife', 'make_bow', 'make_rifle'] },
  tailor_bench: { key: 'tailor_bench', label: "Tailor's bench", category: 'production', color: 0x8a6a8a, cost: { wood: 40, cloth: 10 }, work: 700, blocksMovement: true, recipes: ['make_tunic', 'make_parka', 'make_duster', 'make_tuque', 'make_sun_hat'] },
  heater: { key: 'heater', label: 'Wood heater', category: 'temperature', color: 0xb05030, cost: { steel: 30, wood: 10 }, work: 500, blocksMovement: true, heat: 14, targetTemp: 21 },
  sun_shard: { key: 'sun_shard', label: 'The Sun Shard', category: 'special', color: 0xffc040, cost: {}, work: 0, blocksMovement: true, special: true, heat: 60, targetTemp: 24, radiant: [24, 4] },
  whispering_stone: { key: 'whispering_stone', label: 'Whispering stone', category: 'special', color: 0x1a1a24, cost: {}, work: 0, blocksMovement: true, special: true, aweRadius: 6 },
  // Landmarks: found out in the wilds, never built.
  abandoned_camp: { key: 'abandoned_camp', label: 'Abandoned camp', category: 'special', color: 0x8a6a48, cost: {}, work: 0, blocksMovement: false, special: true, landmark: true },
  cairn: { key: 'cairn', label: 'Cairn', category: 'special', color: 0x8d877c, cost: {}, work: 0, blocksMovement: false, special: true, landmark: true },
  old_ruin: { key: 'old_ruin', label: 'Old ruin', category: 'special', color: 0x6e665c, cost: {}, work: 0, blocksMovement: false, special: true, landmark: true },
  frozen_wreck: { key: 'frozen_wreck', label: 'Frozen wreck', category: 'special', color: 0x55606c, cost: {}, work: 0, blocksMovement: true, special: true, landmark: true, hp: 2000 },
  hot_spring: { key: 'hot_spring', label: 'Hot spring', category: 'special', color: 0x7ec0d0, cost: {}, work: 0, blocksMovement: false, special: true, landmark: true, radiant: [30, 5] },
  monolith: { key: 'monolith', label: 'Monolith', category: 'special', color: 0x22222e, cost: {}, work: 0, blocksMovement: true, special: true, landmark: true, aweRadius: 4, hp: 5000 },
  cooler: { key: 'cooler', label: 'Cooler', category: 'temperature', color: 0x4a8ab0, cost: { steel: 40 }, work: 500, blocksMovement: true, heat: -14, targetTemp: -2 },
};

/** A building's full hit points. */
export function maxHp(def: string): number {
  const d = BUILDINGS[def];
  if (!d) return 100;
  return d.hp ?? Math.round(40 + d.work * 0.15);
}

export const BUILD_CATEGORIES: { key: BuildCategory; label: string }[] = [
  { key: 'structure', label: 'Structure' },
  { key: 'defense', label: 'Defense' },
  { key: 'floors', label: 'Floors' },
  { key: 'furniture', label: 'Furniture' },
  { key: 'production', label: 'Production' },
  { key: 'temperature', label: 'Temperature' },
];
