# Roadmap

What's planned, in rough order. Weekly releases on Thursdays (every two weeks once 1.0 is out). Feedback updates come
every ~2 days in between, and hotfixes whenever something big breaks. Every release adds its entry to
`web/src/site/notes.ts`, so players see What's new once.

## Planned

### 0.14.2: packs

- Division pack art with the official division emblems (the maintainer is sending them). The Shop already uses
  `data/photos/divisions/<Division>.png` when it exists, with a drawn shield until then.
- Rework how packs are shown and opened: bought division packs are saved on the account but the app has no place to
  open them later, and a stack per kind (Standard, Boosted, 8 divisions) is too many. Design TBD.
- Rewrite the 0.14.0 in-app notes the CONTRIBUTING way: no title, and balance lines with old -> new numbers.
- Refresh every team's Statbotics numbers once the API is back (it returned 500s on Nov 11), then check 7028's auto,
  which players say is third best (behind 1114 and 2056) when offseason events are counted.

### 0.14: the shop, one Trade tab and a new Packs screen (#78)

A Shop tab of its own: Standard and Boosted packs always, plus three cards (one Rare or better, rarely a Mythic) and a
division pack that change every 4 hours, with one slot you can freeze. Trade and Social become one tab, and the
Packs screen gets a Buy button. The full plan is in [shop.md](shop.md).

### Waiting on a decision

- **#76: Figtree** for titles, to match Puncher, Stats and FMEA, instead of Lilita One. Mona Sans stays for body text.
- **#64: Uncommon and Mythic** are both teal. The proposal is a true blue for Uncommon.
- **#51:** the Claim button at the bottom of the Open tab instead of the top.

### Battler v2 (its own release)

- #73: scoring visuals during the reveal, and a win chance before you lock in.
- #61: RP instead of Elo on profiles. Elo already scales with your opponent; it only looks flat because most people
  are near 1000.
- #60: a short tutorial the first time, instead of the reveal on entering a match.
- #57: spectating a friend's match.

### Tripwire, still to build

- A nightly scan. Needs a scheduled job in `cdk/`, so it waits for the maintainer's review.
- An incremental scan (only what changed since the last one), sign-in rate limits stored in DynamoDB, and rating
  rules for the Battler.

- **Targeted crafting** (replaced by the 0.14 shop). Spend parts on a specific card you're missing, Common to Rare only, priced high so it doesn't
  replace opening packs. Legendary and Mythic stay pack-only. The server checks the card is in the pack and the player
  can afford it; the card gets a fresh serial like a pulled card and is recorded in the ledger. Show it on a missing
  card in the binder ("Craft for N parts").
- **Holographic sheen.** A shine that moves across Rare and better cards as you tilt them, driven by the card tilt we
  already have (CSS only, no WebGL). It only moves while you're holding the card, like the tilt itself.
- **Settings cleanup** (0.9.1): Account becomes its own page, Sign out goes to the bottom, Version and Patch notes share
  one row, and helper text shows only when something's wrong.
- **Admin flags** for lopsided trades and repeated wagers between the same two players. A "Mythics today" view that
  shows each one's meter value.
- **Match alerts:** a push notification when someone has a spare of a card on your wishlist.
- **Battler:** feed posts for big wins, wager polish, rating on profiles.
- **Optimization and accessibility pass.**
- **Season tooling:** the pipeline for next season's pack, and the beta reset plan for 1.0.

- **Cost optimization (later).** AWS was about $0.02–0.04 a day, rising to about $0.10 on 2026-10-28 with ~30 players.
  Most of it is DynamoDB on-demand read and write requests, plus API Gateway HTTP requests. To look at:
  - Provisioned capacity inside the free tier (25 read and 25 write units) instead of on-demand. This is a `cdk/`
    change, so it needs a maintainer's review first.
  - Fewer client requests: less polling (Social refreshes every 8 s while open), and no full state refetch after every
    action.
  - Caching data that's mostly read (the social list, profiles, the pack recipe).
  - "Good matches" reads every player's collection when its 30-second cache is cold. Precompute or update it as cards
    change instead.

## Ideas, not scheduled

- Impact and Hall of Fame special editions from The Blue Alliance's award data.
- Division or era packs as limited weekend events (see the pinned weekend-event idea).
- Roles from Statbotics ("Auto specialist", "Endgame specialist") as card tags for the Battler.

## Done

- 0.10.0 (2026-10-29):
  - the pack opening in 3D (WebGL, loaded only when you open a pack): a foil tear, the cards rising out of the pack,
    3D flips, the pull fanned out like a hand
  - packs minted when picked up, so the opening is ready before the tear
  - the Seam logo; rarity stars aligned on every card
- 0.9.0 (2026-10-29):
  - the new site, pack opening, Battle modes and wagers
  - profiles as pages, trade matches and counter-offers
  - Copies, feedback rewards, patch notes
  - the fairer Mythic meter (1 in 250, climbing from 200, certain by 300)
