/**
 * Every random event the storyteller can fire. See docs/EVENTS.md for the design notes.
 *
 * Seasons: 0 spring, 1 summer, 2 fall, 3 winter.
 */

export type EventScope = 'map' | 'faction' | 'pawn';
export type EventTone = 'good' | 'neutral' | 'bad';
export type EventCategory = 'weather' | 'health' | 'mood' | 'fortune' | 'disaster' | 'visitors' | 'threat' | 'mystery';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'unique';

/** Base selection weight per rarity tier. */
export const RARITY_WEIGHT: Record<Rarity, number> = {
  common: 10,
  uncommon: 4,
  rare: 1.2,
  epic: 0.4,
  unique: 0.25,
};

export interface EventDef {
  key: string;
  label: string;
  category: EventCategory;
  scope: EventScope;
  tone: EventTone;
  rarity: Rarity;
  /** Threat budget a bad event spends. */
  cost: number;
  /** Days into the game before it can fire. */
  minDay: number;
  /** Days before the same event can fire again (per target faction for faction events). */
  cooldownDays: number;
  /** Allowed seasons; all if omitted. */
  seasons?: number[];
  /** Duration range for ongoing conditions, in in-game hours. */
  hours?: [number, number];
  /** Fires at most once per world. */
  unique?: boolean;
  /** Only fired as a follow-up to another event, never rolled directly. */
  followUp?: boolean;
  /** Multiplies the rarity weight. */
  weight?: number;
  /**
   * The handler sizes the event itself and pays for it from the threat pool; `cost` is then
   * only the minimum pool needed before it can be rolled.
   */
  scaledCost?: boolean;
  description: string;
}

const E = (d: Omit<EventDef, 'cost' | 'minDay' | 'cooldownDays'> & Partial<Pick<EventDef, 'cost' | 'minDay' | 'cooldownDays'>>): EventDef => ({
  cost: 0,
  minDay: 1,
  cooldownDays: 4,
  ...d,
});

