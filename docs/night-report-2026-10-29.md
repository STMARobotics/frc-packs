# Night report: 2026-10-29

Branch `battler-ui-revamp` on STMARobotics/frc-packs. Six commits, all pushed. Nothing went to `main`, and I didn't touch
AWS or `cdk/`. Nothing is live until you merge.

## TL;DR

- **Everything on the list shipped to the branch**: the Copies view, a free pack for accepted feedback, the feedback
  banner, version 0.9.0 with patch notes, and the profile/social/trading overhaul. For Settings I only wrote suggestions,
  as you asked (below).
- **Fairness: no sign of cheating, and the minting factory is statistically clean.** A million packs through the
  server's own generator matched the recipe on every test. The **7 Mythics in one day is most likely the Mythic meter**:
  68% of Mythics land between pack 151 and 199, and the median is pack 155. Players who started together reach that
  zone together. I modeled it: a group that joined on the same day gets about 0.8 Mythics a day for twelve days, then
  2.5 to 4 a day. **This is the one decision waiting on you** (options below). I didn't change the odds.
- **I fixed three anticheat gaps**: a roll can't change when a save is retried; a full meter beats a pack you picked up
  earlier; and demo luck only works on a server with dev tools on.
- **Tests**: 108 server tests pass, plus the new million-pack fairness test. Clippy and rustfmt are clean. Every browser
  and API suite passes at 390×844 and 360×740 against the real local server on DynamoDB Local: site-ui, the new
  social-ui, battler-ui, wager, feedback and battler-api.
- **Next**: decide on the meter, review and merge the branch, then follow the schedule at the bottom.

## What shipped

| Commit | What |
| --- | --- |
| `c381082` | **Copies.** A card's Copies tab lists every copy you own: serial, how you got it and when, its badges, and whether it's free. Sort by serial, newest or oldest. Trade or scrap that exact copy. Scrapping takes two taps. |
| `e093c33` | **Feedback rewards.** A bug report or idea you move to Planned or Done earns its sender 1 sealed pack, once. That's enforced in the same database write as the status change, so moving it back and forth pays nothing more. The sender gets a thank-you note and a push notification. The admin buttons say "Planned · +1 pack". |
| `a8fe84c` | **The banner is back.** "Found a bug or have an idea? Accepted ones earn a pack" is one line at the top of Open. × hides it for a week. There's a Beta tag in the header. I also fixed the Feedback form's title box, which was stretched huge. |
| `9d7d9cb` | **Version and patch notes.** The app is v0.9.0. "What's new" shows once after each update to anyone who played before it (a brand-new device gets the beta welcome instead). Settings shows the version and every release. Releases live in `web/src/site/notes.ts`. |
| `44f61a3` | **Fairness hardening** and the million-pack statistical test (details below). |
| `50f2b80` | **Profiles, social and trading overhaul** (details below). |

### Profiles, social, trading

