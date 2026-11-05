import type { SampleDef } from './bank';
import { burst, echoed, filter, gain, noiseLoop, panned, rand, tone, type Out } from './synth';

/**
 * The world's sounds, rendered once at load: long seamless beds for what never stops (water, fire,
 * insects, rain), and short calls for what comes and goes. Everything here runs offline, so it can
 * use as many nodes as it likes; what plays back is one buffer through one gain.
 */

const BED_RATE = 32000;
/** Loud enough to work with; each layer's real level is set in AMBIENCE_LEVEL. */
const BED_RMS = 0.2;

/** Wander a parameter through random values, for a texture that keeps changing. */
function wander(p: AudioParam, o: Out, dur: number, step: number, lo: number, hi: number): void {
  for (let t = 0; t < dur; t += step) p.linearRampToValueAtTime(rand(lo, hi), o.t + t);
}

// -------------------------------------------------------------------- beds

/** A bubble: a sine that rises as it collapses. A stream is hundreds of these. */
function bubble(o: Out, at: number): void {
  const { ctx } = o;
  const t = o.t + at;
  const f0 = rand(380, 1500);
  const d = rand(0.03, 0.1);
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f0 * rand(1.3, 1.9), t + d);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(rand(0.02, 0.1), t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  osc.connect(g).connect(panned(o, rand(-0.8, 0.8)).dest);
  osc.start(t);
  osc.stop(t + d + 0.01);
}

const water: SampleDef = {
  dur: 9, loop: 1, rate: BED_RATE, rms: BED_RMS,
  build(o) {
    const { ctx } = o;
    const low = filter(ctx, 'lowpass', 420, 0.5);
    wander(low.frequency, o, 10, 0.7, 300, 620);
    noiseLoop(o, 0.8).connect(low).connect(gain(ctx, 0.5)).connect(o.dest);
    const mid = filter(ctx, 'bandpass', 900, 0.8);
    wander(mid.frequency, o, 10, 0.5, 650, 1300);
    noiseLoop(o, 0.9).connect(mid).connect(gain(ctx, 0.22)).connect(o.dest);
    for (let i = 0; i < 170; i++) bubble(o, rand(0, 10));
  },
};

const FIRE_S = 13;

/** Long for a bed: its pops are the one thing here an ear could learn the loop by. */
const fire: SampleDef = {
  dur: FIRE_S, loop: 0.6, rate: BED_RATE, rms: BED_RMS,
  build(o) {
    const { ctx } = o;
    const roar = filter(ctx, 'lowpass', 190, 0.6);
    const breath = gain(ctx, 0.6);
    wander(breath.gain, o, FIRE_S + 1, 0.45, 0.35, 0.8);
    noiseLoop(o, 0.7).connect(roar).connect(breath).connect(o.dest);
    noiseLoop(o).connect(filter(ctx, 'highpass', 5500, 0.7)).connect(gain(ctx, 0.012)).connect(o.dest);
    for (let i = 0; i < 170; i++) {
      const p = panned(o, rand(-0.7, 0.7));
      const hard = Math.random() ** 3;
      burst({ ...p, t: o.t + rand(0, FIRE_S) }, 0.06 + hard * 0.3, rand(0.004, 0.022), 'bandpass', rand(1200, 6500), 0.8);
    }
    for (let i = 0; i < 16; i++) burst({ ...o, t: o.t + rand(0, FIRE_S) }, rand(0.1, 0.22), rand(0.03, 0.07), 'lowpass', rand(500, 1100));
  },
};

const rain: SampleDef = {
  dur: 6, loop: 0.6, rate: BED_RATE, rms: BED_RMS,
  build(o) {
    const { ctx } = o;
    noiseLoop(o).connect(filter(ctx, 'highpass', 1700, 0.6)).connect(filter(ctx, 'lowpass', 9000, 0.6)).connect(gain(ctx, 0.5)).connect(o.dest);
    noiseLoop(o, 0.7).connect(filter(ctx, 'lowpass', 500, 0.6)).connect(gain(ctx, 0.3)).connect(o.dest);
    for (let i = 0; i < 160; i++) burst({ ...panned(o, rand(-0.9, 0.9)), t: o.t + rand(0, 6.5) }, rand(0.05, 0.3), rand(0.006, 0.02), 'bandpass', rand(1500, 5000), 1.5);
  },
};

