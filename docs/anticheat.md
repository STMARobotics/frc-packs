# Tripwire: the FRC Packs anticheat (v2)

Code and data use the neutral word `anticheat`; the name players and admins see is one constant
(`ANTICHEAT_NAME` in `server/src/anticheat/mod.rs`), so renaming it is a one-line change.

Planned Nov 4 2026 from an overnight pen test and RNG study, built Nov 4–5 on the `anticheat-v2` branch. Everything was
run locally (DynamoDB Local in WSL, the real router, `DEV_TOOLS` off). Nothing has touched the live site.

## Status

**Built** (all tests pass: 64 unit, 69 API, 21 of 21 pen test attacks; the ledger audit balances after every attack):

| | What | Where |
|---|---|---|
| Prevent | Picking up a pack opens it; no Back button; `/api/hand` is gone; old held packs give their serials back | `api.rs` `open()`, `open.tsx` |
| Prevent | Mythic packs removed (server, web, textures) | everywhere |
| Prevent | Wagers count toward the daily trade limits, and winnings are recorded as intake | `wagers.rs`, `battler/api.rs` |
| Prevent | Accounts under 24 hours can't give cards (trades or stakes); they can still receive | `trades.rs`, `wagers.rs` |
| Prevent | Admin pack gifting removed | `admin.rs` |
| Prevent | **Intake alarm**: over 30 packs in an hour flags the player in the same write (runs inside `save_pack`, so no source can skip it); over 60 pauses their trading whatever the settings say | `anticheat/mod.rs` |
| Prevent | **Shadow flags** (on by default): a flagged player notices nothing, and every trade and wager they make goes on a watch log. Turn them off in the suite's Settings, or set shadow or paused per player | `anticheat/mod.rs` |
| Prevent | **Canaries**: `/api/hand` and `/api/craft/mythic` are retired but still listen; every call is logged (who, from where, when) and shows in the scan | `anticheat/mod.rs` |
| Record | Openings keep their pity meter and Mythic count; sessions and sign-ups keep the visitor address; wagers keep lock time, finish time and how they ended; every settings save is kept as history | `model.rs`, `accounts.rs`, `wagers.rs`, `admin.rs` |
| Detect | Supply, luck, funnel, thrown wagers, pacing and canaries, on demand from the admin panel | `anticheat/detect.rs` |
| Respond | The **Tripwire suite**, a tab of the admin panel with its own tabs: **Overview** (numbers at a glance), **Scan** (ranked suspects with evidence), **Watchlist** (every flagged player, their mode, what they've done since), **Canaries**, **Actions** (every flag, clear, reversal and settings change) and **Settings** (shadow flags). Per player: shadow flag, pause trading, clear, disable (the existing ban), reverse a time window (preview, then apply) | `anticheat/respond.rs`, `web/src/tripwire.ts` |

**Not built yet:**
- **Nightly scan.** The scan runs when an admin presses "Run Tripwire". Scheduling it means a CDK change (an EventBridge
  rule), which needs a maintainer's review.
- **Incremental scan.** Each run reads the whole table. That costs fractions of a cent at today's size; past tens of
  thousands of players it should read only the ledger since the last run.
- **Sign-in limits in DynamoDB** (1.7) and **battler rating rules** (1.8).
- **Funnel and thrown-wager checks have no automated tests yet.** Supply, luck, the intake alarm, flag, clear and
  reverse do.
- **Timer claims are checked from the first settings save onward.** Before that there's no record of what the timer
  paid. Save the settings once after deploying (even unchanged) to start the history.
- **Luck only scores openings made after this ships.** Older openings didn't record their odds or their rarities at
  the time, so they're never scored. That's on purpose: it avoids false flags.

---

## Is a rewrite needed?

**No.** Keep the core and build on top of it.

The core is the write path: one versioned transaction per change, conditional deletes, idempotency keys, and a ledger
line for everything that moves. It held all 14 integrity attacks in the pen test (races, dupes, replays, tampering).
Rewriting it would add risk and fix nothing.

What failed is two things the core was never built for:

1. **Game rules that pay twice.** The pack-in-hand system lets the pity meter and the first-pack promise pay on two
   packs.
2. **Value moving between accounts.** Wagers skip the trade caps, and brand-new alts can pass cards on.

The old anticheat is the admin ledger audit. It proves the books balance, so it can't see either problem: after every
exploit had run, it still reported 0 mismatches.

v2 is four layers. The first fixes the rules; the other three are new.

| Layer | Job | Before v2 |
|---|---|---|
| **1. Prevent** | Rules that can't be broken, enforced in the write | Solid core, 6 rule holes |
| **2. Record** | Store what review needs (meter at open, who's linked to whom) | Ledger only |
| **3. Detect** | Scoring: supply, luck, value flows, thrown wagers, bots | Integrity audit only |
| **4. Respond** | Flag, ban, reverse, all from the admin panel | Manual `disabled` flag |

---

## Decisions made

- **Picking up a pack opens it.** If you back out halfway, the reveal resumes next time (the server already does
  this). The Back button in the hold screen goes away. Like Siege packs.
- **No trading of peeked packs.** Sealed packs keep trading as counts, and their cards are decided when they're opened.
- **Mythic packs are removed from the game.** Nobody owns one, so no migration is needed.
- **No per-pack seeds.** Storing a seed saves about 5¢ a month per million packs; DynamoDB bills writes in 1 KB chunks
  either way. A seed would also lock the roll code forever: any change to the code or the odds would change every
  unopened pack.

- **Wagers count toward the daily trade caps**, and **accounts under 24 hours old can't give cards away** (built as
  planned; easy to loosen if they get in the way).
- **The name is Tripwire.** The check inside it that used to be called the "intake tripwire" is now the **intake alarm**.
- **Shadow flags by default.** A flag is silent: the player keeps playing and trading, and Tripwire watches. They never
  learn which signal caught them, so they can't work around it. The one exception is a big dupe (over 60 packs in an
  hour): that pauses trading at once, because stopping the spread matters more than staying hidden.
