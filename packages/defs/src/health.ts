/**
 * Health conditions ("hediffs"): diseases, injuries, exposure, mental states and mood effects.
 * A pawn holds a list of active conditions; their effects multiply together.
 */

export type ConditionKind = 'disease' | 'injury' | 'exposure' | 'mental' | 'mood' | 'buff';

export interface ConditionStage {
  /** Stage applies from this severity upward. */
  minSeverity: number;
  label: string;
  moveMult?: number;
  workMult?: number;
  mood?: number;
  /** Multiplies how fast food and rest drain. */
  foodDrain?: number;
  restDrain?: number;
  /** The pawn should lie down in bed until this improves. */
  bedRest?: boolean;
}

export interface ConditionDef {
  key: string;
  label: string;
  kind: ConditionKind;
  description: string;
  stages: ConditionStage[];
  /** Severity change per in-game day. Positive worsens. */
  severityPerDay?: number;
  /** Diseases: immunity gained per day. At 1 the pawn has beaten it. */
  immunityPerDay?: number;
  /** Death when severity reaches 1. */
  lethal?: boolean;
  /** Chance per slow tick to infect a nearby colonist of the same faction. */
  contagious?: number;
  /** Timed conditions: random duration in in-game hours. */
  hours?: [number, number];
  /** Mental states: the pawn won't take work. */
  noWork?: boolean;
  /** Mental state: eats whenever food is not full. */
  binge?: boolean;
  /** Severity at which a disease starts. */
  startSeverity?: number;
}

