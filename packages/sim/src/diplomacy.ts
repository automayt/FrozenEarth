import { ITEMS } from '@fe/defs';
import { RARE_TICK, START_TICK, TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { offerChoice, registerChoice } from './choices';
import { storedCount, takeStored } from './eventHandlers';
import { allied, atWar, pactOf, setPact, type RelView } from './pacts';
import { startRaid } from './raids';
import {
  areRivals,
  cleanLines,
  dispositionOf,
  FRIENDLY_AT,
  GOODWILL,
  goodwillOf,
  HOSTILE_AT,
  lineValue,
  liveTowns,
  opinionBetween,
  rivalsOf,
  shiftGoodwill,
  shiftOpinion,
  TRADE_RANGE,
} from './settlements';
import { cellDistance } from './combat';
import { learn } from './pawns';
import type { Command, DiplomacyAct, Faction, Pawn } from './types';
import type { World } from './world';

/**
 * Diplomacy: what factions have agreed with each other, and how to change it.
 *
 * - Colonies and towns: goodwill (settlements.ts) decides how a town greets you. On top of it a
 *   colony can swear an alliance with a town that likes it enough (allies send fighters when you
 *   are raided, and call on you when they are), buy a truce from a town that hates it, or broker
 *   peace between two rival towns.
 * - Town and town: each town feels something about every other; at the hostile line they are
 *   rivals. Rivals now and then send fighters against each other, and resent whoever helps the
 *   other side.
 * - Colony and colony: players are at peace unless one declares war. Alliances and peace need
 *   both to agree (a letter to the other player). Attacking another colony without declaring war
 *   starts one, and the towns that know you hear of it.
 */

/** Goodwill a town needs before it will swear an alliance. */
export const ALLY_AT = 60;
/** A truce bought from a hostile town, and one agreed between colonies, lasts this long. */
export const TRUCE_DAYS = 3;
export const PLAYER_TRUCE_DAYS = 2;
/** A pair of towns won't hear another peace offer for this long. */
export const MEDIATE_COOLDOWN_DAYS = 2;
/** A rival town sends fighters against another about this often (per rival pair, per day)... */
const FEUD_CHANCE = 0.1;
/** ...but not in a world's first days: towns settle in before they start feuding. */
const FEUD_GRACE_DAYS = 4;
/** Where goodwill lands after paying for peace: wary, not friendly. */
const PEACE_GOODWILL = HOSTILE_AT + 15;

/** How much each act of diplomacy moves goodwill. Exported so the client shows the stakes. */
export const DIPLO = {
  allianceSworn: 5,
  /** Their rivals, when you ally with a town. */
  alliedWithRival: -15,
  brokeAlliance: -25,
  /** Every other town that knows you, when you break an alliance or a truce. */
  oathbreakerRumor: -10,
  /** Breaking a truce with a town you're at truce with. */
  brokeTruce: -40,
  /** Every town that knows you, when you attack a colony without declaring war. */
  treacheryRumor: -8,
  /** Both towns, when you make peace between them. */
  mediated: 12,
  /** Every other town that knows you, when you make peace between two. */
  peacemakerRumor: 3,
  /** Both towns, when a peace attempt fails. */
  meddled: -4,
  /** How far apart two rival towns' feelings move when a peace attempt succeeds or fails. */
  mediationLift: 45,
  mediationSour: -5,
  /** An ally that didn't come when you were raided. */
  abandoned: -10,
} as const;

// ---------------------------------------------------------------- reading the state

export type Stance = 'ally' | 'truce' | 'war' | 'friendly' | 'wary' | 'hostile' | 'peace';

/** How `a` stands with `b`, for showing: a pact first, else a town's disposition, else colonies at peace. */
export function stanceOf(w: RelView, a: number, b: number): Stance {
  const pact = pactOf(w, a, b);
  if (pact) return pact.kind;
  const fa = w.factions.get(a);
  const fb = w.factions.get(b);
  if (fa?.settlement && fb?.settlement) {
    const g = Math.min(opinionBetween(w, fa, fb), opinionBetween(w, fb, fa));
    return g <= HOSTILE_AT ? 'hostile' : g >= FRIENDLY_AT ? 'friendly' : 'wary';
  }
  if (fb?.settlement && fa?.isPlayer) return dispositionOf(fb.settlement, a);
  if (fa?.settlement && fb?.isPlayer) return dispositionOf(fa.settlement, b);
  return 'peace';
}

/** The best Social skill among a colony's colonists close enough to a town to speak for it. */
export function envoySocial(w: World, faction: number, f: Faction): number {
  const home = w.map.idx(f.home.x, f.home.y);
  let best = -1;
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction !== faction || p.downed || p.prisoner || p.species) continue;
    if (cellDistance(w, w.cellOf(p), home) <= TRADE_RANGE) best = Math.max(best, p.skills.social?.level ?? 0);
  }
  return best;
}

