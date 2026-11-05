import type { Bank } from './bank';
import type { Mixer } from './mixer';
import { RECIPES, type Kind } from './recipes';

/** Where the camera is, in world units, and how wide the view is. */
export interface Ear {
  x: number;
  y: number;
  span: number;
}

/** Tuning: most positional sounds at once. A big fight keeps its loudest and nearest. */
export const MAX_VOICES = 14;
/** Tuning: sounds of one kind at once, when the recipe doesn't say. */
const KIND_CAP = 3;
/** Tuning: how far toward one ear a sound at the edge of the screen sits. */
const MAX_PAN = 0.8;
/** Below this it isn't worth a voice. */
export const INAUDIBLE = 0.02;
/** Muffled less than this, skip the filter. */
const MUFFLE_MIN = 0.2;
const OPEN_HZ = 20000;
const SHUT_HZ = 1100;

/** 0..1 loudness for a sound at a world position: nothing a bit past the edge of the screen, and zoomed far out everything is quieter. */
export function reach(x: number, y: number, ear: Ear): number {
  const d = Math.hypot(x - ear.x, y - ear.y);
  const zoom = Math.min(1, 900 / ear.span);
  return Math.max(0, 1 - d / (ear.span * 0.7)) * (0.35 + 0.65 * zoom);
}

/** -1 left .. 1 right, by where it is across the screen. */
export function panAt(x: number, ear: Ear): number {
  return Math.max(-1, Math.min(1, (x - ear.x) / (ear.span / 2))) * MAX_PAN;
}

/** 0 clear .. 1 dull: distance and height both take the top off a sound. */
export function muffleAt(x: number, y: number, ear: Ear): number {
  const far = Math.min(1, Math.hypot(x - ear.x, y - ear.y) / (ear.span * 0.7));
  const high = 1 - Math.min(1, 900 / ear.span);
  return Math.max(far * far, high * 0.7);
}

/** The lowpass for a muffle amount, or 0 for none needed. */
export function cutoffFor(muffle: number): number {
  return muffle < MUFFLE_MIN ? 0 : OPEN_HZ * (SHUT_HZ / OPEN_HZ) ** muffle;
}

interface Slot<T> {
  kind: string;
  /** Importance: priority first, loudness within it. */
  score: number;
  end: number;
  handle: T;
}

/**
 * Who gets to sound. Voices that have finished free themselves; when full, a new sound takes over
 * from the least important one playing, or is dropped if it's the least important itself.
 */
export class VoiceCap<T> {
  private slots: Slot<T>[] = [];

  constructor(
    readonly max: number,
    private kindCap: (kind: string) => number = () => max,
  ) {}

  get active(): number {
    return this.slots.length;
  }

  /** `ok` says whether to play; `steal` is a voice to fade out to make room. */
  claim(kind: string, score: number, end: number, now: number, handle: T): { ok: boolean; steal: T | null } {
    this.slots = this.slots.filter((s) => s.end > now);
    const same = this.slots.filter((s) => s.kind === kind);
    const pool = same.length >= this.kindCap(kind) ? same : this.slots.length >= this.max ? this.slots : null;
    let steal: T | null = null;
    if (pool) {
      const weakest = pool.reduce((a, b) => (b.score < a.score ? b : a));
      if (weakest.score >= score) return { ok: false, steal: null };
      this.slots.splice(this.slots.indexOf(weakest), 1);
      steal = weakest.handle;
    }
    this.slots.push({ kind, score, end, handle });
    return { ok: true, steal };
  }
}

interface Playing {
  /** Null for a recipe playing live, which just gets faded. */
  src: AudioBufferSourceNode | null;
  gain: GainNode;
}

/** Plays the short sounds. Each costs a source, a gain and a panner, plus a filter when far away. */
export class Voices {
  private cap = new VoiceCap<Playing>(MAX_VOICES, (k) => RECIPES[k as Kind].cap ?? KIND_CAP);
  private last = new Map<Kind, number>();

  constructor(
    private ctx: BaseAudioContext,
    private mixer: Mixer,
    private bank: Bank,
  ) {}

  get active(): number {
    return this.cap.active;
  }

  play(kind: Kind, loud = 1, pan = 0, muffle = 0, t = this.ctx.currentTime): boolean {
    const r = RECIPES[kind];
    const seen = this.last.get(kind);
    if (seen !== undefined && (t - seen) * 1000 < (r.gap ?? 30)) return false;
    const { ctx } = this;
    const gain = ctx.createGain();
    gain.gain.value = loud * (r.level ?? 1);
    const voice: Playing = { src: null, gain };
    if (!r.screen) {
      const { ok, steal } = this.cap.claim(kind, (r.prio ?? 1) + loud, t + r.dur, t, voice);
      if (!ok) return false;
      if (steal) {
        steal.gain.gain.setTargetAtTime(0, t, 0.012);
        steal.src?.stop(t + 0.06);
      }
    }
    this.last.set(kind, t);
    const bus = this.mixer.buses[r.screen ? 'interface' : 'effects'];
    let tail: AudioNode = bus;
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(tail);
      tail = p;
    }
    gain.connect(tail);
    const buffer = this.bank.pick(kind);
    if (!buffer) {
      // Not rendered yet: the first click after a page load comes through this way.
      r.make({ ctx, dest: gain, noise: this.bank.noise, t });
      return true;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (r.spread) src.playbackRate.value = 1 + (Math.random() * 2 - 1) * r.spread;
    const cutoff = cutoffFor(muffle);
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoff;
      src.connect(f).connect(gain);
    } else {
      src.connect(gain);
    }
    src.start(t);
    voice.src = src;
    return true;
  }
}
