import { burst, rand, tone, type Out } from './synth';

/**
 * Every short sound in the game, as a recipe. The bank renders each one a few times at load so a
 * sound costs three nodes to play instead of a dozen; until then a recipe can play live.
 */

export type Kind =
  // In the world.
  | 'stone' | 'wood' | 'leaf' | 'build' | 'soil' | 'craft' | 'steam' | 'tend'
  | 'rifle' | 'bow' | 'melee' | 'hit' | 'bite' | 'death' | 'fall' | 'crumble' | 'rock' | 'fire' | 'pop' | 'door'
  | 'deer' | 'hare' | 'muskox' | 'wolf' | 'animalDeath'
  // On the screen.
  | 'click' | 'hover' | 'press' | 'select' | 'open' | 'close' | 'place' | 'mark' | 'refuse'
  | 'letter' | 'letterGood' | 'letterBad' | 'good' | 'bad' | 'neutral';

export interface Recipe {
  /** Screen sounds go to the interface channel and ignore the camera. */
  screen?: boolean;
  /** Seconds of tail to keep. */
  dur: number;
  /** Rendered variations. */
  takes?: number;
  /** Least milliseconds between two of these. */
  gap?: number;
  /** Most of these sounding at once. */
  cap?: number;
  /** Who loses their voice first when too much is going on: higher is kept. */
  prio?: number;
  /** Random pitch spread when played. */
  spread?: number;
  /** Tuning: overall level of this sound. */
  level?: number;
  make(o: Out): void;
}

function paper(o: Out, level = 1): void {
  burst(o, 0.08 * level, 0.22, 'bandpass', 2600, 1.2, 1100);
}

const goodChime = (o: Out) => {
  tone(o, 0.14, 0.35, 660);
  tone(o, 0.12, 0.45, 990, 'sine', undefined, 0.12);
};

const badChime = (o: Out) => {
  tone(o, 0.16, 0.5, 220, 'triangle', 180);
  tone(o, 0.12, 0.6, 165, 'triangle', 140, 0.15);
};

