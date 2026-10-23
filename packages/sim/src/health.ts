import { tell } from './chronicle';
import { ANIMALS, APPAREL, BUILDINGS, COMFORT_MAX, COMFORT_MIN, CONDITIONS, DOWNED_BLOOD_LOSS, DOWNED_PAIN, TRAITS, WEATHER, type ConditionDef, type ConditionStage } from '@fe/defs';
import { HOURS_PER_DAY, RARE_TICK, TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { scheduleEvent } from './schedule';
import { dropWeapon, endJob } from './pawns';
import { raiderGone, raiderDowned } from './raids';
import { predatorFed } from './wildlife';
import type { Building, Pawn, PawnCondition } from './types';
import type { World } from './world';

/** Combined effect of a pawn's traits, conditions and the weather. */
export interface Effects {
  move: number;
  work: number;
  mood: number;
  foodDrain: number;
  restDrain: number;
  immunity: number;
  breakMult: number;
  coldShift: number;
  heatShift: number;
  bedRest: boolean;
  noWork: boolean;
  binge: boolean;
  /** Mood contributions, for the inspect pane. */
  thoughts: [string, number][];
}

export function stageOf(def: ConditionDef, severity: number): ConditionStage {
  let s = def.stages[0];
  for (const st of def.stages) if (severity >= st.minSeverity) s = st;
  return s;
}

export function effectsOf(w: World, p: Pawn): Effects {
  const e: Effects = { move: 1, work: 1, mood: 0, foodDrain: 1, restDrain: 1, immunity: 1, breakMult: 1, coldShift: 0, heatShift: 0, bedRest: false, noWork: false, binge: false, thoughts: [] };
  for (const key of p.traits) {
    const t = TRAITS[key];
    if (!t) continue;
    e.move *= t.moveMult ?? 1;
    e.work *= t.workMult ?? 1;
    e.foodDrain *= t.foodDrain ?? 1;
    e.restDrain *= t.restDrain ?? 1;
    e.immunity *= t.immunityMult ?? 1;
    e.breakMult *= t.breakMult ?? 1;
    e.coldShift += t.coldShift ?? 0;
    e.heatShift += t.heatShift ?? 0;
    if (t.mood) {
      e.mood += t.mood;
      e.thoughts.push([t.label, t.mood]);
    }
  }
  // An animal's coat.
  if (p.species) e.coldShift += ANIMALS[p.species]?.coldShift ?? 0;
  for (const key of p.apparel) {
    const a = APPAREL[key];
    if (!a) continue;
    e.coldShift += a.coldShift;
    e.heatShift += a.heatShift;
    e.move *= a.moveMult ?? 1;
  }
  for (const c of p.conditions) {
    const def = CONDITIONS[c.key];
    if (!def) continue;
    const st = stageOf(def, c.severity);
    e.move *= st.moveMult ?? 1;
    e.work *= st.workMult ?? 1;
    e.foodDrain *= st.foodDrain ?? 1;
    e.restDrain *= st.restDrain ?? 1;
    if (st.bedRest) e.bedRest = true;
    if (def.noWork) e.noWork = true;
    if (def.binge) e.binge = true;
    if (st.mood) {
      e.mood += st.mood;
      e.thoughts.push([st.label ? `${def.label} (${st.label})` : def.label, st.mood]);
    }
  }
  for (const c of w.conditions) {
    const wd = WEATHER[c.key];
    if (!wd || (c.faction && c.faction !== p.faction)) continue;
    e.breakMult *= wd.breakMult ?? 1;
    if (wd.mood) {
      e.mood += wd.mood;
      e.thoughts.push([wd.thought ?? c.key, wd.mood]);
    }
    if (wd.outdoorMove && w.outdoors(w.cellOf(p))) e.move *= wd.outdoorMove;
  }
  return e;
}

export function hasCondition(p: Pawn, key: string): boolean {
  return p.conditions.some((c) => c.key === key);
}

export function conditionOf(p: Pawn, key: string): PawnCondition | undefined {
  return p.conditions.find((c) => c.key === key);
}

/** Add (or refresh) a condition. Returns false if the pawn is immune or already has it. */
export function addCondition(w: World, p: Pawn, key: string, severity?: number): boolean {
  const def = CONDITIONS[key];
  if (!def) return false;
  if (p.traits.some((t) => TRAITS[t]?.immune?.includes(key))) return false;
  const existing = conditionOf(p, key);
  const until = def.hours ? w.tick + Math.round(w.rng.range(def.hours[0], def.hours[1]) * TICKS_PER_HOUR) : 0;
  if (existing) {
    if (!def.hours) return false;
    existing.until = Math.max(existing.until, until);
    w.markDirty(p);
    return false;
  }
  p.conditions.push({ key, severity: severity ?? def.startSeverity ?? 0, immunity: 0, until });
  w.markDirty(p);
  return true;
}

export function removeCondition(w: World, p: Pawn, key: string): void {
  const n = p.conditions.length;
  p.conditions = p.conditions.filter((c) => c.key !== key);
  if (p.conditions.length !== n) w.markDirty(p);
}

// ---------------------------------------------------------------- wounds

/** Total pain from wounds. At DOWNED_PAIN the pawn collapses. */
export function painOf(p: Pawn): number {
  let pain = 0;
  for (const c of p.conditions) pain += (CONDITIONS[c.key]?.pain ?? 0) * c.severity;
  return pain;
}

/** Blood loss per in-game day from untended wounds. */
export function bleedRate(p: Pawn): number {
  let r = 0;
  for (const c of p.conditions) if (c.tended === undefined) r += (CONDITIONS[c.key]?.bleed ?? 0) * c.severity;
  return r;
}

/** Sum of combat wound severity. A pawn dies at 1. */
export function woundTotal(p: Pawn): number {
  let t = 0;
  for (const c of p.conditions) if (CONDITIONS[c.key]?.healPerDay) t += c.severity;
  return t;
}

/** In-game hours until blood loss kills this pawn at its current bleeding rate; Infinity if it isn't bleeding. */
export function hoursToBleedOut(p: Pawn): number {
  const r = bleedRate(p);
  if (r <= 0) return Infinity;
  return ((1 - (conditionOf(p, 'blood_loss')?.severity ?? 0)) / r) * HOURS_PER_DAY;
}

export function needsTending(p: Pawn): boolean {
  return p.conditions.some((c) => c.tended === undefined && CONDITIONS[c.key]?.bleed);
}

/** Add a wound. Fresh damage reopens the wound, so it needs tending again. Returns false if it killed. */
export function injure(w: World, p: Pawn, key: string, severity: number, by?: Pawn): boolean {
  const sp = p.species ? ANIMALS[p.species] : undefined;
  if (sp) {
    severity /= sp.toughness;
    if (by) p.aggro = by.id;
  }
  const c = conditionOf(p, key);
  if (c) {
    c.severity += severity;
    delete c.tended;
  } else {
    p.conditions.push({ key, severity, immunity: 0, until: 0 });
  }
  w.markDirty(p);
  if (woundTotal(p) >= 1) {
    killPawn(w, p, by ? `wounds from ${by.name}` : 'wounds', by);
    return false;
  }
  updateDowned(w, p);
  return true;
}

/** Knock a pawn down, or let it back up, from its current pain and blood loss. */
export function updateDowned(w: World, p: Pawn): void {
  const down = painOf(p) >= DOWNED_PAIN || (conditionOf(p, 'blood_loss')?.severity ?? 0) >= DOWNED_BLOOD_LOSS;
  if (down === p.downed) return;
  p.downed = down;
  const cell = w.cellOf(p);
  if (down) {
    p.drafted = false;
    // Nobody steers a body on the ground: let go, so they don't get up still walking the old direction.
    if (p.possessed) {
      p.possessed = false;
      p.steer = undefined;
    }
    // Collapsing in bed leaves them there, so nobody has to carry them back to it.
    const rest = inBed(w, p) ? p.job : null;
    endJob(w, p);
    if (rest) {
      p.job = rest;
      p.asleep = true;
    }
    // Whatever they held falls from their hands.
    dropWeapon(w, p);
    if (w.factions.get(p.faction)?.raid) raiderDowned(w, p.faction, p);
    else w.message(p.faction, `${p.name} has been downed.`, 'bad', cell);
  } else {
    w.message(p.faction, `${p.name} is back on their feet.`, 'neutral', cell);
  }
  w.markDirty(p);
}

export function isMental(p: Pawn): boolean {
  return p.conditions.some((c) => CONDITIONS[c.key]?.kind === 'mental');
}

/** Lying in their own bed: asleep there, or put there to recover. */
export function inBed(w: World, p: Pawn): boolean {
  return p.asleep && !!p.bed && p.job?.type === 'sleep' && p.job.bed === p.bed;
}

/** Can't get up to eat: downed, or a prisoner kept to their bed. */
export function bedBound(w: World, p: Pawn): boolean {
  return p.downed || (p.prisoner === 'held' && inBed(w, p));
}

/**
 * Slow-tick health update: diseases progress, timed conditions expire, the weather bites,
 * contagion spreads, minds break. Returns false if the pawn died.
 */
export function healthTick(w: World, p: Pawn, e: Effects): boolean {
  const dt = RARE_TICK / TICKS_PER_DAY;
  const cell = w.cellOf(p);
  const resting = inBed(w, p);

  // Exposure: cold and heat build up outside the comfortable range.
  const temp = w.tempAt(cell);
  // Blankets: sleeping in a bed keeps the cold out a little.
  const coldLine = COMFORT_MIN + e.coldShift - (resting ? 8 : 0);
  const hotLine = COMFORT_MAX + e.heatShift;
  exposure(w, p, 'hypothermia', temp < coldLine ? Math.min(2, (0.8 * (coldLine - temp)) / 10) : -2, dt);
  exposure(w, p, 'heatstroke', temp > hotLine ? Math.min(2, (0.8 * (temp - hotLine)) / 10) : -2, dt);
  exposure(w, p, 'malnutrition', p.needs.food <= 0 ? 0.4 : -0.5, dt);
  const bleed = bleedRate(p);
  exposure(w, p, 'blood_loss', bleed > 0 ? bleed : -0.4, dt);

  for (const c of [...p.conditions]) {
    const def = CONDITIONS[c.key];
    if (!def) continue;
    if (def.healPerDay) {
      // Dressed wounds close quickly, open ones barely; bruises need no dressing. Rest in bed helps.
      const care = c.tended !== undefined ? 0.5 + c.tended : def.bleed ? 0.2 : 1;
      c.severity -= def.healPerDay * dt * care * (resting ? 1.3 : 1);
      if (c.severity <= 0) removeCondition(w, p, c.key);
      continue;
    }
    if (def.hours) {
      if (w.tick >= c.until) {
        removeCondition(w, p, c.key);
        if (def.kind === 'mental') w.message(p.faction, `${p.name} has calmed down.`, 'neutral', cell);
      }
      continue;
    }
    if (def.immunityPerDay) {
      c.severity += (def.severityPerDay ?? 0) * dt * (resting ? 0.8 : 1);
      c.immunity += def.immunityPerDay * dt * e.immunity * (resting ? 1.35 : 1) * (hasCondition(p, 'malnutrition') ? 0.7 : 1);
      if (c.immunity >= 1) {
        removeCondition(w, p, c.key);
        w.message(p.faction, `${p.name} has recovered from ${def.label.toLowerCase()}.`, 'good', cell);
        continue;
      }
      if (def.contagious && w.rng.chance(def.contagious)) spread(w, p, c.key);
    }
    if (c.severity >= 1) {
      if (def.lethal) {
        killPawn(w, p, def.label.toLowerCase());
        return false;
      }
      c.severity = 1;
    }
  }

  updateDowned(w, p);

  // Minds: breaks when miserable, inspiration when happy.
  if (!isMental(p) && !p.downed) {
    const mood = p.needs.mood;
    if (mood < 0.18 && w.rng.chance(0.02 * e.breakMult)) {
      const kind = w.rng.pick(['sulking', 'dazed', 'binging', 'hiding']);
      addCondition(w, p, kind);
      w.message(p.faction, `${p.name} has had a mental break: ${CONDITIONS[kind].label.toLowerCase()}.`, 'bad', cell);
    } else if (mood > 0.78 && w.rng.chance(0.003)) {
      if (addCondition(w, p, 'inspired')) w.message(p.faction, `${p.name} is inspired and working with new energy.`, 'good', cell);
    }
  }

  // Clumsy accidents while working.
  const jt = p.job?.type;
  if ((jt === 'mine' || jt === 'build' || jt === 'cut' || jt === 'haul' || jt === 'bill') && w.rng.chance(0.0006)) {
    const kind = jt === 'haul' ? 'back_strain' : w.rng.pick(['cut_hand', 'sprained_ankle']);
    if (addCondition(w, p, kind)) w.message(p.faction, `${p.name} got hurt working: ${CONDITIONS[kind].label.toLowerCase()}.`, 'bad', cell);
  }

  // Awe from wondrous buildings nearby.
  for (const id of w.kinds.building) {
    const b = w.get<Building>(id)!;
    const r = BUILDINGS[b.def]?.aweRadius;
    if (r && w.dist(w.cellOf(b), cell) <= r && !hasCondition(p, 'awed')) addCondition(w, p, 'awed');
  }
  return true;
}

function exposure(w: World, p: Pawn, key: string, ratePerDay: number, dt: number): void {
  const c = conditionOf(p, key);
  if (!c) {
    if (ratePerDay > 0) p.conditions.push({ key, severity: ratePerDay * dt, immunity: 0, until: 0 });
    return;
  }
  const before = c.severity;
  c.severity += ratePerDay * dt;
  if (c.severity <= 0) {
    removeCondition(w, p, key);
    return;
  }
  const def = CONDITIONS[key];
  // Say so when it gets worse than anything already reported, not every time it wavers across a stage.
  const stage = def.stages.indexOf(stageOf(def, c.severity));
  if (stageOf(def, before) !== stageOf(def, c.severity) && ratePerDay > 0 && c.severity >= 0.35 && stage > (c.told ?? -1)) {
    c.told = stage;
    w.message(p.faction, `${p.name} is suffering from ${def.label.toLowerCase()} (${stageOf(def, c.severity).label}).`, 'bad', w.cellOf(p));
  }
}

function spread(w: World, from: Pawn, key: string): void {
  const near: Pawn[] = [];
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.id !== from.id && o.faction === from.faction && w.dist(w.cellOf(o), w.cellOf(from)) <= 6 && !hasCondition(o, key)) near.push(o);
  }
  if (!near.length) return;
  const victim = w.rng.pick(near);
  if (addCondition(w, victim, key)) {
    w.message(victim.faction, `${victim.name} caught ${CONDITIONS[key].label.toLowerCase()} from ${from.name}.`, 'bad', w.cellOf(victim));
  }
}

