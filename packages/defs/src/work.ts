/** Work types in tie-break order: at equal priority, earlier types are tried first. */
export const WORK_TYPES = ['firefight', 'doctor', 'cook', 'hunt', 'construct', 'grow', 'mine', 'plantcut', 'craft', 'haul'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const WORK_LABELS: Record<WorkType, string> = {
  firefight: 'Firefight',
  doctor: 'Doctor',
  cook: 'Cook',
  hunt: 'Hunt',
  construct: 'Construct',
  grow: 'Grow',
  mine: 'Mine',
  plantcut: 'Cut plants',
  craft: 'Craft',
  haul: 'Haul',
};

/** 0 = disabled, 1 = highest, 4 = lowest. */
export const DEFAULT_PRIORITY = 3;

/** Work types that start at a different priority. */
export const START_PRIORITY: Partial<Record<WorkType, number>> = { firefight: 1, doctor: 2 };
