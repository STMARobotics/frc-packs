# Roadmap

What's planned, in rough order. Weekly releases on Thursdays (every two weeks once 1.0 is out). Feedback updates come
every ~2 days in between, and hotfixes whenever something big breaks. Every release adds its entry to
`web/src/site/notes.ts`, so players see What's new once. The plan behind this list is in
[night-report-2026-10-29.md](night-report-2026-10-29.md).

## Planned

- **Targeted crafting.** Spend parts on a specific card you're missing, Common to Rare only, priced high so it doesn't
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
    change, so it needs Andy's review, and a flag to Cassie before anyone touches it.
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

- 0.9.0 (2026-10-29):
  - the new site, pack opening, Battle modes and wagers
  - profiles as pages, trade matches and counter-offers
  - Copies, feedback rewards, patch notes
  - the fairer Mythic meter (1 in 250, climbing from 200, certain by 300)