export function killPawn(w: World, p: Pawn, cause: string, by?: Pawn): void {
  const cell = w.cellOf(p);
  const faction = p.faction;
  const sp = p.species ? ANIMALS[p.species] : undefined;
  if (sp) {
    // A carcass: meat and a hide. Wolves eat their share where it falls.
    const eaten = by?.species && ANIMALS[by.species]?.predator;
    if (eaten) predatorFed(w, by);
    const meat = Math.round(sp.meat * (eaten ? 0.4 : 1));
    if (meat > 0) w.placeItemNear('meat', meat, cell);
    if (sp.hide > 0) w.placeItemNear('cloth', sp.hide, cell);
    w.despawn(p.id);
    return;
  }
  const fname = w.factions.get(faction)?.name ?? 'the colony';
  if (p.carrying) w.placeItemNear(p.carrying.def, p.carrying.count, cell, p.carrying.rot);
  for (const a of p.apparel) w.placeItemNear(a, 1, cell);
  if (p.weapon) w.placeItemNear(p.weapon, 1, cell);
  w.despawn(p.id);
  w.message(0, `${p.name} of ${fname} has died of ${cause}.`, 'bad', cell);
  tell(w, faction, `${p.name} died of ${cause}.`);
  let left = 0;
  for (const id of w.kinds.pawn) {
    const o = w.get<Pawn>(id)!;
    if (o.faction !== faction || o.prisoner) continue;
    left++;
    addCondition(w, o, 'mourning');
  }
  if (w.factions.get(faction)?.raid) raiderGone(w, faction, true, p.id);
  if (left === 0 && w.factions.get(faction)?.isPlayer) {
    w.message(0, `${fname} has fallen. Survivors from the wilds may yet find what is left of it.`, 'bad', cell);
    scheduleEvent(w, 'new_arrivals', faction, TICKS_PER_DAY);
  }
}
