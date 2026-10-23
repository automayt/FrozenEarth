# Fun: conflict and the towns

Fights, raids and the people around you, made more exciting and more rewarding.

## Ranked changes (impact against cost)

| # | Change | Impact | Cost | Why it's fun | Status |
|---|---|---|---|---|---|
| 1 | **Raider chiefs and "pay or fight" demands.** Bigger raids ride behind a named chief ("Corvin the Butcher"). Most stop at the map edge and send a letter: pay tribute, talk them down (your best Social colonist, odds shown), or fight. They wait while you decide. | High | Medium | A raid stops being weather and becomes a face and a decision, and the wait gives you a minute to draft and get behind cover. | Built |
| 2 | **Bring down the chief, break the band.** The chief is a little harder to put down and carries the band's purse; when the chief drops the whole band routs, and routed raiders throw down what they carried. | High | Low | One decisive target makes fights readable without micromanagement: focus the chief, win the day, collect the purse. | Built |
| 3 | **Prisoners are worth something.** A day after you take a raider prisoner, their band sends word: ransom them back for gold, hand them to a town you know for goodwill and a bounty, or keep them and hope they join. Chiefs fetch far more. | High | Low | Turns "downed raider" into a reward with a real choice between gold, friends and a recruit. | Built |
| 4 | **Town jobs beyond deliveries.** Towns that know you post work: clear a wolf pack that's taking their goats, or break up a bandit camp (with its own chief and the stolen goods lying in it). Reward from the town, goodwill, and a line in your story. | High | Medium | Gives a reason to march a squad out across the map, with a fight and a loot pile at the end. | Built |
| 5 | **Last stands and combat barks.** When one colonist is the only one still standing against two or more raiders, everyone hears about it, and if they live it goes in the colony's story ("Yara held alone against four raiders."). Colonists call out when they drop an enemy, rescue a friend or take a prisoner; the chief going down, a band talked off and a last stand each get a banner. | Medium | Low | The chronicle's best stories, made by the sim instead of left to chance. | Built |
| 5b | **Losing a fight hurts, it doesn't end the game.** Scouts slip away once they've put someone down; with nobody left standing, the raiders leave the fallen be, loot and go; when the fighting stops, the downed bind their own bleeding wounds. | High | Low | Early raids on an undrafted colony were wiping it out (everyone down, nobody to tend). A lost fight should cost goods and a week of bed rest, and leave a story. | Built |
| 6 | **Bands that remember you.** A chief who escapes comes back with a grudge and a bigger band; a chief you killed is avenged by a successor. A "known bands" list in Diplomacy shows who's out there and how strong. | Medium-high | Medium | Escalation you can see coming, and a nemesis. | Not built |
| 7 | **Escort a town's caravan** to a neighbour, with an ambush on the road. | High | High | A journey with stakes that isn't your own move. | Not built |
| 8 | **Hold their walls:** a town that hears a raid is coming asks you to garrison it, paying on the day. | Medium | Medium | Formalises the "help a town hold out" moment that already happens by chance. | Not built |
| 9 | **Raiders who surrender** mid-fight once the band breaks (drop weapons, wait to be taken). | Medium | Medium | More prisoners and fewer bodies, and a reason to stop shooting. | Not built |

## How each works

### 1. Chiefs and demands (`packages/sim/src/warband.ts`, `raids.ts`)

- Ordinary and sapper raids of three or more on a player colony get a chief: the best-armed raider, renamed "<first name> the <epithet>", in a duster, carrying the band's purse (gold). Chiefs take `CHIEF_HIDE` (70%) of the damage of each hit.
- `DEMAND_CHANCE` (60%) of those raids stop at the edge (`raid.parley`) and send a `raid_demand` letter for `DEMAND_HOURS` (3 h):
  - **Pay tribute:** goods worth `tribute()` (raid points × 1.2, never more than 60% of what's in your stockpiles), cheapest kinds first. Only offered when you have it.
  - **Talk them down:** your best Social colonist; chance `talkChance(social)` = 15% + 6% a level, at most 80%. Success: they leave. Failure: they come in at once.
  - **Fight** (the default if nobody answers).
- Attacking them while they wait is an answer too: the letter goes and they come in.

### 2. The chief falls (`warband.ts`)

- The chief downed or killed breaks the raid at once (`chiefFell`), naming whoever landed the blow, and the first time it's a milestone ("Brought down a raider chief").
- A routed band (chief down, or lost their nerve) drops what it carries with `ROUT_DROP` (60%) per raider.

### 3. Ransom (`warband.ts`)

- Prisoners taken from a band are marked `captive`; after `RANSOM_DELAY` (0.5–1 day) the band sends a `ransom` letter: ransom (gold), hand over to the friendliest town you know (goodwill and a bounty), or keep (the default). Chiefs are worth `CHIEF_RANSOM`.

### 4. Town jobs (`packages/sim/src/contracts.ts`)

- When a town asks a colony for help, `CONTRACT_CHANCE` (40%) of the time it posts a job instead of asking for goods: `wolves` (a pack of 3–4 near the town; 3 days) or `bandits` (a camp of 2–4 raiders with a chief and a stash of stolen goods; 4 days).
- Accepting spawns the targets. When none are left (dead, captured or fled), the town sends the reward to your colony and its goodwill rises; if time runs out first, goodwill drops and bandits move on.
- Bandits hold their camp (`goal: 'camp'`) and fight anyone who comes close.

### 5. Last stands and barks

- `reviewRaids` notices a lone defender among two or more colonists against two or more raiders (`raid.lastStand`), says so, and tells the story at the end if they're still alive.
- `render/juice.ts`: barks for downing an enemy, rescuing, capturing; `ui/Moments.tsx`: banners for a demand, the chief down, a band talked off, a last stand, a job done.

### 5b. Losing without dying (`warband.ts` stabilise, `raids.ts` reviewRaids)

- Scout raids (`raid.scout`) break off once any colonist is down.
- When nobody at a colony is standing, the raid stops fighting: it turns to looting (or leaves if there's nothing to take), and the downed bind their own wounds.
- Whenever a raid on a colony breaks or ends, downed colonists' untended bleeding wounds are bound at `SELF_TEND` (0.2) quality: they stop bleeding but still need a bed.
