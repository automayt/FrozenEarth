import type { SampleDef } from './bank';
import { burst, echoed, filter, gain, noiseLoop, panned, rand, struck, tone, type Out } from './synth';

/**
 * The instruments and the stingers, rendered once. Sparse and cold: a felted pluck, a glass bell,
 * a held chord, and something low for when things go wrong. Echo is baked into each note, so
 * playing the score needs no live delay or reverb.
 */

/** Music is dark and has little top end, so half the rate costs nothing audible. */
const RATE = 22050;
const MID_RATE = 32000;
const A3 = 220;

const hz = (semi: number) => A3 * 2 ** (semi / 12);

const FELT = [[1, 1, 4.5], [2, 0.38, 2.4], [3, 0.14, 1.3], [4.02, 0.06, 0.8], [5.1, 0.025, 0.5]] as const;
const BELL = [[1, 1, 5], [1.004, 0.55, 5], [2.76, 0.2, 2], [5.4, 0.06, 0.8]] as const;
const LOW_BELL = [[1, 1, 6], [2.01, 0.5, 3.5], [2.74, 0.34, 2.2], [4.13, 0.14, 1.2], [5.4, 0.06, 0.8]] as const;

/** Held notes: saws under a lowpass, opening and closing like a slow breath. */
function chord(o: Out, at: number, semis: readonly number[], d: number, level: number, open: number, wave: OscillatorType = 'sawtooth'): void {
  const { ctx } = o;
  const t = o.t + at;
  const f = filter(ctx, 'lowpass', 120, 0.8);
  f.frequency.setValueAtTime(120, t);
  f.frequency.exponentialRampToValueAtTime(open, t + d * 0.25);
  f.frequency.exponentialRampToValueAtTime(140, t + d);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + Math.min(0.09, d * 0.1));
  g.gain.setTargetAtTime(0, t + d * 0.3, d * 0.22);
  f.connect(g).connect(o.dest);
  for (const s of semis) {
    for (const cents of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.value = hz(s);
      osc.detune.value = cents;
      osc.connect(f);
      osc.start(t);
      osc.stop(t + d * 1.6);
    }
  }
}

function boom(o: Out, at: number, level: number): void {
  tone(o, 0.9 * level, 1.1, 64, 'sine', 40, at);
  burst(o, 0.35 * level, 0.16, 'lowpass', 260, 0.7, undefined, at);
}

const room = (o: Out) => echoed(o, 0.41, 0.34, 1500, 0.3);

// ------------------------------------------------------------------ instruments

const pluck: SampleDef = {
  dur: 7, channels: 1, rate: MID_RATE,
  build(o) {
    struck(room(o), 0.01, hz(0), 0.5, FELT);
  },
};

const glass: SampleDef = {
  dur: 7, channels: 1, rate: MID_RATE,
  build(o) {
    struck(room(o), 0.01, hz(24), 0.3, BELL);
  },
};

const pad: SampleDef = {
  dur: 19, rate: RATE,
  build(o) {
    const { ctx } = o;
    const swell = ctx.createGain();
    swell.gain.setValueAtTime(0, o.t);
    swell.gain.linearRampToValueAtTime(1, o.t + 6);
    swell.gain.setValueAtTime(1, o.t + 9);
    swell.gain.linearRampToValueAtTime(0, o.t + 18.5);
    const f = filter(ctx, 'lowpass', 620, 0.5);
    f.connect(swell).connect(o.dest);
    const voicing = [-12, -5, 2, 7];
    voicing.forEach((semi, i) => {
      for (const cents of [-5, 5]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = hz(semi);
        osc.detune.value = cents + rand(-2, 2);
        const p = ctx.createStereoPanner();
        p.pan.value = (i % 2 ? 1 : -1) * (cents > 0 ? 0.5 : 0.2);
        osc.connect(gain(ctx, 0.085)).connect(p).connect(f);
        osc.start(o.t);
      }
    });
  },
};

const low: SampleDef = {
  dur: 12, channels: 1, rate: RATE,
  build(o) {
    const { ctx } = o;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, o.t);
    g.gain.linearRampToValueAtTime(0.5, o.t + 3);
    g.gain.linearRampToValueAtTime(0, o.t + 11.5);
    const f = filter(ctx, 'lowpass', 240, 0.7);
    f.connect(g).connect(o.dest);
    for (const [type, semi, part] of [['sawtooth', -24, 0.7], ['sawtooth', -24.1, 0.5], ['sine', -36, 0.8]] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz(semi);
      osc.connect(gain(ctx, part)).connect(f);
      osc.start(o.t);
    }
  },
};

const drum: SampleDef = {
  dur: 2.6, takes: 2, channels: 1, rate: RATE,
  build(o) {
    boom(echoed(o, 0.31, 0.3, 480, 0.35), 0.01, 0.85);
  },
};

