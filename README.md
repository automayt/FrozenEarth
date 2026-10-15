# FrozenEarth

A browser-based, multiplayer colony sim in the spirit of RimWorld.

Winter is closing in on the world from the outside. Colonies start in the easier outer band, where the cold arrives first, and have to move inward toward the center. The center is harder to survive but is the last place to freeze. On the way there are friendly and hostile places: you can raid and loot, take jobs, help people, or trick them.

**Current build:** the colony-sim core on one shared map. 2–8 players each run their own faction at the same time. The world map, the advancing winter front and combat are next (see [Roadmap](#roadmap)).

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
- **Storyteller events:** cold snap, heat wave, blight, eclipse, aurora, wanderer joins, cargo pods, stomach flu. Cargo pods land between colonies, and whoever hauls them first keeps them.
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
- **Timing.** 60 ticks = 1 game-second at 1×, and one in-game hour is 1,250 ticks. A 3×, 8-player world costs well under 1 ms per tick.
- **Winter hook.** `World.coldOffset` shifts the outdoor temperature. The future winter front will drive it per map.

## Testing

```bash
npm test             # sim, pathfinding, jobs, determinism, save/load, delta replication
npm run typecheck
npm run bots -- --bots 8 --minutes 2   # against a running server; checks all clients agree
```

## Roadmap

- [x] **M0:** monorepo, CI, tooling
- [x] **M1:** headless sim core (map generation, pathfinding, time, climate)
- [x] **M2:** netcode (snapshot + deltas, reconnect, late join)
- [x] **M3:** pawns, jobs, building, hauling, rooms
- [x] **M4:** farming, cooking and crafting bills, temperature, spoilage
- [x] **M5:** factions per player, speed vote and pause budget, chat, persistence
- [x] **M6:** storyteller and random events
- [ ] **M7:** playtest polish (alerts, more UI, performance profiling, fog of war)
- [ ] Choosing a start location in the lobby, and player-to-player trading
- [ ] Combat, health and injuries, raids, hunting
- [ ] World map: winter front advancing inward, harsher center, caravans between maps
- [ ] NPC settlements, jobs and quests, reputation (help, betray, trick)