- **A profile is its own page** with its own address (`/#u/<username>`), so you can share a link to it. The phone's back
  button leaves it. It sits under the Social tab and the tab bar stays visible. The layout borrows from Discord: a
  banner across the top, your picture over its edge, then your name, @username, badge and bio, then stats (collected,
  Mythics, trades, Battler rating once you've played).
- **Tabs**: Overview (showcase, your latest Mythic and Legendary pulls, rarest cards, special editions, and your
  collection by rarity as bars), Cards (with a "You need" filter on other people's profiles) and Wishlist (cards you
  have a spare of are marked, and one tap offers it).
- **Edit profile**: a bio (160 characters, 3 lines), a picture and a banner (each picked from cards you own), and your
  showcase (up to 3 cards). The picture follows you everywhere: the header, the People list and trade offers.
- **The match strip** on someone else's profile reads like "15 spares you need · 16 of yours they need · Start a fair
  trade". It opens the trade with a balanced offer already on the table.
- **Trade tab**: "Good matches" comes first. It lists people who have spares you lack and need spares of yours, with
  wishlist cards counted first. One tap puts a fair offer on the table: up to 3 cards each way, matched by rarity.
- **Counter-offers**: an offer for you now has Accept, **Counter** and Decline. Counter opens the same cards for you to
  change. Sending it declines their offer.
- **Social**: you can search players by name. Each row opens that player's profile; I dropped the per-row Trade
  buttons. Any name in the activity feed opens a profile too.
- **Safety**: other people's profiles have ⋯ → Report (offensive name or bio, cheating, harassment, something else).
  This uses the report system that already existed, which had no button on the new site. The admin panel shows each
  player's bio with a **Clear** button.

## Decisions I made for you

1. **Order of work**: I did the fairness audit before the social overhaul, because the live game's integrity mattered
   more than new screens.
2. **Banner**: one slim line at the top of Open, not a card under the pack. Below the pack, nobody would scroll to it.
   × hides it for 7 days on that device.
3. **Feedback reward**: 1 standard pack, only for bugs and ideas (never "Other"), paid the first time the item moves to
   Planned or Done, and only once per item.
4. **Version scheme**: 0.x while in beta. The middle number goes up with each weekly release and the last number with
   each feedback update in between. 1.0 ships at launch. I started at **0.9.0**, with 0.8 (Battle) and 0.7 (Mythic
   rebalance) written up as history.
5. **What's new** isn't shown on a brand-new device, which gets the beta welcome instead. Everyone else sees it once
   per version.
6. **I didn't change the Mythic odds or the meter.** It isn't a bug, and changing it moves players' meters while
   they're mid-way. That's your call (see the options below).
7. **A pack picked up before the meter filled gets re-rolled** if opening it now would break the meter's promise. This
   only ever makes a pack better.
8. **Demo luck now needs `DEV_TOOLS` on the server**, whatever the profile says. That way a stray flag can't give
   anyone 20% Mythics in production.
9. **Profiles show the first name big**, because the People list already showed it publicly. I added **no direct
   messages**: players are minors and there's no moderation for them yet.
10. **Picture and banner** must be cards you own when you pick them. They stay if you later trade the card away. It's
    cosmetic, and taking them away would feel bad.
11. **Matches only count spares (2+ copies) both ways.** Asking for someone's only copy rarely gets accepted. The
    suggested offer has up to 3 cards each way, matched by rarity.
12. **A counter-offer declines the original** when you send it. That's two calls: if the decline fails, the original
    simply stays open.
13. **Report reasons** reuse the four the server already knows. "Username" is labeled "Offensive name or bio".
14. **Settings**: suggestions only, no changes (you asked to put a pin in it).

## Fairness and anticheat audit

### How minting works (all on the server; the client never decides anything)

- **Generator**: `rand::rng()`, which is ChaCha12 seeded from the operating system and reseeded as it goes. It's
  cryptographically strong, so nothing about one roll predicts another.
- **Odds** come from `data/packs/cmp26.json`:
  - Slots 1–4: 70.5% Common, 22% Uncommon, 7% Rare, 0.5% Legendary.
  - Last card: Mythic 1 in 400; otherwise 93% Rare, 7% Legendary.
  - Boosted packs have better slots and 4× the Mythic chance.
- **Meters**: Legendary or better at least every 20 packs. The Mythic chance climbs from pack 151 and reaches 100% at
  pack 200.
- **Picking up a pack** rolls it and stores the cards, and only the best rarity is revealed (it colors the glow).
  Putting the pack back keeps the same cards, so peeking can't re-roll anything.
- **Serials** come from a per-team counter that only moves if nobody else moved it first. Freed serials from deleted
  accounts are reused, each taken exactly once.
- **Every change to what a player owns** is one DynamoDB transaction, conditioned on the player's version.
  Double-opening, double-spending and two packs racing each other all lose cleanly.

### Statistical test: 1,000,000 packs, production generator, not seeded

`cargo test --release fairness -- --ignored --nocapture` (about 4 seconds). Each check fails a fair generator about once
in 100,000 runs.

| Check | Result |
| --- | --- |
| Slots 1–4 tiers vs recipe (each slot, and all together) | χ² 0.32 on 3 df, z −1.66 ✅ |
| Last card tiers vs recipe | 2,533 Mythic (2,500 expected); χ² 4.84 on 2 df, z 1.36 ✅ |
| Every team equally likely within its rarity | Mythic z 1.07, Legendary 2.33, Rare 0.49, Uncommon −2.43, Common 0.60 ✅ |
| Runs test (Legendary+ packs don't come in streaks) | 164,271 runs vs 164,086 expected, z 1.13 ✅ |
| Lag 1–5 correlation of each pack's best rarity | all \|z\| ≤ 1.1 ✅ |
| Meter: never more than 200 packs without a Mythic | ✅ (also unit-tested at its edges) |

**No visible patterns**: tiers, teams, streaks and pack-to-pack correlation all look like fair dice.

### The 7 Mythics

With the meter, a player opening standard packs gets a Mythic every **130 packs on average**. The odds say "1 in 400",
but only **32%** of Mythics come by luck before pack 150. The other **68%** land between packs 151 and 199. The median
is pack 155, and 90% have one by pack 163.

At 1 pack per 2 hours, with 2 banked, missions and crafting, active beta players are reaching pack ~150 about now. A
simulated group of 40 who joined on the same day gets about 0.8 Mythics a day for twelve days, then 2.5 to 4 a day.
**Seven in one day fits that.**

Caveat: I can't see production data from here, so this is a model. To confirm, check whether those 7 players had
opened ~150+ packs since their last Mythic. The ledger or each player's pity counter shows it.

**Options**: standard packs only. "Busiest 15-pack window" is how predictable the meter is: the share of all Mythics
that land in one 15-pack stretch.

| Option | Mean packs per Mythic | Median | By luck | Busiest 15-pack window |
| --- | --- | --- | --- | --- |
| Now: 1/400, climbs from 150 to 200 | 131 | 156 | 31% | 64% |
| A: 1/400, climbs from 100 to 300 | 102 | 113 | 22% | 47% |
| B: 1/300, climbs from 120 to 300 | 110 | 130 | 33% | 42% |
| **C (my pick): 1/250, climbs from 200 to 300** | **143** | **173** | **55%** | **35%** |
| D: 1/400, climbs from 175 to 250 | 149 | 181 | 36% | 55% |

**C** makes Mythics a bit rarer and much less predictable. Most come by luck, and the meter is a real safety net
instead of a schedule.

It's a data-only change: `mythicBase` 0.004, `soft` 200, `hard` 300 in `data/packs/cmp26.json`. Then update the
"m/200" display. Players' counters carry over. Someone at 160 today would go back to base odds until 200, so pair the
change with a game notice. If you'd rather not move anyone's meter mid-beta, make the change at the 1.0 reset.

### Anticheat fixes tonight

1. **A roll can't change on a retry.** When a pack is rolled at opening time (not in hand) and the save loses a race,
   for example over a serial, the same cards are used on the retry. Before, it re-rolled. That was a tiny bias towards
   teams other people weren't pulling at the same moment.
2. **A full meter beats a pack picked up earlier.** Picking up a pack stores its cards. If you then opened other packs
   until the meter was full, the stored pack could still open without its promised Mythic or Legendary. That delayed
   the guarantee by a pack. Now it's re-rolled under the current meter.
3. **Demo luck is ignored unless `DEV_TOOLS` is on.**

### Already in place (checked)

- Invite-only sign-up, limits on wrong passwords and invite codes, and idempotency keys on opens, crafts and offers.
- Anti-farming on trades: an account must be a day old to give packs or parts, and a player can take in at most 10
  packs and 2,000 parts a day.
- Battler: the seed is committed by hash at the start and revealed after the game. All rolls come from the server.

### Gaps left (next steps)

- **Cards** from alt accounts aren't capped like packs and parts are. Invites limit how many alts someone can make, but
  an admin flag for lopsided trades would help (one side's value ≫ the other's, or a new account giving away rares).
- A flag for repeated wagers between the same two players (noted before).

## Settings: suggestions only

From the 360-wide screenshots:

1. **Fold First name, Username and Password into one "Account" row** that opens its own page. That's three rows gone.
2. **Sign out**: one plain red text button at the very bottom, not a row that says "Sign out" twice.
3. **The top card should say "Edit profile"** now that profiles are pages. Settings then holds only preferences.
4. **Merge "Version 0.9.0" and "Patch notes"** into one row ("Version 0.9.0 · What's new ›"). The Check/Update button
   can live on that page.
5. **Remove helper text under toggles** unless something's wrong (notifications blocked, iOS needs Add to Home Screen).
6. **Move "Pack wheel every time" somewhere else**: a long-press on the pack, or an "Advanced" fold.
7. **Show "Install the app" only when it can be installed**, as one small row.

That would leave about 7 rows instead of 12.

## Tests run tonight

- `cargo test`: 49 + 59 pass. That includes the new tests for the meter's promise, bios, and the existing odds and
  pity tests. `cargo test --release fairness -- --ignored`: pass (numbers above). `cargo clippy --all-targets` and
  `cargo fmt --check`: clean.
- Against the real server on DynamoDB Local, at **390×844 and 360×740**:
  - `site-ui.cjs`: every screen, Copies, What's new, the version in Settings.
  - `social-ui.cjs` (new, 23 checks):
    - API: a bad bio and a picture you don't own are refused, and matches are right.
    - Editing: you can set and save a profile.
    - Profile pages: own address, back button, "You need" filter, match strip.
    - Trading: a fair suggested offer, a counter that declines the original, accepting the counter.
    - Other: a direct link to a profile, reporting, an unknown player, card pictures in the People list.
  - `battler-ui.cjs`: all screens.
- API suites: `wager.cjs` (13 checks), `feedback.cjs` (9), `battler-api.cjs` (a full game). `battler-api.cjs` had gone
  stale: it still used the open lobby that the Quick Play change removed. It now joins private games by code.
- Not run: `e2e.cjs`, which targets the old page; `load.cjs`; `binder-smooth.cjs`.

## Recommended next steps

1. **Decide on the Mythic meter**: C now with a game notice, or C at the 1.0 reset.
2. **Review on your phone and merge `battler-ui-revamp` → `main`.** That deploys, so it's yours to do. Check these
   first:
   - Your profile → Edit profile.
   - Someone's profile → Start a fair trade.
   - Trade → For you → Counter.
   - Settings → Patch notes.
3. Make the Settings changes above. That's about an hour; it could go out as 0.9.1.
4. Admin flags for lopsided trades and repeated wagers. A "Mythics today" view with each one's meter value would let
   you check claims like the 7 in a day.
5. A push notification when a match appears ("Sam has a spare of a card on your wishlist").
6. The optimization pass and whole-app review that are still pending from before.

## Draft dev schedule

How it works:

- **Weekly release** on Thursdays now; every 2 weeks once v1 launches in season.
- **Feedback updates** every ~2 days in between (Saturday and Tuesday): the last number goes up, with small fixes and
  accepted ideas.
- **Hotfixes**: whenever something big breaks, unscheduled, but with a patch-notes line.
- Each release adds its entry to `web/src/site/notes.ts`, and players see What's new once.

| Date (2026) | Version | Focus |
| --- | --- | --- |
| Thu Oct 29 | 0.9.0 | This branch: new site, opening, Battle modes, profiles, trading, patch notes |
| Sat Oct 31 | 0.9.1 | Feedback update + Settings cleanup |
| Tue Nov 3 | 0.9.2 | Feedback update |
| Thu Nov 5 | 0.10.0 | Mythic meter change (if C) + game notice; admin fairness and trade flags |
| Sat Nov 7 / Tue Nov 10 | 0.10.x | Feedback updates |
| Thu Nov 12 | 0.11.0 | Trading 2: match notifications, wishlist alerts, trade history on profiles |
| Thu Nov 19 | 0.12.0 | Battler: feed posts for big wins, wager polish, rating on profiles |
| Thu Nov 26 | none | Thanksgiving: feedback updates only |
| Thu Dec 3 | 0.13.0 | Optimization pass (load time, binder memory), accessibility pass |
| Thu Dec 10 | 0.14.0 | Season tooling: the pipeline for next season's pack, beta reset plan |
| Thu Dec 17 | 0.15.0 | v1 release candidate: load test, final balance |
| Dec 21 – Jan 3 | freeze | Hotfixes only |
| Kickoff weekend (expected Sat Jan 9, 2027; confirm) | **1.0** | Launch: beta reset, season pack |
| Then every 2nd Thursday | 1.1, 1.2, … | Two-week cycle through the season; feedback updates and hotfixes as above |
