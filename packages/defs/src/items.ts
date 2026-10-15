export type ItemCategory = 'resource' | 'raw_food' | 'meal';

export interface ItemDef {
  key: string;
  label: string;
  category: ItemCategory;
  stackLimit: number;
  color: number;
  /** Food value per unit, 1 = a full stomach. */
  nutrition?: number;
  /** Days until rotten at room temperature. Undefined means it never spoils. */
  spoilDays?: number;
  marketValue: number;
}

export const ITEMS: Record<string, ItemDef> = {
  wood: { key: 'wood', label: 'Wood', category: 'resource', stackLimit: 75, color: 0x9c6b3a, marketValue: 1.2 },
  stone: { key: 'stone', label: 'Stone blocks', category: 'resource', stackLimit: 75, color: 0x8f8a84, marketValue: 0.9 },
  steel: { key: 'steel', label: 'Steel', category: 'resource', stackLimit: 75, color: 0xa9b8c8, marketValue: 1.9 },
  gold: { key: 'gold', label: 'Gold', category: 'resource', stackLimit: 50, color: 0xe8c040, marketValue: 10 },
  cloth: { key: 'cloth', label: 'Cloth', category: 'resource', stackLimit: 75, color: 0xd8d0bc, marketValue: 1.5 },
  berries: { key: 'berries', label: 'Berries', category: 'raw_food', stackLimit: 75, color: 0x8a2a5a, nutrition: 0.05, spoilDays: 14, marketValue: 1.1 },
  rice: { key: 'rice', label: 'Rice', category: 'raw_food', stackLimit: 75, color: 0xe8e2c8, nutrition: 0.05, spoilDays: 40, marketValue: 1.1 },
  corn: { key: 'corn', label: 'Corn', category: 'raw_food', stackLimit: 75, color: 0xe6c84a, nutrition: 0.05, spoilDays: 60, marketValue: 1.1 },
  potato: { key: 'potato', label: 'Potatoes', category: 'raw_food', stackLimit: 75, color: 0xb08a5a, nutrition: 0.05, spoilDays: 30, marketValue: 1.1 },
  simple_meal: { key: 'simple_meal', label: 'Simple meal', category: 'meal', stackLimit: 10, color: 0xd9a05b, nutrition: 0.9, spoilDays: 4, marketValue: 15 },
  survival_meal: { key: 'survival_meal', label: 'Packaged survival meal', category: 'meal', stackLimit: 20, color: 0x7a8a5a, nutrition: 0.9, marketValue: 24 },
};

export const ITEM_CATEGORIES: { key: ItemCategory; label: string }[] = [
  { key: 'resource', label: 'Resources' },
  { key: 'raw_food', label: 'Raw food' },
  { key: 'meal', label: 'Meals' },
];
