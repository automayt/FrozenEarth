# Events

FrozenEarth's random events come from three sources:

1. **The storyteller**, which rolls events on a timer for the whole map and for each colony.
2. **Emergent systems**, which cause things to happen with no storyteller roll: disease spreading, exposure, mental breaks, fire spreading, accidents.
3. **Follow-ups**: some events schedule later consequences, such as a refugee's betrayal, repaid kindness, or a signal that leads to a vault.

All the numbers here live in `packages/defs/src/events.ts` (events and weather), `packages/defs/src/health.ts` (conditions and traits), and `packages/sim/src/storyteller.ts`. The catalogue tables below are generated from those files; run `npm run docs:events` after changing them.

## Design goals

- **Wide variation.** 56 events in 7 categories, plus 27 health conditions and 18 traits that change how each event plays out. The same plague is a nuisance for a hardy colonist resting in a bed and a death sentence for a sickly one sleeping in the snow.
- **Rare and unique moments.** Five rarity tiers. Epic and unique events can fire at most once per world, so each world gets its own story. Players in the same world experience them together.
- **Multiplayer pressure.** Several events are deliberately shared or contested:
  - Cargo pods land *between* colonies.
  - Caches and relics appear *toward the center*, which is the direction the game wants players moving anyway.
  - The Sun Shard is a single heat source that every colony will want to wall in.
  - A lost child you turn away walks on to *another player's* colony.
- **Decisions, not just dice.** Visitor events arrive as choice letters. Some carry hidden information that only shows up later:
  - A refugee may be secretly sick, or a thief who robs you days later.
  - A stranger's crate may hold treasure, rocks, or plague rats.
  This is the start of the "help them, trick them, or get tricked" layer.
- **Winter is the enemy.** Cold-weather events, exposure and the seasons all push toward the core loop of the game: build shelter, keep warm, move inward.

## How the storyteller decides

- **When it rolls.** Every 4 in-game hours it makes one roll for the whole map (12% chance) and one roll per colony (15% each). Over a game this averages about 0.7 map events and 0.9 colony events per in-game day.
- **What it picks.** A weighted pick from the events that are currently eligible. Weight is the rarity weight times the event's own weight.
  - Rarity weights: <!-- rarity:start -->
**common** 10 · **uncommon** 4 · **rare** 1.2 · **epic** 0.4 · **unique** 0.25
<!-- rarity:end -->
- **Eligibility rules:**
  - The game has run at least the event's `minDay`.
  - It is one of the event's seasons.
  - The event's cooldown has passed. Cooldowns are per colony for colony events.
  - It isn't already active.
  - A unique event hasn't fired before.
  - Two temperature-swing weathers never stack (no cold snap during a heat wave).
- **Threat budget.** Bad events cost threat points, and each colony (plus the shared map) earns points over time. Earnings ramp from ×0.5 on day 0 to ×2.2 by around day 14. A colony that had a bad event in the last day has bad events weighted ×0.35, which avoids pile-ons.
- **Retries.** If the picked event can't act (for example, blight with no crops), up to two more are tried.
- **Quiet start.** The first in-game day is quiet.
- **Wiped-out colonies.** If a colony loses every colonist, two survivors arrive a day later (`new_arrivals`), so a player is never locked out of a shared world.

Hosts have an **Events** button (bottom bar) that fires any event on demand, for testing or for running a game-master session. Everyone sees a chat note when it's used.

## Event catalogue

<!-- events:start -->
### Weather and sky

