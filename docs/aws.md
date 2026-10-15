# FRC Packs on AWS

The AWS infrastructure is defined in [`cdk/`](../cdk/). CDK provisions the certificate, API Lambda, DynamoDB table,
static-site bucket, and CloudFront distribution. The site and Lambda assets are built from this repository and deployed
as CDK assets.

```
browser ──► CloudFront
             ├── /api/* ──► API Gateway HTTP API ──► Rust Lambda ──► DynamoDB
             └── everything else ──► private S3 bucket
```

The backend table uses on-demand billing, two all-projection secondary indexes, TTL, point-in-time recovery, and a
retention policy so deleting or replacing the stack does not delete player data. Its keys and item layout are described
in [dynamodb.md](dynamodb.md).

## Requirements

- AWS CLI configured for the account and permissions to deploy CDK stacks.
- Node.js 20 or newer, Rust, and `cargo-lambda`.
- A Route 53 hosted zone for the configured domain. The certificate stack requests its CloudFront certificate in
  `us-east-1` and validates it through Route 53.

The domain, hosted-zone ID, regions, stack names, and `ADMIN_ONLY` default live in [`cdk/lib/config.ts`](../cdk/lib/config.ts).
The frontend and backend deploy to `us-east-2`; the certificate deploys to `us-east-1`.

## First deployment

Install dependencies and bootstrap both deployment regions once:

```sh
npm ci
(cd cdk && npx cdk bootstrap aws://<account-id>/us-east-1 aws://<account-id>/us-east-2)
```

From the repository root, build and deploy all three stacks:

```sh
npm run cdk:deploy
```

The first run builds the web app and ARM64 Lambda package, then deploys the certificate, backend, and frontend stacks.
CDK prints outputs for the API, table, bucket, and distribution. The certificate stack creates a Route 53 DNS
validation record when its hosted zone is configured. Once the distribution is deployed, the frontend stack creates
the configured Route 53 alias record.

Create the initial admin account using the backend stack's `TableName` output:

```sh
cd server
TABLE_NAME=<TableName output> AWS_REGION=us-east-2 cargo run -- create-admin
```

The password is printed once. The default `ADMIN_ONLY` setting is enabled while the deployment is being tested.
Change `adminOnly` in `cdk/lib/config.ts` to `false` and redeploy to allow non-admin accounts to sign in and play.

## Subsequent deployments

After a change to the server, site, photos, pack recipes, or CDK, run this from the repository root:

```sh
npm run cdk:deploy
```

This rebuilds the Lambda and website assets before deploying all stacks. CDK runs the site deployment after the assets,
photos, and packs have uploaded, then invalidates `/*` on CloudFront so the updated site is visible immediately; no
separate GitHub Actions invalidation step is needed.
Mutable root-level app files are cached at CloudFront for up to a day but are not cached by browsers; hashed `/assets/*`
files are cached for a year. Photos are cached for a day, packs for four hours, and `/api/*` is not cached.
Use `npm run cdk:synth` to synthesize the CloudFormation templates locally, `npm run cdk:diff` to review the proposed
changes, and `npm run cdk:test` to run the CDK synthesis checks.

## What protects the site

- **API access.** API Gateway is directly reachable as well as through CloudFront. API Gateway throttles total traffic;
  the server also counts failed sign-ins per visitor using `CloudFront-Viewer-Address` when requests come through
  CloudFront. Direct callers can set that header themselves, so the per-visitor count is not trustworthy for those
  requests. `cf-connecting-ip` and `X-Forwarded-For` are ignored because callers can send anything in them.
- **Headers.** CloudFront adds a content security policy, HSTS, `nosniff`, frame blocking and a referrer policy to
  everything; the server adds the same to its own responses. The policy text lives in `cdk/lib/config.ts` and
  `server/src/lib.rs` and a CDK test fails if they differ.
- **Throttle.** API Gateway accepts `apiThrottle.rate` requests a second in total (`cdk/lib/config.ts`), so a script
  can't run up the Lambda bill unnoticed.
