# Next phase: game feel and fun

No endgame for now. This phase makes FrozenEarth feel like a game and makes the minutes in it more fun.

## 1. A HUD that feels like a game, not a website

The HUD is the colony's field kit: felt, brass, ink and firelight. No navbar and no glass cards.

**Palette**

| Name | Hex | Use |
|---|---|---|
| Woad | `#1c2331` | Wool felt: the body of every panel |
| Soot | `#11151d` | Wells, insets, inputs |
| Tallow | `#eadfc8` | Text |
| Ember | `#ff9a3c` | Warmth: anything you can act on, and what's active |
| Rime | `#c3e4f3` | The cold: frost and temperature information only |
| Brass | `#c9a45c` | Frames and fittings |
| Lichen / Blood | `#a3c46b` / `#e0614b` | Good / bad |

The colour logic is part of the game: ember means "you can do something", rime means "the cold is coming".

**Type**

- **Grenze** for titles and big numerals: a gritty frontier face between a serif and blackletter.
- **Signika** for everything small: built for signage, legible at 11–13 px.
- Sentence case everywhere. No tracked all-caps labels.

**Materials**

- Panels are cut felt: corners chamfered rather than rounded, a brass hairline inside the edge, a faint wool texture, and a real drop shadow.
- Buttons are tactile: raised bevels that press in. Ember lights the active one.
- Commands are icons first, words second, with the hotkey engraved on the slot.

**Layout**

```
 (frost dial)                                       [pennants]  [speed clasp]
 conditions                                                       [ map    ]
 [tips / journal]                                                 [ alerts ]
 [letters      ]
                                [ selection card ]
 [chat]             [ command bar: icon slots | squad | panels ]
```

Clusters anchor to the corners. Nothing spans the full width.

**The one bold thing** is the frost dial: a brass ring with ice creeping round it as the frost nears, and the season and day in big numerals. Everything else stays quiet.

**Motion** only answers the player: buttons press, letters unfold, the dial's ice advances when a day turns.

## 2. Juice: the game answers back

- **Colonists speak:** short barks over their heads at moments that matter ("Finally, a bed.", "Wolves!", "So cold…").
- **Gains float up:** "+40 wood" rises from the tree that was felled; "+12 goodwill" from the town you traded with.
- **Big moments have weight:** a raid arriving, an alliance sworn and a caravan arriving each get a sound sting and a brief camera nudge toward where it happened.

## 3. Your colony's story

- **A chronicle:** a page of the moments worth retelling ("Day 12: Yara held the gate alone against four raiders."). Shareable, and good for bragging between friends.
- **Milestones:** first winter survived, first alliance, a journey completed. Each gets a short fanfare.

## 4. Fun tuning

- Early-game pacing: when the first threats and first visitors arrive.
- Event variety: so day 10 doesn't feel like day 3.
- Every system should pay off in something you can see or feel within a minute of using it.