| Event | Rarity | Tone | Hits | When | What happens |
| --- | --- | --- | --- | --- | --- |
| **Cold snap** `cold_snap` | uncommon | bad (25) | everyone | day 3+, Spring/Fall/Winter, 24–48 h | Temperatures drop by 20°C for one or two days. Outdoor crops may die and colonists risk hypothermia. |
| **Heat wave** `heat_wave` | uncommon | bad (20) | everyone | day 3+, Summer, 24–48 h | Temperatures climb by 12°C. Risk of heatstroke; food spoils fast. |
| **Blizzard** `blizzard` | uncommon | bad (30) | everyone | day 4+, Winter, 12–30 h | −12°C and driving snow. Everyone walks 25% slower outdoors. |
| **Early frost** `early_frost` | uncommon | bad (25) | everyone | day 3+, Fall, 6–10 h | One brutal night at −18°C, enough to kill unprotected crops. |
| **Warm spell** `warm_spell` | uncommon | good | everyone | day 2+, Winter, 36–60 h | A surprise thaw: +14°C in the middle of winter. |
| **Gentle rains** `spring_rains` | common | good | everyone | day 1+, Spring/Summer, 12–30 h | Plants grow 40% faster and fires struggle to spread. |
| **Thunderstorm** `thunderstorm` | common | neutral (5) | everyone | day 2+, Spring/Summer/Fall, 5–12 h | Rain plus lightning strikes that can set trees and wooden buildings alight. |
| **Drought** `drought` | uncommon | bad (20) | everyone | day 5+, Summer, 72–120 h | Plants grow at 40% speed and fires spread faster. |
| **Thick fog** `fog` | common | neutral | everyone | day 1+, Spring/Fall, 5–10 h | A grey blanket over everything. Pawns move 10% slower outdoors. |
| **Eclipse** `eclipse` | uncommon | neutral (5) | everyone | day 2+, 8–14 h | Darkness at noon. Plants stop growing until it passes. |
| **Aurora** `aurora` | uncommon | good | everyone | day 2+, Fall/Winter, 8–14 h | Shimmering lights in the sky lift everyone’s mood. |
| **Ash fall** `ash_fall` | rare | bad (40) | everyone | day 6+, 48–96 h | A distant volcano darkens the sky. −8°C and no plant growth for days. |
| **Breath of the North** `cold_wind` | rare | bad (35) | everyone | day 6+, Fall/Winter, 96–144 h | A bitter wind from the frozen heart of the world: −6°C for most of a week. A taste of what is coming. |
| **Blood moon** `blood_moon` | rare | bad (25) | everyone | day 5+, 10–14 h | A red moon unsettles everyone. Mood falls and mental breaks are three times as likely. |
| **Meteor shower** `meteor_shower` | rare | neutral (10) | everyone | day 4+ | Several meteorites strike across the map, leaving ore and the odd fire. |
| **The Long Night** `long_night` | epic | bad (50) | everyone | day 10+, 60–80 h, **once per world** | The sun does not rise for three days. −10°C, no growth, and a creeping dread. |
| **False Spring** `false_spring` | epic | good | everyone | day 8+, Winter, 100–130 h, **once per world** | Winter breaks for five glorious days: +16°C and plants grow 50% faster. It won’t last. |

### Health

| Event | Rarity | Tone | Hits | When | What happens |
| --- | --- | --- | --- | --- | --- |
| **Flu** `flu_outbreak` | common | bad (15) | a colony | day 3+, Spring/Fall/Winter | A colonist catches the flu. It can spread to others nearby. |
| **Stomach flu** `stomach_flu` | common | bad (8) | a colony | day 2+ | A colonist is miserable and ravenous for a day or two. |
| **Plague** `plague` | rare | bad (45) | a colony | day 8+ | A deadly contagious disease. Rest the sick in beds and keep others away. |
| **Wasting cough** `wasting_cough` | uncommon | bad (12) | a colony | day 4+, Fall/Winter | A lingering cold-weather lung sickness. |
| **Sleeping sickness** `sleeping_sickness` | uncommon | bad (10) | a colonist | day 3+ | A colonist can barely stay awake for days. |
| **Food poisoning** `food_poisoning` | common | bad (5) | a colonist | day 1+ | Something they ate disagreed with them. |
| **Migraine** `migraine` | common | bad (2) | a colonist | day 1+ | A few hours of slow, grumpy work. |
| **Accident** `accident` | common | bad (5) | a colonist | day 1+ | A sprained ankle, a cut hand or a strained back. |
| **Miraculous recovery** `miracle_recovery` | rare | good | a colony | day 3+ | Every sick or injured colonist suddenly recovers. |

### Mood

| Event | Rarity | Tone | Hits | When | What happens |
| --- | --- | --- | --- | --- | --- |
| **Inspiration** `inspiration` | common | good | a colonist | day 1+ | A colonist works 50% faster for a day. |
| **Second wind** `second_wind` | uncommon | good | a colonist | day 1+ | A colonist barely needs sleep for most of a day. |
| **Nightmares** `nightmares` | common | bad (3) | a colonist | day 1+ | A colonist wakes up exhausted and shaken. |
| **Festival day** `festival` | uncommon | good | everyone | day 4+ | An old tradition: everyone celebrates and feels better for a day. |

### Fortune

