import { APPAREL, CONDITIONS, ITEMS } from '@fe/defs';
import { tell } from './chronicle';
import { offerChoice, registerChoice } from './choices';
import { TICKS_PER_DAY } from './constants';
import { payGoods } from './diplomacy';
import { learn } from './pawns';
import { breakRaid } from './raids';
import { dispositionOf, goodwillOf, shiftGoodwill } from './settlements';
import type { Faction, Item, Pawn, RaidState } from './types';
import type { World } from './world';

/**
 * The people behind a raid: a chief with a name, who may stop at the edge and demand tribute
 * first; a band that breaks when its chief falls and drops what it carried; prisoners their band
 * will pay to get back; and the colonist left standing alone, whose story gets told.
 */

/** Raids this big or bigger ride behind a chief. */
export const CHIEF_MIN = 3;
/** The chief takes this share of each wound: a little harder to put down than the rest. */
export const CHIEF_HIDE = 0.7;
/** Share of chief-led raids on a colony that stop at the edge and demand tribute first. */
export const DEMAND_CHANCE = 0.6;
/** How long they wait for an answer. */
export const DEMAND_HOURS = 3;
/** Tribute asked, in market value per raid point, but never more than this share of the stockpiles. */
const TRIBUTE_PER_POINT = 1.2;
const TRIBUTE_SHARE = 0.6;
/** Below this they won't bother asking: there's nothing worth taking without a fight. */
const TRIBUTE_MIN = 40;
/** Chance each raider in a routed band throws down what they carried. */
export const ROUT_DROP = 0.6;
/** Days after a prisoner is taken before their band sends word, from..to. */
const RANSOM_DAYS: [number, number] = [0.5, 1];
/** What a band pays to get one of its own back, in gold: a fighter, and a chief. */
const RANSOM_GOLD: [number, number] = [4, 7];
const CHIEF_RANSOM_GOLD: [number, number] = [15, 22];
/** A town's thanks for a raider handed over: goodwill (fighter, chief), and a bounty as a share of the ransom. */
const HANDOVER_GOODWILL: [number, number] = [8, 20];
const BOUNTY_SHARE = 0.5;

const EPITHETS = ['Butcher', 'Crow', 'Hangman', 'Widow', 'Hound', 'Red', 'Grey', 'Knife', 'Hammer', 'Wolf', 'Tall', 'Quiet', 'Lame', 'Smiler', 'Tinker', 'Saint'];

const weaponRank = (p: Pawn): number => ['', 'knife', 'club', 'bow', 'rifle'].indexOf(p.weapon);

/** The best-armed of a band becomes its chief: a name, a coat, and the band's purse. */
export function makeChief(w: World, rf: Faction, raiders: Pawn[], min = CHIEF_MIN): Pawn | null {
  if (raiders.length < min || !rf.raid) return null;
  const chief = raiders.reduce((a, b) => (weaponRank(b) > weaponRank(a) ? b : a));
  chief.name = `${chief.name.split(' ')[0]} the ${w.rng.pick(EPITHETS)}`;
  // A coat and hat for the chief (that you can take off them after).
  if (!chief.apparel.some((a) => APPAREL[a]?.slot === 'outer')) chief.apparel.push('duster');
  if (!chief.apparel.some((a) => APPAREL[a]?.slot === 'head')) chief.apparel.push('tuque');
  chief.carrying = { def: 'gold', count: 4 + w.rng.int(6), rot: 0 };
  rf.raid.chief = chief.id;
  rf.raid.chiefName = chief.name;
  w.markDirty(chief);
  return chief;
}

/** The band's name without "Raiders of". */
export function bandName(f: Faction): string {
  return f.name.replace(/^(Raiders|Bandits) of /, '');
}

function stockValue(w: World, faction: number): number {
  let v = 0;
  for (const id of w.kinds.item) {
    const it = w.get<Item>(id)!;
    const z = w.zoneAt(w.cellOf(it));
    if (z && z.faction === faction && z.kind === 'stockpile') v += (ITEMS[it.def]?.marketValue ?? 0) * it.count;
  }
  return v;
}

/** What a band of this many raid points asks a colony for; 0 if it has too little to be worth asking. */
export function tribute(w: World, faction: number, points: number): number {
  const v = Math.round(Math.min(points * TRIBUTE_PER_POINT, stockValue(w, faction) * TRIBUTE_SHARE));
  return v >= TRIBUTE_MIN ? v : 0;
}

/** Chance a colonist with this Social skill talks a chief out of attacking. */
export function talkChance(social: number): number {
  return Math.max(0.15, Math.min(0.8, 0.15 + 0.06 * Math.max(0, social)));
}

