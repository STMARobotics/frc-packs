# Contributing

- Work on a short-lived branch and open a pull request into `main`.
- Pushing to `main` deploys the live site (`.github/workflows/deploy.yml`), so only merge when it's ready to ship.
- Changes under `cdk/` affect AWS cost and infrastructure and need a maintainer's review.
- Changing the Mythic meter (`mythicBase`, `soft`, `hard` in `data/packs/cmp26.json`) changes the odds players see: rerun
  the fairness simulation and add an in-game notice.
- Every player-facing release adds an entry to `web/src/site/notes.ts` and bumps `VERSION`.

To run the project locally, see the [README](README.md).