| Event | Rarity | Tone | Hits | When | What happens |
| --- | --- | --- | --- | --- | --- |
| **Cargo pods** `cargo_pods` | common | good | everyone | day 0.5+ | Supplies crash down between the colonies. Whoever hauls them first keeps them. |
| **Meteorite** `meteorite` | uncommon | neutral | everyone | day 2+ | A lump of rich ore falls from the sky. |
| **Ore discovered** `ore_discovered` | uncommon | good | a colony | day 2+ | Colonists spot a vein of steel or gold in nearby rock. |
| **Berry bloom** `berry_bloom` | common | good | a colony | day 1+, Spring/Summer/Fall | Wild berry bushes sprout and ripen around the colony. |
| **Bumper crop** `bumper_crop` | uncommon | good | a colony | day 3+, Spring/Summer/Fall | Crops leap ahead in growth. |
| **Abandoned cache** `abandoned_cache` | uncommon | good | everyone | day 2+ | A stash of supplies is spotted, usually closer to the dangerous center of the map. |
| **Frozen explorer** `frozen_explorer` | rare | good | everyone | day 4+, Fall/Winter | The body of someone who walked out of the center. Their pack holds valuables and a warning. |

### Disasters

| Event | Rarity | Tone | Hits | When | What happens |
| --- | --- | --- | --- | --- | --- |
| **Blight** `blight` | uncommon | bad (25) | a colony | day 4+, Spring/Summer/Fall | Crops rot on the stalk. Harvest or cut the infected plants. |
| **Wildfire** `wildfire` | uncommon | bad (25) | everyone | day 4+, Summer/Fall | A forest catches fire. Firefighters should keep it away from buildings. |
| **Dry lightning** `dry_lightning` | uncommon | bad (15) | everyone | day 3+, Summer/Fall, 3–6 h | A few lightning strikes with no rain to stop the fires. |
| **Rats in the stores** `pests` | common | bad (12) | a colony | day 3+ | Vermin eat into stored raw food. |
| **Night thief** `thief` | uncommon | bad (18) | a colony | day 3+ | Someone slips in at night and steals from a stockpile. |

### Visitors and choices

| Event | Rarity | Tone | Hits | When | What happens |
| --- | --- | --- | --- | --- | --- |
| **Wanderer joins** `wanderer_joins` | uncommon | good | a colony | day 1+ | Someone walks in from the edge of the map and joins without asking questions. |
| **Refugee** `refugee` | common | neutral | a colony | day 2+ | Choice: take in someone fleeing trouble. They may be sick, or not who they say they are. |
| **A settlement asks for help** `settlement_plea` | common | neutral | a colony | day 2+ | Choice: a settlement your colonists have met asks for goods, for a reward (sometimes one of their people joins you), or offers a job: clear a wolf pack or break up a bandit camp near their town. Agree and fail to deliver, and they remember. |
| **Peddler** `peddler` | common | neutral | a colony | day 1+ | Choice: a travelling peddler offers a trade from your stockpiles. |
| **Beggars** `beggars` | uncommon | neutral | a colony | day 2+ | Choice: hungry travellers ask for food. Kindness is sometimes repaid. |
| **Lost child** `lost_child` | uncommon | neutral | a colony | day 3+ | Choice: a child wanders in alone. They can’t work hard, but they grow up. |
| **Mysterious stranger** `mysterious_stranger` | rare | neutral | a colony | day 4+ | Choice: a hooded figure offers a sealed crate for a price. It could hold anything. |
| **Pilgrim of the Center** `pilgrim` | epic | good | a colony | day 6+, **once per world** | Choice: a strange, calm traveller who walked out of the frozen heart of the world asks to join. |
| **Kindness repaid** `beggars_return` | common | good | a colony | follow-up only | The travellers you fed come back with a gift. |
| **Survivors arrive** `new_arrivals` | common | good | a colony | follow-up only | When a colony is wiped out, two survivors arrive a day later so the player can keep going. |
| **Betrayal** `refugee_betrayal` | common | bad | a colony | follow-up only | A refugee you took in robs you and runs. |

### Threats (combat)

