export type BuildCategory = 'structure' | 'furniture' | 'production' | 'temperature' | 'floors';

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
}

export const BUILDINGS: Record<string, BuildingDef> = {
  wood_wall: { key: 'wood_wall', label: 'Wood wall', category: 'structure', color: 0x7a5530, cost: { wood: 5 }, work: 240, blocksMovement: true, wall: true },
  stone_wall: { key: 'stone_wall', label: 'Stone wall', category: 'structure', color: 0x8a8580, cost: { stone: 5 }, work: 480, blocksMovement: true, wall: true },
  door: { key: 'door', label: 'Wood door', category: 'structure', color: 0xa07040, cost: { wood: 15 }, work: 360, blocksMovement: false, wall: true, door: true },
  wood_floor: { key: 'wood_floor', label: 'Wood floor', category: 'floors', color: 0x8b6a43, cost: { wood: 2 }, work: 90, blocksMovement: false, floorTerrain: 'wood_floor' },
  stone_tile: { key: 'stone_tile', label: 'Stone tile', category: 'floors', color: 0x7d7a74, cost: { stone: 3 }, work: 200, blocksMovement: false, floorTerrain: 'stone_tile' },
  bed: { key: 'bed', label: 'Bed', category: 'furniture', color: 0x5a7aa0, cost: { wood: 25 }, work: 500, blocksMovement: false, bed: true },
  table: { key: 'table', label: 'Table', category: 'furniture', color: 0x8a6a40, cost: { wood: 15 }, work: 400, blocksMovement: true, table: true },
  chair: { key: 'chair', label: 'Chair', category: 'furniture', color: 0x7a5a38, cost: { wood: 8 }, work: 240, blocksMovement: false, chair: true },
  campfire: { key: 'campfire', label: 'Campfire', category: 'production', color: 0xd06a2a, cost: { wood: 20 }, work: 240, blocksMovement: false, recipes: ['cook_simple_meal'], heat: 6, targetTemp: 28 },
  stove: { key: 'stove', label: 'Wood stove', category: 'production', color: 0x5a5050, cost: { steel: 60, wood: 20 }, work: 900, blocksMovement: true, recipes: ['cook_simple_meal', 'cook_simple_meal_x4'] },
  crafting_spot: { key: 'crafting_spot', label: 'Crafting spot', category: 'production', color: 0x9a8a6a, cost: {}, work: 30, blocksMovement: false, recipes: ['stone_blocks', 'cloth_from_plants'] },
  workbench: { key: 'workbench', label: 'Workbench', category: 'production', color: 0x6a5a40, cost: { wood: 50, steel: 20 }, work: 900, blocksMovement: true, recipes: ['stone_blocks', 'cloth_from_plants', 'survival_meal'] },
  heater: { key: 'heater', label: 'Wood heater', category: 'temperature', color: 0xb05030, cost: { steel: 30, wood: 10 }, work: 500, blocksMovement: true, heat: 14, targetTemp: 21 },
  cooler: { key: 'cooler', label: 'Cooler', category: 'temperature', color: 0x4a8ab0, cost: { steel: 40 }, work: 500, blocksMovement: true, heat: -14, targetTemp: -2 },
};

export const BUILD_CATEGORIES: { key: BuildCategory; label: string }[] = [
  { key: 'structure', label: 'Structure' },
  { key: 'floors', label: 'Floors' },
  { key: 'furniture', label: 'Furniture' },
  { key: 'production', label: 'Production' },
  { key: 'temperature', label: 'Temperature' },
];