- **Failed-sign-in counting** is still kept in each warm Lambda's memory, so a determined attacker spreads guesses across
  instances. It slows guessing a lot (50 tries a visitor and 10 a username every 15 minutes, per instance) but is not a
  hard cap. For one, add an AWS WAF web ACL with a rate rule on `/api/login` and `/api/signup` to the CloudFront
  distribution (about $6 a month); it must be created in `us-east-1`, next to the certificate.

## Notifications

- **Free pack ready:** a second copy of the function (`ReadyCheckFunction`) runs every `readyCheckMinutes`
  (`cdk/lib/config.ts`) on an EventBridge schedule and sends the notifications. It is the same program started with
  `LAMBDA_TASK=ready-check`.
- **Trade offers and accepted trades:** sent before the API answers (for at most a few seconds), because Lambda stops
  running as soon as it has replied.

## Alerts and cost

Set `alertEmail` in `cdk/lib/config.ts` and redeploy to get CloudWatch alarms (function errors, throttles, API 5xx, the
notification check failing) and a monthly budget warning (`monthlyBudgetUsd`) by email. AWS first sends a confirmation
email to that address; click its link. Logs are kept one week in CloudWatch (log groups `ServerLogs` and
`ReadyCheckLogs` in the backend stack).

## Running the site

- **Lost admin password:** from a computer signed in to AWS,
  `cd server && TABLE_NAME=<TableName output> AWS_REGION=us-east-2 cargo run -- reset-password <username>`. It prints a
  new password once and signs that account out everywhere.
- **Opening to everyone / closing again:** change `adminOnly` in `cdk/lib/config.ts`, merge to `main`, and approve the
  deploy. With it on, only admin accounts can sign in, sign up or play.
- **Restoring data:** the table has point-in-time recovery (the preceding 35 days). In the DynamoDB console choose the
  table, Backups, Restore to point in time, and restore into a **new** table. Check it (the admin panel's audit), then
  point the function at it by changing the table in `cdk/lib/packs-backend-stack.ts`, or copy the items you need back.
  The live table has deletion protection and a retain policy, so deleting the stack never deletes player data.
- **Rolling back a bad deploy:** revert the commit on `main`; the deploy workflow rebuilds and redeploys the previous
  version. If the deploy itself is stuck, CloudFormation rolls the failed stack back on its own.
- **Reading logs:** CloudWatch > Log groups > the backend stack's `ServerLogs`. Failed writes show as `warn`/`error`
  lines; every request is traced at `info`.
- **Health check:** `GET /api/health` answers `{"ok":true}` when the API can reach the database. Point an uptime monitor
  at `https://<your domain>/api/health`.

## Notes

- **Backups:** point-in-time recovery can restore the DynamoDB table to a point in time in the preceding 35 days.
- **Cost:** the table is pay-per-request and the rest of the stack is largely usage-based. Review AWS pricing before
  relying on estimates.
- **Admin audit and deleting accounts** run inside one API request (28 seconds at most). They are fine for hundreds of
  players; much larger games should move them to a command run from a laptop.

## Deploying from GitHub

Pull requests run `.github/workflows/ci.yml`: formatting, lint, the server tests against DynamoDB Local, the site build
and the CDK checks. Pushing to `main` runs the same checks and, only if they pass, `.github/workflows/deploy.yml` builds
the Lambda package on Linux (avoiding cross-compilation problems on developer machines) and deploys the CDK stacks.
`.github/workflows/audit.yml` looks weekly for known vulnerabilities, and Dependabot opens update pull requests.

To make every deploy wait for a person to approve it, add `environment: production` under the `deploy` job in
`deploy.yml` and add required reviewers in the repository's Settings > Environments > production. **Changing this changes
the identity GitHub presents to AWS** (from `ref:refs/heads/main` to `environment:production`), so update the role's
trust policy in the same change or the deploy will stop working. Also turn on branch protection for `main` (require pull
requests and the `ci` checks).

One-time setup:

1. Configure GitHub OIDC in AWS with provider `token.actions.githubusercontent.com` and audience `sts.amazonaws.com`.
2. Create a role trusted only by this repository's `main` branch (for the STMA fork,
   `repo:STMARobotics/frc-packs:ref:refs/heads/main`). Grant it permission to deploy the CDK stacks and use their
   bootstrapped assets in both `us-east-1` and `us-east-2`. Its ARN is configured directly in
   `.github/workflows/deploy.yml`.