/** A colony's best talker who is up and about, anywhere. */
function talker(w: World, faction: number): Pawn | null {
  let best: Pawn | null = null;
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction !== faction || p.downed || p.prisoner || p.species) continue;
    if (!best || (p.skills.social?.level ?? 0) > (best.skills.social?.level ?? 0)) best = p;
  }
  return best;
}

/**
 * Maybe stop at the edge and send word first: pay, talk, or fight. Returns the text to add to the
 * arrival letter, or '' if they just come in.
 */
export function maybeDemand(w: World, rf: Faction, target: number, points: number, at: number): string {
  const raid = rf.raid;
  if (!raid?.chiefName || !w.rng.chance(DEMAND_CHANCE)) return '';
  const price = tribute(w, target, points);
  const speaker = talker(w, target);
  const chance = speaker ? talkChance(speaker.skills.social?.level ?? 0) : 0;
  const options = [];
  if (price) options.push({ key: 'pay', label: `Pay tribute (goods worth ${price})` });
  if (speaker) options.push({ key: 'talk', label: `Talk them down (${speaker.name.split(' ')[0]}, about ${Math.round(chance * 100)}%)` });
  options.push({ key: 'fight', label: 'Fight' });
  const what = price ? `goods worth ${price} from your stockpiles` : 'everything you have';
  const c = offerChoice(
    w,
    target,
    'raid_demand',
    `${raid.chiefName} demands tribute`,
    `${raid.chiefName}, chief of ${bandName(rf)}, has stopped at the edge of your land with ${raid.size} fighters and sends word: "${what[0].toUpperCase() + what.slice(1)}, and we go. Refuse, and we take it." They will wait about ${DEMAND_HOURS} hours. Attack them and that's your answer.`,
    options,
    DEMAND_HOURS,
    { band: rf.id, price, speaker: speaker?.id ?? 0, chance },
    at,
  );
  raid.parley = c.expires;
  raid.parleyChoice = c.id;
  raid.until += c.expires - w.tick;
  return ` Their chief, ${raid.chiefName}, waits at the edge for your answer: pay, talk, or fight.`;
}

/** Still waiting at the edge for the colony's answer? */
export function parleying(w: World, raid: RaidState): boolean {
  return !!raid.parley && w.tick < raid.parley;
}

/** Stop waiting: the letter goes, and the fight (if any) starts from now. */
export function endParley(w: World, raid: RaidState): void {
  raid.goalSince = w.tick;
  const id = raid.parleyChoice;
  raid.parley = 0;
  raid.parleyChoice = 0;
  if (id && w.choices.delete(id)) {
    w.choiceData.delete(id);
    w.dirty.choices = true;
  }
}

/** Someone attacked them while they waited: that's an answer. */
export function answeredWithSteel(w: World, rf: Faction, by: Pawn): void {
  const raid = rf.raid;
  if (!raid || !parleying(w, raid)) return;
  endParley(w, raid);
  w.dirty.factions.add(rf.id);
  const who = by.faction === raid.target ? `You answered ${raid.chiefName} with steel.` : `${by.species ? 'Wolves' : (w.factions.get(by.faction)?.name ?? 'Someone')} attacked ${bandName(rf)} while they waited.`;
  w.message(raid.target, `${who} ${rf.name} are coming in!`, 'bad');
}

registerChoice('raid_demand', (w, c, option, d) => {
  const rf = w.factions.get(Number(d.band));
  const raid = rf?.raid;
  // Already broken off, or already answered with an attack.
  if (!rf || !raid || raid.fled || raid.parleyChoice !== c.id) return;
  endParley(w, raid);
  w.dirty.factions.add(rf.id);
  const chief = raid.chiefName ?? 'Their chief';
  const band = bandName(rf);
  if (option === 'pay') {
    const price = Number(d.price);
    if (payGoods(w, c.faction, null, price)) {
      breakRaid(w, rf, `${chief} takes the tribute. ${rf.name} are leaving, for now.`);
      tell(w, c.faction, `Paid ${band} goods worth ${price} to leave the colony be.`);
      return;
    }
    w.message(c.faction, `You can't cover the tribute. ${chief} takes that as a no: ${rf.name} are coming in!`, 'bad');
    return;
  }
  if (option === 'talk') {
    const p = w.get<Pawn>(Number(d.speaker));
    if (!p || p.kind !== 'pawn' || p.faction !== c.faction || p.downed) {
      w.message(c.faction, `Nobody went out to talk. ${rf.name} are coming in!`, 'bad');
      return;
    }
    learn(w, p, 'social', 400);
    if (w.rng.chance(Number(d.chance))) {
      breakRaid(w, rf, `${p.name} talked ${chief} out of it. ${rf.name} are leaving.`);
      tell(w, c.faction, `${p.name} talked ${chief} of ${band} out of attacking.`, 'first_parley');
      return;
    }
    w.message(c.faction, `${chief} laughs in ${p.name}'s face. ${rf.name} are coming in!`, 'bad', w.cellOf(p));
    return;
  }
  w.message(c.faction, d.expired ? `No answer: ${chief} gives the word. ${rf.name} are coming in!` : `You refuse. ${rf.name} draw their weapons and come in!`, 'bad');
});

