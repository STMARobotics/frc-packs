# 0.14: the shop, one Trade tab, and a new home screen (feedback #78)

Draft plan, second version. It replaces the first draft (five shared cards a day in the Binder) and "targeted crafting"
in the roadmap.

## The tab bar

Today: Open · Binder · Trade · Social · Battle. In 0.14: **Packs · Binder · Shop · Trade · Battle.**

- **Trade takes in Social.** Its top tabs become **Offers · Players · Activity**:
  - **Offers** holds what is in For you, Sent and History today, in that order, with a **New trade** button at the top.
    Starting a trade from a player's profile still works the same way.
  - **Players** is the leaderboard and player search from Social, unchanged.
  - **Activity** is Social's feed, unchanged.
- **Old links:** the `#social` link opens Trade › Players, so nothing that points at it breaks.
- **Badge:** the incoming-offers badge stays on Trade.

## The shop

Each player gets their own shop. It refreshes every 4 hours on the clock: 12am, 4am, 8am, 12pm, 4pm and 8pm Central
(`GAME_TZ`). The header shows "New stock in 2h 41m".

### Always there

| Item | Price | Notes |
|---|---|---|
| Standard pack | `shop_std`, 120 to start | Goes into your packs, the same as a timer pack |
| Boosted pack | `boost_cost` | The Workshop's craft button moves here |

### Changes every 4 hours

| Slot | What can come up | Price |
|---|---|---|
| Card 1 | Common 70%, Uncommon 25%, Rare 5% | 75 / 180 / 600 |
| Card 2 | The same odds, never the same team as card 1 | |
| Card 3: Rare or better | Rare 85%, Legendary 14.6%, **Mythic 0.4%** | 600 / 2,500 / **25,000** |
| Division pack | One of the 8 divisions, picked at random | `shop_division`, 200 to start |

- **Mythics:** card 3 rolls 6 times a day, so a Mythic shows up about once every 6 weeks. A particular Mythic, like
  HighTide, about once every year and a half. The price is set so it takes months of saving, and freezing is how you
  get there.
- **A division pack** is a standard pack whose 5 cards all come from one division:
  - It opens as soon as you buy it, with the normal opening animation.
  - It isn't kept in your packs, so it can't be traded or wagered and needs no new kind of pack in the inventory.
  - It uses your Mythic meter and moves it like any pack. Every division has at least one Mythic.
- **Buying limits:** each card and the division pack can be bought once, then show Sold until the next refresh.
- **Card details:**
  - Each card shows "You have ×N" or "New", and a heart if it's on your wishlist.
  - A bought card gets its own serial like a pull, and the team leaves your wishlist.
  - Finishing a division set pays the set's bonus pack, the same as opening and trades.
- **Before spending:** the app asks once, "Buy 4414 HighTide for 25,000 parts?"

### Freezing a slot

Tap the snowflake on card 1, card 2, card 3 or the division pack. That slot keeps what's in it through every refresh
until you buy it or unfreeze it.

- **One slot at a time.** Freezing another slot unfreezes the first.
- **No time limit and no token.** The cost is built in: a frozen slot stops rolling. Holding a Mythic in card 3 for a
  month means a month without new Rares or Legendaries there. That keeps "save up for HighTide" a real choice.
- **Unfreezing doesn't reroll.** The slot gets something new at the next refresh, not right away. Otherwise freezing
  and unfreezing would reroll the shop for free.
- **Price:** a frozen item costs whatever its price is when you buy it.
- **Rejected alternatives:**
  - Freeze tokens from missions are more to build and explain.
  - A deposit, paying 10% now and the rest later, would be the right fit if anyone ever freezes for free in a way
    that hurts the game. The design can switch to it without a data change.

### Packs on the home screen

The new home screen has **Buy · 120** next to **Open**, and it buys whichever kind is selected (Standard or Boosted),
so nobody needs the shop just to buy a pack. Both buttons call the same route as the shop.

**Pack buying needs a daily limit: 10 bought packs a day**, Standard and Boosted together, and the limit is an admin
setting. Without one, someone with lots of parts buying 31 packs in an hour sets off Tripwire's intake alarm, which is
built for duped packs. The same thing can already happen with crafting boosted packs today. With the limit, it can't
happen at all.

## Server

- **No refresh job and no stored stock.**
  - A shop is worked out from `hash(seed, player, window, slot)`, where the window is the number of 4-hour blocks
    since 2020-01-01 in `GAME_TZ`.
  - `seed` is a random secret saved in the settings item the first time it's needed. The code is public, so without
    a secret anyone could compute their future shops and know when a Mythic is coming.
  - Rarity overrides from the admin panel apply.
- **New items:**
  - `SHOP#<window>#<slot>` on the player, written only if it doesn't exist, with a 40-day TTL. It records a buy and
    is what stops two buys of one slot at the same moment.
  - `SHOPFREEZE` on the player: `{ slot, window }`, the window the frozen item was rolled in. When that slot is
    frozen, the shop shows that window's roll in it.
  - `SHOPBUY#<day>`: a count of packs bought that day, with a condition so it can't pass the limit.