/** What a hostile town wants, in market value, to agree to a truce. Social skill talks it down. */
export function peacePrice(goodwill: number, social: number): number {
  return Math.round(Math.max(0, PEACE_GOODWILL - goodwill) * GOODWILL.giftValue * 1.5 * (1 - 0.03 * Math.max(0, social)));
}

/** Chance that a colony's envoy talks two rival towns into making peace. */
export function mediationChance(goodwillA: number, goodwillB: number, social: number): number {
  return Math.max(0.1, Math.min(0.9, 0.25 + 0.04 * Math.max(0, social) + (goodwillA + goodwillB) / 300));
}

/** Can this colony swear an alliance with this town right now? A reason if not. */
export function allianceProblem(w: World, faction: number, f: Faction): string | null {
  const s = f.settlement;
  if (!s || s.state !== 'home') return `${f.name} can't make agreements while ${s?.state === 'leaving' ? 'on the move' : 'gone'}.`;
  if (!s.met.includes(faction)) return `You haven't met ${f.name} yet.`;
  if (allied(w, f.id, faction)) return `You are already allies.`;
  const g = goodwillOf(s, faction);
  if (g < ALLY_AT) return `${f.name} needs goodwill of ${ALLY_AT} to swear an alliance (now ${g}).`;
  const rival = rivalsOf(w, f).find((r) => allied(w, r.id, faction));
  if (rival) return `You stand with ${rival.name}, their rival. They won't ally with you while you do.`;
  if (envoySocial(w, faction, f) < 0) return `Send a colonist to ${f.name} to speak for you (within ${TRADE_RANGE} cells).`;
  return null;
}

// ---------------------------------------------------------------- acts

/** Every town that knows this colony hears of something it did. */
function rumor(w: World, faction: number, by: number, why: string, except: number[] = []): void {
  for (const f of liveTowns(w)) {
    if (except.includes(f.id) || !f.settlement!.met.includes(faction)) continue;
    shiftGoodwill(w, f, faction, by, why, false);
  }
}

export function diplomacy(w: World, faction: number, cmd: Extract<Command, { c: 'diplomacy' }>): void {
  const me = w.factions.get(faction);
  const them = w.factions.get(cmd.target);
  if (!me?.isPlayer || !them || them.id === faction) return;
  const say = (t: string) => w.message(faction, t, 'neutral');
  if (them.isPlayer) return colonyAct(w, me, them, cmd.act, say);
  if (!them.settlement) return;
  switch (cmd.act) {
    case 'ally':
      return proposeTownAlliance(w, me, them, say);
    case 'breakAlly':
      if (!allied(w, faction, them.id)) return say(`You aren't allied with ${them.name}.`);
      setPact(w, faction, them.id, null);
      shiftGoodwill(w, them, faction, DIPLO.brokeAlliance, 'Broke our alliance', false);
      rumor(w, faction, DIPLO.oathbreakerRumor, `Broke an alliance with ${them.name}`, [them.id]);
      return say(`You have ended your alliance with ${them.name}. Word of it will get around.`);
    case 'war': {
      const g = goodwillOf(them.settlement, faction);
      if (allied(w, faction, them.id)) setPact(w, faction, them.id, null);
      if (pactOf(w, faction, them.id)?.kind === 'truce') {
        setPact(w, faction, them.id, null);
        rumor(w, faction, DIPLO.oathbreakerRumor, `Broke a truce with ${them.name}`, [them.id]);
      }
      if (g > HOSTILE_AT - 20) shiftGoodwill(w, them, faction, HOSTILE_AT - 20 - g, 'Declared war on us', false);
      return;
    }
    case 'peace':
      return suePeace(w, me, them, cmd.give, say);
    case 'mediate': {
      const other = w.factions.get(Number(cmd.other));
      if (!other?.settlement) return;
      return mediate(w, me, them, other, say);
    }
  }
}