// ---------------------------------------------------------------- the chief falls

/** Note who struck the chief, so the story can name them. */
export function chiefStruck(raid: RaidState, t: Pawn, by: Pawn): void {
  if (raid.chief === t.id) raid.chiefBy = by.id;
}

/** The chief went down or died: the band breaks. */
export function chiefFell(w: World, f: Faction, killed: boolean): void {
  const raid = f.raid;
  if (!raid?.chief) return;
  const by = raid.chiefBy ? w.get<Pawn>(raid.chiefBy) : undefined;
  const hero = by && by.kind === 'pawn' && w.factions.get(by.faction)?.isPlayer ? by : undefined;
  const chief = raid.chiefName ?? 'Their chief';
  raid.chief = 0;
  w.dirty.factions.add(f.id);
  const target = w.factions.get(raid.target);
  const colony = target?.isPlayer ? raid.target : hero?.faction;
  if (colony) tell(w, colony, `Brought down ${chief}, chief of ${bandName(f)}${hero ? `: ${hero.name} landed the blow` : ''}.`, 'first_chief');
  if (!raid.fled && colony) breakRaid(w, f, `${chief} ${killed ? 'is dead' : 'is down'}${hero ? `, felled by ${hero.name}` : ''}! ${f.name} are breaking and running.`, true);
}

/** A routed band throws down what it was carrying to run faster. */
export function routDrop(w: World, raiders: Pawn[]): void {
  for (const p of raiders) {
    if (p.downed || !p.carrying || !w.rng.chance(ROUT_DROP)) continue;
    w.placeItemNear(p.carrying.def, p.carrying.count, w.cellOf(p), p.carrying.rot);
    p.carrying = null;
    w.markDirty(p);
  }
}

// ---------------------------------------------------------------- ransom

/** A raider was just taken prisoner from their band. */
export function noteCaptive(w: World, p: Pawn, band: Faction): void {
  // The chief's mark is cleared when they fall, so know them by name.
  const chief = !!band.raid?.chiefName && band.raid.chiefName === p.name;
  const [lo, hi] = RANSOM_DAYS;
  p.captive = { band: band.raid?.sponsor ? (w.factions.get(band.raid.sponsor)?.name ?? bandName(band)) : bandName(band), offerAt: w.tick + Math.round((lo + w.rng.next() * (hi - lo)) * TICKS_PER_DAY) };
  if (chief) p.captive.chief = true;
}

/** The friendliest town a colony knows that isn't against it. */
function friendliestTown(w: World, faction: number): Faction | null {
  let best: Faction | null = null;
  for (const f of w.factions.values()) {
    const s = f.settlement;
    if (!s || s.state !== 'home' || !s.met.includes(faction) || dispositionOf(s, faction) === 'hostile') continue;
    if (!best || goodwillOf(s, faction) > goodwillOf(best.settlement!, faction)) best = f;
  }
  return best;
}

/** Slow tick for a prisoner: when the time comes, their band offers to buy them back. */
export function ransomTick(w: World, p: Pawn): void {
  const cap = p.captive;
  if (!cap?.offerAt || w.tick < cap.offerAt || p.prisoner !== 'held') return;
  cap.offerAt = 0;
  const [lo, hi] = cap.chief ? CHIEF_RANSOM_GOLD : RANSOM_GOLD;
  const gold = lo + w.rng.int(hi - lo + 1);
  const town = friendliestTown(w, p.faction);
  const [gwLo, gwHi] = HANDOVER_GOODWILL;
  const goodwill = cap.chief ? gwHi : gwLo;
  const bounty = Math.max(1, Math.round(gold * BOUNTY_SHARE));
  const options = [{ key: 'ransom', label: `Ransom them (${gold} gold)` }];
  if (town) options.push({ key: 'handover', label: `Hand them to ${town.name} (${bounty} gold, +${goodwill} goodwill)` });
  options.push({ key: 'keep', label: 'Keep them' });
  const who = cap.chief ? `their chief, ${p.name}` : p.name;
  offerChoice(
    w,
    p.faction,
    'ransom',
    `${cap.band} want ${p.name.split(' ')[0]} back`,
    `A rider from ${cap.band} comes under a white rag. They will pay ${gold} gold to have ${who} back.${town ? ` ${town.name} would rather see them answer for it, and would pay a bounty.` : ''} Or keep them: in time a content prisoner may join you.`,
    options,
    10,
    { pawn: p.id, gold, bounty, goodwill, town: town?.id ?? 0, band: cap.band },
    w.cellOf(p),
  );
}

