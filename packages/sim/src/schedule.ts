import { START_TICK, TICKS_PER_DAY } from './constants';
import type { World } from './world';

export interface ScheduledEvent {
  tick: number;
  key: string;
  faction: number;
  data?: Record<string, unknown>;
}

export interface StoryState {
  nextCheck: number;
  /** "<event>" or "<event>:<faction>" -> tick it last fired. */
  lastFired: Record<string, number>;
  /** Faction id -> threat points available for bad events. 0 = the shared map pool. */
  threat: Record<number, number>;
  /** Faction id -> tick of its last bad event. */
  lastBad: Record<number, number>;
  lastSeason: number;
  uniqueFired: string[];
  /** Follow-up events waiting to fire. Server-side only. */
  scheduled: ScheduledEvent[];
}

export function newStoryState(): StoryState {
  // A quiet first day to get settled.
  return { nextCheck: START_TICK + TICKS_PER_DAY, lastFired: {}, threat: {}, lastBad: {}, lastSeason: 0, uniqueFired: [], scheduled: [] };
}

/** Fill in fields added after a save was written. */
export function upgradeStoryState(s: Partial<StoryState>): StoryState {
  return { ...newStoryState(), ...s, threat: typeof s.threat === 'object' && s.threat ? s.threat : {} };
}

/** Queue an event to fire after a delay (in ticks). */
export function scheduleEvent(w: World, key: string, faction: number, delayTicks: number, data?: Record<string, unknown>): void {
  w.story.scheduled.push({ tick: w.tick + Math.max(1, Math.round(delayTicks)), key, faction, data });
}