function proposeTownAlliance(w: World, me: Faction, f: Faction, say: (t: string) => void): void {
  const problem = allianceProblem(w, me.id, f);
  if (problem) return say(problem);
  setPact(w, me.id, f.id, 'ally');
  shiftGoodwill(w, f, me.id, DIPLO.allianceSworn, 'Swore an alliance with us', false);
  for (const r of rivalsOf(w, f)) {
    if (r.settlement!.met.includes(me.id)) shiftGoodwill(w, r, me.id, DIPLO.alliedWithRival, `Allied with ${f.name}, our rival`, false);
  }
  w.message(me.id, `${f.name} is now your ally. They will send fighters when you are raided, and call on you when they are.`, 'good', w.map.idx(f.home.x, f.home.y));
  learnSocial(w, me.id, f, 40);
}

/** Pay a hostile town to stop fighting: a truce, and goodwill back to wary. */
function suePeace(w: World, me: Faction, f: Faction, give: unknown, say: (t: string) => void): void {
  const s = f.settlement!;
  if (s.state !== 'home') return say(`${f.name} isn't receiving envoys while ${s.state === 'leaving' ? 'on the move' : 'gone'}.`);
  const g = goodwillOf(s, me.id);
  if (g > HOSTILE_AT && !atWar(w, me.id, f.id)) return say(`You aren't at war with ${f.name}.`);
  const social = envoySocial(w, me.id, f);
  if (social < 0) return say(`Your envoy has to reach ${f.name} first (within ${TRADE_RANGE} cells), and their guards shoot at enemies.`);
  const lines = cleanLines(give ?? []);
  if (!lines) return;
  for (const [d, n] of lines) if (storedCount(w, me.id, d) < n) return say(`You don't have ${n} ${ITEMS[d].label.toLowerCase()} in your stockpiles.`);
  const price = peacePrice(g, social);
  const offered = lineValue(lines);
  if (offered + 1e-9 < price) return say(`${f.name} wants tribute worth about ${price} to talk peace. You offered ${Math.round(offered)}.`);
  const drop = w.map.idx(f.home.x, f.home.y + 1);
  for (const [d, n] of lines) w.placeItemNear(d, takeStored(w, me.id, d, n), drop);
  shiftGoodwill(w, f, me.id, PEACE_GOODWILL - g, 'Paid tribute for peace', false);
  setPact(w, me.id, f.id, 'truce', w.tick + TRUCE_DAYS * TICKS_PER_DAY);
  w.message(me.id, `${f.name} accepts your tribute. A truce holds for ${TRUCE_DAYS} days; their guards will let your people be. Breaking it would be remembered everywhere.`, 'good', w.map.idx(f.home.x, f.home.y));
  learnSocial(w, me.id, f, 60);
}

