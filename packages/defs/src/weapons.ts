/**
 * Weapons. A pawn holds at most one, by key in `Pawn.weapon`; an empty key means bare fists.
 * Loose weapons are items with the same key (see ITEMS).
 * Range is in cells (Euclidean). Accuracy is the hit chance at point-blank range; it falls off
 * toward half that at maximum range.
 */

export type InjuryKind = 'cut' | 'gunshot' | 'bruise';

export interface WeaponDef {
  key: string;
  label: string;
  melee: boolean;
  /** Cells. Melee weapons reach the 8 neighbouring cells. */
  range: number;
  /** Injury severity per hit, before a ±30% roll. */
  damage: number;
  /** Ticks between attacks. */
  cooldown: number;
  accuracy: number;
  injury: InjuryKind;
  /** Tracer colour for ranged weapons. */
  color: number;
  /** Raid points one raider armed with this costs. */
  raidCost: number;
  /** Hit points knocked off a wall or door per blow (guns are swung by the stock). */
  structDamage: number;
}

export const FISTS: WeaponDef = {
  key: '',
  label: 'Fists',
  melee: true,
  range: 1.5,
  damage: 0.05,
  cooldown: 70,
  accuracy: 0.75,
  injury: 'bruise',
  color: 0xffffff,
  raidCost: 20,
  structDamage: 8,
};

export const WEAPONS: Record<string, WeaponDef> = {
  knife: { key: 'knife', label: 'Knife', melee: true, range: 1.5, damage: 0.12, cooldown: 60, accuracy: 0.8, injury: 'cut', color: 0xffffff, raidCost: 35, structDamage: 12 },
  club: { key: 'club', label: 'Club', melee: true, range: 1.5, damage: 0.13, cooldown: 80, accuracy: 0.8, injury: 'bruise', color: 0xffffff, raidCost: 35, structDamage: 22 },
  bow: { key: 'bow', label: 'Short bow', melee: false, range: 11, damage: 0.13, cooldown: 130, accuracy: 0.65, injury: 'cut', color: 0xd8c8a0, raidCost: 45, structDamage: 8 },
  rifle: { key: 'rifle', label: 'Bolt rifle', melee: false, range: 18, damage: 0.18, cooldown: 150, accuracy: 0.7, injury: 'gunshot', color: 0xffe080, raidCost: 60, structDamage: 14 },
};

/** Stable order for compact wire encoding. Index 0 is fists. */
export const WEAPON_KEYS = ['', ...Object.keys(WEAPONS)];

export function weaponOf(key: string | undefined): WeaponDef {
  return (key && WEAPONS[key]) || FISTS;
}
