# Contributing

These rules are for everyone working on FRC Packs, people and AI agents alike. Agents: follow them without being asked.

- Work on a short-lived branch and open a pull request into `main`.
- Pushing to `main` deploys the live site (`.github/workflows/deploy.yml`), so only merge when it's ready to ship.
- Changes under `cdk/` affect AWS cost and infrastructure and need a maintainer's review.
- Changing the Mythic meter (`mythicBase`, `soft`, `hard` in `data/packs/cmp26.json`) changes the odds players see:
  rerun the fairness simulation and add an in-game notice (`server/src/announce.rs`).
- Anything that adds packs, parts or cards, or moves them between players, must keep `server/tests/pentest.rs`
  passing, and should get a new attack there if it opens a new way in. See [docs/anticheat.md](docs/anticheat.md).

To run the project locally, see the [README](README.md).

## Versioning

The version lives in one place: `VERSION` in `web/src/site/notes.ts`. (`package.json`'s `1.0.0` is unused; leave it.)
It's sent with the recipe request, so it also busts caches.

We're in beta, so versions are `0.MAJOR.MINOR`:

| Bump | When | Example |
|---|---|---|
| **Major** (middle number), resets minor to 0 | A real update: the weekly release, or a batch of features and feedback | 0.10.1 → **0.11.0** |
| **Minor** (last number) | A small follow-up between major updates: a fix, a tweak, one small feature | 0.11.0 → **0.11.1** |
| No bump | Nothing a player can see: tests, docs, tooling, refactors, admin-only changes | n/a |

Rules:

- **One bump per release, not per commit.** Bump once, on the branch, right before it merges to `main`. A branch with
  ten commits is still one version.
- **Hotfixes are minor bumps.**
- **The commit that bumps** is titled `0.11.2: <what changed, in a few words>`, for example
  `0.11.2: cards show their robot's Battle effect`.
- **Never reuse or skip a version.** If two branches both bumped, the second one to merge bumps again.

## Patch notes

Every release that bumps the version adds an entry at the top of `NOTES` in `web/src/site/notes.ts`. Players who've
played before see the newest one once, and Settings lists them all.

Patch notes are written by the developer, for the players, in the developer's own voice. Agents: **draft them, then
ask the maintainer to read them before merging**. Mark the commit `(draft for review)` until they approve.

### How they should sound

Short and plain. A person who works on the game telling players what changed, not a press release.

This is what games known for good patch notes have in common (Stardew Valley, VALORANT, Clash Royale, Factorio):

- **One change per line, one clause, usually under 15 words.** Stardew's notes are almost all lines like "Bee houses
  now work with flowers in garden pots." Say the change and stop.
- **Name the thing, then what happened to it.** "Bump n Dump now also hits Valor's auto." "Renamed AprilTag Camera ->
  Limelight." Lead with the card, part, screen or button, not with a feeling.
- **Balance changes show the old and new number.** Clash Royale and VALORANT write a stat with an arrow (VALORANT uses
  `>>>`): `Bump n Dump auto debuff: 15% -> 10%`. Add the percent change in brackets if it's big: `(-33%)`.
- **Fixes say what was broken, specifically.** "Fixed crash when…", "Fixed an issue where…", or just the bug itself
  under a Fixes heading. Name the screen or card and when it happened: "NEW and COPY tags sometimes showing behind the
  card while opening a pack." Don't write "various bug fixes" or "stability improvements". If you can't say what it
  fixed, players don't need the line.
- **The why is optional, one sentence, for things that might surprise people.** VALORANT puts a short note under a
  balance change explaining it. Most lines don't need one.
- **Headings only when the list is long.** A handful of lines doesn't need them. For a long one, use plain groups like
  `Changes` and `Fixes`, or by area (`Packs`, `Binder`, `Trading`, `Battler`).
- **Your voice is fine, in small amounts.** A one-line intro ("Mostly fixes from last week's feedback") or an honest
  note ("should be fixed, but I can't test it on iPhone") reads as a person. Don't add jokes for their own sake.
  Slack's release notes are the warning here: they're cute ("everything is a bit better") and say nothing.

**Things that make notes sound AI-written. Don't:**

- Give the release a title ("Your feedback, round one", "Packs in 3D"). The version number is the title.
- Use a colon tagline: "Who has it?: tap any card…", "A new look: …". Write "Added a Who has it? button on cards".
- Use hype words: *seamless, enhanced, streamlined, improved experience, brand-new, exciting, sleek, cleaner*.
- Write "now you can…" or "you'll love…". Say what the thing does.
- Make every line the same shape and length, or group everything in threes.
- Use em dashes (—) or semicolons to pack two changes into one line. Two changes, two lines.
- End with "and more!" or "plus lots of small improvements".
- Put a category in front of every line (`Battle: …`, `Fixed: …`) when a heading would do.
- List things players won't notice: refactors, tests, admin-panel changes, how the anticheat works inside. Saying that
  Tripwire exists, or that it changed in a way players feel, is fine. Never describe an exploit or what Tripwire looks
  for, fixed or not.

**Before you're done**, read each line and ask:
- Could a player point at what changed?
- Would the developer say it like this out loud?

If not, cut the line or rewrite it.

### Example

A small release. Most should look like this:

```text
0.11.2
* Fixed special effects not showing on cards, like 7028's Bump n Dump. The full rules are under Details.
```

A big one (0.11, written by the developer, with the 7028 line split up):

```text
0.11.0, 0.11.1, 0.11.2
Most of the feedback from the last two weeks is in. 0.11.1 was a font change and 0.11.2 fixed effects not showing on
cards.

Changes
* New logo
* Rearranged the packs page
* Added a "Who has it?" button on binder cards, including ones you don't have
* New sorting options in the binder
* Added a compact view in the binder
* Trades show how many copies you have of each card in the offer
* Added a spares filter in trading
* Missions are harder, with one big challenge a day
* The battler keeps the navigation bar now
* Buffed 7028 to match its real auto (3rd in the world, 1st in the USA)
* 7028's new effect, Bump n Dump, debuffs the robot across from it by up to 10%
* Bump n Dump boosts your alliance's auto by up to 15% with a Limelight or Swerve Module (L1) attached
* Bump n Dump disables Valor's auto if Valor is across from it
* Renamed AprilTag Camera -> Limelight
* Renamed Swerve Module -> Swerve Module (L1)

Fixes
* No robot photos while opening a pack, mostly on iPhone (should be fixed, but I can't test it, I'm on Android)
* NEW and COPY tags sometimes showing behind the card while opening a pack
* Boosted packs looking like standard packs after closing and reopening the app
* "This card isn't available to trade anymore" showing for some people
```

What to avoid. It's the same release, written as a feature list with taglines:

```text
Your feedback, round one · 0.11.0
* A new look: a cleaner typeface everywhere and a new logo.
* Who has it?: tap any card to see who else has it, spares first, and ask them for it.
* Fixed: NEW and COPY tags sometimes showing behind the cards.
* Battle: two parts are renamed: AprilTag Camera is now Limelight, and Swerve Module is now Swerve Module (L1).
```

## Releasing (checklist)

Before merging a player-facing change to `main`:

1. `npm run build` in `web/` passes (typecheck + build).
2. `cd server && cargo test` passes with DynamoDB Local, including `tests/pentest.rs` if the change touches packs,
   parts, cards, trades or wagers.
3. You tried it on localhost.
4. `VERSION` is bumped once, the notes are drafted at the top of `NOTES`, and the maintainer has approved them.
5. The bump commit is titled `0.X.Y: …`.
