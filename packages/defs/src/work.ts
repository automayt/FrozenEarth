/** Work types in tie-break order: at equal priority, earlier types are tried first. */
export const WORK_TYPES = ['cook', 'construct', 'grow', 'mine', 'plantcut', 'craft', 'haul'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const WORK_LABELS: Record<WorkType, string> = {
  cook: 'Cook',
  construct: 'Construct',
  grow: 'Grow',
  mine: 'Mine',
  plantcut: 'Cut plants',
  craft: 'Craft',
  haul: 'Haul',
};

/** 0 = disabled, 1 = highest, 4 = lowest. */
export const DEFAULT_PRIORITY = 3;