/** The tense layer's floor: a low unease with nothing in it to count. */
const dread: SampleDef = {
  dur: 26, loop: 4, rate: RATE, rms: 0.2,
  build(o) {
    const { ctx } = o;
    const f = filter(ctx, 'lowpass', 110, 0.8);
    for (let t = 0; t < 30; t += 1.7) f.frequency.linearRampToValueAtTime(rand(70, 170), o.t + t);
    noiseLoop(o, 0.5).connect(f).connect(gain(ctx, 1.4)).connect(o.dest);
    for (const [freq, level] of [[55, 0.12], [58.3, 0.09], [82.4, 0.04]] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain(ctx, level)).connect(o.dest);
      osc.start(o.t);
    }
    const thin = filter(ctx, 'bandpass', 2800, 18);
    for (let t = 0; t < 30; t += 2.3) thin.frequency.linearRampToValueAtTime(rand(2400, 3300), o.t + t);
    noiseLoop(o).connect(thin).connect(gain(ctx, 0.05)).connect(o.dest);
  },
};

// ------------------------------------------------------------------ stingers

const raid: SampleDef = {
  dur: 5.5, rate: RATE,
  build(base) {
    const o = echoed(base, 0.37, 0.3, 900, 0.3);
    boom(o, 0.01, 1);
    boom(o, 0.46, 0.8);
    chord(o, 0.02, [-24, -17, -11, -10], 3.2, 0.11, 950);
  },
};

const firstRaid: SampleDef = {
  dur: 8, rate: RATE,
  build(base) {
    const o = echoed(base, 0.37, 0.34, 900, 0.32);
    boom(o, 0.01, 0.8);
    boom(o, 0.84, 0.8);
    boom(o, 1.44, 0.9);
    boom(o, 1.86, 1);
    chord(o, 0.02, [-24, -12], 2.4, 0.09, 500);
    chord(o, 1.86, [-24, -17, -11, -10, -5], 4.4, 0.11, 1300);
    struck(panned(o, 0.4), 1.9, hz(26), 0.09, BELL);
    struck(panned(o, -0.4), 2.1, hz(27), 0.08, BELL);
  },
};

const chief: SampleDef = {
  dur: 5.5, rate: RATE,
  build(base) {
    const o = echoed(base, 0.33, 0.28, 1800, 0.28);
    boom(o, 0.01, 0.8);
    chord(o, 0.02, [-24, -17], 1.2, 0.1, 900);
    boom(o, 0.72, 0.9);
    chord(o, 0.72, [-19, -12, -5, 2], 3.6, 0.11, 2000);
    struck(o, 0.76, hz(7), 0.28, FELT);
    struck(o, 0.76, hz(14), 0.2, FELT);
  },
};

const death: SampleDef = {
  dur: 9, rate: RATE,
  build(base) {
    const o = echoed(base, 0.53, 0.38, 900, 0.34);
    struck(o, 0.01, 110, 0.42, LOW_BELL);
    struck(panned(o, 0.25), 2.1, hz(3), 0.2, FELT);
    struck(panned(o, -0.25), 3.5, hz(0), 0.24, FELT);
  },
};

const frost: SampleDef = {
  dur: 10, rate: 26000,
  build(base) {
    const { ctx } = base;
    const o = echoed(base, 0.47, 0.42, 3000, 0.4);
    const hiss = filter(ctx, 'bandpass', 3200, 6);
    hiss.frequency.setValueAtTime(3200, o.t);
    hiss.frequency.exponentialRampToValueAtTime(700, o.t + 7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, o.t);
    g.gain.linearRampToValueAtTime(0.22, o.t + 2.5);
    g.gain.linearRampToValueAtTime(0, o.t + 7);
    noiseLoop(o).connect(hiss).connect(g).connect(o.dest);
    struck(panned(o, -0.5), 0.3, hz(31), 0.18, BELL);
    struck(panned(o, 0.5), 1.5, hz(26), 0.18, BELL);
    struck(panned(o, 0.1), 3, hz(24), 0.2, BELL);
    struck(o, 4.8, hz(12), 0.24, BELL);
  },
};

const thaw: SampleDef = {
  dur: 9, rate: RATE,
  build(base) {
    const o = room(base);
    [0, 3, 7, 12, 14].forEach((semi, i) => struck(panned(o, (i - 2) * 0.22), 0.05 + i * 0.95, hz(semi), 0.26 + i * 0.015, FELT));
    chord(o, 0.05, [-12, -5, 2], 6.5, 0.035, 600, 'triangle');
  },
};

/** Cues are prefixed: 'death' is also the sound of someone falling. */
export const SCORE_SAMPLES: Record<string, SampleDef> = { pluck, glass, pad, low, drum, dread, 'cue.raid': raid, 'cue.firstRaid': firstRaid, 'cue.chief': chief, 'cue.death': death, 'cue.frost': frost, 'cue.thaw': thaw };