export const RECIPES: Record<Kind, Recipe> = {
  // ------------------------------------------------------------ work
  stone: {
    dur: 0.16, takes: 3, gap: 90, prio: 1, spread: 0.08,
    make(o) {
      // Pick on rock: a bright click over a dull knock.
      burst(o, 0.35, 0.05, 'highpass', 2500);
      burst(o, 0.5, 0.12, 'lowpass', 500);
      tone(o, 0.05, 0.05, rand(2600, 3400), 'sine', 2200);
    },
  },
  wood: {
    dur: 0.14, takes: 3, gap: 90, prio: 1, spread: 0.08,
    make(o) {
      tone(o, 0.25, 0.09, rand(220, 260), 'triangle', 140);
      burst(o, 0.3, 0.07, 'bandpass', 900, 2);
    },
  },
  leaf: {
    dur: 0.22, takes: 2, gap: 120, prio: 1, spread: 0.1,
    make(o) {
      burst(o, 0.18, 0.18, 'highpass', 3000);
    },
  },
  build: {
    dur: 0.11, takes: 3, gap: 90, prio: 1, spread: 0.08,
    make(o) {
      tone(o, 0.18, 0.06, rand(520, 600), 'square', 300, 0, 2400);
      burst(o, 0.2, 0.06, 'bandpass', 1400, 3);
    },
  },
  soil: {
    dur: 0.2, takes: 2, gap: 140, prio: 1, spread: 0.1,
    make(o) {
      burst(o, 0.2, 0.16, 'lowpass', 700);
    },
  },
  craft: {
    dur: 0.16, takes: 2, gap: 160, prio: 1, spread: 0.1,
    make(o) {
      burst(o, 0.12, 0.12, 'bandpass', 2200, 4);
    },
  },
  steam: {
    dur: 0.55, takes: 1, gap: 200, prio: 1, spread: 0.1,
    make(o) {
      burst(o, 0.18, 0.5, 'highpass', 4000);
    },
  },
  tend: {
    dur: 0.14, takes: 2, gap: 240, prio: 1, spread: 0.1,
    make(o) {
      // Cloth being pulled tight.
      burst(o, 0.06, 0.11, 'bandpass', 1900, 1, 1300);
    },
  },

  // ------------------------------------------------------------ fighting
  rifle: {
    dur: 0.85, takes: 3, gap: 40, cap: 5, prio: 3, spread: 0.05,
    make(o) {
      burst(o, 0.7, 0.03, 'highpass', 1500);
      burst(o, 0.5, 0.35, 'lowpass', 900, 0.7, 120);
      // The shot coming back off the trees.
      burst(o, 0.09, 0.28, 'bandpass', 700, 0.8, 300, 0.17);
      burst(o, 0.05, 0.3, 'bandpass', 500, 0.8, 220, 0.38);
    },
  },
  bow: {
    dur: 0.22, takes: 2, gap: 50, cap: 3, prio: 3, spread: 0.08,
    make(o) {
      tone(o, 0.25, 0.18, 330, 'triangle', 180);
      burst(o, 0.12, 0.12, 'bandpass', 1800, 2, 600);
    },
  },
  melee: {
    dur: 0.2, takes: 2, gap: 50, cap: 3, prio: 3, spread: 0.1,
    make(o) {
      burst(o, 0.3, 0.16, 'bandpass', 600, 1.5, 2400);
    },
  },
  hit: {
    dur: 0.14, takes: 3, gap: 40, cap: 4, prio: 2, spread: 0.1,
    make(o) {
      tone(o, 0.3, 0.1, 140, 'sine', 60);
      burst(o, 0.25, 0.06, 'lowpass', 1200);
    },
  },
  bite: {
    dur: 0.3, takes: 2, gap: 60, cap: 3, prio: 3, spread: 0.1,
    make(o) {
      burst(o, 0.32, 0.07, 'bandpass', 1800, 2);
      tone(o, 0.16, 0.24, rand(170, 210), 'sawtooth', 110, 0, 900);
    },
  },
  death: {
    dur: 0.6, takes: 3, gap: 120, cap: 3, prio: 4, spread: 0.08,
    make(o) {
      // A breath going out, then a body on the ground.
      tone(o, 0.22, 0.34, rand(170, 230), 'sawtooth', 85, 0, 700);
      burst(o, 0.45, 0.24, 'lowpass', 280, 0.7, 80, 0.26);
      tone(o, 0.28, 0.18, 105, 'sine', 48, 0.26);
    },
  },
  animalDeath: {
    dur: 0.5, takes: 2, gap: 120, cap: 2, prio: 3, spread: 0.12,
    make(o) {
      tone(o, 0.16, 0.26, rand(600, 800), 'triangle', 220, 0, 1800);
      burst(o, 0.3, 0.2, 'lowpass', 320, 0.7, 90, 0.2);
    },
  },

  // ------------------------------------------------------------ the world giving way
  fall: {
    dur: 1.25, takes: 2, gap: 200, cap: 2, prio: 3, spread: 0.08,
    make(o) {
      // Creak, then the crash.
      tone(o, 0.12, 0.5, 90, 'sawtooth', 60, 0, 900);
      burst(o, 0.6, 0.7, 'lowpass', 600, 0.7, 80, 0.48);
    },
  },
  crumble: {
    dur: 0.65, takes: 2, gap: 120, cap: 2, prio: 3, spread: 0.08,
    make(o) {
      burst(o, 0.5, 0.6, 'lowpass', 800, 0.7, 100);
      burst(o, 0.25, 0.3, 'bandpass', 1500, 1);
    },
  },
  rock: {
    dur: 0.4, takes: 2, gap: 80, cap: 3, prio: 2, spread: 0.1,
    make(o) {
      burst(o, 0.5, 0.35, 'lowpass', 600, 0.8, 120);
    },
  },
  fire: {
    dur: 0.07, takes: 3, gap: 180, cap: 1, prio: 0, spread: 0.2,
    make(o) {
      burst(o, 0.08, rand(0.03, 0.06), 'highpass', rand(2000, 5000));
    },
  },
  pop: {
    dur: 0.09, takes: 1, gap: 70, prio: 1, spread: 0.05,
    make(o) {
      tone(o, 0.08, 0.06, 660, 'sine', 990);
    },
  },
  door: {
    dur: 0.32, takes: 2, gap: 260, cap: 2, prio: 2, spread: 0.08,
    make(o) {
      // The hinge, then the latch.
      tone(o, 0.045, 0.2, rand(230, 280), 'sawtooth', 340, 0, 1500);
      tone(o, 0.13, 0.07, 170, 'triangle', 110, 0.19);
      burst(o, 0.2, 0.06, 'lowpass', 700, 0.7, undefined, 0.19);
    },
  },

  // ------------------------------------------------------------ animals
  deer: {
    dur: 0.3, takes: 2, gap: 800, cap: 2, prio: 1, spread: 0.1,
    make(o) {
      tone(o, 0.1, 0.24, rand(560, 680), 'sawtooth', 400, 0, 1600);
    },
  },
  hare: {
    dur: 0.1, takes: 2, gap: 800, cap: 1, prio: 1, spread: 0.1,
    make(o) {
      tone(o, 0.05, 0.07, rand(1600, 2000), 'sine', 1300);
    },
  },
  muskox: {
    dur: 0.52, takes: 2, gap: 800, cap: 2, prio: 1, spread: 0.08,
    make(o) {
      tone(o, 0.24, 0.46, rand(95, 120), 'sawtooth', 78, 0, 420);
      burst(o, 0.08, 0.3, 'lowpass', 300);
    },
  },
  wolf: {
    dur: 0.4, takes: 2, gap: 800, cap: 2, prio: 2, spread: 0.1,
    make(o) {
      tone(o, 0.15, 0.32, rand(290, 350), 'sawtooth', 220, 0, 1100);
      burst(o, 0.1, 0.3, 'bandpass', 700, 2);
    },
  },

  // ------------------------------------------------------------ the interface
  click: {
    screen: true, dur: 0.06,
    make(o) {
      tone(o, 0.08, 0.04, 880, 'sine', 660);
    },
  },
  hover: {
    screen: true, dur: 0.03, gap: 45, spread: 0.06,
    make(o) {
      tone(o, 0.04, 0.018, 2300, 'sine', 1700);
    },
  },
  press: {
    screen: true, dur: 0.06, takes: 2, gap: 40, spread: 0.04,
    make(o) {
      // A small wooden tap: the warm body under the tick.
      tone(o, 0.13, 0.035, 720, 'triangle', 420);
      burst(o, 0.07, 0.016, 'bandpass', 2600, 2);
    },
  },
  select: {
    screen: true, dur: 0.05, gap: 60, spread: 0.04,
    make(o) {
      tone(o, 0.08, 0.03, 980, 'triangle', 700);
    },
  },
  open: {
    screen: true, dur: 0.22, gap: 60,
    make(o) {
      burst(o, 0.08, 0.17, 'bandpass', 500, 1.2, 1800);
      tone(o, 0.08, 0.14, 392, 'triangle', 587);
    },
  },
  close: {
    screen: true, dur: 0.2, gap: 60,
    make(o) {
      burst(o, 0.07, 0.14, 'bandpass', 1500, 1.2, 420);
      tone(o, 0.08, 0.12, 523, 'triangle', 330);
    },
  },
  place: {
    screen: true, dur: 0.2, takes: 2, gap: 60, spread: 0.03,
    make(o) {
      // A peg going in: a knock, then a small clear note saying it took.
      tone(o, 0.14, 0.08, 210, 'triangle', 120);
      burst(o, 0.12, 0.05, 'bandpass', 1200, 2);
      tone(o, 0.05, 0.12, 880, 'sine', undefined, 0.035);
    },
  },
  mark: {
    screen: true, dur: 0.1, gap: 60, spread: 0.03,
    make(o) {
      tone(o, 0.09, 0.05, 330, 'triangle', 240);
      burst(o, 0.05, 0.03, 'bandpass', 1800, 2);
    },
  },
  refuse: {
    screen: true, dur: 0.28, gap: 180,
    make(o) {
      // Two dull thuds, the second lower: no.
      tone(o, 0.15, 0.09, 175, 'triangle', 150);
      tone(o, 0.15, 0.13, 131, 'triangle', 110, 0.11);
    },
  },
  letter: {
    screen: true, dur: 0.65, gap: 1200,
    make(o) {
      paper(o);
      tone(o, 0.08, 0.42, 784);
      tone(o, 0.055, 0.5, 1175, 'sine', undefined, 0.09);
    },
  },
  letterGood: {
    screen: true, dur: 0.65, gap: 500,
    make(o) {
      paper(o);
      goodChime(o);
    },
  },
  letterBad: {
    screen: true, dur: 0.8, gap: 500,
    make(o) {
      paper(o);
      badChime(o);
    },
  },
  good: { screen: true, dur: 0.6, gap: 300, make: goodChime },
  bad: { screen: true, dur: 0.8, gap: 300, make: badChime },
  neutral: {
    screen: true, dur: 0.35, gap: 300,
    make(o) {
      tone(o, 0.1, 0.3, 520);
    },
  },
};
