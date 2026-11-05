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
import type { Kind } from './sound/recipes';
import { WORLD_SAMPLES } from './sound/samples';
import { layerTargets, quietLayers, sampleScene, type Precip } from './sound/scene';
import { commandSound, listenForPresses, uiChange, type UiState } from './sound/ui';
import { INAUDIBLE, muffleAt, panAt, reach, Voices, type Ear } from './sound/voices';

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
      this.applyVolume();
      void this.prepare(this.bank);
    } catch {
      // No sound on this machine, then.
      this.ctx = null;
      this.voices = null;
      this.ambience = null;
    }
  }

  /** Render the sounds in the background. Whatever isn't ready simply isn't heard yet. */
  private async prepare(bank: Bank): Promise<void> {
    try {
      await bank.renderEffects();
      await bank.renderAll(WORLD_SAMPLES);
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
    if (v > INAUDIBLE) this.voices!.play(kind, v, panAt(x, this.ear), muffleAt(x, y, this.ear));
  }

  /**
   * Called every frame from the renderer with the tick and the weather. A few times a second it
   * looks at what's around the camera and steers the ambience. A failure here must never reach
   * the render loop, so it just turns the world's sound off.
   */
  world(tick: number, precip: Precip, wind: number): void {
    if (!this.running || !this.ambience) return;
    const now = performance.now();
    if (now < this.nextSample) return;
    this.nextSample = now + SAMPLE_MS;
    const m = store.mirror;
    if (!m.w) return;
    try {
      const scene = sampleScene(m, this.ear.x / CELL, this.ear.y / CELL, this.ear.span / CELL, tick, precip, wind);
      this.ambience.update(this.ctx!.currentTime, layerTargets(scene), scene);
    } catch (e) {
      console.warn('Sound: the world went quiet', e);
      this.ambience = null;
    }
  }

  /** The page was hidden or shown: don't keep the world playing to nobody. Letters still chime. */
  private hidden(on: boolean): void {
    clearTimeout(this.hiddenTimer);
    if (!on || !this.ctx || !this.ambience) return;
    const { ctx, ambience } = this;
    ambience.update(ctx.currentTime, quietLayers(), { waterPan: 0, firePan: 0 });
    this.hiddenTimer = setTimeout(() => ambience.stop(ctx.currentTime), HIDDEN_STOP_MS);
  }

  /** A letter came in. Answers to our own commands have their own sound, by way of the toast they raise. */
  letter(msg: GameMessage): void {
    if (msg.reply) {
      if (msg.tone === 'good') this.play('good');
      return;
    }
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
