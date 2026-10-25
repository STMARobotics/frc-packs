# Data on DynamoDB

The server keeps everything in one DynamoDB table (`TABLE_NAME`). This is how the data is laid out, and how the rules
the game depends on (no double opens, no spending what you don't have, no duplicate serials, trades that either fully
happen or don't) are enforced without SQL transactions and row locks.

## The one rule that makes it safe: every change to a player is conditional on their version

Each player's profile item carries a version number `ver`. Every request that changes what a player owns (packs,
parts, cards, missions, streak, trades) reads the player first, works out the result, and then writes everything in
one DynamoDB transaction that also sets `ver = ver + 1` **on condition that `ver` is still what it read**. If anything
else changed that player in between (a second tab, a retry, a double tap, a script), the condition fails, nothing is
written, and the request starts over from a fresh read (or answers `409 busy` after a few tries).

So a player's changes happen one at a time, without locks.
A trade includes both players' versions, so it lines up with everything either of them does.

On top of that, writes carry the conditions that the database constraints used to check:

| Rule | How it's enforced |
| --- | --- |
| A card is only spent once | Moving or scrapping a card deletes its item with `attribute_exists(pk)`; a card already gone fails the transaction. |
| Card in a pack still being revealed can't be traded | The trade checks the opening item: `revealed >= 5`. |
| Serial numbers are unique | Each team's counter only goes up (`ADD minted 1`); a freed serial is taken by deleting its item with `attribute_exists`, so two packs can't take the same one. A failed open leaves a gap, never a duplicate. |
| Usernames are unique, ignoring case | A `NAME#<lowercase>` item, written with `attribute_not_exists`. |
| An invite can't be used past its limit | `uses < max_uses` on the invite update. |
| A request is done once | `REQ#<key>` is written in the same transaction, with `attribute_not_exists`. A retry gets the stored answer. |
| Special edition numbers are unique | A `SPSER#<edition>#<serial>` item, written with `attribute_not_exists`. |
| Packs, parts never go negative | The player version condition plus the amounts checked on the fresh read, and `>=` conditions on the pack item. |

The ledger is written by the same transactions: every change to packs, boosted packs, parts
or cards adds a `LED#` item with the change and the reason, so the admin audit can still prove each player's holdings
add up.

## Items

`pk` / `sk`, then what's in it. `U#<id>` is a player (UUID).

| pk | sk | What |
| --- | --- | --- |
| `U#<id>` | `PROFILE` | username, password hash, admin, disabled, first name, badge, parts, next free pack, streak, level, showcase, pending opening, `ver`. GSI1 `USERS` (every account). |
| `NAME#<lowercase name>` | `NAME` | the account id, for sign-in and uniqueness |
| `S#<token hash>` | `SESSION` | the account id; expires after 400 days (TTL). GSI2 `U#<id>` lists an account's sessions. |
| `INV#<code>` | `INVITE` | note, max uses, uses, who used it. GSI1 `INVITES`. |
| `U#<id>` | `PACK#<pack>` | sealed, boosted, mythic, opened, pity counters |
| `U#<id>` | `HAND#<pack>#<0/1>` | the pack picked up but not opened (its rolled cards) |
| `U#<id>` | `OPEN#<id>` | an opened pack: which, cards revealed so far, sets it finished |
| `U#<id>` | `CARD#<pack>#<team>#<card id>` | one copy: tier, serial, opening, how it was got. Sorted by team, then age, so "the first copy" is the first one. |
| `U#<id>` | `STATS#<pack>` | distinct teams, cards, Mythic and Legendary teams, finished trades (profile and social lists) |
| `U#<id>` | `SET#<pack>#<division>` | a finished division set |
| `U#<id>` | `FAV#…`, `WISH#…` | favorites and wishlist |
| `U#<id>` | `DAY#<date>` | today's mission counts and claimed missions (expires after 40 days) |
| `U#<id>` | `REQ#<key>` | an idempotent request's answer (expires after 2 days) |
| `U#<id>` | `LED#<time>#<n>` | one ledger line |
| `PRINT#<pack>#<team>` | `PRINT` | serials printed so far, and copies in the game now |
| `FREE#<pack>#<team>` | `<serial>` | a serial back in circulation (from a deleted account) |
| `TRADE#<id>` | `TRADE` | an offer and its outcome. GSI1 `TU#<from>`, GSI2 `TU#<to>`. |
| `FEED#<pack>` | `<time>#…` | the Social feed: big pulls, finished sets, finished trades (expires after 30 days) |
| `REPORT#<id>` | `REPORT` | a report. GSI1 `REPORTS` while unresolved; GSI2 `RB#<reporter>` for the daily limit. |
| `SP#<id>` | `SPECIAL` | a special edition copy. GSI2 `U#<owner>`, GSI1 `SPE#<edition>`. |
| `SETTINGS` | `SETTINGS` | the free-pack rules, the push signing key, and the admin's rarity changes (`tier_overrides`, `tiers_ver`, and the parts and note chosen for the last change) |
| `PUSH#<endpoint hash>` | `PUSH` | a device's push subscription. GSI2 `U#<id>`. |
| `CTR` | `CTR` | counters for card, opening, trade, report and special ids |

## Limits

A DynamoDB transaction holds at most 100 items. Opening a pack writes about 35; a trade about 50. Scrapping every extra
copy can touch hundreds of cards, so it scraps in batches of 25 per transaction (each batch is complete on its own:
cards, parts and ledger together).
