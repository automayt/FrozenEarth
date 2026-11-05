/**
 * The small set of parts every sound is made from. They write into any BaseAudioContext at a given
 * time, so one recipe can play live or be rendered once into a buffer.
 */

export interface Out {
  ctx: BaseAudioContext;
  dest: AudioNode;
  /** Stereo white noise, a few seconds long. */
  noise: AudioBuffer;
  /** When the sound starts, in context time. */
  t: number;
}

const NOISE_S = 6;

export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.round(ctx.sampleRate * NOISE_S);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** A burst of filtered noise with a fast attack and exponential decay. */
export function burst(o: Out, gain: number, dur: number, type: BiquadFilterType, freq: number, q = 1, sweepTo?: number, delay = 0): void {
  const { ctx } = o;
  const t = o.t + delay;
  const src = ctx.createBufferSource();
  src.buffer = o.noise;
  src.playbackRate.value = rand(0.8, 1.2);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.005, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(o.dest);
  src.start(t, Math.random() * 4, dur + 0.05);
}

/** A short pitched tone, softened by a lowpass when `cutoff` is given. */
export function tone(o: Out, gain: number, dur: number, freq: number, type: OscillatorType = 'sine', endFreq?: number, delay = 0, cutoff?: number): void {
  const { ctx } = o;
  const t = o.t + delay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.008, dur / 3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  if (cutoff) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    osc.connect(f).connect(g).connect(o.dest);
  } else {
    osc.connect(g).connect(o.dest);
  }
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/** A looping noise source (decorrelated left and right), for beds. */
export function noiseLoop(o: Out, rate = 1): AudioBufferSourceNode {
  const src = o.ctx.createBufferSource();
  src.buffer = o.noise;
  src.loop = true;
  src.playbackRate.value = rate;
  src.start(o.t, Math.random() * 5);
  return src;
}

export function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

export function gain(ctx: BaseAudioContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

/** Same output, placed somewhere in the stereo field. */
export function panned(o: Out, pan: number): Out {
  const p = o.ctx.createStereoPanner();
  p.pan.value = pan;
  p.connect(o.dest);
  return { ...o, dest: p };
}

/** Same output with a filtered echo behind it: the only space anything here gets, baked in. */
export function echoed(o: Out, time: number, feedback: number, cutoff: number, mix: number): Out {
  const { ctx } = o;
  const input = ctx.createGain();
  input.connect(o.dest);
  const d = ctx.createDelay(Math.max(1, time + 0.1));
  d.delayTime.value = time;
  const f = filter(ctx, 'lowpass', cutoff, 0.7);
  const fb = gain(ctx, feedback);
  const wet = gain(ctx, mix);
  input.connect(d);
  d.connect(f);
  f.connect(fb);
  fb.connect(d);
  f.connect(wet);
  wet.connect(o.dest);
  return { ...o, dest: input };
}

/** One struck note: sine partials as [ratio, level, seconds to die away]. */
export function struck(o: Out, at: number, freq: number, level: number, parts: readonly (readonly [number, number, number])[], attack = 0.005): void {
  const { ctx } = o;
  const t = o.t + at;
  for (const [ratio, part, decay] of parts) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq * ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * part, t + attack);
    g.gain.setTargetAtTime(0, t + attack, decay / 5);
    osc.connect(g).connect(o.dest);
    osc.start(t);
    osc.stop(t + decay * 1.4);
  }
}
