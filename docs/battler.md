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
     soon as both decks are picked. The winner gets both stakes; a draw, or a match called off before anything was
     played (in the deck pick or the draft), gives each their own back; a forfeit in the pit is a loss. Kept cards can't
     be staked, and an account under 24 hours old can't stake or win parts or packs (the same rule as trades). The
     moving of ownership is `server/src/wagers.rs` (the FRC Packs side); the Battler only says who won.
3. **Start.** Both pick a deck (kept private). The server freezes both decks, effects included, into the game. A short
   intro plays on both screens: versus, the two Alliance Captains (public, and they play every round), the decks
   shuffling, and a toss for who drafts first.
4. **Draft.** The 20 non-captain robots of both decks are shuffled into one pile. Players take turns: three robots are
   on offer, the player takes one, the other two go back into the pile. After 20 picks each player has a pool of 10
   robots (public, both can see it). Missing a pick takes the first robot offered (45 s, plus 8 s on the first pick for
   the intro); two misses call the game off.
5. **Each round (5).** Each player fields their Captain plus two robots **from their own pool** (the Bench), and draws 3
   support cards. In the Pit they can swap partners, attach Parts, play at most one Lore (it affects all six robots),
   and assign driver stations 1-3, then lock. Robots are face down to the other player until both lock, then flip.
   Last round's partners come back by default unless they're broken or low.
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

## Code

| Where | What |
| --- | --- |
| `server/src/battler/effects.rs` | Effects as data: operations, scopes, conditions, chances; validation; rules text generated from the data |
| `server/src/battler/engine.rs` | Resolves one round from the six robots, their parts, the lore and a seed. Pure |
| `server/src/battler/game.rs` | The game state machine (OPEN, DECKS, DRAFT, PIT, RESULTS, FINAL, CANCELLED), timeouts, what each player may see |
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
  or the other player's chosen partners until the round is revealed (`Game::view`, tested). The draft offer and both pools are public.
- **Provably fixed randomness.** Each game has one secret seed. Its SHA-256 is shown from the start; the seed is
  revealed when the game ends, so players can check nothing was re-rolled.
- **Deadlines without a background worker.** Any request applies passed deadlines: 5 minutes to pick decks (else called
  off), 45 seconds per draft pick, 5 minutes per pit (unlocked players are auto-locked with what they had; a second miss forfeits), 2 minutes on the
  results screen (then it moves on).
- **Ratings once.** The move to FINAL, both new ratings (conditioned on each player's game count) and the history lines
  are one transaction.
- **Wagers paid once.** Escrow happens in the same transaction as the game moving on; paying out is conditioned on the
  wager still being locked, and is retried whenever a finished game is looked at, so a stopped server can't lose or
  double a stake.

## Tests

```sh
cd server && cargo test --lib battler                       # rules, engine, state machine, cards (31 tests)
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