export const CONDITIONS: Record<string, ConditionDef> = {
  // ---------------------------------------------------------------- diseases
  flu: {
    key: 'flu',
    label: 'Flu',
    kind: 'disease',
    description: 'Contagious. Usually beaten in two or three days, faster with bed rest. Can kill the weak.',
    severityPerDay: 0.28,
    immunityPerDay: 0.42,
    lethal: true,
    contagious: 0.015,
    startSeverity: 0.1,
    stages: [
      { minSeverity: 0, label: 'minor', workMult: 0.85, moveMult: 0.95, mood: -0.05 },
      { minSeverity: 0.35, label: 'major', workMult: 0.7, moveMult: 0.85, mood: -0.1, bedRest: true },
      { minSeverity: 0.7, label: 'extreme', workMult: 0.4, moveMult: 0.6, mood: -0.18, bedRest: true },
    ],
  },
  stomach_flu: {
    key: 'stomach_flu',
    label: 'Stomach flu',
    kind: 'disease',
    description: 'Miserable but not dangerous. Doubles hunger for a day or so.',
    severityPerDay: 0.5,
    immunityPerDay: 0.8,
    startSeverity: 0.15,
    stages: [
      { minSeverity: 0, label: 'queasy', workMult: 0.8, foodDrain: 1.6, mood: -0.08 },
      { minSeverity: 0.5, label: 'vomiting', workMult: 0.55, moveMult: 0.8, foodDrain: 2, mood: -0.15, bedRest: true },
    ],
  },
  plague: {
    key: 'plague',
    label: 'Plague',
    kind: 'disease',
    description: 'Highly contagious and often fatal. Bed rest is the best chance of surviving it.',
    severityPerDay: 0.5,
    immunityPerDay: 0.44,
    lethal: true,
    contagious: 0.03,
    startSeverity: 0.12,
    stages: [
      { minSeverity: 0, label: 'early', workMult: 0.8, mood: -0.08 },
      { minSeverity: 0.3, label: 'spreading', workMult: 0.6, moveMult: 0.8, mood: -0.15, bedRest: true },
      { minSeverity: 0.65, label: 'critical', workMult: 0.25, moveMult: 0.5, mood: -0.25, bedRest: true },
    ],
  },
  wasting_cough: {
    key: 'wasting_cough',
    label: 'Wasting cough',
    kind: 'disease',
    description: 'A slow lung sickness from the cold. Lingers for days but rarely kills.',
    severityPerDay: 0.12,
    immunityPerDay: 0.16,
    startSeverity: 0.1,
    stages: [
      { minSeverity: 0, label: 'coughing', workMult: 0.85, restDrain: 1.3, mood: -0.06 },
      { minSeverity: 0.5, label: 'wheezing', workMult: 0.65, moveMult: 0.85, restDrain: 1.6, mood: -0.12, bedRest: true },
    ],
  },
  sleeping_sickness: {
    key: 'sleeping_sickness',
    label: 'Sleeping sickness',
    kind: 'disease',
    description: 'Constant exhaustion for a few days.',
    hours: [48, 84],
    stages: [{ minSeverity: 0, label: '', restDrain: 3, workMult: 0.85, mood: -0.08 }],
  },
  food_poisoning: {
    key: 'food_poisoning',
    label: 'Food poisoning',
    kind: 'disease',
    description: 'From rotten or badly cooked food. Passes in under a day.',
    hours: [8, 16],
    stages: [{ minSeverity: 0, label: '', workMult: 0.5, moveMult: 0.85, mood: -0.15 }],
  },
  migraine: {
    key: 'migraine',
    label: 'Migraine',
    kind: 'disease',
    description: 'A pounding headache for a few hours.',
    hours: [3, 9],
    stages: [{ minSeverity: 0, label: '', workMult: 0.6, mood: -0.1 }],
  },

  // ---------------------------------------------------------------- injuries
  sprained_ankle: {
    key: 'sprained_ankle',
    label: 'Sprained ankle',
    kind: 'injury',
    description: 'Hobbling for a few days.',
    hours: [36, 96],
    stages: [{ minSeverity: 0, label: '', moveMult: 0.6, mood: -0.05 }],
  },
  cut_hand: {
    key: 'cut_hand',
    label: 'Cut hand',
    kind: 'injury',
    description: 'A clumsy slip. Work is slower until it heals.',
    hours: [18, 48],
    stages: [{ minSeverity: 0, label: '', workMult: 0.8, mood: -0.04 }],
  },
  burns: {
    key: 'burns',
    label: 'Burns',
    kind: 'injury',
    description: 'From fighting fires or standing in them.',
    hours: [24, 72],
    stages: [{ minSeverity: 0, label: '', workMult: 0.75, moveMult: 0.9, mood: -0.1 }],
  },
  back_strain: {
    key: 'back_strain',
    label: 'Strained back',
    kind: 'injury',
    description: 'Hauled too much. Slow and grumpy for a while.',
    hours: [24, 60],
    stages: [{ minSeverity: 0, label: '', workMult: 0.75, moveMult: 0.9, mood: -0.06 }],
  },

  // ---------------------------------------------------------------- exposure (from the environment)
  hypothermia: {
    key: 'hypothermia',
    label: 'Hypothermia',
    kind: 'exposure',
    description: 'From staying out in the cold. Get warm or die.',
    lethal: true,
    stages: [
      { minSeverity: 0, label: 'shivering', workMult: 0.9, mood: -0.05 },
      { minSeverity: 0.35, label: 'hypothermic', workMult: 0.6, moveMult: 0.75, mood: -0.15 },
      { minSeverity: 0.7, label: 'freezing to death', workMult: 0.2, moveMult: 0.4, mood: -0.3 },
    ],
  },
  heatstroke: {
    key: 'heatstroke',
    label: 'Heatstroke',
    kind: 'exposure',
    description: 'From staying in the heat. Get to shade or a cool room.',
    lethal: true,
    stages: [
      { minSeverity: 0, label: 'sweating', workMult: 0.9, mood: -0.05 },
      { minSeverity: 0.35, label: 'heatstroke', workMult: 0.6, moveMult: 0.8, mood: -0.15 },
      { minSeverity: 0.7, label: 'collapsing', workMult: 0.2, moveMult: 0.5, mood: -0.3 },
    ],
  },
  malnutrition: {
    key: 'malnutrition',
    label: 'Malnutrition',
    kind: 'exposure',
    description: 'From going without food. Fatal if it goes on too long.',
    lethal: true,
    stages: [
      { minSeverity: 0, label: 'trivial', workMult: 0.9 },
      { minSeverity: 0.3, label: 'moderate', workMult: 0.7, moveMult: 0.85, mood: -0.1 },
      { minSeverity: 0.6, label: 'severe', workMult: 0.4, moveMult: 0.6, mood: -0.25 },
    ],
  },

  // ---------------------------------------------------------------- mental states
  sulking: {
    key: 'sulking',
    label: 'Sulking',
    kind: 'mental',
    description: 'Mental break. Refuses to work and mopes around.',
    hours: [6, 14],
    noWork: true,
    stages: [{ minSeverity: 0, label: '' }],
  },
  dazed: {
    key: 'dazed',
    label: 'Dazed wandering',
    kind: 'mental',
    description: 'Mental break. Wanders aimlessly, ignoring work.',
    hours: [4, 10],
    noWork: true,
    stages: [{ minSeverity: 0, label: '', moveMult: 0.8 }],
  },
  binging: {
    key: 'binging',
    label: 'Food binge',
    kind: 'mental',
    description: 'Mental break. Eats everything in sight.',
    hours: [5, 10],
    noWork: true,
    binge: true,
    stages: [{ minSeverity: 0, label: '', foodDrain: 1.5 }],
  },
  hiding: {
    key: 'hiding',
    label: 'Hiding in bed',
    kind: 'mental',
    description: 'Mental break. Hides under the covers.',
    hours: [6, 12],
    noWork: true,
    stages: [{ minSeverity: 0, label: '', bedRest: true }],
  },

  // ---------------------------------------------------------------- buffs & mood memories
  inspired: {
    key: 'inspired',
    label: 'Inspired',
    kind: 'buff',
    description: 'Struck by inspiration: works much faster for a day.',
    hours: [18, 30],
    stages: [{ minSeverity: 0, label: '', workMult: 1.5, mood: 0.08 }],
  },
  second_wind: {
    key: 'second_wind',
    label: 'Second wind',
    kind: 'buff',
    description: 'Boundless energy: barely needs sleep for a while.',
    hours: [16, 30],
    stages: [{ minSeverity: 0, label: '', restDrain: 0.3, moveMult: 1.15, mood: 0.05 }],
  },
  mourning: {
    key: 'mourning',
    label: 'Mourning',
    kind: 'mood',
    description: 'A fellow colonist died.',
    hours: [72, 120],
    stages: [{ minSeverity: 0, label: '', mood: -0.2 }],
  },
  festival: {
    key: 'festival',
    label: 'Festival spirit',
    kind: 'mood',
    description: 'Celebrated the festival.',
    hours: [24, 36],
    stages: [{ minSeverity: 0, label: '', mood: 0.15 }],
  },
  charitable: {
    key: 'charitable',
    label: 'Gave to those in need',
    kind: 'mood',
    description: 'The colony helped strangers.',
    hours: [48, 72],
    stages: [{ minSeverity: 0, label: '', mood: 0.08 }],
  },
  robbed: {
    key: 'robbed',
    label: 'Robbed',
    kind: 'mood',
    description: 'Someone stole from the colony.',
    hours: [36, 60],
    stages: [{ minSeverity: 0, label: '', mood: -0.1 }],
  },
  betrayed: {
    key: 'betrayed',
    label: 'Betrayed',
    kind: 'mood',
    description: 'Someone the colony trusted turned on it.',
    hours: [72, 120],
    stages: [{ minSeverity: 0, label: '', mood: -0.18 }],
  },
  awed: {
    key: 'awed',
    label: 'Awestruck',
    kind: 'mood',
    description: 'Witnessed something wondrous.',
    hours: [36, 72],
    stages: [{ minSeverity: 0, label: '', mood: 0.18 }],
  },
  dread: {
    key: 'dread',
    label: 'Dread',
    kind: 'mood',
    description: 'Something is very wrong with the world.',
    hours: [24, 48],
    stages: [{ minSeverity: 0, label: '', mood: -0.12 }],
  },
};