export const EVENTS: Record<string, EventDef> = Object.fromEntries(
  [
    // ------------------------------------------------------------------ weather
    E({ key: 'cold_snap', label: 'Cold snap', category: 'weather', scope: 'map', tone: 'bad', rarity: 'uncommon', cost: 25, minDay: 3, cooldownDays: 6, seasons: [0, 2, 3], hours: [24, 48], description: 'Temperatures drop by 20°C for one or two days. Outdoor crops may die and colonists risk hypothermia.' }),
    E({ key: 'heat_wave', label: 'Heat wave', category: 'weather', scope: 'map', tone: 'bad', rarity: 'uncommon', cost: 20, minDay: 3, cooldownDays: 6, seasons: [1], hours: [24, 48], description: 'Temperatures climb by 12°C. Risk of heatstroke; food spoils fast.' }),
    E({ key: 'blizzard', label: 'Blizzard', category: 'weather', scope: 'map', tone: 'bad', rarity: 'uncommon', cost: 30, minDay: 4, cooldownDays: 5, seasons: [3], hours: [12, 30], description: '−12°C and driving snow. Everyone walks 25% slower outdoors.' }),
    E({ key: 'early_frost', label: 'Early frost', category: 'weather', scope: 'map', tone: 'bad', rarity: 'uncommon', cost: 25, minDay: 3, cooldownDays: 8, seasons: [2], hours: [6, 10], description: 'One brutal night at −18°C, enough to kill unprotected crops.' }),
    E({ key: 'warm_spell', label: 'Warm spell', category: 'weather', scope: 'map', tone: 'good', rarity: 'uncommon', minDay: 2, cooldownDays: 8, seasons: [3], hours: [36, 60], description: 'A surprise thaw: +14°C in the middle of winter.' }),
    E({ key: 'spring_rains', label: 'Gentle rains', category: 'weather', scope: 'map', tone: 'good', rarity: 'common', minDay: 1, cooldownDays: 3, seasons: [0, 1], hours: [12, 30], description: 'Plants grow 40% faster and fires struggle to spread.' }),
    E({ key: 'thunderstorm', label: 'Thunderstorm', category: 'weather', scope: 'map', tone: 'neutral', rarity: 'common', cost: 5, minDay: 2, cooldownDays: 3, seasons: [0, 1, 2], hours: [5, 12], description: 'Rain plus lightning strikes that can set trees and wooden buildings alight.' }),
    E({ key: 'drought', label: 'Drought', category: 'weather', scope: 'map', tone: 'bad', rarity: 'uncommon', cost: 20, minDay: 5, cooldownDays: 10, seasons: [1], hours: [72, 120], description: 'Plants grow at 40% speed and fires spread faster.' }),
    E({ key: 'fog', label: 'Thick fog', category: 'weather', scope: 'map', tone: 'neutral', rarity: 'common', minDay: 1, cooldownDays: 2, seasons: [0, 2], hours: [5, 10], description: 'A grey blanket over everything. Pawns move 10% slower outdoors.' }),
    E({ key: 'eclipse', label: 'Eclipse', category: 'weather', scope: 'map', tone: 'neutral', rarity: 'uncommon', cost: 5, minDay: 2, cooldownDays: 8, hours: [8, 14], description: 'Darkness at noon. Plants stop growing until it passes.' }),
    E({ key: 'aurora', label: 'Aurora', category: 'weather', scope: 'map', tone: 'good', rarity: 'uncommon', minDay: 2, cooldownDays: 6, seasons: [2, 3], hours: [8, 14], description: 'Shimmering lights in the sky lift everyone’s mood.' }),
    E({ key: 'ash_fall', label: 'Ash fall', category: 'weather', scope: 'map', tone: 'bad', rarity: 'rare', cost: 40, minDay: 6, cooldownDays: 15, hours: [48, 96], description: 'A distant volcano darkens the sky. −8°C and no plant growth for days.' }),
    E({ key: 'cold_wind', label: 'Breath of the North', category: 'weather', scope: 'map', tone: 'bad', rarity: 'rare', cost: 35, minDay: 6, cooldownDays: 12, seasons: [2, 3], hours: [96, 144], description: 'A bitter wind from the frozen heart of the world: −6°C for most of a week. A taste of what is coming.' }),
    E({ key: 'blood_moon', label: 'Blood moon', category: 'weather', scope: 'map', tone: 'bad', rarity: 'rare', cost: 25, minDay: 5, cooldownDays: 12, hours: [10, 14], description: 'A red moon unsettles everyone. Mood falls and mental breaks are three times as likely.' }),
    E({ key: 'meteor_shower', label: 'Meteor shower', category: 'weather', scope: 'map', tone: 'neutral', rarity: 'rare', cost: 10, minDay: 4, cooldownDays: 12, description: 'Several meteorites strike across the map, leaving ore and the odd fire.' }),
    E({ key: 'long_night', label: 'The Long Night', category: 'weather', scope: 'map', tone: 'bad', rarity: 'epic', cost: 50, minDay: 10, cooldownDays: 999, unique: true, hours: [60, 80], description: 'The sun does not rise for three days. −10°C, no growth, and a creeping dread.' }),
    E({ key: 'false_spring', label: 'False Spring', category: 'weather', scope: 'map', tone: 'good', rarity: 'epic', minDay: 8, cooldownDays: 999, unique: true, seasons: [3], hours: [100, 130], description: 'Winter breaks for five glorious days: +16°C and plants grow 50% faster. It won’t last.' }),

    // ------------------------------------------------------------------ health
    E({ key: 'flu_outbreak', label: 'Flu', category: 'health', scope: 'faction', tone: 'bad', rarity: 'common', cost: 15, minDay: 3, cooldownDays: 5, seasons: [0, 2, 3], description: 'A colonist catches the flu. It can spread to others nearby.' }),
    E({ key: 'stomach_flu', label: 'Stomach flu', category: 'health', scope: 'faction', tone: 'bad', rarity: 'common', cost: 8, minDay: 2, cooldownDays: 4, description: 'A colonist is miserable and ravenous for a day or two.' }),
    E({ key: 'plague', label: 'Plague', category: 'health', scope: 'faction', tone: 'bad', rarity: 'rare', cost: 45, minDay: 8, cooldownDays: 20, description: 'A deadly contagious disease. Rest the sick in beds and keep others away.' }),
    E({ key: 'wasting_cough', label: 'Wasting cough', category: 'health', scope: 'faction', tone: 'bad', rarity: 'uncommon', cost: 12, minDay: 4, cooldownDays: 8, seasons: [2, 3], description: 'A lingering cold-weather lung sickness.' }),
    E({ key: 'sleeping_sickness', label: 'Sleeping sickness', category: 'health', scope: 'pawn', tone: 'bad', rarity: 'uncommon', cost: 10, minDay: 3, cooldownDays: 6, description: 'A colonist can barely stay awake for days.' }),
    E({ key: 'food_poisoning', label: 'Food poisoning', category: 'health', scope: 'pawn', tone: 'bad', rarity: 'common', cost: 5, minDay: 1, cooldownDays: 3, description: 'Something they ate disagreed with them.' }),
    E({ key: 'migraine', label: 'Migraine', category: 'health', scope: 'pawn', tone: 'bad', rarity: 'common', cost: 2, minDay: 1, cooldownDays: 2, description: 'A few hours of slow, grumpy work.' }),
    E({ key: 'accident', label: 'Accident', category: 'health', scope: 'pawn', tone: 'bad', rarity: 'common', cost: 5, minDay: 1, cooldownDays: 3, description: 'A sprained ankle, a cut hand or a strained back.' }),
    E({ key: 'miracle_recovery', label: 'Miraculous recovery', category: 'health', scope: 'faction', tone: 'good', rarity: 'rare', minDay: 3, cooldownDays: 10, description: 'Every sick or injured colonist suddenly recovers.' }),

    // ------------------------------------------------------------------ mood
    E({ key: 'inspiration', label: 'Inspiration', category: 'mood', scope: 'pawn', tone: 'good', rarity: 'common', minDay: 1, cooldownDays: 3, description: 'A colonist works 50% faster for a day.' }),
    E({ key: 'second_wind', label: 'Second wind', category: 'mood', scope: 'pawn', tone: 'good', rarity: 'uncommon', minDay: 1, cooldownDays: 4, description: 'A colonist barely needs sleep for most of a day.' }),
    E({ key: 'nightmares', label: 'Nightmares', category: 'mood', scope: 'pawn', tone: 'bad', rarity: 'common', cost: 3, minDay: 1, cooldownDays: 2, description: 'A colonist wakes up exhausted and shaken.' }),
    E({ key: 'festival', label: 'Festival day', category: 'mood', scope: 'map', tone: 'good', rarity: 'uncommon', minDay: 4, cooldownDays: 10, description: 'An old tradition: everyone celebrates and feels better for a day.' }),

    // ------------------------------------------------------------------ fortune
    E({ key: 'cargo_pods', label: 'Cargo pods', category: 'fortune', scope: 'map', tone: 'good', rarity: 'common', minDay: 0.5, cooldownDays: 2, description: 'Supplies crash down between the colonies. Whoever hauls them first keeps them.' }),
    E({ key: 'meteorite', label: 'Meteorite', category: 'fortune', scope: 'map', tone: 'neutral', rarity: 'uncommon', minDay: 2, cooldownDays: 5, description: 'A lump of rich ore falls from the sky.' }),
    E({ key: 'ore_discovered', label: 'Ore discovered', category: 'fortune', scope: 'faction', tone: 'good', rarity: 'uncommon', minDay: 2, cooldownDays: 6, description: 'Colonists spot a vein of steel or gold in nearby rock.' }),
    E({ key: 'berry_bloom', label: 'Berry bloom', category: 'fortune', scope: 'faction', tone: 'good', rarity: 'common', minDay: 1, cooldownDays: 5, seasons: [0, 1, 2], description: 'Wild berry bushes sprout and ripen around the colony.' }),
    E({ key: 'bumper_crop', label: 'Bumper crop', category: 'fortune', scope: 'faction', tone: 'good', rarity: 'uncommon', minDay: 3, cooldownDays: 6, seasons: [0, 1, 2], description: 'Crops leap ahead in growth.' }),
    E({ key: 'abandoned_cache', label: 'Abandoned cache', category: 'fortune', scope: 'map', tone: 'good', rarity: 'uncommon', minDay: 2, cooldownDays: 5, description: 'A stash of supplies is spotted, usually closer to the dangerous center of the map.' }),
    E({ key: 'frozen_explorer', label: 'Frozen explorer', category: 'fortune', scope: 'map', tone: 'good', rarity: 'rare', minDay: 4, cooldownDays: 10, seasons: [2, 3], description: 'The body of someone who walked out of the center. Their pack holds valuables and a warning.' }),

    // ------------------------------------------------------------------ disasters
    E({ key: 'blight', label: 'Blight', category: 'disaster', scope: 'faction', tone: 'bad', rarity: 'uncommon', cost: 25, minDay: 4, cooldownDays: 6, seasons: [0, 1, 2], description: 'Crops rot on the stalk. Harvest or cut the infected plants.' }),
    E({ key: 'wildfire', label: 'Wildfire', category: 'disaster', scope: 'map', tone: 'bad', rarity: 'uncommon', cost: 25, minDay: 4, cooldownDays: 8, seasons: [1, 2], description: 'A forest catches fire. Firefighters should keep it away from buildings.' }),
    E({ key: 'dry_lightning', label: 'Dry lightning', category: 'disaster', scope: 'map', tone: 'bad', rarity: 'uncommon', cost: 15, minDay: 3, cooldownDays: 6, seasons: [1, 2], hours: [3, 6], description: 'A few lightning strikes with no rain to stop the fires.' }),
    E({ key: 'pests', label: 'Rats in the stores', category: 'disaster', scope: 'faction', tone: 'bad', rarity: 'common', cost: 12, minDay: 3, cooldownDays: 5, description: 'Vermin eat into stored raw food.' }),
    E({ key: 'thief', label: 'Night thief', category: 'disaster', scope: 'faction', tone: 'bad', rarity: 'uncommon', cost: 18, minDay: 3, cooldownDays: 6, description: 'Someone slips in at night and steals from a stockpile.' }),

    // ------------------------------------------------------------------ visitors (most are choices)
    E({ key: 'wanderer_joins', label: 'Wanderer joins', category: 'visitors', scope: 'faction', tone: 'good', rarity: 'uncommon', minDay: 1, cooldownDays: 5, description: 'Someone walks in from the edge of the map and joins without asking questions.' }),
    E({ key: 'refugee', label: 'Refugee', category: 'visitors', scope: 'faction', tone: 'neutral', rarity: 'common', minDay: 2, cooldownDays: 4, description: 'Choice: take in someone fleeing trouble. They may be sick, or not who they say they are.' }),
    E({ key: 'settlement_raid', label: 'A settlement under attack', category: 'threat', scope: 'map', tone: 'neutral', rarity: 'uncommon', minDay: 4, cooldownDays: 4, description: 'Raiders attack a settlement. Colonies that know them hear of it; helping drive the raiders off earns their gratitude. The town holds out behind its walls, or falls.' }),
    E({ key: 'settlement_plea', label: 'A settlement asks for help', category: 'visitors', scope: 'faction', tone: 'neutral', rarity: 'common', minDay: 2, cooldownDays: 3, description: 'Choice: a settlement your colonists have met asks for goods, for a reward (sometimes one of their people joins you), or offers a job: clear a wolf pack or break up a bandit camp near their town. Agree and fail to deliver, and they remember.' }),
    E({ key: 'peddler', label: 'Peddler', category: 'visitors', scope: 'faction', tone: 'neutral', rarity: 'common', minDay: 1, cooldownDays: 3, description: 'Choice: a travelling peddler offers a trade from your stockpiles.' }),
    E({ key: 'beggars', label: 'Beggars', category: 'visitors', scope: 'faction', tone: 'neutral', rarity: 'uncommon', minDay: 2, cooldownDays: 5, description: 'Choice: hungry travellers ask for food. Kindness is sometimes repaid.' }),
    E({ key: 'lost_child', label: 'Lost child', category: 'visitors', scope: 'faction', tone: 'neutral', rarity: 'uncommon', minDay: 3, cooldownDays: 10, description: 'Choice: a child wanders in alone. They can’t work hard, but they grow up.' }),
    E({ key: 'mysterious_stranger', label: 'Mysterious stranger', category: 'visitors', scope: 'faction', tone: 'neutral', rarity: 'rare', minDay: 4, cooldownDays: 12, description: 'Choice: a hooded figure offers a sealed crate for a price. It could hold anything.' }),
    E({ key: 'pilgrim', label: 'Pilgrim of the Center', category: 'visitors', scope: 'faction', tone: 'good', rarity: 'epic', minDay: 6, cooldownDays: 999, unique: true, description: 'Choice: a strange, calm traveller who walked out of the frozen heart of the world asks to join.' }),
    E({ key: 'beggars_return', label: 'Kindness repaid', category: 'visitors', scope: 'faction', tone: 'good', rarity: 'common', followUp: true, description: 'The travellers you fed come back with a gift.' }),
    E({ key: 'new_arrivals', label: 'Survivors arrive', category: 'visitors', scope: 'faction', tone: 'good', rarity: 'common', followUp: true, description: 'When a colony is wiped out, two survivors arrive a day later so the player can keep going.' }),
    E({ key: 'refugee_betrayal', label: 'Betrayal', category: 'visitors', scope: 'faction', tone: 'bad', rarity: 'common', followUp: true, description: 'A refugee you took in robs you and runs.' }),

    // ------------------------------------------------------------------ threats (combat)
    E({ key: 'raid', label: 'Raid', category: 'threat', scope: 'faction', tone: 'bad', rarity: 'uncommon', cost: 60, scaledCost: true, minDay: 5, cooldownDays: 5, weight: 1.5, description: 'Armed raiders arrive at the map edge and attack the colony. Bigger and better armed the richer the colony is; paid for from the threat budget. They flee once half of them are down. Bands of three or more ride behind a named chief: bring the chief down and they break. Most chiefs stop at the edge first and demand tribute (choice: pay, talk them down, or fight). Prisoners taken may be ransomed back.' }),
    E({ key: 'night_raid', label: 'Night raid', category: 'threat', scope: 'faction', tone: 'bad', rarity: 'rare', cost: 60, scaledCost: true, minDay: 8, cooldownDays: 8, description: 'Raiders with knives and clubs creep in after dark. If it is daytime when the storyteller picks it, they wait for nightfall.' }),
    E({ key: 'sapper_raid', label: 'Sapper raid', category: 'threat', scope: 'faction', tone: 'bad', rarity: 'rare', cost: 60, scaledCost: true, minDay: 12, cooldownDays: 10, description: 'Raiders who tunnel through rock and smash through walls and doors to get at the colony instead of looking for a way in.' }),
    E({ key: 'scout_party', label: 'Scouting party', category: 'threat', scope: 'faction', tone: 'bad', rarity: 'common', cost: 25, minDay: 3, cooldownDays: 4, description: 'One or two raiders probe the colony’s defences. They run as soon as one of them goes down.' }),

    // ------------------------------------------------------------------ mysteries & unique
    E({ key: 'strange_signal', label: 'Strange signal', category: 'mystery', scope: 'map', tone: 'neutral', rarity: 'rare', minDay: 5, cooldownDays: 999, unique: true, description: 'A repeating signal from near the center of the map. Something answers two days later.' }),
    E({ key: 'ancient_vault', label: 'Ancient vault', category: 'mystery', scope: 'map', tone: 'good', rarity: 'epic', minDay: 6, cooldownDays: 15, description: 'A sealed stone chamber full of old supplies is exposed near the center. Dig in to claim it.' }),
    E({ key: 'sun_shard', label: 'The Sun Shard', category: 'mystery', scope: 'map', tone: 'good', rarity: 'unique', minDay: 8, cooldownDays: 999, unique: true, description: 'A fragment of something impossibly warm falls near the center. Enclose it to heat a room through any winter. Everyone will want it.' }),
    E({ key: 'whispering_stone', label: 'Whispering stone', category: 'mystery', scope: 'map', tone: 'neutral', rarity: 'unique', minDay: 5, cooldownDays: 999, unique: true, description: 'A tall black stone rises from the ground. Those who stand near it feel awe.' }),
  ].map((e) => [e.key, e]),
);

