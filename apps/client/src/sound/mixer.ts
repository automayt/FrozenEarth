import type { Channel } from './levels';

/** Master at full is a little under the limiter's ceiling, as it has always been. */
export const MASTER_SCALE = 0.8;
/** The limiter starts holding peaks here (dBFS). */
const LIMIT_DB = -3;
/**
 * Browsers add automatic makeup gain to the compressor node (0.6 × the reduction at full scale,
 * per the Web Audio spec). Taken back out, so quiet sounds pass at exactly their own level.
 */
const MAKEUP_DB = 0.6 * (-LIMIT_DB - -LIMIT_DB / 20);
const SMOOTH_S = 0.05;

export type Bus = Exclude<Channel, 'master'>;

/**
 * The graph everything plays into:
 *   music, ambience, effects, interface -> limiter -> trim -> master -> speakers.
 * The limiter sits before the master fader so the mix itself doesn't change with volume. Works on
 * any BaseAudioContext, so the same graph renders offline for measuring.
 */
export class Mixer {
  readonly buses: Record<Bus, GainNode>;
  private master: GainNode;

  constructor(private ctx: BaseAudioContext) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMIT_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    const trim = ctx.createGain();
    trim.gain.value = 10 ** (-MAKEUP_DB / 20);
    this.master = ctx.createGain();
    limiter.connect(trim).connect(this.master).connect(ctx.destination);
    const bus = (): GainNode => {
      const g = ctx.createGain();
      g.connect(limiter);
      return g;
    };
    this.buses = { music: bus(), ambience: bus(), effects: bus(), interface: bus() };
  }

  /** Set every fader. Muting only pulls the master down, so the mix comes back as it was. */
  apply(volume: (c: Channel) => number, muted: boolean, t = this.ctx.currentTime): void {
    this.master.gain.setTargetAtTime(muted ? 0 : volume('master') * MASTER_SCALE, t, SMOOTH_S);
    for (const name of Object.keys(this.buses) as Bus[]) this.buses[name].gain.setTargetAtTime(volume(name), t, SMOOTH_S);
  }
}
