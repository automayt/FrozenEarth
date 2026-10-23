# Fun: the world and discovery

Goal: make the map worth exploring, and make the move inward something to look forward to.

## Ranked changes (impact vs cost)

| # | Change | Impact | Cost | Why it's fun | Status |
|---|---|---|---|---|---|
| 1 | **Landmarks**: ruins, abandoned camps, cairn caches, frozen wrecks, hot springs and monoliths placed at map generation, hidden until someone sees them | High | Medium | The map stops being blank: there is always a "what's over there?" to send someone toward, and richer finds lie further in | Built |
| 2 | **Taming and pack animals**: tame deer, muskox (and hares as pets); tamed beasts graze at home, carry loads on a journey, and muskox pull sledges | High | Medium | Animals become companions with names and a story, and the journey gets the carrying capacity it was missing | Built |
| 3 | **Road finds**: on a journey the caravan finds tracks of game, a frozen traveller's pack, a stray pack beast that joins, a lost traveller who asks to come along, and thin ice that can give way | High | Low | The road becomes an adventure, not a progress bar; each trip tells a slightly different story | Built |
| 4 | **The frost as a set piece**: lakes that freeze into new routes are announced, the frost swallows unvisited landmarks (a race to reach them), hot springs steam on inside the frost | Medium | Low | The front becomes a visible, dramatic character that changes the map, and creates deadlines worth racing | Built |
| 5 | **Weather that matters on the road**: a blizzard catches the caravan (dig in or press on); an aurora night points the way to a hidden landmark, and monoliths hum under it | Medium | Low | Weather turns into decisions and rewards, not just a temperature number | Built |
| 6 | **Scouting from the journey planner**: landmarks near a planned route are listed, so where you settle next is chosen by what's there | Medium | Low | Choosing the next home becomes a real choice | Built (minimal) |
| 7 | Frost storm wall: a visible weather band riding the frost line (snow squalls, a white wall on screen) | Medium | Medium | Drama you can see from your base | Not built (render team area) |
| 8 | Animal breeding, herds that grow, milk/wool | Medium | High | A pastoral long game | Not built |
| 9 | A "scout" order: walk to a spot, look around, come home on your own | Low | Medium | Convenience; drafting and moving already does it | Not built |

## How it plays

- **Landmarks** are drawn only once one of your colonists has seen them (within about 14 cells) or you have heard of them. Spotting one sends a letter and puts a marker on your minimap. Walking up to it (2 cells) searches it, first come, first served:
  - *Abandoned camp*: food, cloth, sometimes a sledge or a bow, and often a scrawled map pointing at another landmark.
  - *Cairn cache*: a bundle of supplies.
  - *Old ruin*: building stone and metal, a line of lore, and sometimes a cellar: a letter asks whether to go down (better loot, or the floor gives way).
  - *Frozen wreck*: a letter asks whether to break into the hold: the richest loot on the map, but wolves may be denning inside, or the hull may collapse.
  - *Hot spring*: never used up. Warms the air around it even in deep frost, its water never freezes, and colonists who bathe there feel better.
  - *Monolith*: never used up. Awe, and the first time a colony touches one it learns where the landmarks around it are. Under an aurora it hums and inspires.
  - Richer landmarks are further in. Landmarks the frost reaches before anyone searched them are lost under the ice.
- **Taming**: mark an animal with the Tame tool or the Tame button. A colonist with Hunt work enabled walks up slowly (the animal holds still for them) and tries to win it over; social skill helps. A muskox that loses patience may charge. A tamed animal gets a name, grazes near home, follows the caravan, and adds carrying room (deer 45, muskox 90, and a muskox pulls a sledge on its own). If it dies, the colony's story remembers it.
- **Road finds** happen at most twice a trip, rolled at waypoints.
- **Ice bridges**: when most of a lake has frozen, colonies within reach hear that the ice will bear a caravan.
- **Blizzard on the road**: a letter: dig in (camp until it passes) or press on (each waypoint risks frostbite).

## Where it lives

- `packages/defs/src/landmarks.ts` (kinds, rings, counts), landmark buildings in `buildings.ts`, `tame`/`pack`/`draft` on `ANIMALS`, conditions `bathed` and `petted`.
- `packages/sim/src/landmarks.ts`: placement (own RNG stream, new worlds only), spotting/visiting, loot and lore, cellar and wreck letters, frost burial, hot spring warmth, aurora reveal.
- `packages/sim/src/taming.ts`: the Tame command, the `tame` job (Hunt work), tamed behaviour, pack capacity. `caravan.ts` takes pack animals along and asks about blizzards.
- `packages/sim/src/finds.ts`: road finds. `packages/sim/src/frontier.ts`: lakes freezing into crossings.
- Client: landmarks drawn only once known (`renderer.ts` drawLandmark, `textures.ts`), minimap rings, Inspect (landmark card with Send, Tame button, tamed animal card), Tame tool, journey planner (pack animals, landmarks along the route), barks from letters (`juice.ts`), moment banners.

## Balance knobs

| Knob | Where | Now |
|---|---|---|
| Landmarks per map | `CELLS_PER_LANDMARK` | one per 2800 cells (about 14 on 200x200) |
| Spot / search range | `SPOT_RANGE`, `VISIT_RANGE` | 14 / 2 cells |
| Loot tables, stacks | `LOOT` in landmarks.ts | 2-3 stacks, +1 in the inner half |
| Cellar fall / wreck wolves / hull collapse | landmarks.ts | 30% / 30% / 12% |
| Frost burial level | `BURY_AT` | 0.6 frost |
| Taming chance per try | `tame` on ANIMALS, `tameChance` | hare 0.3, deer 0.2, muskox 0.1, x(0.6 + 0.06 social) |
| Time between tries | `ATTEMPT_TICKS` | 400 ticks |
| Pack capacity | `pack`, `draft` | deer 45, muskox 90 + pulls a sledge |
| Road finds | `FIND_CHANCE`, `MAX_FINDS` | 9% a waypoint (x2.5 on ice), 2 a trip |
| Blizzard bite when pressing on | `STORM_BITE` | 12% a waypoint |
| Lake news | `MIN_LAKE`, `FROZEN_SHARE` | 60 cells, 70% frozen |
