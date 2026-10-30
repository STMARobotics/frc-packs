# The Battler

A 1v1, five-round card game played with the robots you own in FRC Packs, at `/battle.html`. It follows
`FRC_Card_Game_Implementation_Spec.md` (v1.1), with the decisions and gaps listed at the bottom.

## How a game goes

1. **Decks.** 1 Alliance Captain + 10 robots + 15 support cards (any mix of Part and Lore, up to 3 copies each, no
   team twice). Robots must be owned in FRC Packs; ownership is checked again when a deck is picked for a game.
2. **Finding a game.** Quick Play joins whoever has waited longest, or starts a game and waits in the queue (two
   players who queue at the same moment are paired). A private match is hosted for someone in particular: it's in no
   list, and the server only lets someone see or join it with its 6-character code (typed in, or in the invite link).
   One game at a time per player.
   - **Wagers** (private matches only). Before the match starts, each player can put up a stake: parts, sealed packs,
     cards (exact copies picked by the server, newest first), special editions, or a pink slip (one copy of every robot
     in the deck they bring). Both see both stakes, with a meter of how even they are (weighed like the trading post),
     and both must accept; changing either stake takes back both acceptances, and either player can call it off. Once
     both accept, both stakes leave the players' collections into escrow in one transaction, and the match starts as
     soon as both decks are picked. The winner gets both stakes; a draw or a called-off game gives each their own back.
     Forfeiting from the schedule onward is a loss. Kept cards can't
     be staked, and an account under 24 hours old can't stake or win parts or packs (the same rule as trades). The
     moving of ownership is `server/src/wagers.rs` (the FRC Packs side); the Battler only says who won.
3. **Start and schedule.** Both pick a deck. The server freezes both decks, effects included, into the game. The first
   game screen is the complete five-match schedule: both alliances' robots, projected points and estimated win chances.
   Each player's ten non-captain robots are shuffled separately into five pairs; each plays exactly once, alongside
   that player's Captain. A robot always stays with the player who brought it, including when both decks contain the
   same team. There is no drafting. The schedule is fixed by the game's secret seed, stored with the game and public
   to both players. It stays available through Schedule during the game.
4. **Ready up.** Both players acknowledge the schedule before match 1 begins or any support cards are drawn. Once
   the schedule is shown, leaving counts as a forfeit: the opponent wins, ratings change and any wager goes to the
   winner. If only one player readies up before the two-minute deadline, that player wins by timeout. If neither
   player readies up, the game is called off and any wager is returned.
5. **Each match (5).** Each player fields their scheduled Captain and two partners, and draws 3 support cards. Partners
   cannot be swapped. In the Pit they can attach Parts, play at most one Lore (it affects all six robots), and assign
   driver stations 1-3, then lock. Scheduled robot identities are public; station order and support choices remain
   private until both lock. During card play, both players see the opponent's robot cards face up in schedule order
   and can tap them to inspect their stats and effects. The reveal shows actual stations and support cards, then scores
   the match.
6. **Batteries.** Every pooled robot starts at 100%. A robot that plays loses 30%; one on the bench gains 25%. Below 50%
   it plays at 85% of its stats, below 25% at 65%. Each round a fielded robot can break down (4% when fresh, up to ~19%
   at 0%): it scores nothing in End, then sits out a round being repaired and returns at 60%. A broken robot can't be
   picked. The Captain never runs down or breaks.
7. **Scoring.** Auto, Tele and End are summed per alliance (battery power, robot effects, then parts, then lore; flat
   points, then percent, then multipliers, rounded half up, never below 0). Win = 3 RP, tie = 1 each. Each robot rolls
   once for +1 RP at its station's RP chance. The reveal plays Auto as five one-second ticks per robot (each about a
   fifth of the points, up to 10% off, always summing to the real total), then Tele and End.
8. **End.** Most RP wins, then most points, else a draw. Elo (start 1000, K 32) changes once per game.

Played cards are used up only for that game; nothing is ever taken from the FRC Packs collection.

The home screen shows a scrollable list of the 25 highest-rated players by Elo, with their win/loss/draw records.
Players enter after their first rated game; equal Elo shares a rank, with usernames ordering tied rows. Disabled accounts are excluded.
The list reads existing ratings, so players who played before the leaderboard was added are included automatically.

## Code