| Event | Rarity | Tone | Hits | When | What happens |
| --- | --- | --- | --- | --- | --- |
| **A settlement under attack** `settlement_raid` | uncommon | neutral | everyone | day 4+ | Raiders attack a settlement. Colonies that know them hear of it; helping drive the raiders off earns their gratitude. The town holds out behind its walls, or falls. |
| **Raid** `raid` | uncommon | bad (60+, scaled) | a colony | day 5+ | Armed raiders arrive at the map edge and attack the colony. Bigger and better armed the richer the colony is; paid for from the threat budget. They flee once half of them are down. Bands of three or more ride behind a named chief: bring the chief down and they break. Most chiefs stop at the edge first and demand tribute (choice: pay, talk them down, or fight). Prisoners taken may be ransomed back. |
| **Night raid** `night_raid` | rare | bad (60+, scaled) | a colony | day 8+ | Raiders with knives and clubs creep in after dark. If it is daytime when the storyteller picks it, they wait for nightfall. |
| **Sapper raid** `sapper_raid` | rare | bad (60+, scaled) | a colony | day 12+ | Raiders who tunnel through rock and smash through walls and doors to get at the colony instead of looking for a way in. |
| **Scouting party** `scout_party` | common | bad (25) | a colony | day 3+ | One or two raiders probe the colony’s defences. They run as soon as one of them goes down. |

### Mysteries and uniques

| Event | Rarity | Tone | Hits | When | What happens |
| --- | --- | --- | --- | --- | --- |
| **Strange signal** `strange_signal` | rare | neutral | everyone | day 5+, **once per world** | A repeating signal from near the center of the map. Something answers two days later. |
| **Ancient vault** `ancient_vault` | epic | good | everyone | day 6+ | A sealed stone chamber full of old supplies is exposed near the center. Dig in to claim it. |
| **The Sun Shard** `sun_shard` | unique | good | everyone | day 8+, **once per world** | A fragment of something impossibly warm falls near the center. Enclose it to heat a room through any winter. Everyone will want it. |
| **Whispering stone** `whispering_stone` | unique | neutral | everyone | day 5+, **once per world** | A tall black stone rises from the ground. Those who stand near it feel awe. |

<!-- events:end -->

### Weather effects

<!-- weather:start -->
| Condition | Effects |
| --- | --- |
| Cold snap | -20°C |
| Heat wave | +12°C, dry (fires spread faster) |
| Blizzard | -12°C, outdoor movement ×0.75 |
| Early frost | -18°C |
| Warm spell | +14°C |
| Gentle rains | plant growth ×1.4, rain (fires die down) |
| Thunderstorm | rain (fires die down), lightning every ~1.5 h |
| Drought | plant growth ×0.4, dry (fires spread faster) |
| Thick fog | outdoor movement ×0.9 |
| Eclipse | darkness |
| Aurora | mood +12 |
| Ash fall | -8°C, plant growth ×0, darkness |
| Breath of the North | -6°C, mood -4 |
| Blood moon | mental breaks ×3, mood -15 |
| The Long Night | -10°C, plant growth ×0, darkness, mood -10 |
| False Spring | +16°C, plant growth ×1.5, mood +8 |
| Dry lightning | dry (fires spread faster), lightning every ~2 h |
<!-- weather:end -->

## Emergent events (no storyteller roll)

| What | Trigger | Notes |
| --- | --- | --- |
| **Hypothermia / heatstroke** | Staying outside the comfortable band (4–36°C, shifted by traits; beds give −8°C of comfort while sleeping) | Builds at about 0.08 × degrees past the line per day, eases at 2/day once comfortable. Lethal at 100%. Colonists who get too cold seek out warm rooms, campfire warmth or the Sun Shard, and even leave bed to do it. |
| **Malnutrition** | Food at 0 | +0.4/day, lethal. |
| **Contagion** | A contagious disease | Each slow tick there's a chance to infect a colonist of the same colony within 6 cells. |
| **Disease course** | Any disease | Severity rises while immunity builds. Bed rest slows severity (×0.8) and speeds immunity (×1.35); malnutrition slows immunity. Whichever reaches 100% first decides the outcome. |
| **Mental breaks** | Mood under 18% | 2% per slow tick, multiplied by traits and weather (blood moon ×3). Possible breaks: sulking, dazed wandering, a food binge, hiding in bed. |
| **Inspiration** | Mood over 78% | Small chance of *Inspired*: 50% faster work for a day. |
| **Work accidents** | Mining, building, cutting, hauling, crafting | Small chance of a cut hand, a sprained ankle or (from hauling) a strained back. |
| **Food poisoning** | Eating rotting food (35%) or raw food (2%) | Iron stomach makes a colonist immune. |
| **Fire spread** | Any burning cell | Spreads to flammable neighbours (plants, wooden buildings, wood, cloth and food items). Rain douses it; dry weather fans it. Firefighting (priority 1 by default) handles fires near home or near anything a colony owns. Anyone standing in fire risks burns. |
| **Lightning** | Thunderstorm or dry lightning | Random strikes; any flammable cell can catch. Colonies within 25 cells get a warning letter. |
| **Death and mourning** | Any lethal condition | Everyone in the colony gets *Mourning* (−20 mood for 3–5 days). |
| **Crop freeze** | Outdoor crops below −6°C | The crops die. |
| **Spoilage** | Food above 0°C | Rots over its spoil time; cold rooms preserve it. |