/** Day insects: a chirring band that swells and sinks. */
const insects: SampleDef = {
  dur: 11, loop: 1.5, rate: BED_RATE, rms: BED_RMS,
  build(o) {
    const { ctx } = o;
    for (const [freq, q, rate, pan] of [[3600, 9, 24, -0.5], [5400, 12, 31, 0.45], [7200, 10, 38, 0.1]]) {
      const p = panned(o, pan);
      const band = filter(ctx, 'bandpass', freq, q);
      const chirr = gain(ctx, 0.55);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      lfo.connect(gain(ctx, 0.45)).connect(chirr.gain);
      lfo.start(o.t);
      const swell = gain(ctx, 0.5);
      wander(swell.gain, o, 13, 1.3, 0.15, 1);
      noiseLoop(o).connect(band).connect(chirr).connect(swell).connect(p.dest);
    }
  },
};

const crickets: SampleDef = {
  dur: 8, loop: 0.5, rate: BED_RATE, rms: BED_RMS,
  build(o) {
    const { ctx } = o;
    for (let i = 0; i < 6; i++) {
      const osc = ctx.createOscillator();
      osc.frequency.value = rand(3900, 4800);
      const g = ctx.createGain();
      g.gain.value = 0;
      const level = rand(0.25, 1);
      const rate = rand(1.1, 2);
      for (let t = rand(0, 0.5); t < 8.4; t += 1 / rate + rand(-0.03, 0.03)) {
        for (let p = 0; p < 3; p++) {
          const at = o.t + t + p * 0.035;
          g.gain.setValueAtTime(0, at);
          g.gain.linearRampToValueAtTime(level, at + 0.006);
          g.gain.linearRampToValueAtTime(0, at + 0.024);
        }
      }
      osc.connect(g).connect(panned(o, rand(-0.85, 0.85)).dest);
      osc.start(o.t);
    }
  },
};

// -------------------------------------------------------------------- calls

function whistle(o: Out, at: number, f0: number, f1: number, d: number, level: number): void {
  const { ctx } = o;
  const t = o.t + at;
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + d);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + d * 0.2);
  g.gain.linearRampToValueAtTime(level * 0.7, t + d * 0.7);
  g.gain.linearRampToValueAtTime(0, t + d);
  osc.connect(g).connect(o.dest);
  osc.start(t);
  osc.stop(t + d + 0.01);
}

/** A handful of different birds; each take is one voice. */
const birds: SampleDef = {
  dur: 3, takes: 6, channels: 1, rate: BED_RATE,
  build(base, take) {
    const o = echoed(base, 0.19, 0.3, 2600, 0.3);
    let t = 0.02;
    switch (take) {
      case 0: // Two clear falling notes.
        whistle(o, t, 3500, 3440, 0.34, 0.4);
        whistle(o, t + 0.42, 2880, 2840, 0.46, 0.4);
        break;
      case 1: // A fast trill.
        for (let i = 0; i < 14; i++) whistle(o, t + i * 0.052, i % 2 ? 4750 : 4200, i % 2 ? 4200 : 4750, 0.048, 0.3);
        break;
      case 2: // A wandering song.
        for (let i = 0; i < 8; i++) {
          const d = rand(0.08, 0.2);
          whistle(o, t, rand(2200, 3900), rand(2200, 3900), d, 0.34);
          t += d + rand(0.02, 0.1);
        }
        break;
      case 3: // Thin, high seeps.
        for (let i = 0; i < 3; i++) whistle(o, t + i * 0.26, 6000, 7100, 0.09, 0.22);
        break;
      case 4: // A crow, some way off.
        for (let i = 0; i < 3; i++) tone(o, 0.3, 0.24, 430, 'sawtooth', 340, t + i * 0.42, 1100);
        break;
      default: // A low coo.
        whistle(o, t, 520, 590, 0.3, 0.4);
        whistle(o, t + 0.34, 590, 470, 0.55, 0.45);
        break;
    }
  },
};

