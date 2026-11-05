import type { Bank } from './bank';
import type { Mixer } from './mixer';
import type { Layers, Scene } from './scene';
import { filter, gain, rand } from './synth';

/**
 * The world's sound. A bed is one looping buffer through a gain, and it only exists while it can be
 * heard. Wind alone is filtered live, because moving filters are what makes it wind.
 */

/** Tuning: the level of each layer when it's fully present. */
export const AMBIENCE_LEVEL = { wind: 0.7, whistle: 0.24, rain: 0.34, water: 0.3, fire: 0.36, insects: 0.15, crickets: 0.15 };
/** Tuning: calls per minute at full presence, the level they play at, and how widely they spread. */
const CALLS = {
  birds: { sample: 'call.birds', perMin: 11, level: 0.3, width: 0.8 },
  wolves: { sample: 'call.wolves', perMin: 0.9, level: 0.3, width: 0.7 },
  thunder: { sample: 'call.thunder', perMin: 1.3, level: 0.75, width: 0.5 },
  ice: { sample: 'call.ice', perMin: 3, level: 0.34, width: 0.8 },
  // Single snaps over the fire's loop, so no two passes through it are the same.
  fire: { sample: 'fire', perMin: 30, level: 1, width: 0.5 },
} as const;
/** Tuning: seconds for a layer to fade toward where it should be. */
const FADE_S = 2.2;
/** Below this a bed has faded out, and after IDLE_S of that it's stopped. */
const SILENT = 0.002;
const IDLE_S = 8;
const MAX_CALLS = 3;
/** Tuning: wind gusts; how often the air changes its mind, and how far. */
const GUST_EVERY: [number, number] = [2.5, 7];
const GUST_DEPTH = 0.55;

/** One looping layer, started when first needed and stopped once it has been silent a while. */
export class Bed {
  private gain: GainNode;
  private pan: StereoPannerNode;
  private src: AudioBufferSourceNode | null = null;
  private idleSince: number | null = null;
  private level = 0;
  private panAt = 0;

  constructor(
    private ctx: BaseAudioContext,
    bus: AudioNode,
    private bank: Bank,
    private name: string,
    private fade = FADE_S,
  ) {
    this.gain = gain(ctx, 0);
    this.pan = ctx.createStereoPanner();
    this.gain.connect(this.pan).connect(bus);
  }

  get playing(): boolean {
    return !!this.src;
  }

  set(level: number, pan: number, t: number): void {
    if (level > SILENT && !this.src) {
      const buffer = this.bank.pick(this.name);
      if (!buffer) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(this.gain);
      // Anywhere in the loop: two sessions never line up, and it never starts on the same crackle.
      src.start(t, Math.random() * buffer.duration);
      this.src = src;
    }
    // Nothing changed: don't grow the parameter's timeline four times a second, forever.
    if (Math.abs(level - this.level) > 1e-4 || Math.abs(pan - this.panAt) > 1e-3) {
      this.level = level;
      this.panAt = pan;
      this.gain.gain.setTargetAtTime(level, t, this.fade);
      this.pan.pan.setTargetAtTime(pan, t, this.fade);
    }
    if (level > SILENT) {
      this.idleSince = null;
      return;
    }
    this.idleSince ??= t;
    if (this.src && t - this.idleSince > IDLE_S) this.stop(t);
  }

  stop(t: number): void {
    this.src?.stop(t + 0.05);
    this.src = null;
    this.idleSince = null;
  }
}

export class Ambience {
  private beds: Record<'rain' | 'water' | 'fire' | 'insects' | 'crickets', Bed>;
  private wind: { src: AudioBufferSourceNode | null; body: GainNode; edge: GainNode; low: BiquadFilterNode; high: BiquadFilterNode };
  private gust = 1;
  private gustTo = 1;
  private nextGust = 0;
  private calls = 0;
  private lastT = 0;

  constructor(
    private ctx: BaseAudioContext,
    private mixer: Mixer,
    private bank: Bank,
  ) {
    const bus = mixer.buses.ambience;
    const bed = (name: string) => new Bed(ctx, bus, bank, `bed.${name}`);
    this.beds = { rain: bed('rain'), water: bed('water'), fire: bed('fire'), insects: bed('insects'), crickets: bed('crickets') };
    const low = filter(ctx, 'lowpass', 400, 0.5);
    const high = filter(ctx, 'bandpass', 1300, 4);
    const body = gain(ctx, 0);
    const edge = gain(ctx, 0);
    low.connect(body).connect(bus);
    high.connect(edge).connect(bus);
    this.wind = { src: null, body, edge, low, high };
  }

  private blow(t: number, l: Layers): void {
    const w = this.wind;
    if (!w.src && l.wind > SILENT) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.bank.noise;
      src.loop = true;
      src.connect(w.low);
      src.connect(w.high);
      src.start(t);
      w.src = src;
    }
    if (t >= this.nextGust) {
      this.nextGust = t + rand(GUST_EVERY[0], GUST_EVERY[1]);
      this.gustTo = 1 - GUST_DEPTH * Math.random();
    }
    this.gust += (this.gustTo - this.gust) * 0.25;
    const air = l.wind * this.gust;
    // Light air is mostly felt as a low movement; the curve keeps it present without making gales deafening.
    w.body.gain.setTargetAtTime(AMBIENCE_LEVEL.wind * air ** 0.6, t, 0.9);
    w.low.frequency.setTargetAtTime(300 + 560 * air, t, 0.9);
    w.edge.gain.setTargetAtTime(AMBIENCE_LEVEL.whistle * l.whistle * this.gust * this.gust, t, 0.9);
    w.high.frequency.setTargetAtTime(800 + 1500 * air, t, 0.7);
  }

  private call(c: (typeof CALLS)[keyof typeof CALLS], t: number): void {
    const buffer = this.bank.pick(c.sample);
    if (!buffer || this.calls >= MAX_CALLS) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rand(0.92, 1.08);
    const g = gain(this.ctx, c.level * rand(0.55, 1));
    const p = this.ctx.createStereoPanner();
    p.pan.value = rand(-c.width, c.width);
    src.connect(g).connect(p).connect(this.mixer.buses.ambience);
    this.calls++;
    src.onended = () => this.calls--;
    src.start(t);
  }

  /** Move toward what the scene asks for. `t` is the audio clock; call a few times a second. */
  update(t: number, l: Layers, s: Pick<Scene, 'waterPan' | 'firePan'>): void {
    const dt = this.lastT ? Math.min(1, t - this.lastT) : 0;
    this.lastT = t;
    this.blow(t, l);
    const b = this.beds;
    const LV = AMBIENCE_LEVEL;
    b.rain.set(LV.rain * l.rain, 0, t);
    b.water.set(LV.water * l.water, s.waterPan * 0.7, t);
    b.fire.set(LV.fire * l.fire, s.firePan * 0.7, t);
    b.insects.set(LV.insects * l.insects, 0, t);
    b.crickets.set(LV.crickets * l.crickets, 0, t);
    for (const key of Object.keys(CALLS) as (keyof typeof CALLS)[]) {
      const c = CALLS[key];
      if (Math.random() < l[key] * (c.perMin / 60) * dt) this.call(c, t);
    }
  }

  /** How many loops are running: anything inaudible should have stopped. */
  get looping(): number {
    return Object.values(this.beds).filter((b) => b.playing).length + (this.wind.src ? 1 : 0);
  }

  /** Stop the loops outright, once they've faded: the page is hidden. */
  stop(t: number): void {
    for (const b of Object.values(this.beds)) b.stop(t);
    this.wind.src?.stop(t + 0.05);
    this.wind.src = null;
  }
}