/** Try to talk two rival towns into burying the feud. */
function mediate(w: World, me: Faction, a: Faction, b: Faction, say: (t: string) => void): void {
  const sa = a.settlement!;
  const sb = b.settlement!;
  if (a.id === b.id) return;
  if (sa.state !== 'home' || sb.state !== 'home') return say(`Both towns must be at home to talk.`);
  if (!sa.met.includes(me.id) || !sb.met.includes(me.id)) return say(`You need to have met both ${a.name} and ${b.name}.`);
  if (!areRivals(w, a, b)) return say(`${a.name} and ${b.name} aren't feuding.`);
  const ga = goodwillOf(sa, me.id);
  const gb = goodwillOf(sb, me.id);
  if (ga <= HOSTILE_AT || gb <= HOSTILE_AT) return say(`Neither town will listen to a go-between they count as an enemy.`);
  const social = Math.max(envoySocial(w, me.id, a), envoySocial(w, me.id, b));
  if (social < 0) return say(`Send a colonist to ${a.name} or ${b.name} to speak for you (within ${TRADE_RANGE} cells).`);
  const last = sa.mediated?.[b.id] ?? -Infinity;
  if (w.tick - last < MEDIATE_COOLDOWN_DAYS * TICKS_PER_DAY) return say(`${a.name} and ${b.name} have heard enough talk of peace for now. Try again in a day or two.`);
  (sa.mediated ??= {})[b.id] = w.tick;
  (sb.mediated ??= {})[a.id] = w.tick;
  const at = w.map.idx(a.home.x, a.home.y);
  learnSocial(w, me.id, a, 60);
  learnSocial(w, me.id, b, 60);
  if (w.rng.chance(mediationChance(ga, gb, social))) {
    shiftOpinion(w, a, b, DIPLO.mediationLift);
    shiftGoodwill(w, a, me.id, DIPLO.mediated, `Made peace between us and ${b.name}`, false);
    shiftGoodwill(w, b, me.id, DIPLO.mediated, `Made peace between us and ${a.name}`, false);
    rumor(w, me.id, DIPLO.peacemakerRumor, `Brokered peace between ${a.name} and ${b.name}`, [a.id, b.id]);
    w.message(me.id, `Your envoy talked ${a.name} and ${b.name} into peace. Both are grateful.`, 'good', at);
  } else {
    shiftOpinion(w, a, b, DIPLO.mediationSour);
    shiftGoodwill(w, a, me.id, DIPLO.meddled, `Meddled in our quarrel with ${b.name}`, false);
    shiftGoodwill(w, b, me.id, DIPLO.meddled, `Meddled in our quarrel with ${a.name}`, false);
    w.message(me.id, `The talks between ${a.name} and ${b.name} went nowhere. Neither thanks you for trying.`, 'bad', at);
  }
}

function learnSocial(w: World, faction: number, f: Faction, xp: number): void {
  const home = w.map.idx(f.home.x, f.home.y);
  let best: Pawn | null = null;
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction !== faction || p.downed || p.prisoner || cellDistance(w, w.cellOf(p), home) > TRADE_RANGE) continue;
    if (!best || (p.skills.social?.level ?? 0) > (best.skills.social?.level ?? 0)) best = p;
  }
  if (best) learn(w, best, 'social', xp);
}

// ---------------------------------------------------------------- colony and colony

const OFFER_HOURS = 24;

function colonyAct(w: World, me: Faction, them: Faction, act: DiplomacyAct, say: (t: string) => void): void {
  const pact = pactOf(w, me.id, them.id);
  switch (act) {
    case 'ally':
      if (pact?.kind === 'ally') return say(`You are already allied with ${them.name}.`);
      if (pact?.kind === 'war') return say(`You are at war with ${them.name}. Make peace first.`);
      return sendOffer(w, me, them, 'ally', say);
    case 'peace':
      if (pact?.kind !== 'war') return say(`You aren't at war with ${them.name}.`);
      return sendOffer(w, me, them, 'peace', say);
    case 'breakAlly':
      if (pact?.kind !== 'ally') return say(`You aren't allied with ${them.name}.`);
      setPact(w, me.id, them.id, null);
      w.message(them.id, `${me.name} has ended your alliance.`, 'bad');
      return say(`You have ended your alliance with ${them.name}.`);
    case 'war':
      if (pact?.kind === 'war') return say(`You are already at war with ${them.name}.`);
      return declareWar(w, me, them, false);
    case 'mediate':
      return;
  }
}

function sendOffer(w: World, me: Faction, them: Faction, kind: 'ally' | 'peace', say: (t: string) => void): void {
  const pending = [...w.choices.values()].some((c) => c.event === 'pact_offer' && c.faction === them.id && Number(w.choiceData.get(c.id)?.from) === me.id);
  if (pending) return say(`${them.name} hasn't answered your last offer yet.`);
  const c = offerChoice(
    w,
    them.id,
    'pact_offer',
    kind === 'ally' ? `${me.name} proposes an alliance` : `${me.name} asks for peace`,
    kind === 'ally'
      ? `${me.name} offers an alliance. Allies' doors open to each other's colonists, you see what their colonists see, and neither of you can order an attack on the other without first breaking it.`
      : `${me.name} wants to end the war. Accept, and a truce holds for ${PLAYER_TRUCE_DAYS} days; after that you are at peace unless someone declares war again.`,
    [
      { key: 'accept', label: kind === 'ally' ? 'Accept the alliance' : 'Make peace' },
      { key: 'decline', label: 'Decline' },
    ],
    OFFER_HOURS,
    { from: me.id, kind },
  );
  c.from = me.id;
  const away = w.online && !w.online.has(them.id) ? ` They're offline: it will wait for them.` : '';
  say(`Your ${kind === 'ally' ? 'offer of alliance' : 'offer of peace'} has been sent to ${them.name}.${away}`);
}

