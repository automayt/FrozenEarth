/**
 * Wild animals. They're pawns with a species, owned by one of two wildlife factions: prey (never
 * hostile; they flee or, if they're the defending kind, fight back) and predators (hostile to
 * people, but only hunt when they're hungry or winter has set in).
 */

export interface AnimalDef {
  key: string;
  label: string;
  /** Fallback body colour when there's no sprite. */
  color: number;
  /** Drawn size relative to a person. */
  size: number;
  /** Walk speed relative to a person. */
  speed: number;
  /** Wounds are divided by this: a hare dies to one arrow, a muskox shrugs off a few. */
  toughness: number;
  /** Injury per bite or kick when it fights; 0 = never fights. */
  bite: number;
  /** Ticks between attacks. */
  cooldown: number;
  /** Meat from a kill, at full size. */
  meat: number;
  /** Cloth from the hide. */
  hide: number;
  predator: boolean;
  /** Prey that fights back when attacked instead of fleeing. */
  defends: boolean;
  /** How close a person can get before it bolts, in cells. */
  shy: number;
  /** Group size when it wanders in. */
  group: [min: number, max: number];
  /** How much cold the coat shrugs off, like a parka's coldShift. */
  coldShift: number;
  /** Relative share of the wild population. */
  weight: number;
  /** Chance a taming attempt wins it over (before skill); absent = can't be tamed. */
  tame?: number;
  /** Bulk it carries on a journey once tamed. */
  pack?: number;
  /** Strong enough to pull a sledge on its own. */
  draft?: boolean;
}

export const ANIMALS: Record<string, AnimalDef> = {
  hare: { key: 'hare', label: 'Snow hare', color: 0xd8d4cc, size: 0.5, speed: 1.35, toughness: 0.4, bite: 0, cooldown: 60, meat: 6, hide: 1, predator: false, defends: false, shy: 8, group: [1, 3], coldShift: -22, weight: 3, tame: 0.3 },
  deer: { key: 'deer', label: 'Deer', color: 0x9a6a3a, size: 0.95, speed: 1.25, toughness: 1, bite: 0.08, cooldown: 90, meat: 32, hide: 6, predator: false, defends: false, shy: 7, group: [2, 5], coldShift: -16, weight: 3, tame: 0.2, pack: 45 },
  muskox: { key: 'muskox', label: 'Muskox', color: 0x4a3a2a, size: 1.2, speed: 0.8, toughness: 2.2, bite: 0.14, cooldown: 100, meat: 60, hide: 14, predator: false, defends: true, shy: 3, group: [3, 6], coldShift: -40, weight: 1.5, tame: 0.1, pack: 90, draft: true },
  wolf: { key: 'wolf', label: 'Wolf', color: 0x7a7a80, size: 0.85, speed: 1.3, toughness: 0.9, bite: 0.13, cooldown: 70, meat: 18, hide: 5, predator: true, defends: true, shy: 0, group: [3, 5], coldShift: -30, weight: 0 },
};

export const PREY = Object.values(ANIMALS).filter((a) => !a.predator);