| Where | What |
| --- | --- |
| `server/src/battler/effects.rs` | Effects as data: operations, scopes, conditions, chances; validation; rules text generated from the data |
| `server/src/battler/engine.rs` | Resolves one round from the six robots, their parts, the lore and a seed. Pure |
| `server/src/battler/game.rs` | The game state machine (OPEN, DECKS, SCHEDULE, PIT, RESULTS, FINAL, CANCELLED), fixed schedule, predictions, timeouts, what each player may see |
| `server/src/battler/content.rs` | Robot cards from the pack recipe (stats from `bt`, or test stats), Part/Lore cards from `data/battler/support-2026.json` |
| `server/src/battler/api.rs` | `/api/battler/*`: decks, lobby, games, history, admin effects. Storage layout is in `docs/dynamodb.md` |
| `web/battle.html`, `web/src/battler/` | The page (Preact): `main.tsx` routes the screens in `screens/`; `game/` is a game from the lobby to the final (`state.ts` applies taps at once and sends them in order, `arena.tsx` the match, `reveal.ts` the reveal timeline); `battler.css` is the look |
| `tools/battler_stats.py` | Imports robot stats from Statbotics (spec §4) |

## Keeping it fair

- **The server decides everything.** The browser sends taps (attach this part, lock); shuffles, rolls, scores and
  ratings only happen on the server.
- **One change at a time.** Every action carries the game version the player saw and is written back on condition the
  game hasn't changed (`ver`), so double taps, two tabs or scripts can't apply anything twice or act on stale state.
- **Hidden information stays hidden.** A player's view never contains the opponent's hand, draw pile, pending pit plan
  or station choices until the round is revealed (`Game::view`, tested). Both scheduled alliances and deck robot pools are public.
- **Provably fixed randomness.** Each game has one secret seed. Its SHA-256 is shown from the start; the seed is
  revealed when the game ends, so players can check nothing was re-rolled.
- **Deadlines without a background worker.** Any request applies passed deadlines: 5 minutes to pick decks (else called
  off), 2 minutes to ready up (an unready player loses to a ready opponent), 5 minutes per pit (unlocked players are auto-locked with what they had; a second miss forfeits), 2 minutes on the
  results screen (then it moves on).
- **Ratings once.** The move to FINAL, both new ratings (conditioned on each player's game count) and the history lines
  are one transaction.
- **Wagers paid once.** Escrow happens in the same transaction as the game moving on; paying out is conditioned on the
  wager still being locked, and is retried whenever a finished game is looked at, so a stopped server can't lose or
  double a stake.

## Schedule predictions

Each scheduled alliance's projected points sum its three robots' nonnegative AUTO, TELE and END stats. The win estimate
uses a logistic score margin, following the shape of [Statbotics' EPA model](https://github.com/avgupta456/statbotics/blob/master/backend/src/models/epa/main.py):
`spread = max(1, 0.1 * (red_points + blue_points))`, then
`red_chance = 1 / (1 + 10^(-(red_points - blue_points) / spread))`; blue is the complement.

The spread is 20% of the mean alliance score. This is a provisional Battler estimate, not Statbotics' calibrated
season model or a live Statbotics prediction. It intentionally uses only public base stats, never support hands,
station choices, the secret seed or the actual future match rolls. Equal scores give 50/50, swapping alliances swaps
the estimates, and the two displayed percentages add to 100%. Effects, Parts, Lore and breakdowns can change the
result. Matches using fallback robot stats are explicitly labeled as provisional.

Old games still at the draft are upgraded to schedules on their next request, restoring robots to their original
owners. Games already in the pit continue under their original rules; newly started games always use schedules.

## Tests

```sh
cd server && cargo test --lib battler                       # rules, engine, schedule, state machine, cards
cd web && node test/battler-api.cjs                          # two players, a whole game through the API (needs DEV_TOOLS=1)
cd web && node test/battler-ui.cjs                           # two phones play a whole game by tapping, with screenshots
cd web && node test/wager.cjs                                # wagers: stakes, escrow, called off (returned), forfeit (settled)
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
- **"Their lore"** (October 2026): the empty "Their lore" placeholder is gone; if the other player plays a Lore it
  appears face down as a count in their bar and flips at the reveal. Battery numbers (30 / 25 / 60, break chance) are
  first guesses to tune.
- **Robot avatars** show the team number; there are no TBA avatars in the repo yet.
- **Only the 2026 set** exists (the cmp26 pack). 2025 robots would need a 2025 pack recipe.
- **Production routing.** The page is served as `/battle.html`, which needs no CloudFront change.
