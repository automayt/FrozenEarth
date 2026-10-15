import type { WorkType } from './work';

export interface Ingredient {
  /** A specific item key, or a category prefixed with "cat:" (e.g. "cat:raw_food"). */
  of: string;
  count: number;
}

export interface RecipeDef {
  key: string;
  label: string;
  work: number;
  workType: WorkType;
  ingredients: Ingredient[];
  product: { item: string; count: number };
}

export const RECIPES: Record<string, RecipeDef> = {
  make_tunic: { key: 'make_tunic', label: 'Sew a cloth tunic', work: 600, workType: 'craft', ingredients: [{ of: 'cloth', count: 20 }], product: { item: 'tunic', count: 1 } },
  make_parka: { key: 'make_parka', label: 'Sew a parka', work: 1400, workType: 'craft', ingredients: [{ of: 'cloth', count: 45 }], product: { item: 'parka', count: 1 } },
  make_duster: { key: 'make_duster', label: 'Sew a duster', work: 1000, workType: 'craft', ingredients: [{ of: 'cloth', count: 35 }], product: { item: 'duster', count: 1 } },
  make_tuque: { key: 'make_tuque', label: 'Knit a tuque', work: 450, workType: 'craft', ingredients: [{ of: 'cloth', count: 15 }], product: { item: 'tuque', count: 1 } },
  make_sun_hat: { key: 'make_sun_hat', label: 'Weave a sun hat', work: 400, workType: 'craft', ingredients: [{ of: 'cloth', count: 12 }], product: { item: 'sun_hat', count: 1 } },
  cook_simple_meal: {
    key: 'cook_simple_meal',
    label: 'Cook simple meal',
    work: 300,
    workType: 'cook',
    ingredients: [{ of: 'cat:raw_food', count: 10 }],
    product: { item: 'simple_meal', count: 1 },
  },
  cook_simple_meal_x4: {
    key: 'cook_simple_meal_x4',
    label: 'Cook 4 simple meals',
    work: 900,
    workType: 'cook',
    ingredients: [{ of: 'cat:raw_food', count: 40 }],
    product: { item: 'simple_meal', count: 4 },
  },
  stone_blocks: {
    key: 'stone_blocks',
    label: 'Dress stone blocks',
    work: 500,
    workType: 'craft',
    ingredients: [{ of: 'stone', count: 10 }],
    product: { item: 'stone', count: 14 },
  },
  cloth_from_plants: {
    key: 'cloth_from_plants',
    label: 'Weave plant fibre cloth',
    work: 400,
    workType: 'craft',
    ingredients: [{ of: 'wood', count: 10 }],
    product: { item: 'cloth', count: 8 },
  },
  survival_meal: {
    key: 'survival_meal',
    label: 'Pack survival meals',
    work: 700,
    workType: 'cook',
    ingredients: [
      { of: 'cat:raw_food', count: 12 },
      { of: 'cloth', count: 2 },
    ],
    product: { item: 'survival_meal', count: 1 },
  },
};