- **Canaries never act on their own.** Right after an update, an app left open since before it can call a retired
  endpoint too, so a canary call scores low (25, or 45 for ten or more) and only points an admin at the player.

---

## Layer 1: Prevent

### 1.1 Picking up a pack opens it (closes holes 1, 2, 3, 6)

The roll happens at open, with the meter as it is right then, and the meter moves in the same write. With no pack held
between pick-up and open, the double-dip, the hold-back and the double first-pack promise can't happen.

**Server**
- Remove `POST /api/hand` and `hand()` in `api.rs`.
- `open()`: drop the held-pack branch (`HAND#`, `keeps()`, `valid_cards` for held packs).
  - Every open rolls fresh with the current meter.
  - The `fresh` mutex stays, so a retried write still gives the same cards.
  - When deploying: if a legacy `HAND#` item exists, release its serials (`release_held`) and delete it in the same
    write. That way a hand picked up before the deploy can't carry the exploit over.
- `roll.rs`: delete `promised()` and `keeps()`. The pity rules themselves (soft/hard meter, Legendary every 20, the
  first pack) stay as they are.

**Web** (`web/src/site/screens/open.tsx`)
- `pickUp()` calls `api.open` (through `startOpen`) instead of `api.hand`.
  - The answer carries the cards, so the glow, photo preloading and pre-drawing all still work.
  - It also carries the state, which updates the pack counts.
- `HoldButtons`: remove **Back**. Controller **B** in the hold screen does nothing. Leaving the screen any other way
  leaves the pack pending, and the Open tab resumes it.
- The swipe still tears the pack, but it's only the animation now; the server already opened it.
- Remove `api.hand` from `api.ts`.

**Tests**
- `server/tests/api.rs`: rewrite the hand tests.
  - Delete: `pack_in_hand_is_fixed_and_opens_as_promised`, `picking_up_mints_the_pack_and_it_opens_as_minted`,
    `a_pack_in_hand_from_before_minting_still_opens`, `a_pack_rolled_again_gives_its_serials_back`,
    `a_mythic_pack_is_minted_at_pick_up`, `a_tampered_hand_is_rerolled`.
  - Add `the_hand_endpoint_is_gone` (404) and `a_legacy_hand_is_released_on_open` (its serials go back, and the
    opened cards come from a fresh roll).
