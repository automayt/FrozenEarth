/**
 * Procedural sound: every effect is synthesised with Web Audio, so there are no audio files.
 * Sounds are attenuated by distance from the camera, rate-limited per kind, and the whole
 * thing stays silent until the first user gesture (browsers require that).
 */

const VOLUME_KEY = 'fe.volume';
const MUTE_KEY = 'fe.muted';

type Kind = 'stone' | 'wood' | 'leaf' | 'build' | 'soil' | 'craft' | 'steam' | 'tend' | 'rifle' | 'bow' | 'melee' | 'hit' | 'fall' | 'crumble' | 'rock' | 'fire' | 'click' | 'good' | 'bad' | 'neutral' | 'pop';

function readNum(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : Number(v);
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the setting just won't persist.
  }
}

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private wind: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private rain: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private last = new Map<Kind, number>();
  private listener = { x: 0, y: 0, span: 1000 };
  volume = readNum(VOLUME_KEY, 0.5);
  muted = readNum(MUTE_KEY, 0) === 1;
  private changeListeners = new Set<() => void>();

  /** Create the audio graph. Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.applyVolume();
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    write(VOLUME_KEY, String(this.volume));
    this.applyVolume();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    write(MUTE_KEY, this.muted ? '1' : '0');
    this.applyVolume();
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private applyVolume(): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume * 0.8, this.ctx.currentTime, 0.05);
    for (const fn of this.changeListeners) fn();
  }

  /** Where the camera is, in world units, and how wide the view is. */
  setListener(x: number, y: number, span: number): void {
    this.listener = { x, y, span: Math.max(200, span) };
  }

  /** 0..1 loudness for a sound at a world position. */
  private reach(x?: number, y?: number): number {
    if (x === undefined || y === undefined) return 1;
    const d = Math.hypot(x - this.listener.x, y - this.listener.y);
    // Zoomed far out, everything is a bit quieter.
    const zoom = Math.min(1, 900 / this.listener.span);
    return Math.max(0, 1 - d / (this.listener.span * 0.7)) * (0.35 + 0.65 * zoom);
  }

  private ready(kind: Kind, minGapMs: number): boolean {
    if (!this.ctx || !this.master || this.muted || this.ctx.state !== 'running') return false;
    const now = performance.now();
    if (now - (this.last.get(kind) ?? 0) < minGapMs) return false;
    this.last.set(kind, now);
    return true;
  }

  // ---------------------------------------------------------------- building blocks

  /** A burst of filtered noise with a fast attack and exponential decay. */
  private burst(gain: number, dur: number, type: BiquadFilterType, freq: number, q = 1, sweepTo?: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  /** A short pitched tone. */
  private tone(gain: number, dur: number, freq: number, type: OscillatorType = 'sine', endFreq?: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- effects

  /** One-off sound at a world position (or non-positional if x/y omitted). */
  play(kind: Kind, x?: number, y?: number): void {
    const v = this.reach(x, y);
    if (v <= 0.02) return;
    const gaps: Partial<Record<Kind, number>> = { stone: 90, wood: 90, leaf: 120, build: 90, soil: 140, craft: 160, steam: 200, rifle: 40, bow: 50, melee: 50, hit: 40, fire: 60, pop: 70 };
    if (!this.ready(kind, gaps[kind] ?? 30)) return;
    switch (kind) {
      case 'stone':
        // Pick on rock: a bright click over a dull knock.
        this.burst(0.35 * v, 0.05, 'highpass', 2500);
        this.burst(0.5 * v, 0.12, 'lowpass', 500);
        break;
      case 'wood':
        this.tone(0.25 * v, 0.09, 220 + Math.random() * 40, 'triangle', 140);
        this.burst(0.3 * v, 0.07, 'bandpass', 900, 2);
        break;
      case 'leaf':
        this.burst(0.18 * v, 0.18, 'highpass', 3000);
        break;
      case 'build':
        this.tone(0.18 * v, 0.06, 520 + Math.random() * 80, 'square', 300);
        this.burst(0.2 * v, 0.06, 'bandpass', 1400, 3);
        break;
      case 'soil':
        this.burst(0.2 * v, 0.16, 'lowpass', 700);
        break;
      case 'craft':
        this.burst(0.12 * v, 0.12, 'bandpass', 2200, 4);
        break;
      case 'steam':
        this.burst(0.18 * v, 0.5, 'highpass', 4000);
        break;
      case 'tend':
        break;
      case 'rifle':
        this.burst(0.7 * v, 0.03, 'highpass', 1500);
        this.burst(0.5 * v, 0.35, 'lowpass', 900, 0.7, 120);
        break;
      case 'bow':
        this.tone(0.25 * v, 0.18, 330, 'triangle', 180);
        this.burst(0.12 * v, 0.12, 'bandpass', 1800, 2, 600);
        break;
      case 'melee':
        this.burst(0.3 * v, 0.16, 'bandpass', 600, 1.5, 2400);
        break;
      case 'hit':
        this.tone(0.3 * v, 0.1, 140, 'sine', 60);
        this.burst(0.25 * v, 0.06, 'lowpass', 1200);
        break;
      case 'fall':
        // Creak, then the crash.
        this.tone(0.12 * v, 0.5, 90, 'sawtooth', 60);
        setTimeout(() => this.ctx && this.burst(0.6 * v, 0.7, 'lowpass', 600, 0.7, 80), 480);
        break;
      case 'crumble':
        this.burst(0.5 * v, 0.6, 'lowpass', 800, 0.7, 100);
        this.burst(0.25 * v, 0.3, 'bandpass', 1500, 1);
        break;
      case 'rock':
        this.burst(0.5 * v, 0.35, 'lowpass', 600, 0.8, 120);
        break;
      case 'fire':
        this.burst(0.08 * v, 0.03 + Math.random() * 0.03, 'highpass', 2000 + Math.random() * 3000);
        break;
      case 'pop':
        this.tone(0.08 * v, 0.06, 660, 'sine', 990);
        break;
      case 'click':
        this.tone(0.08, 0.04, 880, 'sine', 660);
        break;
      case 'good':
        this.tone(0.14, 0.35, 660, 'sine');
        this.tone(0.12, 0.45, 990, 'sine', undefined, 0.12);
        break;
      case 'bad':
        this.tone(0.16, 0.5, 220, 'triangle', 180);
        this.tone(0.12, 0.6, 165, 'triangle', 140, 0.15);
        break;
      case 'neutral':
        this.tone(0.1, 0.3, 520, 'sine');
        break;
    }
  }

  /** Continuous wind and rain, eased toward the current weather. 0..1 each. */
  ambience(wind: number, rain: number): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (!this.wind) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.wind = { src, gain, filter };
    }
    if (!this.rain) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.playbackRate.value = 1.3;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 1800;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.rain = { src, gain };
    }
    // Gusts: the wind's level and pitch wander slowly.
    const gust = 0.75 + 0.25 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1);
    this.wind.gain.gain.setTargetAtTime(0.18 * wind * gust, t, 0.8);
    this.wind.filter.frequency.setTargetAtTime(250 + 500 * wind * gust, t, 0.8);
    this.rain.gain.gain.setTargetAtTime(0.12 * rain, t, 0.8);
  }
}

export const sound = new Sound();