function howl(o: Out, at: number, low: number, high: number, d: number, level: number): void {
  const { ctx } = o;
  const t = o.t + at;
  const vib = ctx.createOscillator();
  vib.frequency.value = rand(4, 5.5);
  const depth = gain(ctx, 5);
  vib.connect(depth);
  vib.start(t);
  vib.stop(t + d);
  const voice = filter(ctx, 'bandpass', 820, 1.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + d * 0.25);
  g.gain.setValueAtTime(level, t + d * 0.65);
  g.gain.linearRampToValueAtTime(0, t + d);
  voice.connect(g).connect(o.dest);
  for (const [type, part] of [['sawtooth', 0.5], ['sine', 0.9]] as const) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(low, t);
    osc.frequency.exponentialRampToValueAtTime(high, t + d * 0.3);
    osc.frequency.setValueAtTime(high, t + d * 0.62);
    osc.frequency.exponentialRampToValueAtTime(low * 0.8, t + d);
    depth.connect(osc.frequency);
    osc.connect(gain(ctx, part)).connect(voice);
    osc.start(t);
    osc.stop(t + d);
  }
}

const wolves: SampleDef = {
  dur: 9, takes: 3, channels: 1, rate: 16000,
  build(base, take) {
    const far = filter(base.ctx, 'lowpass', 1300, 0.7);
    far.connect(base.dest);
    const o = echoed({ ...base, dest: far }, 0.42, 0.42, 900, 0.5);
    howl(o, 0.05, rand(300, 340), rand(470, 530), rand(3.6, 4.6), 0.55);
    if (take > 0) howl(o, rand(1.4, 2.2), rand(350, 390), rand(560, 620), rand(3, 3.8), 0.38);
    if (take > 1) howl(o, rand(2.8, 3.4), rand(260, 300), rand(420, 460), rand(3, 3.6), 0.3);
  },
};

const thunder: SampleDef = {
  dur: 7, takes: 2, channels: 1, rate: 12000,
  build(base) {
    const o = { ...base, dest: gain(base.ctx, 3.5) };
    o.dest.connect(base.dest);
    burst(o, 0.22, 0.5, 'lowpass', 900, 0.7, 180, 0.02);
    burst(o, 0.9, 3.2, 'lowpass', 190, 0.7, 50, 0.1);
    burst(o, 0.55, 2.2, 'lowpass', 150, 0.7, 45, 1.1);
    burst(o, 0.45, 3, 'lowpass', 130, 0.7, 40, 2.6);
  },
};

/** The frost working: lake ice and frozen ground cracking somewhere out there. */
const ice: SampleDef = {
  dur: 1.8, takes: 3, channels: 1, rate: BED_RATE,
  build(base) {
    const o = echoed(base, 0.13, 0.35, 2400, 0.35);
    tone(o, 0.14, 0.04, rand(1700, 2600), 'sawtooth', 500, 0, 3000);
    tone(o, 0.22, 0.3, rand(3000, 4000), 'sine', rand(400, 700));
    burst(o, 0.14, 0.07, 'highpass', 3000);
    tone(o, 0.2, 0.7, rand(80, 110), 'sine', 55, 0.02);
  },
};

/** Prefixed so they can't collide with a short effect of the same name. */
export const WORLD_SAMPLES: Record<string, SampleDef> = { 'bed.water': water, 'bed.fire': fire, 'bed.rain': rain, 'bed.insects': insects, 'bed.crickets': crickets, 'call.birds': birds, 'call.wolves': wolves, 'call.thunder': thunder, 'call.ice': ice };