## Health conditions

<!-- conditions:start -->
| Condition | Kind | How it behaves |
| --- | --- | --- |
| **Flu** | disease | severity +0.28/day vs immunity +0.42/day, lethal at 100%, contagious. Contagious. Usually beaten in two or three days, faster with bed rest. Can kill the weak. |
| **Stomach flu** | disease | severity +0.5/day vs immunity +0.8/day. Miserable but not dangerous. Doubles hunger for a day or so. |
| **Plague** | disease | severity +0.5/day vs immunity +0.44/day, lethal at 100%, contagious. Highly contagious and often fatal. Bed rest is the best chance of surviving it. |
| **Wasting cough** | disease | severity +0.12/day vs immunity +0.16/day. A slow lung sickness from the cold. Lingers for days but rarely kills. |
| **Sleeping sickness** | disease | lasts 48–84 h. Constant exhaustion for a few days. |
| **Food poisoning** | disease | lasts 8–16 h. From rotten or badly cooked food. Passes in under a day. |
| **Migraine** | disease | lasts 3–9 h. A pounding headache for a few hours. |
| **Sprained ankle** | injury | lasts 36–96 h. Hobbling for a few days. |
| **Cut hand** | injury | lasts 18–48 h. A clumsy slip. Work is slower until it heals. |
| **Burns** | injury | lasts 24–72 h. From fighting fires or standing in them. |
| **Strained back** | injury | lasts 24–60 h. Hauled too much. Slow and grumpy for a while. |
| **Cut** | injury | wound: stacks per hit, bleeds 4×severity/day until tended, pain ×1, heals 0.3/day once tended. From blades, arrows and claws. Bleeds until a doctor tends it. |
| **Gunshot wound** | injury | wound: stacks per hit, bleeds 6×severity/day until tended, pain ×1.2, heals 0.22/day once tended. Bleeds heavily until a doctor tends it. |
| **Bruises** | injury | wound: stacks per hit, pain ×1.1, heals 0.5/day once tended. From fists and clubs. Hurts, but does not bleed and heals by itself. |
| **Hypothermia** | exposure | builds from the environment, lethal at 100%. From staying out in the cold. Get warm or die. |
| **Heatstroke** | exposure | builds from the environment, lethal at 100%. From staying in the heat. Get to shade or a cool room. |
| **Malnutrition** | exposure | builds from the environment, lethal at 100%. From going without food. Fatal if it goes on too long. |
| **Blood loss** | exposure | builds from the environment, lethal at 100%. From untended wounds. Recovers slowly once the bleeding stops. Fatal at 100%. |
| **Sulking** | mental | lasts 6–14 h. Mental break. Refuses to work and mopes around. |
| **Dazed wandering** | mental | lasts 4–10 h. Mental break. Wanders aimlessly, ignoring work. |
| **Food binge** | mental | lasts 5–10 h. Mental break. Eats everything in sight. |
| **Hiding in bed** | mental | lasts 6–12 h. Mental break. Hides under the covers. |
| **Inspired** | buff | lasts 18–30 h. Struck by inspiration: works much faster for a day. |
| **Second wind** | buff | lasts 16–30 h. Boundless energy: barely needs sleep for a while. |
| **Mourning** | mood | lasts 72–120 h. A fellow colonist died. |
| **Festival spirit** | mood | lasts 24–36 h. Celebrated the festival. |
| **Gave to those in need** | mood | lasts 48–72 h. The colony helped strangers. |
| **Robbed** | mood | lasts 36–60 h. Someone stole from the colony. |
| **Betrayed** | mood | lasts 72–120 h. Someone the colony trusted turned on it. |
| **Awestruck** | mood | lasts 36–72 h. Witnessed something wondrous. |
| **Dread** | mood | lasts 24–48 h. Something is very wrong with the world. |
<!-- conditions:end -->

