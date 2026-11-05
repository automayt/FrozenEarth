/**
 * Procedural sound: everything is synthesised with Web Audio, so there are no audio files. The
 * whole thing stays silent until the first user gesture (browsers require that), and if audio is
 * blocked or fails, every call here quietly does nothing and the game plays on.
 *
 * This file is the front door; the parts are in sound/. Mixer API for a settings screen:
 *   sound.getVolume(channel), sound.setVolume(channel, v), sound.muted, sound.toggleMute(),
 *   sound.onChange(fn), with channel one of CHANNELS: master, music, ambience, effects, interface.
 */

import type { Command, GameMessage } from '@fe/sim';
import { store } from './store';
import { Ambience } from './sound/ambience';
import { Bank } from './sound/bank';
import { Volumes, type Channel } from './sound/levels';
import { Mixer } from './sound/mixer';
import { Music } from './sound/music';
import type { Kind } from './sound/recipes';
import { WORLD_SAMPLES } from './sound/samples';
import { layerTargets, quietLayers, sampleScene, type Precip, type Scene } from './sound/scene';
import { cueForMoment, deathIn, Tension, tensionFrom, tensionTarget, type Cue } from './sound/score';
import { SCORE_SAMPLES } from './sound/scoreSamples';
import { commandSound, listenForPresses, uiChange, type UiState } from './sound/ui';
import { INAUDIBLE, muffleAt, panAt, reach, Voices, type Ear } from './sound/voices';
import { Watcher } from './sound/watch';

export { CHANNELS, type Channel } from './sound/levels';

const MUTE_KEY = 'fe.muted';
/** Long enough for the mute fade before the audio thread is put to sleep. */
const MUTE_SLEEP_MS = 300;
/** Tuning: how often the world is listened to. */
const SAMPLE_MS = 250;
/** Long enough for the beds to fade out when the page is hidden. */
const HIDDEN_STOP_MS = 7000;
/** World units per cell. */
const CELL = 32;
/** Tuning: a fight in earshot this recently still counts as fighting. */
const FIGHT_MEMORY_MS = 6000;
/** A banner this soon after its letter doesn't chime a second time. */
const LETTER_CHIME_MS = 500;
/** The sounds of blows, which raise the tension when they're close enough to hear. */
const BLOWS = new Set<Kind>(['rifle', 'bow', 'melee', 'bite']);

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(on: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, on ? '1' : '0');
  } catch {
    // Storage blocked: the setting just won't persist.
  }
}

class Sound {
  private ctx: AudioContext | null = null;
  private mixer: Mixer | null = null;
  private bank: Bank | null = null;
  private voices: Voices | null = null;
  private ambience: Ambience | null = null;
  private music: Music | null = null;
  private tension = new Tension();
  private lastFight = -Infinity;
  private raidHeard = false;
  private lastLetter = -Infinity;
  private watcher = new Watcher({ play: (kind, x, y) => this.play(kind, x, y), cue: (cue) => this.cue(cue) });
  private nextSample = 0;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private ear: Ear = { x: 0, y: 0, span: 1000 };
  private volumes = new Volumes();
  private ui: UiState | null = null;
  private changeListeners = new Set<() => void>();
  private sleepTimer: ReturnType<typeof setTimeout> | undefined;
  muted = readMuted();

  /** Create the audio graph. Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.muted) void this.ctx.resume();
      return;
    }
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx({ latencyHint: 'balanced' });
      this.ctx = ctx;
      this.mixer = new Mixer(ctx);
      this.bank = new Bank(ctx);
      this.voices = new Voices(ctx, this.mixer, this.bank);
      this.ambience = new Ambience(ctx, this.mixer, this.bank);
      this.music = new Music(ctx, this.mixer, this.bank);
      this.applyVolume();
      if (this.muted) void ctx.suspend();
      void this.prepare(this.bank);
    } catch {
      // No sound on this machine, then.
      this.ctx = null;
      this.voices = null;
      this.ambience = null;
      this.music = null;
    }
  }

  /** Render the sounds in the background. Whatever isn't ready simply isn't heard yet. */
  private async prepare(bank: Bank): Promise<void> {
    try {
      await bank.renderEffects();
      await bank.renderAll(WORLD_SAMPLES);
      await bank.renderAll(SCORE_SAMPLES);
    } catch {
      // Live recipes still work.
    }
  }

  /** The master volume. */
  get volume(): number {
    return this.volumes.get('master');
  }

  getVolume(channel: Channel): number {
    return this.volumes.get(channel);
  }