registerChoice('pact_offer', (w, c, option, d) => {
  const from = w.factions.get(Number(d.from));
  const to = w.factions.get(c.faction);
  if (!from || !to) return;
  const kind = d.kind === 'peace' ? 'peace' : 'ally';
  if (option !== 'accept') {
    const what = kind === 'ally' ? 'alliance' : 'offer of peace';
    w.message(from.id, d.expired ? `${to.name} didn't answer your ${what} in time.` : `${to.name} declined your ${what}.`, 'neutral');
    return;
  }
  if (kind === 'ally') {
    if (atWar(w, from.id, to.id)) return;
    setPact(w, from.id, to.id, 'ally');
    w.message(0, `${from.name} and ${to.name} are now allies.`, 'good');
  } else {
    if (!atWar(w, from.id, to.id)) return;
    setPact(w, from.id, to.id, 'truce', w.tick + PLAYER_TRUCE_DAYS * TICKS_PER_DAY);
    w.message(0, `${from.name} and ${to.name} have made peace. A truce holds for ${PLAYER_TRUCE_DAYS} days.`, 'good');
  }
});

/** War between colonies: their colonists fight on sight. A surprise attack also costs you with every town that knows you. */
export function declareWar(w: World, me: Faction, them: Faction, surprise: boolean): void {
  const was = pactOf(w, me.id, them.id)?.kind;
  setPact(w, me.id, them.id, 'war');
  if (surprise) {
    w.message(0, `${me.name} attacked ${them.name} without warning. They are at war.`, 'bad');
    rumor(w, me.id, was === 'truce' || was === 'ally' ? DIPLO.oathbreakerRumor + DIPLO.treacheryRumor : DIPLO.treacheryRumor, `Attacked ${them.name} without warning`);
  } else {
    w.message(0, `${me.name} has declared war on ${them.name}.`, 'bad');
    if (was === 'ally' || was === 'truce') rumor(w, me.id, DIPLO.oathbreakerRumor, `Turned on ${them.name}`);
  }
}

/** Why your colonists won't take an order to attack this faction, if they won't. */
export function attackRefusal(w: RelView, faction: number, target: number): string | null {
  const pact = pactOf(w, faction, target);
  const f = w.factions.get(target);
  if (!f || !pact) return null;
  if (pact.kind === 'ally') return `${f.name} is your ally. End the alliance first (Diplomacy).`;
  if (pact.kind === 'truce') {
    const hours = Math.max(1, Math.ceil(((pact.until ?? w.tick) - w.tick) / TICKS_PER_HOUR));
    return `You agreed a truce with ${f.name}; it ends in ${hours}h. Breaking it means declaring war (Diplomacy).`;
  }
  return null;
}

/** One faction's pawn struck another's. Between colonies not at war, that's a surprise attack. */
export function noteAttack(w: World, attacker: number, victim: number): void {
  const a = w.factions.get(attacker);
  const v = w.factions.get(victim);
  if (!a?.isPlayer || !v) return;
  if (v.isPlayer) {
    if (!atWar(w, attacker, victim)) declareWar(w, a, v, true);
    return;
  }
  if (v.settlement && pactOf(w, attacker, victim)?.kind === 'truce') {
    setPact(w, attacker, victim, null);
    shiftGoodwill(w, v, attacker, DIPLO.brokeTruce, 'Broke the truce', false);
    rumor(w, attacker, DIPLO.oathbreakerRumor, `Broke a truce with ${v.name}`, [victim]);
  }
}

// ---------------------------------------------------------------- allies in a fight

