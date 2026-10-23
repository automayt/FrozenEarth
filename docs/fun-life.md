# Fun: the colonists and the rhythm of play

What a headless 12-day run showed before this work: colonists never notice each other, nothing
personal ever happens, threats arrive without warning, and day 10 reads like day 3 (weather,
flu, a migraine, cargo pods). No raid and no mental break in 12 days for an idle colony. The
first in-game day is silent, then events are a flat random drip.

## Ranked changes (impact vs cost)

| # | Change | Impact | Cost | Why it's fun | Status |
|---|---|---|---|---|---|
| 1 | **Bonds**: colonists chat when near each other (bubbles you can see), opinions grow or sour with chemistry, traits and social skill; friends, rivals and lovers, with mood from each | High | Medium | Within minutes the people stop being units: "Yara and Bram keep sniping at each other" is a story you didn't script | Built |
| 2 | **Dramas**: rivals come to blows, friends fall in love, a death breaks a lover's heart, lovers have a child; a quarrel letter asks you to take a side; a feast trades food for goodwill | High | Medium | Real choices with a cost on both sides, and moments worth retelling in the Story | Built |
| 3 | **Omens**: most raids and the hard weather are foreshadowed by a letter hours before ("a trapper from Pinewick saw armed men camped a day's walk off") | High | Low | Dread and preparation instead of a coin flip: you wall up, draft, bring the caravan home | Built |
| 4 | **An opening arc**: each new colony gets a paced first week (a visitor, a squabble, a newcomer, scouts with a warning, a windfall, the first real raid foreshadowed), and the random drip is thinner meanwhile | High | Low | The first hour has a shape: calm, people, tension, a fight, relief | Built |
| 5 | **Traits that change behaviour, and a mind you can read**: Kind, Abrasive, Romantic, Night owl (sleeps by day, works by night); Southerners refuse outdoor work in a freeze; a warning letter naming what's weighing on someone before they break; volatile people with a rival pick a fight as their break; relief after a break | Medium-high | Low | Traits you see in play, and breaks you can see coming and head off | Built |
| 6 | Children grow up (a lost child or a newborn becomes an adult with a trait after ten days) | Medium | Low | Day 15 has people in it who weren't there on day 3 | Built |
| 7 | Mood memories from daily life (a fine meal, raw food again, slept in the cold, saw a corpse) | Medium | Medium | Small causes you can fix, so mood is something you manage | Not built |
| 8 | Aspirations (Yara wants a room of her own, to reach the center, to master cooking): fulfilled ones are a big mood boost and a Story line | Medium | Medium-high | Gives each colonist a goal the player can choose to serve | Not built |
| 9 | A mood glance on the colonists panel (who's near breaking, and why) | Medium | Low | Lets you act before the break letter | Not built |
| 10 | Later-game event pool (events with a maxDay or that need history: an old rival returns, a grave visited, a wedding) | Medium | Medium | Makes week three feel unlike week one | Not built |

## How it plays

- **Chatter.** Colonists within a few cells of each other now and then exchange a line; you see
  a speech bubble and the reply. A pair's *chemistry* is fixed per pair, so some people just get
  on and others never will. Kind people comfort the downcast; abrasive ones insult; low mood and
  a grudge make insults likelier; social skill makes chats warmer and grows with them.
- **Bonds.** Opinion ±100 each way. Both at 40 or more: friends ("Near a friend" +4). Either at
  -40 or less: rivals ("Has to put up with X" -5 when close). Both at 70 and a romantic moment:
  lovers ("In love with X" +8). Each bond is a letter and a Story line. Inspect shows them.
- **Dramas.** Rivals who trade insults may come to blows (punches fly, bruises, both sulk). A
  lover's death means heartbreak (a long, heavy mood), a friend's means grief on top of the
  mourning everyone feels. Lovers together a few days may have a child.
- **Choices.** *A quarrel*: side with one (they're vindicated, the other slighted and resentful)
  or let them sort it out (they make up, or fight). *A feast*: spend meals for everyone's mood
  and a warmer colony, or keep the food and disappoint whoever proposed it.
- **Omens.** Raids (most of them), night raids, sapper raids, cold snaps, blizzards, early
  frosts and plague send a warning letter first; the real thing follows hours later.
- **Opening.** Beats at fixed points in a new colony's first week, each a small event of a kind.
- **Minds.** When mood first dips toward a break, a letter names the three worst thoughts. After
  a break, relief. Southerners down tools outdoors in a freeze and go find somewhere warm.

Balance knobs live at the top of `packages/sim/src/social.ts` and `packages/sim/src/opening.ts`.
