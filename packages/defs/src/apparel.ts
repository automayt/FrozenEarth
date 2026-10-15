/** Clothing. Worn apparel shifts the temperatures a colonist can stand. */

export type ApparelSlot = 'torso' | 'head' | 'outer';

export interface ApparelDef {
  /** Same key as the item it's made from. */
  key: string;
  label: string;
  slot: ApparelSlot;
  /** Negative = tolerates more cold. */
  coldShift: number;
  /** Positive = tolerates more heat; negative = a hot garment. */
  heatShift: number;
  moveMult?: number;
  /** Seasons (0-3) a colonist prefers to wear this in. */
  seasons: number[];
}

export const APPAREL: Record<string, ApparelDef> = {
  tunic: { key: 'tunic', label: 'Cloth tunic', slot: 'torso', coldShift: -3, heatShift: 2, seasons: [0, 1, 2, 3] },
  parka: { key: 'parka', label: 'Parka', slot: 'outer', coldShift: -18, heatShift: -8, moveMult: 0.97, seasons: [2, 3] },
  duster: { key: 'duster', label: 'Duster', slot: 'outer', coldShift: -4, heatShift: 8, seasons: [0, 1] },
  tuque: { key: 'tuque', label: 'Tuque', slot: 'head', coldShift: -6, heatShift: -2, seasons: [2, 3] },
  sun_hat: { key: 'sun_hat', label: 'Sun hat', slot: 'head', coldShift: 0, heatShift: 5, seasons: [1] },
};

export const APPAREL_SLOTS: ApparelSlot[] = ['torso', 'outer', 'head'];
