export type EventScope = 'map' | 'faction';
export type EventTone = 'good' | 'neutral' | 'bad';

export interface EventDef {
  key: string;
  label: string;
  scope: EventScope;
  tone: EventTone;
  /** Storyteller budget cost. Bad events cost more. */
  cost: number;
  /** Relative chance among affordable events. */
  weight: number;
  /** Minimum in-game days before this event can fire. */
  minDay: number;
  /** In-game days before the same event can fire again. */
  cooldownDays: number;
  /** Duration in in-game hours for ongoing conditions. */
  durationHours?: number;
}

export const EVENTS: Record<string, EventDef> = {
  cold_snap: { key: 'cold_snap', label: 'Cold snap', scope: 'map', tone: 'bad', cost: 30, weight: 1, minDay: 3, cooldownDays: 8, durationHours: 36 },
  heat_wave: { key: 'heat_wave', label: 'Heat wave', scope: 'map', tone: 'bad', cost: 25, weight: 0.8, minDay: 3, cooldownDays: 8, durationHours: 30 },
  blight: { key: 'blight', label: 'Blight', scope: 'faction', tone: 'bad', cost: 25, weight: 1, minDay: 4, cooldownDays: 6 },
  eclipse: { key: 'eclipse', label: 'Eclipse', scope: 'map', tone: 'neutral', cost: 10, weight: 0.6, minDay: 2, cooldownDays: 6, durationHours: 14 },
  aurora: { key: 'aurora', label: 'Aurora', scope: 'map', tone: 'good', cost: 0, weight: 0.5, minDay: 2, cooldownDays: 6, durationHours: 12 },
  wanderer_joins: { key: 'wanderer_joins', label: 'Wanderer joins', scope: 'faction', tone: 'good', cost: 0, weight: 1, minDay: 1, cooldownDays: 4 },
  cargo_pods: { key: 'cargo_pods', label: 'Cargo pods', scope: 'map', tone: 'good', cost: 0, weight: 1.4, minDay: 0.5, cooldownDays: 2 },
  stomach_flu: { key: 'stomach_flu', label: 'Stomach flu', scope: 'faction', tone: 'bad', cost: 20, weight: 0.7, minDay: 3, cooldownDays: 6, durationHours: 24 },
};