// ---------------------------------------------------------------- traits

export interface TraitDef {
  key: string;
  label: string;
  description: string;
  moveMult?: number;
  workMult?: number;
  mood?: number;
  foodDrain?: number;
  restDrain?: number;
  immunityMult?: number;
  /** Shifts the temperature at which cold starts to hurt. Negative = tougher. */
  coldShift?: number;
  heatShift?: number;
  /** Multiplies the chance of a mental break. */
  breakMult?: number;
  /** Immune to these condition keys. */
  immune?: string[];
  /** Traits that can't appear together with this one. */
  conflicts?: string[];
  /** Never rolled randomly; only granted by events. */
  special?: boolean;
}

export const TRAITS: Record<string, TraitDef> = {
  hardy: { key: 'hardy', label: 'Hardy', description: 'Fights off disease and shrugs off the cold.', immunityMult: 1.3, coldShift: -6, conflicts: ['sickly'] },
  sickly: { key: 'sickly', label: 'Sickly', description: 'Catches everything and recovers slowly.', immunityMult: 0.7, conflicts: ['hardy'] },
  fast_walker: { key: 'fast_walker', label: 'Fast walker', description: 'Moves 20% faster.', moveMult: 1.2, conflicts: ['slowpoke'] },
  slowpoke: { key: 'slowpoke', label: 'Slowpoke', description: 'Moves 15% slower.', moveMult: 0.85, conflicts: ['fast_walker'] },
  industrious: { key: 'industrious', label: 'Industrious', description: 'Works 20% faster.', workMult: 1.2, conflicts: ['lazy'] },
  lazy: { key: 'lazy', label: 'Lazy', description: 'Works 20% slower.', workMult: 0.8, conflicts: ['industrious'] },
  glutton: { key: 'glutton', label: 'Glutton', description: 'Gets hungry 40% faster.', foodDrain: 1.4, conflicts: ['iron_stomach'] },
  iron_stomach: { key: 'iron_stomach', label: 'Iron stomach', description: 'Never gets food poisoning or stomach flu.', immune: ['food_poisoning', 'stomach_flu'], conflicts: ['glutton'] },
  tireless: { key: 'tireless', label: 'Tireless', description: 'Needs 25% less sleep.', restDrain: 0.75, conflicts: ['sleepyhead'] },
  sleepyhead: { key: 'sleepyhead', label: 'Sleepyhead', description: 'Needs 30% more sleep.', restDrain: 1.3, conflicts: ['tireless'] },
  optimist: { key: 'optimist', label: 'Optimist', description: 'Always sees the bright side.', mood: 0.08, conflicts: ['pessimist'] },
  pessimist: { key: 'pessimist', label: 'Pessimist', description: 'Always expects the worst.', mood: -0.08, conflicts: ['optimist'] },
  volatile: { key: 'volatile', label: 'Volatile', description: 'Snaps under stress much more easily.', breakMult: 2.5, conflicts: ['steady'] },
  steady: { key: 'steady', label: 'Steady nerves', description: 'Rarely breaks down.', breakMult: 0.4, conflicts: ['volatile'] },
  cold_blooded: { key: 'cold_blooded', label: 'Northerner', description: 'Grew up in the cold. Tolerates it far better.', coldShift: -10, heatShift: -4, conflicts: ['heat_lover'] },
  heat_lover: { key: 'heat_lover', label: 'Southerner', description: 'Loves the heat, hates the cold.', coldShift: 5, heatShift: 8, conflicts: ['cold_blooded'] },
  // Granted by events only.
  child: { key: 'child', label: 'Child', description: 'Too young for hard labour. Works at half speed.', workMult: 0.5, moveMult: 0.9, special: true },
  pilgrim: { key: 'pilgrim', label: 'Pilgrim of the Center', description: 'Walked out of the frozen heart of the world. Tireless, calm, and strange.', workMult: 1.3, restDrain: 0.6, breakMult: 0.1, coldShift: -15, special: true },
};

export const RANDOM_TRAITS = Object.values(TRAITS).filter((t) => !t.special);

/** Comfortable temperature range before exposure conditions start building. */
export const COMFORT_MIN = 4;
export const COMFORT_MAX = 36;