## Traits

Colonists roll 0–2 traits, with no conflicting pairs. Event-only traits come from specific visitors.

<!-- traits:start -->
| Trait | Effect |
| --- | --- |
| **Hardy** | Fights off disease and shrugs off the cold. |
| **Sickly** | Catches everything and recovers slowly. |
| **Fast walker** | Moves 20% faster. |
| **Slowpoke** | Moves 15% slower. |
| **Industrious** | Works 20% faster. |
| **Lazy** | Works 20% slower. |
| **Glutton** | Gets hungry 40% faster. |
| **Iron stomach** | Never gets food poisoning or stomach flu. |
| **Tireless** | Needs 25% less sleep. |
| **Sleepyhead** | Needs 30% more sleep. |
| **Optimist** | Always sees the bright side. |
| **Pessimist** | Always expects the worst. |
| **Volatile** | Snaps under stress much more easily. |
| **Steady nerves** | Rarely breaks down. |
| **Northerner** | Grew up in the cold. Tolerates it far better. |
| **Southerner** | Loves the heat, hates the cold. |
| **Child** (event only) | Too young for hard labour. Works at half speed. |
| **Pilgrim of the Center** (event only) | Walked out of the frozen heart of the world. Tireless, calm, and strange. |
<!-- traits:end -->

## Future events

These need systems that don't exist yet. They are listed so the content plan is complete and the systems get built with them in mind.

### Building on combat
Combat is in: drafting, weapons, wounds with bleeding and a doctor work type, and the `raid`, `night_raid` and `scout_party` threats above. Raids are sized from the colony's wealth and headcount (`raidPoints` in `packages/sim/src/raids.ts`), paid from its threat budget, arrive at the nearest map edge, and break once half the raiders are down. Still to come:
- **Raid variants:** sappers who dig or bash through walls (raiders can't open other factions' doors yet, so a fully walled colony only loses what lies outside), a siege camp, a raid during a blizzard.
- **Hunting** is deferred: there are no animals yet, so there is no `hunt` designation.
- **Loot and gear:** weapons are a pawn field, not items, so they can't be dropped, picked up or crafted yet. Downed pawns can't be carried to bed or taken prisoner.
- **Manhunter pack:** starving animals driven out of the cold.
- **Duel challenge** *(choice)*: an outsider demands single combat for a stockpile.
- **Feud:** a raider band targets whichever player wronged them before (needs reputation).
- **Player-versus-player:** "War party spotted", a warning letter when another player's drafted pawns approach your borders.

### Need animals
- **Herd migration:** caribou or musk oxen cross the map heading inward. Hunt them before winter.
- **Thrumbo sighting** *(rare)*: a huge, peaceful animal worth a fortune if you dare.
- **Animal self-tame**, **rabid animal**, and **ice wolves at night** (in winter only).

### Need the world map and the advancing winter front
- **The frost line advances:** a scheduled, inevitable event per region. The map's cold offset steps down and the season clock skips ahead.
- **Whiteout:** an outer-band map is lost to winter; any colony still there must caravan out or freeze.
- **Thaw corridor** *(rare)*: a temporary warm path opens toward the center.
- **Caravan ambush**, **lost in the snow**, and **frozen river crossing**, while travelling between maps.
- **Last train to the center** *(unique)*: one evacuation that every player hears about. Not everyone will make it.

### Need NPC settlements, jobs and reputation
- **Job board** *(choice)*: escort, delivery, bounty, rescue. Accept, complete, and get paid, or betray the client.
- **Trade caravan** with real bartering.
- **Plea for help:** a friendly settlement is under attack. Help, ignore, or loot it while it's distracted.
- **Double agent** *(choice)*: a faction asks you to spy on another player.
- **Ransom** *(choice)*: a colonist is captured; pay, rescue, or abandon them.
- **Blood debt:** an NPC you tricked returns with friends.
- **Peace summit** *(rare)*: all players invited; one may be an assassin.

### Need the center's hazards (still to be designed)
- **Pull of the Center** *(epic)*: colonists dream of the center; mood bonus if you move inward, penalty if you don't.
- **Something in the ice**: a thawing structure appears, a dungeon-like vault with guardians.
- **Inverted season:** near the center, winter events become summer ones. Hints at what lies there.
- **The Pilgrim's road** *(unique follow-up)*: if a pilgrim joined, they eventually offer to lead your caravan inward safely, once.