- **Routes:**
  - `GET /api/shop`: this window's items, prices, sold and frozen flags, and when the next window starts.
  - `POST /api/shop/buy` `{ window, slot, price }`: refused with `shop_changed` if the window has passed, unless the
    slot is frozen at that window. Refused with `price_changed` if an admin changed the price. Uses an idempotency
    key like every other spend.
  - `POST /api/shop/freeze` `{ slot, window }` and `{ slot: null }` to unfreeze.
  - `POST /api/shop/pack` `{ kind: "std" | "boosted" }`: used by both the shop and the home screen. `POST /api/craft`
    stays as another name for buying a Boosted pack, for apps that haven't updated.
- **Minting cards:** a card is minted with `take_serials(.., live: true)` and ledger reason `shop` (detail
  `"<team> #<serial> w<window> s<slot>"`).
- **Division packs:** the opening code gets a pool filter. The opening record keeps the division, so Tripwire's luck
  check computes odds from the right pool.
- **Settings in the admin panel:**
  - Prices: `shop_std`, `shop_division`, `shop_common`, `shop_uncommon`, `shop_rare`, `shop_legendary` and
    `shop_mythic`.
  - `shop_packs_per_day` (the daily pack limit) and `shop_on`.
  - All of them are kept in the settings history.
- **No CDK change.**

## Tripwire, before it ships

The shop is a new source of cards and packs, so each check needs a rule for it.

- **Known sources:** cards with reason `shop`, packs with reasons `shop` and `shop, set`, and openings of division
  packs.
- **Every shop card is checked against the shop it came from.** Rolls come from the server's seed, so the scan can
  recompute that player's window and slot and confirm the card was really for sale there, or frozen there. A card that
  wasn't for sale is high-confidence evidence, not a guess.
- **Ceilings:**
  - Packs bought on any one day ≤ the limit that applied that day.
  - At most one buy per window and slot.
  - Parts spent ≥ the lowest price each item ever had.
- **The intake alarm** stays as it is. The daily limit keeps honest buying under 30 packs an hour.
- **Pen tests:**
  - 10 buys of one slot at once: 1 succeeds.
  - An 11th pack in a day: refused.
  - A buy for the next window: refused.
  - A buy from an old window that isn't frozen: refused.
  - Freezing, unfreezing and freezing again in the same window: the shop doesn't change.
  - A price change partway through a buy: refused.
  - A Mythic slot bought by someone who doesn't have it: refused.
  - The ledger audit balances after all of them.

## The home screen (Packs tab)

The layout from your screenshot, with less on it:

```text
┌─────────────────────────────────┐
│ Packs                           │
│ 2026 Championship               │
│ ┌──────────────┐ ┌────────────┐ │
│ │              │ │ ×3         │ │  pack kinds stacked on the right,
│ │  pack art    │ │ Standard   │ │  the selected one outlined
│ │  (tap = open)│ ├────────────┤ │
│ │              │ │ ×1 Boosted │ │
│ └──────────────┘ └────────────┘ │
│ [   Open Standard   ] [Buy · 120]│
│ ┌─ Next free pack ┐ ┌─ Mythic ─┐ │
│ │ 1:10:47         │ │ ▓▓▓░░░░  │ │
│ └─────────────────┘ └──────────┘ │
└─────────────────────────────────┘
```

- **What stays:**
  - The 3D pack, where tapping it still opens it.
  - The pack-kind picker, moved beside the pack.
  - The Claim button, which takes the timer tile's place when free packs are waiting.
- **What's new:** the Open and Buy buttons.
- **What moves:** the free pack timer and the Mythic meter are already under the pack. They become the two tiles.
  The streak and today's missions stay below them.
- **What goes:**
  - The pull odds list. The odds are already on the back of the pack ("Turn over").
  - The line explaining the free pack timer.
  - Anything else that only repeats what the tiles say.
- **Phones first.** On a wide screen the same layout is centred, not stretched.

## Tests

- **Unit:**
  - The same seed, player and window always gives the same shop.
  - Card 3 is never below Rare, cards 1 and 2 are never the same team, and Mythics only ever appear in card 3.
  - The odds over 1,000,000 simulated windows match the table.
  - A frozen slot keeps its roll.
- **API:** every buy, freeze and limit rule above, the wishlist dropping a team, the set bonus, and `shop_on` off.
- **Tripwire:** a normal shop history raises nothing. A card that wasn't in that player's shop is flagged, and so is
  an 11th pack.
- **Browser:**
  - Shop tab: buy a planted card and freeze a slot.
  - Home screen: Buy · 120 adds a pack.
  - Trade › Players finds a player.
  - `#social` still opens Players.

## Release

0.14.0, a middle-number bump. Draft notes, for your approval:

```text
0.14.0 · The shop
* Added a Shop tab: packs, and three cards and a division pack that change every 4 hours
* One card is always Rare or better, and once in a long while it's a Mythic
* Freeze a slot to keep its card until you've saved up for it
* Buy packs right from the Packs tab
* Trade and Social are one tab now: Offers, Players and Activity
* A new Packs screen
```

## Open questions

1. **Prices:** Standard pack 120, division pack 200, Mythic 25,000. The Rare (600) should cost more than a Boosted
   pack, so check the live `boost_cost`.
2. **The daily pack limit (10).** It also limits crafting boosted packs, which has no limit today.
3. **Should cards 1 and 2 ever be a Rare?** At 5% it would be a nice surprise, but it overlaps card 3.