- `server/tests/pentest.rs`: rewrite the four hand attacks to go through the open-only flow. They stay in as
  regression tests and should now pass.

### 1.2 Remove Mythic packs

- **Server:** delete
  - `craft_mythic`, the `/craft/mythic` route, `MYTHIC_PACK_COST` and `MYTHIC_PACKS_ON`
  - `PackReq.mythic` and `Opts.mythic` (plus the "three Mythics" branch in `roll::draw`)
  - `PackRow.mythic` and every `- row.mythic` in `pack_kind`, `trades::has_goods`, `wagers::check` and
    `wagers::escrow`
  - the profile and state fields that report it
- **Testkit:** remove `set_mythic_packs`.
- **Web:** remove
  - the `myth` kind, `SKIES.myth` and the `myth` entries in `counts` and `flags` (`open.tsx`)
  - the craft button (`workshop.tsx`) and `api.craftMythic`
  - the mentions in `trade.tsx`, `gate.tsx` and `battler/game/wager.tsx`
  - the Mythic pack texture (`gl/pack.ts`, `web/public/gl/pack-myth.webp`), plus `preview/mock.ts` and `style.css`
- **Tests:** remove `mythic_packs_hold_three_different_mythics` (`roll.rs`) and the Mythic-pack API test.
- Mythic *cards* are untouched.

### 1.3 Wagers share the trade caps (closes hole 4)

- `accept_wager`: before locking, refuse if either player would take in more packs or parts than the daily cap allows.
  Use `trades::over_daily` (make it `pub(crate)`). Error codes `their_trade_limit` and `trade_limit`, same as trades.
- `wagers::settle`: record what each player receives with `take_in`.
- `wagers::check`: cap a stake at `trades::MAX_PACKS` and `MAX_PARTS`.
- Pen test `a_thrown_wager_cannot_move_more_than_a_trade` should then pass.

### 1.4 New accounts can't give cards (closes hole 5)

- Trades (`offer` and `accept`) and wager stakes: if the giver is under 24 hours old (`too_new`), refuse with
  `too_new` for any cards on their side. Receiving is still allowed.
- Pen test `new_alts_can_pass_their_first_legendary_on_at_once` should then pass.

### 1.5 Admin pack gifting is gone (done)

`POST /api/admin/users/{id}/packs` and the "Give packs" row in the admin panel are removed, and the
`admins_cannot_give_packs` test checks that the route stays gone. Every pack now comes from a rule the game enforces,
which is what makes the supply check (3.1) exact. Old `admin gift` ledger lines stay as history.

### 1.6 Intake alarm (in the write)

