# FrozenEarth

A browser-based, multiplayer colony sim in the spirit of RimWorld.

Winter is closing in on the world from the outside. Colonies start in the easier outer band, where the cold arrives first, and have to move inward toward the center. The center is harder to survive but is the last place to freeze. On the way there are friendly and hostile places: you can raid and loot, take jobs, help people, or trick them.

**Current build:** the colony-sim core on one shared map. 2–8 players each run their own faction at the same time. Combat and raids are in; the world map and the advancing winter front are next (see [Roadmap](#roadmap)).

## Play

Requires Node 22+.

```bash
npm install
npm run dev
```

Open http://localhost:5180 and pick a name. Open a second browser tab with a different name to play as a second faction.

### Hosting for friends

```bash
npm run build
npm start -- --world myworld --password hunter2
```

This serves the game and the websocket on one port (default 8090; change it with `--port` or `FE_PORT`). Friends join at `http://<your-ip>:8090` over LAN, a VPS, or a tunnel such as Tailscale or `cloudflared`. The world autosaves every minute, when the last player leaves, and when the server stops, to `saves/<world>/world.bin`.

Server options: `--world <name>`, `--port <n>`, `--password <pw>`, `--seed <n>`, `--size <cells>` (default 200), `--saves <dir>`.

The first player to join a new world is the host (admin). Rejoining with the same name in the same browser brings you back to your colony.

### Controls

| Input | Action |
| --- | --- |
| WASD / arrows, right- or middle-drag | Pan |
| Mouse wheel | Zoom |
| Left click | Select (pawn, building, item, plant or cell) |
| Left drag with a tool | Designate, build or zone a rectangle (walls are drawn as hollow rooms) |
| Left drag (no tool) | Box-select your colonists |
| R | Draft or undraft the selected colonists (everyone, if none is selected) |
| Right click (drafted colonists selected) | Move there; on another faction's pawn, attack it |
| Right click / Esc | Drop the tool, close menus, deselect |
| Space | Request pause |
| 1 / 2 / 3 | Vote for game speed |
| H | Jump to your colony |

**Shared time.** Everyone shares one clock. The game runs at the slowest speed anyone has voted for. Any player can pause, which uses their pause budget: 120 s at most, refilled by 60 s each in-game day. When it runs out, the game resumes. You can still give orders while paused. The game pauses itself when nobody is online.

## What's in

- **Map:** procedural (simplex noise). Soil, rich soil, sand, gravel, marsh, water, mountains with steel ore, forests, berry bushes.
- **Colonists:**
  - Needs: food, rest, mood with visible thoughts.
  - A RimWorld-style work-priority grid.
  - Reservations, so two pawns never grab the same thing, including pawns from different factions.
- **Orders:** mine, chop, cut, harvest, cancel, deconstruct.
- **Building:** blueprint, then material delivery, then construction. Walls, faction-locked doors, floors, beds, tables, chairs.
- **Stockpiles:** category filters and hauling. Items in another faction's stockpile are off-limits to your pawns.
- **Farming:** grow zones for rice, corn and potatoes. Growth depends on fertility, light and temperature, and crops freeze in winter.
- **Crafting:** benches with bills ("do X times", "until you have X", "forever"). Campfire and stove for cooking; crafting spot and workbench for crafting.
- **Rooms and temperature:** enclosed rooms are detected automatically. Room temperature drifts toward the outdoors, and heaters and coolers push it back. Food spoils unless kept cold.
- **Seasons and climate:** day/night and four seasons.
- **Storyteller events:** 60 random events over five rarity tiers, from common migraines to once-per-world wonders such as the Sun Shard. They include weather, disease outbreaks, fires, visitors who arrive as choice letters (some hiding secrets), contested loot between colonies, raids, and center-of-the-map mysteries. See [docs/EVENTS.md](docs/EVENTS.md).
- **Health and personality:**
  - Diseases that spread; a race between severity and immunity that bed rest helps you win.
  - Injuries, hypothermia, heatstroke, starvation and death.
  - 18 traits, mental breaks and inspirations.
- **Fire:** spreads through forests and wooden buildings, rain puts it out, and lightning starts it. Colonists fight fires near home.
- **Clothing:** tunics, parkas, dusters and hats from a tailor's bench. Colonists dress for the season, and a parka is the difference between life and death outdoors in winter.
- **Skills:** construction, mining, plants, cooking and crafting. Each colonist is good at something, and practice levels them up (0.6× to 1.4× speed).
- **Choose where to settle:** five suggested sites, or click anywhere. The outer band is easier now but freezes first.
- **Trading:** offer goods from your stockpiles to another player for theirs. They accept or decline by letter.
- **Alerts:** a list of what needs attention, such as freezing colonists, low food, fires, idle colonists and missing beds.
- **Combat:**
  - Draft colonists to take direct control, then right-click to move or attack. Drafted colonists fire on raiders in range by themselves. They never fire on another player's pawns unless you order it.
  - Weapons: knife, club, short bow and bolt rifle, plus fists. Each has range, damage, cooldown and accuracy. Weapons are items: the downed and the dead drop theirs, colonists pick one up on order (right-click it with a drafted colonist, or use the Equip list on the weapon), and the workbench makes them.
  - Line of sight: walls, doors and rock block shots, and a wall next to a target on the shooter's side halves the chance to hit.
  - Wounds: cuts, gunshots and bruises. Untended cuts and gunshots bleed into blood loss, which is fatal at 100%. Enough pain or blood loss knocks a pawn down. The Doctor work type carries downed colony-mates to a bed and dresses wounds to stop the bleeding, seeing patients in bed first, and brings meals to downed patients and bed-bound prisoners. Someone downed, or bleeding out within a day, is urgent: a doctor drops lower work for them whatever its priority, and a sleeping doctor is woken when death is only hours away and nobody else is up (priority 0 still means never).
  - Raids: raiders scaled to each colony's wealth arrive at the map edge, come for its colonists, loot if they can, and flee when half of them are down. There are also night raids, scouting parties and sapper raids.
  - Sieges: buildings have hit points. Raiders who can't walk to anyone smash the cheapest wall or door in the way; sappers also tunnel through rock. Colonists with Construction repair the damage.
  - Prisoners: capture a downed raider (the Capture button, or right-click with drafted colonists) and they are carried to a free bed and held. A prisoner may come round to joining the colony, or you can release them.
  - Hunting is deferred until there are animals.
- **Multiplayer and persistence:** chat, a player list with speed votes, reconnect, late join, persistent worlds.

## Architecture

```
packages/defs      data-driven content: terrain, items, plants, buildings, recipes, events
packages/sim       pure, deterministic simulation (no I/O): World, pathfinding, jobs, needs, storyteller
packages/protocol  message types, msgpack codec, client-side Mirror that applies deltas
apps/server        Node: tick loop, websocket sessions, time votes, persistence, serves the client
apps/client        Vite + PixiJS 8 renderer + React HUD
tools/bots         headless clients for load and sync testing
tools/art          how the sprites were generated with ComfyUI
```

- **Server-authoritative.** Only the server runs the sim. Clients send commands, and the server checks faction ownership on every one.
- **Deltas.** The server sends changes about 15 times a second as idempotent upserts. A client that joins late gets a full snapshot, then deltas.
- **Pawn movement.** Movement is sent as a timed path, which the client interpolates, instead of a position every tick.
- **Deterministic.** The sim uses a seeded RNG and never reads the wall clock. The same seed and command log give a byte-identical world, which is what makes save/load and replays reliable. A test enforces it.
- **Timing.** 60 ticks = 1 game-second at 1×, and one in-game hour is 1,250 ticks. An 8-colony, 40-colonist world costs about 0.05–0.12 ms per tick, and each client receives about 20 KB/s at 3× speed (compressed).
- **Winter hook.** `World.coldOffset` shifts the outdoor temperature. The future winter front will drive it per map.

## Testing

```bash
npm test             # sim, pathfinding, jobs, determinism, save/load, delta replication
npm run typecheck
npm run bots -- --bots 8 --minutes 2   # against a running server; checks all clients agree
npm run bench                          # sim cost per tick, snapshot size and delta bandwidth
```

## Roadmap

- [x] **M0:** monorepo, CI, tooling
- [x] **M1:** headless sim core (map generation, pathfinding, time, climate)
- [x] **M2:** netcode (snapshot + deltas, reconnect, late join)
- [x] **M3:** pawns, jobs, building, hauling, rooms
- [x] **M4:** farming, cooking and crafting bills, temperature, spoilage
- [x] **M5:** factions per player, speed vote and pause budget, chat, persistence
- [x] **M6:** storyteller and random events: 56 events, health conditions, traits, mental states, fire, choice letters
- [ ] **M7:** playtest polish (alerts, more UI, performance profiling, fog of war)
- [x] Choosing a start location in the lobby, and player-to-player trading
- [x] Performance pass: incremental connectivity and rooms, haul caching, leaner deltas, chunk culling
- [x] Combat: drafting, weapons, wounds and doctors, raids
- [x] Sappers and door-bashing, weapons as items, rescuing and capturing downed pawns
- [ ] Hunting (needs animals)
- [ ] World map: winter front advancing inward, harsher center, caravans between maps
- [ ] NPC settlements, jobs and quests, reputation (help, betray, trick)