/** A colony is being raided: allied towns send help, allied colonies hear of it. */
export function callAllies(w: World, target: number, raiders: Faction): void {
  const t = w.factions.get(target);
  if (!t) return;
  const at = w.map.idx(t.home.x, t.home.y);
  for (const f of w.factions.values()) {
    if (f.id === target || !allied(w, f.id, target)) continue;
    if (f.isPlayer) {
      w.message(f.id, `Your ally ${t.name} is under attack by ${raiders.name}.`, 'bad', at);
      continue;
    }
    if (f.settlement?.state !== 'home') continue;
    // Up to two fighters, and someone always stays home.
    const people: Pawn[] = [];
    for (const id of w.kinds.pawn) {
      const p = w.get<Pawn>(id)!;
      if (p.faction === f.id && !p.downed && !p.prisoner && !p.aid) people.push(p);
    }
    const sent = people.slice(0, Math.min(2, people.length - 1));
    for (const p of sent) {
      p.aid = [target, w.tick + Math.round(TICKS_PER_DAY * 1.5)];
      p.job = null;
      p.path = null;
      w.markDirty(p);
    }
    if (sent.length) w.message(target, `${f.name}, your ally, sends ${sent.map((p) => p.name.split(' ')[0]).join(' and ')} to help.`, 'good', w.map.idx(f.home.x, f.home.y));
  }
}

/** A town is being raided: its allied colonies get a call, and a cold shoulder later if they never came. */
export function townCallsAllies(w: World, town: Faction): void {
  for (const f of w.factions.values()) {
    if (f.isPlayer && allied(w, f.id, town.id)) w.message(f.id, `${town.name}, your ally, calls for help against raiders!`, 'bad', w.map.idx(town.home.x, town.home.y));
  }
}

/** The raid on a town is over: allies that didn't lift a finger are remembered for it. */
export function alliesWhoStayedHome(w: World, town: Faction, helpers: Record<number, number> | undefined): void {
  for (const f of w.factions.values()) {
    if (!f.isPlayer || !allied(w, f.id, town.id)) continue;
    if ((helpers?.[f.id] ?? 0) >= 0.1) continue;
    shiftGoodwill(w, town, f.id, DIPLO.abandoned, "Didn't come when we called", false);
  }
}

// ---------------------------------------------------------------- over time

/** Truces running out, and rival towns now and then sending fighters at each other. */
export function diplomacyTick(w: World): void {
  if (w.tick % RARE_TICK !== 0) return;
  for (const f of w.factions.values()) {
    if (!f.pacts) continue;
    for (const [k, p] of Object.entries(f.pacts)) {
      if (p.until === undefined || w.tick < p.until) continue;
      const other = w.factions.get(Number(k));
      if (f.isPlayer && other) w.message(f.id, `The truce with ${other.name} has ended.`, 'neutral');
      delete f.pacts[Number(k)];
      w.dirty.factions.add(f.id);
    }
    if (!Object.keys(f.pacts).length) delete f.pacts;
  }
  if (w.tick % TICKS_PER_DAY !== TICKS_PER_DAY / 2) return;
  feuds(w);
}

/** Once a day: maybe one rival town sends fighters against another. At most one such fight at a time. */
function feuds(w: World): void {
  if (w.tick - START_TICK < FEUD_GRACE_DAYS * TICKS_PER_DAY) return;
  for (const f of w.factions.values()) if (f.raid?.sponsor && !f.raid.fled) return;
  const towns = liveTowns(w).filter((f) => f.settlement!.state === 'home');
  for (const a of towns) {
    for (const b of towns) {
      if (a.id === b.id || !areRivals(w, a, b) || opinionBetween(w, a, b) > HOSTILE_AT) continue;
      let people = 0;
      let theirs = 0;
      for (const id of w.kinds.pawn) {
        const f = w.get<Pawn>(id)!.faction;
        if (f === a.id) people++;
        else if (f === b.id) theirs++;
      }
      // Feuds wear a town down; they don't finish off one that is nearly gone.
      if (people < 3 || theirs < 3 || !w.rng.chance(FEUD_CHANCE)) continue;
      // A skirmish, not a massacre: a couple of fighters who head home once one of them is down.
      if (startRaid(w, b.id, 100 + people * 25, 'scout', a.id)) {
        shiftOpinion(w, a, b, -10);
        return;
      }
    }
  }
}