  /** Set one channel's volume, 0..1; saved for next time. With just a number, sets the master. */
  setVolume(v: number): void;
  setVolume(channel: Channel, v: number): void;
  setVolume(a: Channel | number, b?: number): void {
    const channel = typeof a === 'number' ? 'master' : a;
    this.volumes.set(channel, typeof a === 'number' ? a : (b ?? 0));
    this.applyVolume();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    writeMuted(this.muted);
    this.applyVolume();
    // Muted, nothing needs computing at all: let the audio thread rest.
    clearTimeout(this.sleepTimer);
    if (!this.ctx) return;
    if (this.muted) this.sleepTimer = setTimeout(() => void this.ctx?.suspend(), MUTE_SLEEP_MS);
    else void this.ctx.resume();
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private applyVolume(): void {
    this.mixer?.apply((c) => this.volumes.get(c), this.muted);
    for (const fn of this.changeListeners) fn();
  }

  /** Where the camera is, in world units, and how wide the view is. */
  setListener(x: number, y: number, span: number): void {
    this.ear = { x, y, span: Math.max(200, span) };
  }

  private get running(): boolean {
    return !!this.voices && !this.muted && this.ctx?.state === 'running';
  }

  /** One-off sound at a world position (or on the screen, if x/y are omitted). */
  play(kind: Kind, x?: number, y?: number): void {
    if (!this.running) return;
    if (x === undefined || y === undefined) {
      this.voices!.play(kind);
      return;
    }
    const v = reach(x, y, this.ear);
    if (v <= INAUDIBLE) return;
    if (BLOWS.has(kind)) this.lastFight = performance.now();
    this.voices!.play(kind, v, panAt(x, this.ear), muffleAt(x, y, this.ear));
  }

  /**
   * Called every frame from the renderer with the tick and the weather. A few times a second it
   * looks at what's around the camera and steers the ambience. A failure here must never reach
   * the render loop, so it just turns the world's sound off.
   */
  world(tick: number, precip: Precip, wind: number): void {
    if (!this.running || !this.ambience || document.hidden) return;
    const now = performance.now();
    if (now < this.nextSample) return;
    this.nextSample = now + SAMPLE_MS;
    const m = store.mirror;
    if (!m.w) return;
    try {
      const t = this.ctx!.currentTime;
      const scene = sampleScene(m, this.ear.x / CELL, this.ear.y / CELL, this.ear.span / CELL, tick, precip, wind);
      this.ambience.update(t, layerTargets(scene), scene);
      this.score(t, now, tick, scene);
      if (store.view) this.watcher.sample(m, tick, store.view, SAMPLE_MS / 1000);
    } catch (e) {
      console.warn('Sound: the world went quiet', e);
      this.ambience = null;
    }
  }

  private score(t: number, now: number, tick: number, scene: Scene): void {
    const danger = tensionFrom(store.mirror, store.me?.faction ?? 0, tick, now - this.lastFight < FIGHT_MEMORY_MS);
    const level = this.tension.update(tensionTarget(danger), SAMPLE_MS / 1000);
    const winter = scene.season === 'Winter' ? 0.7 : 0;
    this.music?.update(t, level, { sparse: Math.max(winter, scene.frostNear, scene.frozen) });
  }

  /** What changed in the mirror this frame, for sounds that have to be worked out from it. */
  note(m: typeof store.mirror, changed: ReadonlySet<number>, removed: ReadonlySet<number>): void {
    if (this.running) this.watcher.note(m, changed, removed);
  }

  private cue(cue: Cue): boolean {
    if (!this.running || !this.music) return false;
    return this.music.stinger(cue, this.ctx!.currentTime);
  }

  /** A banner went up. The big ones get music; the rest, or if music can't be heard, a chime unless its letter just gave one. */
  moment(title: string, tone: 'good' | 'bad' | 'neutral'): void {
    const cue = cueForMoment(title, this.raidHeard);
    if (cue === 'firstRaid') this.raidHeard = true;
    const scored = !!cue && this.cue(cue) && this.volumes.get('music') >= 0.05;
    if (!scored && performance.now() - this.lastLetter > LETTER_CHIME_MS) this.play(tone);
  }

  /** The page was hidden or shown: don't keep the world playing to nobody. Letters still chime. */
  private hidden(on: boolean): void {
    clearTimeout(this.hiddenTimer);
    if (!on || !this.ctx || !this.ambience) return;
    const { ctx, ambience, music } = this;
    ambience.update(ctx.currentTime, quietLayers(), { waterPan: 0, firePan: 0 });
    music?.sleep(ctx.currentTime);
    this.hiddenTimer = setTimeout(() => {
      ambience.stop(ctx.currentTime);
      music?.stop(ctx.currentTime);
    }, HIDDEN_STOP_MS);
  }

  /** A letter came in. Answers to our own commands have their own sound, by way of the toast they raise. */
  letter(msg: GameMessage): void {
    if (msg.reply) {
      if (msg.tone === 'good') this.play('good');
      return;
    }
    const death = deathIn(msg.text);
    if (death) {
      const w = store.mirror.w;
      if (msg.at !== undefined && w) this.play('death', ((msg.at % w) + 0.5) * CELL, (Math.floor(msg.at / w) + 0.5) * CELL);
      const mine = store.me && store.mirror.factions.get(store.me.faction)?.name === death.colony;
      if (mine) this.cue('death');
      else return;
    }
    this.lastLetter = performance.now();
    this.play(msg.tone === 'good' ? 'letterGood' : msg.tone === 'bad' ? 'letterBad' : 'letter');
  }

  /** The player gave an order. */
  command(c: Command['c']): void {
    const kind = commandSound(c);
    if (kind) this.play(kind);
  }

  /** Wire up the interface: every control in the page, and the store for panels and refusals. */
  listen(): void {
    listenForPresses((kind) => this.play(kind));
    document.addEventListener('visibilitychange', () => this.hidden(document.hidden));
    store.subscribe(() => {
      const newest = store.toasts[store.toasts.length - 1];
      const is: UiState = { panel: store.panel, menu: store.menu, help: store.help, selected: store.selected, toast: Math.max(newest?.id ?? 0, this.ui?.toast ?? 0), toastBad: newest?.tone === 'bad' };
      if (this.ui) for (const kind of uiChange(this.ui, is)) this.play(kind);
      this.ui = is;
    });
  }
}

export const sound = new Sound();

if (typeof document !== 'undefined') sound.listen();
