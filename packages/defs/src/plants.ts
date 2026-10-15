export interface PlantDef {
  key: string;
  label: string;
  color: number;
  /** In-game days from sowing to fully grown, at ideal conditions. */
  growDays: number;
  /** Item dropped when cut (trees) or harvested (crops, berry bushes). */
  yieldItem?: string;
  yieldCount?: number;
  /** Minimum growth before a harvest gives anything. */
  harvestMin: number;
  /** Ticks of work to cut or harvest. */
  work: number;
  tree: boolean;
  /** Can be planted in a grow zone. */
  sowable: boolean;
  /** Harvesting leaves the plant alive at low growth instead of removing it. */
  regrows: boolean;
  /** Extra ticks added to walking through the cell. */
  moveCostAdd: number;
  minFertility: number;
}

export const PLANTS: Record<string, PlantDef> = {
  oak: { key: 'oak', label: 'Oak tree', color: 0x2f5a2a, growDays: 25, yieldItem: 'wood', yieldCount: 25, harvestMin: 0.4, work: 360, tree: true, sowable: false, regrows: false, moveCostAdd: 4, minFertility: 0.5 },
  pine: { key: 'pine', label: 'Pine tree', color: 0x1f4a32, growDays: 20, yieldItem: 'wood', yieldCount: 20, harvestMin: 0.4, work: 300, tree: true, sowable: false, regrows: false, moveCostAdd: 4, minFertility: 0.5 },
  bush: { key: 'bush', label: 'Bush', color: 0x4a6a2a, growDays: 6, harvestMin: 1, work: 80, tree: false, sowable: false, regrows: false, moveCostAdd: 2, minFertility: 0.5 },
  berry_bush: { key: 'berry_bush', label: 'Berry bush', color: 0x5a3a5a, growDays: 8, yieldItem: 'berries', yieldCount: 8, harvestMin: 0.65, work: 120, tree: false, sowable: false, regrows: true, moveCostAdd: 2, minFertility: 0.5 },
  rice: { key: 'rice', label: 'Rice plant', color: 0x9ab84a, growDays: 3, yieldItem: 'rice', yieldCount: 6, harvestMin: 0.65, work: 100, tree: false, sowable: true, regrows: false, moveCostAdd: 0, minFertility: 0.5 },
  corn: { key: 'corn', label: 'Corn plant', color: 0x7a9a2a, growDays: 6, yieldItem: 'corn', yieldCount: 18, harvestMin: 0.65, work: 160, tree: false, sowable: true, regrows: false, moveCostAdd: 1, minFertility: 0.5 },
  potato: { key: 'potato', label: 'Potato plant', color: 0x6a8a3a, growDays: 4.5, yieldItem: 'potato', yieldCount: 11, harvestMin: 0.65, work: 120, tree: false, sowable: true, regrows: false, moveCostAdd: 0, minFertility: 0.3 },
};

export const SOWABLE_PLANTS = Object.values(PLANTS).filter((p) => p.sowable);