If a duped pack can be traded, it can spread within an hour, so a nightly job finds it too late. Add one cheap check to
the writes that add packs (claim, craft, open's streak and set bonus, feedback reward, trade and wager settlement):

- The profile already keeps a 24-hour `intake` list for trades. Extend it to record every pack that comes in, with its
  reason.
- If the last hour's intake goes over **30 packs**, set `flagged` in the same write. Trades and wagers pause; opening
  still works. The admin tab shows the account at the top.
- Legitimate play tops out far below 30 an hour: a banked timer is 2, a streak is 1, all 8 division bonuses at once
  is 8, a full day of trade intake is 10, and crafting is limited by parts.
- The check costs nothing extra: the list is on the profile, which every one of these writes already reads and writes.

### 1.7 Sign-in limits in DynamoDB

- `accounts::Limiter`: keep counts in `LIMIT#<key>` items, incremented atomically (`db.bump`), with a 15-minute TTL.
- Keep the in-memory map as a fast first check.
- Today every Lambda instance keeps its own counts, so guesses spread across instances get extra tries.

### 1.8 Battler ratings

- A forfeit before the first pit is scored changes no ratings.
- Playing the same opponent again within 24 hours changes no ratings.
- This stops Elo farming with an alt.

---

## Layer 2: Record

Detection needs facts the ledger doesn't keep. These are all small additions to writes that already happen:

| What | Where | Why |
|---|---|---|
| Meter before the open (`pity_m`, `pity_l`), kind, opened-count | `Opening` item | Luck can be computed from the roll's real odds |
| Visitor (the CloudFront IP) and user agent | session item, and on the profile at sign-up | Link alts |
| Invite code | already on the profile (`invite_code`) | Link alts that share one code |
| `locked_at`, `finished_at`, end reason, stake value | `Wager` item | Find thrown matches |
| Per-minute counts of opens, crafts and claims | the day item (`Day.counts`, by minute bucket) | Bot pacing |

The `anticheat` module also gets a value table: each tier's worth in parts (the scrap values), a pack worth 250, and a
boosted pack worth 500. That gives every card, pack and part one common unit for comparing flows.

---

## Layer 3: Detect

A new module, `server/src/anticheat/`. It runs nightly (an EventBridge rule on the existing Lambda, like the
ready-check) and on demand from the admin panel. It writes `AC#SUSPECT#<user>` items with a score, the evidence, and a
30-day TTL.

| Check | Signal | Flag when |
|---|---|---|
| **Luck** | Mythics and Legendaries vs. what each opening's kind and meter predicted (exact tail probability) | p < 1e-5 over 7 days, or p < 1e-7 over all time |
| **Funnel** | Net value between account pairs (trades, wagers, specials), in parts | One-way flow over 20,000 parts in 7 days, or any flow inside a cluster of accounts that share an invite code or visitor |
| **Thrown wager** | Goods staked, then a forfeit or timeout within 2 minutes of locking | Once with more than 2,000 parts staked, or 3 times between the same pair |
| **Pacing** | Requests per minute, hours with no gaps | Over 30 opens a minute, or activity in 20+ of 24 hours |
| **Integrity** | The current `audit_all` (ledger vs. holdings, serials, stale offers) moves in here unchanged | Any mismatch |
| **Supply** | Packs in, by reason, against the most that reason can pay (3.1) | Anything over the ceiling |

### 3.1 Supply check

Packs have no IDs: they're counts, and cards are minted when a pack is opened. A duped pack therefore looks exactly
like a real one and opens into real cards with real serials, so the serial and luck checks can't see it. The ledger
can see it, but only if the dupe skipped writing a ledger line. A bug that pays packs *through* a normal code path
writes a correct-looking line, and the books still balance.

The supply check asks a different question: was the source *allowed* to make this pack? With admin gifting gone, every
pack has one of these sources, and each has a hard ceiling:

| Ledger reason | Ceiling per player |
|---|---|
| `new account` | `start_packs`, once |
| `claim` | timers elapsed since the account was made × packs per timer, with the bank cap applied (computed from the claim lines' own timestamps) |
| `open, streak` | 1 per streak milestone, at most 1 a day |
| set bonus (`open` / `trade` with a `SET#` record) | 1 per finished division, 8 for life |
| `craft` | equal to the parts the same transaction spent ÷ the cost |
| `feedback reward` | 1 per feedback item stamped `rewarded` |
| `trade <id>` / `wager <id>` in | equal to the other player's matching "out" line with the same ID |
| `dev tools` | 0 in production (dev tools are off there); any such line is flagged |

(A rarity change pays parts, not packs, so it isn't in this table.)

**Global check:** sealed + opened + in escrow, across all players, must equal the total minted by source.

**No false flags, by design.**
- This isn't statistics: every ceiling is the *maximum the rule allows*, computed from the same settings the game uses.
- When the rules change (the timer length, say), the check uses the rules in force at each line's time. Settings
  changes go into a `SETTINGS#` history (one item per save).
- Before it's switched on, the check runs once over the whole table. Every line that breaks a ceiling is either a bug
  (fix it, so nobody gets flagged for it) or a missing rule (add it). Flagging only starts once that run is clean.
- A player is only **flagged**, never banned automatically. Flagged means trades and wagers pause until an admin looks;
  packs still open.
- Old `admin gift` lines (from before 1.5) are allowed up to their recorded amounts, so they never trip the check.

**Cost.**
- The nightly check reads only the ledger lines added since the last run (a `gsi1` index keyed by day), plus a running
  total per player kept on a small `AC#SUPPLY#<user>` item. It doesn't scan the whole table.
- A few hundred active players with a few thousand lines a day comes to well under a cent a night of DynamoDB reads,
  and a few seconds of Lambda time.
- The full-table run is only for the first switch-on and for the manual "run everything" button.
- The intake alarm (1.6) adds no reads or writes.

**After a dupe:** every card links to its opening, and every opening has its "−1 pack" line. Once the dupe's start
time is known, Reverse (layer 4) removes the openings after that time, with their cards, not just the extra pack count.

Each check returns `(score 0–100, evidence lines)`. A player's score is their highest check plus 10 for each other
check that fired.

Reference numbers for the luck check come from `server/examples/rng_sim.rs`. For example, 6 Mythics from 55 timer packs
never happened in 500,000 simulated players.

---

## Layer 4: Respond (built)

The **Tripwire suite** is a tab of the admin panel (computers only), with its own tabs:

| Tab | What it shows |
|---|---|
| **Overview** | Players, watched (shadow), trading paused, canary calls today, the last scan's suspects, and the newest watchlist entries |
| **Scan** | Runs every detection check; suspects ranked by score, each with its evidence and the actions below |
| **Watchlist** | Every flagged player: why, their mode (and whether it's their own or from the settings), and every trade and wager since |
| **Canaries** | Every call to a retired endpoint: path, player, address, time |
| **Actions** | Every flag, clear, reversal and settings change, with who did it |
| **Settings** | Shadow flags on or off |

| Action | Effect |
|---|---|
| **Shadow flag** | Nothing changes for the player. Every trade and wager they make (offering, accepting, being offered, staking) goes on their watch log for 30 days |
| **Pause trading** | Trades and wagers are refused ("Trading is paused on your account while we take a look"); open offers are called off. Packs still open, so a false positive costs little |
| **Clear** | Lifts the flag and forgets the hour's intake |
| **Disable** | The existing ban: signed out everywhere, open trades called off |
| **Reverse** | Takes back what came in during a time window (packs, boosted packs, parts, and the cards from then still in the binder; never a new account's starting packs), as new ledger lines with the reason `anticheat reversal`. Always previewed first; cards already traded away are listed so they can be followed |
| **Rollback** | Any account, from its panel under Accounts: back to a moment. Every change to its parts, packs, cards and Mythic meter since is undone (scrapped cards come back with their serial numbers), except trades and wagers, which other players are in. New ledger lines with the reason `rollback`, which Tripwire counts as a known source and the intake alarm ignores. Previewed first, logged in Actions |

A flag set by hand can pick its mode; a flag without one (including the intake alarm's) follows the Settings tab. Every
action is logged under `AC#LOG`, and every change to what a player owns goes through the ledger, so the audit still
balances.

**Where it's stored:** `AC#CONFIG` (settings), `AC#LOG` (actions), `AC#WATCH#<user>` (watch logs, 30-day TTL),
`AC#CANARY` (canary calls, 30-day TTL), and `flagged`, `flagged_at`, `flag_mode` and `packs_in` on the profile.

---

## Order of work

| # | Step | Size | Closes |
|---|---|---|---|
| 1 | Picking up opens the pack (1.1) | 1 day with the tests | holes 1, 2, 3, 6 |
| 2 | Remove Mythic packs (1.2) | half a day | n/a |
| 3 | Wagers share the trade caps (1.3) | 2 hours | hole 4 |
| 4 | New accounts can't give cards (1.4) | 30 min | hole 5 |
| 5 | `pentest.rs` runs with the API tests; all of it passes | 30 min | regression |
| 6 | Record (layer 2) | half a day | n/a |
| 7 | Detect: luck + funnel + integrity first, then thrown wagers and pacing | 1–2 days | n/a |
| 8 | Respond: admin tab, flag, ban, reverse | 1 day | n/a |
| 9 | Sign-in limits in DynamoDB, ratings rules (1.7, 1.8) | half a day | n/a |
| 10 | Intake alarm (1.6) and supply check (3.1), the dry run first | 1 day | dupes of any kind |

Steps 1–5 can ship on their own and close every hole the pen test found. Steps 6–8 are the new anticheat proper; ship
them together so that whatever detection flags can be acted on.

---

## Appendix A: pen test results (before v2)

`server/tests/pentest.rs`. Each test checks for the safe outcome, so a failing test is a hole.

**Holes**

| # | Hole | Measured |
|---|---|---|
| 1 | Pity double-dip (standard + boosted packs both picked up near a full meter) | 27–28 of 30 extra Mythics (fair: about 0.1) |
| 2 | Legendary double-dip (the same trick at the 20-pack promise) | 30 of 30 (fair: about 3) |
| 3 | Hold-back (the 5 cards are sent at pick-up; a known Mythic is held back while the meter climbs) | 10 of 10 paid twice |
| 4 | Wager funnel (an alt stakes everything and forfeits) | 50,000 parts + 50 packs in one match |
| 5 | Alt first-pack farm (a new account's guaranteed Legendary+ is traded on at once) | 5 of 5 |
| 6 | First-pack promise pays twice | 10 of 10 |

**Held** (14 attacks):
- opening the last pack 25 times at once
- crafting 25 times with parts for 2
- scrapping one copy 25 times
- collecting a level 20 times, and re-earning it by trading a team away and back
- claiming each mission 10 times at once
- claiming the timer 25 times at once
- idempotency-key replays and reusing a key for another action
- one trade accepted 20 times at once
- a trade raced against scrapping the same copy
- the daily trade cap
- 160 opens across 8 players at once (0 duplicate serials)
- tampered amounts, teams and counts; dev tools, admin and Mythic craft from a normal account
- session and CSRF basics

**The old audit** (`/api/admin/audit`) after every attack: 0 mismatches, 0 bad serials.

## Appendix B: RNG study

`server/examples/rng_sim.rs`, simulated player cassie, 18 threads, 50 million packs per check: **the RNG is fair.**

| Check | Observed | Expected |
|---|---|---|
| Standard pack has a Mythic | 0.4005% | 0.4000% (z +0.57) |
| Boosted pack has a Mythic | 1.5999% | 1.6000% (z −0.07) |
| Each of the 12 Mythic teams | 4,162,763–4,169,456 | equal (z +0.23) |
| Players side by side (153 pairs) | worst \|z\| 2.41 | ~3.2 by chance |

The built-in 1M-pack fairness test (each slot's odds, every team in every tier, runs, lag-1 to lag-5 correlation) also
passes.

**6+ Mythics, by pack count** (500,000 simulated players each):

| Packs | Chance |
|---|---|
| 50 standard + 5 boosted (about 3 days of timers) | never |
| 60 standard + 30 boosted | 1 in 12,195 |
| 60 standard + 100 boosted | 1 in 94 |
| 100 standard + 200 boosted | 1 in 6 |

**The pasted Nov 3 session:** two Mythics in 7 boosted packs from a reset meter is about 1 in 196. That's lucky, not
cheating. Both were boosted packs, so the hand holes (which need two kinds) don't apply. Worth checking: where the
3,000 parts they crafted with came from (scrap history before Nov 1).

## Running it

```bash
# DynamoDB Local runs in WSL (Windows on ARM has no SQLite library for it)
wsl -e sh -c "cd /mnt/c/Users/me6ap/Tools/dynamodb-local && java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -sharedDb -inMemory -port 8765"
export PATH="/c/Program Files/LLVM/bin:$PATH" DYNAMODB_ENDPOINT=http://localhost:8765 AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x
cd server
cargo test --release --test pentest -- --nocapture --test-threads 4
cargo test --release --test pentest zz_ -- --ignored --nocapture   # the audit after the attacks
cargo run --release --example rng_sim -- 50000000
cargo test --release fairness -- --ignored --nocapture
```
