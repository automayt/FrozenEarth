import { RECIPES, type Kind } from './recipes';
import { makeNoise, type Out } from './synth';

/** A sound worth rendering once and keeping. */
export interface SampleDef {
  dur: number;
  takes?: number;
  channels?: 1 | 2;
  rate?: number;
  /** A bed that loops: this many seconds of tail are crossfaded into the head. */
  loop?: number;
  /** Scale each take to this RMS, so a bed's loudness is set in one table and not by its filters. */
  rms?: number;
  build(o: Out, take: number): void;
}

/** Plenty for short effects; about a third of the memory of 44.1k stereo. */
const EFFECT_RATE = 32000;

/** Fold `tail` samples past `n` back over the start with an equal-power fade, so the first `n` loop without a seam. */
export function foldLoop(data: Float32Array, n: number, tail: number): Float32Array {
  const out = data.slice(0, n);
  for (let i = 0; i < tail; i++) {
    const k = ((i + 0.5) / tail) * (Math.PI / 2);
    out[i] = data[i] * Math.sin(k) + data[n + i] * Math.cos(k);
  }
  return out;
}

function scaleToRms(buf: AudioBuffer, target: number): void {
  let sum = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
  }
  const rms = Math.sqrt(sum / (buf.length * buf.numberOfChannels));
  if (rms < 1e-6) return;
  const k = target / rms;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

/** Renders once at startup, off the main thread; playing from it costs almost nothing. */
export class Bank {
  readonly noise: AudioBuffer;
  private buffers = new Map<string, AudioBuffer[]>();
  /** Wall-clock milliseconds spent rendering, for the report. */
  renderMs = 0;

  constructor(private ctx: BaseAudioContext) {
    this.noise = makeNoise(ctx);
  }

  has(name: string): boolean {
    return this.buffers.has(name);
  }

  /** A random take, or undefined if it isn't ready yet. */
  pick(name: string): AudioBuffer | undefined {
    const list = this.buffers.get(name);
    return list?.[Math.floor(Math.random() * list.length)];
  }

  take(name: string, i: number): AudioBuffer | undefined {
    return this.buffers.get(name)?.[i];
  }

  count(name: string): number {
    return this.buffers.get(name)?.length ?? 0;
  }

  async render(name: string, def: SampleDef): Promise<void> {
    const rate = def.rate ?? this.ctx.sampleRate;
    const channels = def.channels ?? 2;
    const tail = def.loop ?? 0;
    const length = Math.ceil((def.dur + tail) * rate);
    const list: AudioBuffer[] = [];
    const start = performance.now();
    for (let take = 0; take < (def.takes ?? 1); take++) {
      const off = new OfflineAudioContext(channels, length, rate);
      def.build({ ctx: off, dest: off.destination, noise: this.noise, t: 0 }, take);
      let buf = await off.startRendering();
      if (tail) buf = this.looped(buf, Math.ceil(def.dur * rate), Math.ceil(tail * rate));
      if (def.rms) scaleToRms(buf, def.rms);
      list.push(buf);
    }
    this.renderMs += performance.now() - start;
    this.buffers.set(name, list);
  }

  private looped(buf: AudioBuffer, n: number, tail: number): AudioBuffer {
    const out = this.ctx.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(foldLoop(buf.getChannelData(c), n, tail) as Float32Array<ArrayBuffer>, c);
    return out;
  }

  /** The short sounds: interface first, since a click is the next thing anyone will hear. */
  async renderEffects(): Promise<void> {
    const kinds = (Object.keys(RECIPES) as Kind[]).sort((a, b) => Number(!!RECIPES[b].screen) - Number(!!RECIPES[a].screen));
    for (const kind of kinds) {
      const r = RECIPES[kind];
      await this.render(kind, { dur: r.dur, takes: r.takes, channels: 1, rate: EFFECT_RATE, build: (o) => r.make(o) });
    }
  }

  async renderAll(defs: Record<string, SampleDef>): Promise<void> {
    for (const [name, def] of Object.entries(defs)) await this.render(name, def);
  }
}
