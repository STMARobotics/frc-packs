# The Battler

A 1v1, five-round card game played with the robots you own in FRC Packs, at `/battle.html`. It follows
`FRC_Card_Game_Implementation_Spec.md` (v1.1), with the decisions and gaps listed at the bottom.

## How a game goes

1. **Decks.** 1 Alliance Captain + 10 robots + 15 support cards (any mix of Part and Lore, up to 3 copies each, no
   team twice). Robots must be owned in FRC Packs; ownership is checked again when a deck is picked for a game.
2. **Lobby.** Host a game (or share its invite link); one other player joins. One game at a time per player.
3. **Start.** Both pick a deck (kept private). The server freezes both decks, effects included, into the game, shuffles
   the 20 non-captain robots into one shared Alliance Deck and each player's 15 support cards into their own pile.
4. **Each round (5).** Each player fields their Captain plus two robots dealt from the shared deck and draws 3 support
   cards. In the Pit they attach Parts to their robots, play at most one Lore (it affects all six robots), and assign
   driver stations 1-3, then lock. Hidden until both lock.
5. **Scoring.** Auto, Tele and End are summed per alliance (robot effects, then parts, then lore; flat points, then
   percent, then multipliers, rounded half up, never below 0). Win = 3 RP, tie = 1 each. Each robot rolls once for
   +1 RP at its station's RP chance.
6. **End.** Most RP wins, then most points, else a draw. Elo (start 1000, K 32) changes once per game.

Played cards are used up only for that game; nothing is ever taken from the FRC Packs collection.

## Code

| Where | What |
| --- | --- |
| `server/src/battler/effects.rs` | Effects as data: operations, scopes, conditions, chances; validation; rules text generated from the data |
| `server/src/battler/engine.rs` | Resolves one round from the six robots, their parts, the lore and a seed. Pure |
| `server/src/battler/game.rs` | The game state machine (OPEN, DECKS, PIT, RESULTS, FINAL, CANCELLED), timeouts, what each player may see |
| `server/src/battler/content.rs` | Robot cards from the pack recipe (stats from `bt`, or test stats), Part/Lore cards from `data/battler/support-2026.json` |
| `server/src/battler/api.rs` | `/api/battler/*`: decks, lobby, games, history, admin effects. Storage layout is in `docs/dynamodb.md` |
| `web/battle.html`, `web/src/battle.ts`, `web/src/battle.css` | The page |
| `tools/battler_stats.py` | Imports robot stats from Statbotics (spec §4) |

## Keeping it fair

- **The server decides everything.** The browser sends taps (attach this part, lock); shuffles, rolls, scores and
  ratings only happen on the server.
- **One change at a time.** Every action carries the game version the player saw and is written back on condition the
  game hasn't changed (`ver`), so double taps, two tabs or scripts can't apply anything twice or act on stale state.
- **Hidden information stays hidden.** A player's view never contains the opponent's hand, draw pile, pending pit plan
  or the undealt Alliance Deck (`Game::view`, tested).
- **Provably fixed randomness.** Each game has one secret seed. Its SHA-256 is shown from the start; the seed is
  revealed when the game ends, so players can check nothing was re-rolled.
- **Deadlines without a background worker.** Any request applies passed deadlines: 5 minutes to pick decks (else called
  off), 5 minutes per pit (unlocked players are auto-locked with what they had; a second miss forfeits), 2 minutes on the
  results screen (then it moves on).
- **Ratings once.** The move to FINAL, both new ratings (conditioned on each player's game count) and the history lines
  are one transaction.

## Tests

```sh
cd server && cargo test --lib battler                       # rules, engine, state machine, cards (24 tests)
cd web && node test/battler-api.cjs                          # two players, a whole game through the API (needs DEV_TOOLS=1)
cd web && node test/battler-ui.cjs                           # two phones play a whole game by tapping, with screenshots
```

## Decisions and gaps (October 2026)

- **Lives inside FRC Packs** (same server, database and accounts) rather than as a separate app, and signs in with the
  FRC Packs account. Google Workspace SSO (spec §2.1) is not built.
- **Part and Lore cards** are a starter set of drafts (24 parts, 8 lore) in `data/battler/support-2026.json`, and every
  player gets 3 copies of each for free until they can be pulled from packs. They're edited in that file; the admin page
  only edits robot effects so far.
- **Robot effects** are written and published by an admin on the page (`#admin`). Robots without one play with no
  effect. Four example effects in the support file are labelled "Test effect" in game.
- **Robot stats** use clearly marked test stats (from Champs EPA) until `tools/battler_stats.py` can reach Statbotics;
  rerun it and `tools/build_packs.py` to replace them.
- **Robot avatars** show the team number; there are no TBA avatars in the repo yet.
- **Only the 2026 set** exists (the cmp26 pack). 2025 robots would need a 2025 pack recipe.
- **Production routing.** The page is served as `/battle.html`, which needs no CloudFront change.
