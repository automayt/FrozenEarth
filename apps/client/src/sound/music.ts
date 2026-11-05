import { Bed } from './ambience';
import type { Bank } from './bank';
import type { Mixer } from './mixer';
import { composeCalm, composeTense, type Cue, type Mood, type NoteEvent, type Rng, type Voice } from './score';
import { gain } from './synth';

/**
 * The score, played note by note from the composer so nothing ever loops. Calm and tense are two
 * faders that cross as danger rises and falls; a note already sounding always rings out. While
 * it's silent, which is most of the time, the music costs a few idle gain nodes.
 */

/** Tuning: level of each instrument, of the tense floor, and of each stinger. */
export const MUSIC_LEVEL: Record<Voice | 'dread', number> = { pad: 0.42, pluck: 0.55, glass: 0.5, low: 0.26, drum: 0.5, dread: 0.15 };
export const STINGER_LEVEL: Record<Cue, number> = { raid: 0.8, firstRaid: 0.85, chief: 0.75, death: 0.75, frost: 0.75, thaw: 0.7 };
/** Tuning: how far music drops under a stinger. */
const DUCK = 0.3;
/** Tuning: fewest seconds between stingers. */
const STINGER_GAP = 25;
/** Tuning: seconds into a session before the first phrase. */
const FIRST_PHRASE: [number, number] = [20, 55];
/** A new calm phrase waits for tension to fall below this, then this many seconds more. */
const CALM_BELOW = 0.15;
const CALM_AFTER = 40;
/** Scheduled ahead of the audio clock by this much; sampling is a little slower than this. */
const LOOKAHEAD = 0.5;

const TENSE_VOICES: readonly Voice[] = ['low', 'drum'];

interface Queued extends NoteEvent {
  when: number;
}

export class Music {
  private calm: GainNode;
  private tense: GainNode;
  private duck: GainNode;
  private dread: Bed;
  private queue: Queued[] = [];
  private nextCalm = -1;
  private nextTense = 0;
  private lastStinger = -Infinity;
  private out: GainNode;

  constructor(
    private ctx: BaseAudioContext,
    mixer: Mixer,
    private bank: Bank,
    private rng: Rng = Math.random,
  ) {
    this.duck = gain(ctx, 1);
    this.out = mixer.buses.music;
    this.duck.connect(this.out);
    this.calm = gain(ctx, 1);
    this.tense = gain(ctx, 0);
    this.calm.connect(this.duck);
    this.tense.connect(this.duck);
    this.dread = new Bed(ctx, this.tense, bank, 'dread', 2.5);
  }

  /** Move the score on. `t` is the audio clock, `level` the current tension. Call a few times a second. */
  update(t: number, level: number, mood: Mood): void {
    if (this.nextCalm < 0) this.nextCalm = t + FIRST_PHRASE[0] + this.rng() * (FIRST_PHRASE[1] - FIRST_PHRASE[0]);
    // Danger brings the tense fader up fast; calm comes back slowly, and music never just stops.
    const tense = Math.max(0, Math.min(1, (level - 0.15) / 0.55));
    this.calm.gain.setTargetAtTime(1 - 0.9 * tense, t, tense > 0.3 ? 1.5 : 5);
    this.tense.gain.setTargetAtTime(tense, t, tense > 0.3 ? 1.5 : 6);
    this.dread.set(MUSIC_LEVEL.dread * tense, 0, t);
    if (level >= CALM_BELOW) {
      this.nextCalm = Math.max(this.nextCalm, t + CALM_AFTER);
      // What hadn't started doesn't need to: the phrase gives way to the danger.
      this.queue = this.queue.filter((q) => TENSE_VOICES.includes(q.voice));
    } else if (t >= this.nextCalm) {
      const phrase = composeCalm(mood, this.rng);
      this.enqueue(phrase.events, t + 0.2);
      this.nextCalm = t + phrase.length + phrase.rest;
    }
    if (tense > 0.05 && t >= this.nextTense) {
      const { wait, events } = composeTense(level, this.rng);
      this.enqueue(events, t + 0.2);
      this.nextTense = t + wait;
    }
    this.flush(t);
  }

  private enqueue(events: NoteEvent[], from: number): void {
    for (const e of events) this.queue.push({ ...e, when: from + e.at });
    this.queue.sort((a, b) => a.when - b.when);
  }

  private flush(t: number): void {
    while (this.queue.length && this.queue[0].when <= t + LOOKAHEAD) {
      const q = this.queue.shift()!;
      // The page was asleep: a note that's late has missed its moment.
      if (q.when >= t - 0.25) this.note(q);
    }
  }

  private note(e: Queued): void {
    const buffer = this.bank.pick(e.voice);
    if (!buffer) return;
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 2 ** (e.semi / 12);
    const g = gain(ctx, MUSIC_LEVEL[e.voice] * e.vel);
    const out = TENSE_VOICES.includes(e.voice) ? this.tense : this.calm;
    if (e.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = e.pan;
      src.connect(g).connect(p).connect(out);
    } else {
      src.connect(g).connect(out);
    }
    src.start(Math.max(e.when, ctx.currentTime));
  }

  /** A short piece for a big moment, over everything else. False if one has just played or it isn't ready. */
  stinger(cue: Cue, t: number): boolean {
    const buffer = this.bank.pick(`cue.${cue}`);
    if (!buffer || t - this.lastStinger < STINGER_GAP) return false;
    this.lastStinger = t;
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // Past the duck, so it isn't pulled down by its own arrival.
    src.connect(gain(ctx, STINGER_LEVEL[cue])).connect(this.out);
    src.start(t + 0.02);
    const hold = buffer.duration * 0.55;
    this.duck.gain.cancelScheduledValues(t);
    this.duck.gain.setTargetAtTime(DUCK, t, 0.25);
    this.duck.gain.setTargetAtTime(1, t + hold, 2.5);
    this.nextCalm = Math.max(this.nextCalm, t + buffer.duration + 30);
    return true;
  }

  /** The page is hidden: nothing new starts, and the tense floor fades. */
  sleep(t: number): void {
    this.queue = [];
    this.calm.gain.setTargetAtTime(0, t, 1);
    this.tense.gain.setTargetAtTime(0, t, 1);
    this.dread.set(0, 0, t);
  }

  stop(t: number): void {
    this.dread.stop(t);
  }
}
