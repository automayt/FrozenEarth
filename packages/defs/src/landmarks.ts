/**
 * Landmarks: places worth walking to. Each is a special building (see BUILDINGS) placed when the
 * map is made. Colonies only know of one once someone has seen it or heard of it; walking up to
 * it searches it. Loot landmarks are emptied by whoever gets there first; hot springs and
 * monoliths last.
 */

export type LandmarkKind = 'abandoned_camp' | 'cairn' | 'old_ruin' | 'frozen_wreck' | 'hot_spring' | 'monolith';

export interface LandmarkDef {
  key: LandmarkKind;
  label: string;
  /** "an abandoned camp": how a letter names it. */
  a: string;
  /** Relative share of the landmarks on a map. */
  weight: number;
  /** Most of these on one map. */
  max: number;
  /** Where on the map: distance from the center as a fraction of the half-size (0 center, 1 edge). */
  ring: [min: number, max: number];
  /** Never used up: the place itself is the reward. */
  lasting?: boolean;
  /** One line for the inspect pane. */
  blurb: string;
}

export const LANDMARKS: Record<LandmarkKind, LandmarkDef> = {
  abandoned_camp: { key: 'abandoned_camp', label: 'Abandoned camp', a: 'an abandoned camp', weight: 3, max: 6, ring: [0.3, 1.2], blurb: 'Someone made camp here and never came back for their things.' },
  cairn: { key: 'cairn', label: 'Cairn', a: 'a cairn', weight: 3, max: 6, ring: [0.2, 1.2], blurb: 'Stones piled to mark something buried underneath.' },
  old_ruin: { key: 'old_ruin', label: 'Old ruin', a: 'an old ruin', weight: 2.5, max: 4, ring: [0.15, 0.9], blurb: 'Broken walls of a house from before the cold.' },
  frozen_wreck: { key: 'frozen_wreck', label: 'Frozen wreck', a: 'a frozen wreck', weight: 1.5, max: 3, ring: [0.1, 0.75], blurb: 'An iron hull half sunk in the ground, its hold still shut.' },
  hot_spring: { key: 'hot_spring', label: 'Hot spring', a: 'a hot spring', weight: 1.2, max: 3, ring: [0.2, 1.05], lasting: true, blurb: 'Warm water out of the rock. It warms the air around it and never freezes.' },
  monolith: { key: 'monolith', label: 'Monolith', a: 'a strange monolith', weight: 1, max: 2, ring: [0.05, 0.6], lasting: true, blurb: 'A black stone, too smooth to be natural. Standing by it, you feel watched.' },
};

/** Landmarks per this many cells of map area. */
export const CELLS_PER_LANDMARK = 2800;