registerChoice('ransom', (w, c, option, d) => {
  if (option === 'keep') return;
  const p = w.get<Pawn>(Number(d.pawn));
  if (!p || p.kind !== 'pawn' || p.faction !== c.faction || p.prisoner !== 'held') {
    w.message(c.faction, `The prisoner ${String(d.band)} asked about is no longer yours to give.`, 'neutral');
    return;
  }
  const home = w.factions.get(c.faction)!;
  const homeCell = w.map.idx(home.home.x, home.home.y);
  p.prisoner = 'leaving';
  p.job = null;
  p.path = null;
  w.markDirty(p);
  if (option === 'handover') {
    const town = w.factions.get(Number(d.town));
    if (town?.settlement) {
      shiftGoodwill(w, town, c.faction, Number(d.goodwill), `Handed over ${p.name} for justice`);
      w.placeItemNear('gold', Number(d.bounty), homeCell);
      w.message(c.faction, `${p.name} is led off to ${town.name}. Their bounty, ${Number(d.bounty)} gold, is by your home.`, 'good', homeCell);
      tell(w, c.faction, `Handed ${p.name} of ${String(d.band)} over to ${town.name}.`);
      return;
    }
  }
  w.placeItemNear('gold', Number(d.gold), homeCell);
  w.message(c.faction, `${String(d.band)} paid ${Number(d.gold)} gold for ${p.name}, who is walking away. The gold is by your home.`, 'good', homeCell);
  tell(w, c.faction, `Ransomed ${p.name} back to ${String(d.band)} for ${Number(d.gold)} gold.`);
});

// ---------------------------------------------------------------- the fight is over

/** How well the downed bind their own wounds when the fighting stops (a doctor does better). */
export const SELF_TEND = 0.2;

/**
 * The fighting at a colony has stopped (the raiders broke, or there's nobody left standing to
 * fight): its downed bind their own wounds as best they can, so a lost fight leaves the colony
 * hurt and robbed rather than bleeding to death with nobody to help.
 */
export function stabilise(w: World, colony: number): void {
  if (!w.factions.get(colony)?.isPlayer) return;
  const names: string[] = [];
  let at = -1;
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction !== colony || !p.downed || p.prisoner || p.species) continue;
    let bound = false;
    for (const c of p.conditions) {
      if (c.tended !== undefined || !CONDITIONS[c.key]?.bleed) continue;
      c.tended = SELF_TEND;
      bound = true;
    }
    if (!bound) continue;
    w.markDirty(p);
    names.push(p.name.split(' ')[0]);
    at = w.cellOf(p);
  }
  if (!names.length) return;
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  w.message(colony, `The fighting has stopped. ${who} bound ${names.length === 1 ? 'their' : 'their own'} wounds as best they could: get them to a bed.`, 'neutral', at);
}

// ---------------------------------------------------------------- last stands

/** During a raid on a colony: is one colonist left standing alone against two or more? */
export function checkLastStand(w: World, f: Faction, raiders: number): void {
  const raid = f.raid!;
  if (raid.lastStand || raiders < 2 || !w.factions.get(raid.target)?.isPlayer) return;
  let people = 0;
  let up: Pawn | null = null;
  let ups = 0;
  for (const id of w.kinds.pawn) {
    const p = w.get<Pawn>(id)!;
    if (p.faction !== raid.target || p.prisoner || p.species) continue;
    people++;
    if (!p.downed) {
      ups++;
      up = p;
    }
  }
  if (people < 2 || ups !== 1 || !up) return;
  raid.lastStand = [up.id, raiders];
  w.dirty.factions.add(f.id);
  w.message(raid.target, `${up.name} is the last one standing against ${raiders} of ${f.name}!`, 'bad', w.cellOf(up));
}

/** The raid is over: a colonist who stood alone and lived gets their line in the story. */
export function tellLastStand(w: World, raid: RaidState, colony: number): boolean {
  if (!raid.lastStand) return false;
  const p = w.get<Pawn>(raid.lastStand[0]);
  if (!p || p.kind !== 'pawn' || p.faction !== colony) return false;
  tell(w, colony, `${p.name} held alone against ${raid.lastStand[1]} raiders.`, 'first_stand');
  return true;
}
