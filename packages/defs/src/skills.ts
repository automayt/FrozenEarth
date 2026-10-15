/** Skills improve with practice and make the matching work faster. */

export const SKILLS = ['construction', 'mining', 'plants', 'cooking', 'crafting'] as const;
export type SkillKey = (typeof SKILLS)[number];

export const SKILL_LABELS: Record<SkillKey, string> = {
  construction: 'Construction',
  mining: 'Mining',
  plants: 'Plants',
  cooking: 'Cooking',
  crafting: 'Crafting',
};

export const MAX_SKILL = 20;

/** Work speed multiplier at a skill level: 0.6 at level 0, 1.0 at 10, 1.4 at 20. */
export function skillSpeed(level: number): number {
  return 0.6 + 0.04 * Math.max(0, Math.min(MAX_SKILL, level));
}

/** XP needed to go from this level to the next. */
export function xpToNext(level: number): number {
  return 500 + 250 * level;
}