/**
 * Ongoing world conditions, keyed by event key. Effects apply while the condition lasts.
 */
export interface WeatherDef {
  tempOffset?: number;
  growthMult?: number;
  /** Treat it as night for light purposes. */
  dark?: boolean;
  /** Movement multiplier for pawns outdoors. */
  outdoorMove?: number;
  /** Rain: fires spread less and burn out faster. */
  rain?: boolean;
  /** Dry: fires spread more. */
  dry?: boolean;
  /** Mean in-game hours between lightning strikes. */
  lightningHours?: number;
  breakMult?: number;
  /** Mood shift for everyone while active. */
  mood?: number;
  /** Short label for the mood thought. */
  thought?: string;
}

export const WEATHER: Record<string, WeatherDef> = {
  cold_snap: { tempOffset: -20 },
  heat_wave: { tempOffset: 12, dry: true },
  blizzard: { tempOffset: -12, outdoorMove: 0.75 },
  early_frost: { tempOffset: -18 },
  warm_spell: { tempOffset: 14 },
  spring_rains: { growthMult: 1.4, rain: true },
  thunderstorm: { rain: true, lightningHours: 1.5 },
  drought: { growthMult: 0.4, dry: true },
  fog: { outdoorMove: 0.9 },
  eclipse: { dark: true },
  aurora: { mood: 0.12, thought: 'Saw the aurora' },
  ash_fall: { tempOffset: -8, growthMult: 0, dark: true },
  cold_wind: { tempOffset: -6, mood: -0.04, thought: 'Bitter north wind' },
  blood_moon: { breakMult: 3, mood: -0.15, thought: 'Blood moon' },
  long_night: { tempOffset: -10, growthMult: 0, dark: true, mood: -0.1, thought: 'The sun is gone' },
  false_spring: { tempOffset: 16, growthMult: 1.5, mood: 0.08, thought: 'False spring' },
  dry_lightning: { dry: true, lightningHours: 2 },
};
