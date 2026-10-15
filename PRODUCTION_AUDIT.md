# FRC Packs production-readiness audit

Branch `dynamodb-and-new-cards`, HEAD `8ced01e`, audited 2026-10-13. Read-only: this file is the only thing created. Nothing was deployed and AWS was never contacted.

How to read it: severity is **Blocker** (don't open to real players until fixed), **High**, **Medium** or **Low**. Every finding cites a file and line I read. Anything I could not confirm from the code is marked *unverified*. Secrets: none found, so nothing to redact.

> **Update, 2026-10-14: fixes applied on branch `audit-fixes`.** After this audit, the STMA fork replaced `deploy/aws`
> (CloudFormation, Lambda URL) with `cdk/` (API Gateway), and is live on packs.7028robotics.com with admin-only off.
> The findings below were written against the original layout; the section "Status after fixes" at the end says what
> was fixed, what changed meaning with CDK, and what is still open. Blocker B1 does not apply to the CDK setup.

---

## Go / No-Go

**No-Go for opening to real players. Go for the next step: a first deploy in `ADMIN_ONLY=1` mode to a staging stack.**

The game server itself is in good shape. All 57 DynamoDB API tests pass, the money/serial/trade paths are transactional and tested against races, passwords are argon2, sessions are stored hashed, the front end escapes user text, and there are no secrets in the tree or in git history. The problems are almost all in the new AWS wiring, which has never run against real AWS:

### Top blockers (ranked)

1. **B1. Every write request is likely to be rejected by CloudFront's signed Lambda URL.** Lambda function URLs behind CloudFront origin access control require the browser to send an `x-amz-content-sha256` header on POST/PUT. The front end never sends it (`web/src/api.ts:290-299`). Login, signup, open, trade: all POSTs. This is from AWS's documented limit, not something I could run here, so *unverified until a staging deploy*, but if it holds the site cannot be played.
2. **B2. The sign-in rate limit can be bypassed or can lock everyone out.** The client address comes from the `cf-connecting-ip` header first (`server/src/auth.rs:60`), which any browser can set when the site is not behind Cloudflare. On AWS it is not. And if CloudFront does not forward `cloudfront-viewer-address` (the managed policy at `template.yaml:151` probably doesn't, *unverified*), every visitor counts as `"direct"` (`auth.rs:63`), so 50 bad logins from one person block sign-in for everyone on that Lambda instance.
3. **B3. "Free pack ready" notifications cannot work on AWS, and trade notifications are unreliable.** The only scheduler is a `tokio::spawn` loop skipped on Lambda (`main.rs:96`), the `ready-check` subcommand can't be invoked by EventBridge because the Lambda handler treats every event as HTTP (`main.rs:90-92`), and there is no schedule in `template.yaml`. Trade pushes are fired with `tokio::spawn` after the response (`push.rs:171`), and Lambda freezes once the response is sent. Ship with notifications off, or fix before advertising them.
4. **B4. Production auto-deploys on every push to `main` with no gate, and CI never runs on branches or PRs.** Tests run only inside the deploy job (`.github/workflows/deploy.yml:13-15, 43-48`). No environment approval, no rollback path (see H5).
5. **B5. No abuse or cost protection in front of the API.** No WAF, no reserved Lambda concurrency, no billing alarm, no CloudWatch alarms (`template.yaml`). With the in-memory limiter (per warm Lambda instance) that means credential-stuffing and a bill spike are both unbounded.

If B1 and B2 are fixed and verified on a staging stack, and B3 is either fixed or the feature is switched off, the rest can ship in `ADMIN_ONLY=1` while you work down the High list. Opening to the public (`ADMIN_ONLY=0`) should wait for B4 and B5 plus the High items.

---

## Checks run

| Check | Result |
| --- | --- |
| `cargo fmt --check` (server) | Pass |
| `cargo clippy --all-targets` | Pass, no warnings |
| `cargo build --release` | Pass (native Windows build; the Lambda arm64 build was **not** attempted, see H3) |
| `cargo test` against a DynamoDB Local already running on this PC (port 8765, tables `frc-packs-test` and `frc-own-*` only, not the dev table) | **57 passed, 0 failed**; plus unit tests and the 200,000-pack odds simulations |
| `tsc --noEmit` (web) | Pass. Note `app.js` (2,573 lines) is not type-checked: `checkJs` is false in `web/tsconfig.json` |
| `npm audit` (web) | 0 vulnerabilities |
| `cargo audit` | **Not run** (not installed). Run it in CI, see M10 |
| `npm run build` (web) | Not re-run separately; `deploy.sh site` runs it and `tsc` passed |
| Browser e2e (`web/test/e2e.cjs`) | **Not run** (needs Playwright's Chromium and a server with `DEV_TOOLS=1`) |
| Secrets scan of tree and full git history | None found (see S-section) |
| Front-end API paths vs server routes | Every path the site calls exists on the server (see I-section for the reverse) |

Without `DYNAMODB_ENDPOINT` the API tests silently skip and still report success (`server/tests/api.rs:17-19`, README "They're skipped without `DYNAMODB_ENDPOINT`"). A plain `cargo test` on a machine without DynamoDB Local is green and proves nothing about the API. CI sets it, so that is fine there.

---

## 1. Inconsistencies

| Sev | Where | What's wrong | Fix | Effort |
| --- | --- | --- | --- | --- |
| High | `web/src/api.ts:290-299` vs `deploy/aws/template.yaml:104-118` | Caller/callee mismatch: CloudFront OAC to a Lambda URL needs `x-amz-content-sha256` on POST (B1). | Either compute SHA-256 of the body in `call()` and send the header, or switch the API origin to a function URL with `AuthType: NONE` plus a secret origin header checked by the server, or use an HTTP API. Test on staging. | M |
| Medium | `web/public/privacy.html:48, 58` | Says the site is served through Cloudflare (it will be CloudFront; Cloudflare is DNS only per `docs/aws.md:25,43`) and that backups last two weeks (PITR is 35 days, `docs/aws.md:71`). It also doesn't mention beta feedback (title, details and a device/page string, `feedback.rs:34-40`) or AWS as the host. | Rewrite those lines. This page is shown to minors (it has a "Young players" section), so keep it accurate. | S |
| Medium | `docs/aws.md:66-68` vs `main.rs:68, 88-90` | Doc says an EventBridge rule can "run the function's `ready-check`". The Lambda binary only handles HTTP events, so that can't work as written (B3). | Fix the design (below), then the doc. | M |
| Medium | `deploy.yml:53` vs `docs/aws.md:50-58` | Doc table says template or `ADMIN_ONLY` changes need `deploy.sh infra`; CI runs only `server`/`site`/`all` and `path` triggers include `deploy/aws/**` (`deploy.yml:15`), so a pushed template change looks deployed but isn't. | Add an `infra` option to the workflow, or remove `deploy/aws/**` from the push paths and say so. | S |
| Medium | `deploy/aws/sync-static.sh:12-13` and `deploy.sh:24` | Pack recipes (`data/packs`) are shipped twice: into the Lambda zip (server rules) and into S3 (what the browser reads). `deploy.sh server` and `deploy.sh site` can be run separately, so the two can disagree about odds/teams. | Deploy recipes from one step, or have `all` be the only supported path for recipe changes; add a version check on `/api/state`. | S |
| Low | `README.md:62` ("Not done yet" list), `README.md:69` | README says rate limiting on pack opening is not done. True, but it isn't flagged as a launch consideration (see Missing features). | Fine to leave; mention in launch notes. | S |
| Low | `prototype/README.md` | Describes a 5-hour timer; the server defaults to 2 hours (`api.rs:51`). The prototype is a separate legacy tool so this is expected drift. | Add one line saying the prototype is frozen. | S |
| Low | `docs/dynamodb.md:15, 31` and `server/src/model.rs:3` | Still compare to "the Postgres version" (`lock_user`, triggers). Accurate history, but it reads like current behavior. | Trim or reword. | S |
| Low | `server/src/lib.rs:96`, `main.rs:19, 103`, `auth.rs:56` | Comments still mention Cloudflare, the system journal and systemd. Harmless; confusing for the next reader. | Update comments. | S |
| Low | `template.yaml` env vs `main.rs` / `model.rs:357` / `push.rs:86` | `GAME_TZ` and `PUSH_CONTACT` are read but not set in the stack. Defaults (`America/Chicago`, the GitHub repo URL) are reasonable. `BIND`, `WEB_DIR`, `DEV_TOOLS` are intentionally unset (Lambda serves no static files; dev tools off). No variable is defined and unread. | Add `GAME_TZ` and `PUSH_CONTACT` to the template so they are explicit. | S |

Clean: all routes in `web/src/api.ts`, `web/src/app.js`, `web/src/admin.ts` map to real server routes. The reverse gaps are in section 2 (dead code).

---

## 2. Shenanigans (dead code, workarounds, silent failures)

| Sev | Where | What | Fix | Effort |
| --- | --- | --- | --- | --- |
| Medium | `push.rs:118` | Comment says "only real push services", code only checks `https://` and length. The server then POSTs to whatever URL a signed-in player supplies (`push.rs:188-193`), and `reqwest` follows redirects by default (client built at `push.rs:85`). That's a blind SSRF: a player can make your Lambda call any HTTPS host, or redirect to an internal address. Body is encrypted so the impact is limited, but it is still your IP and your Lambda. | Allow-list the host suffixes of the real push services (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`) and set `redirect(Policy::none())`. | S |
| Medium | `api.rs:573-576` | Sign-in does not run the password hash for an unknown username, so unknown names answer much faster than known ones. Usernames can be enumerated by timing. (Signup already reveals taken names, so this is a modest leak.) | Verify against a dummy hash when the user is missing. | S |
| Medium | `push.rs:171-176`, `push.rs:237-246` | Background tasks spawned for notifications and the minute loop assume a long-lived process (B3). | See B3. | M |
| Medium | `admin.rs:122-123` (`audit_all` → `db.rs:193 scan_all`) | The admin "audit" scans the whole table with consistent reads inside a Lambda with a 20 s timeout (`template.yaml:95`). It will start timing out as data grows and costs real read units each click. | Run the audit as a CLI/scheduled job or paginate it into chunks. | M |
| Medium | `admin.rs:590-630` (`delete_user`) | Account deletion is a long run of separate writes, not one transaction, inside the same 20 s limit. A timeout leaves a half-deleted account (name freed, cards left behind or the reverse). | Make it resumable (mark "deleting" first, loop on retry) or run it from the CLI. | M |
| Low | `api.rs:179-187` | Idempotency: if the Lambda dies after the transaction commits but before `idem_end` writes the saved answer, a retry gets `409 in_progress` for 2 days even though the action happened. | On `in_progress`, rebuild the answer from state, or shorten the marker TTL. | S |
| Low | `admin.rs:79` | `let _ = req.boosted;` ignores a request field (the test pack always shows one of each rarity). | Drop the field from the request type and UI. | S |
| Low | `api.rs:1432` | Mythic packs disabled by a compile-time constant `MYTHIC_PACKS_ON = false`, with UI hidden by hand-editing `web/index.html`. Easy to desync. | Make it an admin setting or env flag. | S |
| Low | `server/src/specials.rs:32` | `POST /api/specials/grant` exists but nothing in `web/` calls it (admin-only API with no UI, presumably used via curl). | Document it or add a button. | S |
| Low | `api.rs:150-187` | `serde_json::...unwrap_or_default()` on stored hands/answers turns corrupt data into "empty" silently (a bad stored hand is treated as no hand and re-rolled, `api.rs:927`). Safe by design, but nothing logs it. | Log at `warn` when it happens. | S |
| Low | `web/src/app.js` (2,573 lines, plain JS, `checkJs: false`) | The core of the game gets no type checking, and `innerHTML` is used in ~105 places. I read the user-controlled ones (usernames, first names, feedback, report text, badge, trade names) and all go through `esc()` (`app.js:206`), so I found no XSS. `esc()` does not escape `'` (low risk since attributes use double quotes). | Add `esc` for `'`; consider `// @ts-check` gradually. | M |
| Low | `data/photos/upscaled/` (untracked, not in `.gitignore`) | A large untracked image folder next to 505 tracked photos (41 MB, repo `.git` is 21 MB). Easy to commit by accident. | Add to `.gitignore` or commit deliberately. | S |
| Low | `prototype/`, `design/battler/`, `docker-compose.yml` | Legacy prototype and design experiments are tracked in the main repo. Not shipped (deploy only copies `web/dist`, `data/photos`, `data/packs`) so this is clutter, not risk. | Optional: move to a branch/folder note. | S |

No TODO/FIXME/HACK/XXX markers, `println!`/`dbg!` or debug logging in server or web source. The few `.unwrap()`/`.expect()` calls on request paths are on infallible values (header values, `Tier::position`, a fixed date).

---

## 3. Missing features

| Sev | Where | What's missing | Fix | Effort |
| --- | --- | --- | --- | --- |
| Blocker | `template.yaml` (whole file) | No WAF, no Lambda reserved concurrency, no budget/billing alarm, no CloudWatch alarms (5xx, throttles, DynamoDB throttling). Open internet → Lambda → DynamoDB with no brake (B5). | Add a WAF web ACL with a rate rule on `/api/login` and `/api/signup`, set `ReservedConcurrentExecutions`, add an AWS Budget and 3-4 alarms to an SNS email. | M |
| High | `accounts.rs:246` (`Limiter`) and `docs/aws.md:69-70` | The brute-force limiter is per-process memory, so each warm Lambda counts separately and cold starts reset it. The doc admits this and points to WAF; WAF isn't in the template. | WAF rate rule (above), or a DynamoDB-backed counter with TTL. | M |
| High | `template.yaml:20-26, 140-152` and `lib.rs:69-91` | No security response headers anywhere: no HSTS, no CSP, no `X-Content-Type-Options`, no `Referrer-Policy`, no frame protection (a grep across `server/`, `web/`, `deploy/` finds none). The page loads Google Fonts (`web/index.html:16-18`), so a CSP must allow `fonts.googleapis.com` / `fonts.gstatic.com`. | Add a CloudFront ResponseHeadersPolicy. | S |
| High | `deploy/aws/deploy.sh:13-33, 56-60` and `deploy.yml` | No rollback. The Lambda zip is overwritten at one fixed S3 key (`frc-packs-lambda.zip`), `update-function-code` publishes no version or alias, and CloudFront serves the new site at once. Reverting means rebuilding an older commit. | Publish Lambda versions + an alias, key the zip by commit SHA, enable S3 bucket versioning on the code bucket. | M |
| High | `deploy.yml:12-15, 43-48` | CI runs only on pushes to `main` and only as part of a deploy; nothing runs on PRs or feature branches. No fmt/clippy/tsc/e2e step; no required reviewers or GitHub Environment approval before production. | Add a PR workflow (fmt, clippy, `cargo test` with DynamoDB Local, `npm run build`) and put the deploy job behind a protected Environment. | S |
| High | Lambda build, `deploy.sh:15`, `deploy.yml:41`, `docs/aws.md:77-79` | The Lambda package has never been built. On Windows it fails (Zig `CacheCheckFailed`), and the Linux CI path has never run (also `pip install cargo-lambda` is unpinned; `deploy.sh:26` uses `python`, which GitHub's Ubuntu runners may not provide, *unverified*). First deploy is the first test of the package. | Do a trial run of the workflow with `AWS_ROLE_ARN` pointed at a throwaway stack/account; pin tool versions; use `python3`. | S |
| High | `template.yaml` (no `AWS::Logs::LogGroup`, no alarms) | Logs go to an auto-created log group with **no retention** (kept forever, small cost) and nobody is told about errors. | Add a LogGroup with 30-90 days and alarm on `ERROR` metric filter / 5xx. | S |
| Medium | `template.yaml:29-50` | DynamoDB: PITR on, `DeletionPolicy: Retain`, on-demand. Good. Missing: table `DeletionProtectionEnabled`, and a restore runbook (how to restore PITR into a new table and repoint `TABLE_NAME`). | Add deletion protection and a short restore section to `docs/aws.md`. | S |
| Medium | `template.yaml:78-87` | IAM is scoped to the one table and its indexes (good), but includes `dynamodb:Scan` for the admin audit and nothing denies items other than the app's own use. Acceptable; revisit if the audit moves off Lambda. | Drop `Scan` when the audit moves. | S |
| Medium | `docs/aws.md` | No runbook: restoring a backup, rotating a lost admin password in prod (`reset-password` command needs AWS credentials on a dev machine), the order to flip `ADMIN_ONLY`, what to watch after launch, how to read logs. The admin-creation step exists (`docs/aws.md:44-48`) but depends on a laptop with AWS credentials. | Write a short operations page. | M |
| Medium | `deploy.yml:12-15`, `README.md:1-80` | The browser e2e test (`web/test/e2e.cjs`) and `web/test/load.cjs` are not wired into CI; the e2e needs a server running with `DEV_TOOLS=1`, which must never be set in prod. | Run e2e in CI against DynamoDB Local; keep `DEV_TOOLS` out of the stack (it is, `template.yaml:98-103`). | M |
| Medium | `server/src/api.rs` (open/claim/scrap) | No rate limit on pack opening or other write endpoints (README admits this). Each open reads the player's whole collection (`model::cards`) with consistent reads, so a scripted client can burn DynamoDB capacity cheaply for them and expensively for you. | Add a per-user request limiter (and the WAF rule above). | M |
| Medium | `server/src/auth.rs:30, 79` | Sessions last 400 days with no rotation or idle timeout; a stolen cookie works for over a year until password change/sign-out-everywhere. | Shorten to 30-90 days with sliding renewal. | S |
| Medium | `push.rs:247` (`ready_check`) | Even when scheduled, it reads every user via `gsi1 USERS` and checks subscriptions per due user each run. Fine for hundreds of users, linear cost as you grow. | Index "due to notify" or keep per-user timers. | M |
| Low | `template.yaml` | No CloudFront access logs, no custom error responses (a missing S3 key returns S3's 403 XML, not a friendly page), no `/health` monitor (the endpoint exists at `/api/health`, `api.rs:199`). | Add a Route 53 / UptimeRobot check on `/api/health`. | S |
| Low | Accessibility | Not audited in a browser (not run). Source shows some `aria-label` use (`app.js:1191, 2015`) but the game is heavily gesture-driven. Marked *unverified*. | Run an a11y pass (keyboard, screen reader, contrast) before a school audience. | M |
| Low | Test coverage | Strong on economy, trades, races, admin, feedback (57 API tests + odds sims). No tests for push sending (`push.rs`), CloudFront/Lambda glue, the `main.rs` commands, or front-end logic outside the e2e bot. | Add a push test with a mock endpoint (also covers the SSRF fix). | M |

---

## 4. Security

Already good (verified in code): argon2id password hashing run off the request threads (`accounts.rs:108`); session tokens are 32 random bytes, stored only as a SHA-256 hash (`auth.rs:17-29`); cookie is `HttpOnly; SameSite=Lax; Secure` when `COOKIE_SECURE` (`auth.rs:37-39`, set to `"1"` in the template); non-JSON writes to `/api` are rejected (`lib.rs:119`), which with SameSite closes the usual CSRF route; every handler takes `User` or `Admin` extractors, and `ADMIN_ONLY` is enforced in sign-in, sign-up, `/session` and the extractor (`api.rs:447-448, 492, 587`, `auth.rs:103`); admin routes all require `Admin`; DEV_TOOLS endpoints return 403 unless the flag is on, and the template does not set it; the Lambda URL is `AWS_IAM` behind CloudFront, so it isn't public; the S3 bucket is fully private behind OAC; pack odds, serials and holdings are decided server-side with conditional transactions; no CORS is configured (same origin, correct).

| Sev | Where | Issue | Fix | Effort |
| --- | --- | --- | --- | --- |
| Blocker | `auth.rs:58-65` | **Spoofable client IP (B2).** `cf-connecting-ip` is trusted from any caller. On AWS an attacker rotates that header to dodge the per-visitor, per-username-and-visitor and invite-code limits (`api.rs:489, 567-569`); only the global per-username cap (100 failures/15 min per instance) remains. Conversely, if CloudFront strips `cloudfront-viewer-address`, all visitors collapse into `"direct"` and one person locks everyone out. | Behind CloudFront, use only `CloudFront-Viewer-Address`, and use origin request policy `AllViewerAndCloudFrontHeaders-2022-06` so it is actually forwarded; drop `cf-connecting-ip` unless a Cloudflare proxy is deliberately used. Verify on staging with a curl that sets a fake header. | S |
| High | `template.yaml:20-26` | No HSTS/CSP etc. (see Missing features). | ResponseHeadersPolicy. | S |
| High | `deploy.yml:17-19, 31` | The workflow assumes an AWS role via OIDC (good, no long-lived keys), but the role's trust policy and permissions exist only as prose in `docs/aws.md:81-87`. If the trust condition isn't pinned to `ref:refs/heads/main` of this repo, any branch could deploy. | Provide the role as a CloudFormation snippet with the `sub` condition; keep it least-privilege. | S |
| Medium | `push.rs:118, 188-193` | SSRF via push subscription endpoint, redirects followed (see Shenanigans). | Allow-list hosts, disable redirects. | S |
| Medium | `api.rs:573-576` | Login timing reveals which usernames exist. | Dummy-hash verify. | S |
| Medium | `auth.rs:30` | Long-lived sessions (400 days). | Shorten and slide. | S |
| Medium | `deploy.yml:22, 28, 33, 35, 38` | Third-party actions are pinned to major tags (`@v4`, `@stable`, `@v2`), `pip install cargo-lambda` is unpinned. A compromised tag would run with deploy credentials. | Pin to commit SHAs / versions; enable Dependabot for Actions. | S |
| Medium | `Cargo.toml` / `package.json` | `cargo audit` not run (not installed here); `npm audit` is clean. Rust edition 2024 and fairly new crates; I can't vouch for advisories. | Add `cargo audit` (or `cargo deny`) to the PR workflow. | S |
| Low | `accounts.rs:127, 142` | Invite codes are about 59 bits and only limited by the (bypassable) visitor limiter; brute force is still infeasible at that entropy. Admin password is about 79 bits. | None needed once B2 is fixed. | - |
| Low | `api.rs:199` | `/api/health` is unauthenticated and does a DB read; fine for monitoring, but it's an unthrottled DB read path an attacker can hammer. | Covered by the WAF rate rule. | S |
| Low | `web/public/sw.js` | Service worker has no fetch caching (by design), push handler trusts `msg.url` but resolves it against the site origin (`sw.js:23`), so it can't navigate off-site. Fine. | None. | - |

Secrets: scanned tracked files and the full git history for AWS keys, private keys, GitHub/other tokens, `.env`/`.pem` files and hardcoded passwords. **Nothing found.** `.env` is ignored (`.gitignore`, `deploy/aws/.gitignore`). History does contain a throwaway local Postgres URL (`postgres://frc:frc@localhost`), used for local dev only and removed from the tree. The VAPID private key is generated at runtime and stored in the DynamoDB settings item (`push.rs:60`), so anyone with table read access has it; keep the table policy tight. `prototype/fetch_photos.py` reads a TBA key from the environment, not hardcoded.

---

## Proposed fix order

**Before the first staging deploy (do now)**
1. B1: decide the CloudFront-to-Lambda signing approach and implement it (M).
2. B2: fix `visitor()` and the origin request policy (S).
3. Run the GitHub workflow once against a throwaway stack to prove the Linux Lambda build (S); pin tool versions (S).
4. Add a PR workflow so tests run before merge (S).

**Before inviting any real player (still `ADMIN_ONLY=1` is fine for testing)**
5. Response headers policy (S), log group retention and alarms (S), budget alert (S), Lambda reserved concurrency (S).
6. Push SSRF allow-list (S), login timing (S), shorten session lifetime (S).
7. Rewrite the privacy page to match AWS/CloudFront, 35-day backups and feedback data (S).
8. Disable or fix notifications (B3): simplest is to hide the "free pack ready" toggle for launch; trade pushes are best-effort until the sends are awaited before the response returns (S to disable, M to do properly).
9. Deploy approval gate and rollback (versioned Lambda zip and alias) (M).
10. WAF rate rules on `/api/login`, `/api/signup` (M).

**Before opening to the public (`ADMIN_ONLY=0`)**
11. Operations runbook: restore from PITR, lost admin password, flipping `ADMIN_ONLY`, where logs are (M).
12. Move the admin audit and account deletion off the 20 s Lambda path (M).
13. Per-user request limits on write endpoints (M).
14. Accessibility pass and a browser e2e run in CI (M).

**Can wait**
15. Doc and comment drift (Postgres/Cloudflare/systemd mentions), unused `boosted` field, Mythic pack flag, `specials/grant` UI, `.gitignore` for `data/photos/upscaled/`, prototype/design folder cleanup, `cargo audit` in CI, adding `'` to `esc()`.

---

## Status after fixes (branch `audit-fixes`, based on the fork's `main` plus the feedback commit)

Verified locally: `cargo fmt`, `clippy -D warnings` (also with `--features lambda`), 17 unit tests, all 57 API tests against
DynamoDB Local, `tsc`, site build, `cdk synth` checks (`npm run cdk:test`), and the game, admin and privacy pages loaded in a
browser against the new headers with no policy violations. **Not verified (needs a real deploy):** the Lambda ARM build on
Linux, the CloudFormation resolution of the secret, the CloudFront behaviors, EventBridge firing, service-worker
registration under the new CSP (the in-app browser can't register service workers), and the alerts.

| Finding | Result |
| --- | --- |
| B1 CloudFront signing of POSTs | **Not applicable to the fork.** It uses API Gateway behind CloudFront, not a signed Lambda URL. |
| B2 client address / sign-in limits | **Partly mitigated.** `auth.rs` trusts only `CloudFront-Viewer-Address`, and the CDK request policy forwards it while not forwarding `Host`. The origin secret was later removed; direct API Gateway callers can now supply a forged visitor address. The limiter is also per Lambda instance, so it remains best-effort. |
| B3 notifications on Lambda | **Fixed.** A scheduled second function runs the free-pack check every 5 minutes (`LAMBDA_TASK=ready-check`); trade notifications are now sent before the response returns. |
| B4 deploy gate / CI | **Mostly fixed.** New `ci.yml` (fmt, clippy `-D warnings`, API tests with DynamoDB Local, site build, CDK checks) runs on PRs and before every deploy; the fork had dropped its server tests. Actions pinned to commit SHAs, `cargo-lambda` pinned, weekly `audit.yml`, Dependabot. **Open:** the approval step needs a repo setting plus a role trust change (documented in `docs/aws.md`), and branch protection on `main`. |
| B5 abuse and cost | **Partly fixed.** API Gateway throttle (100 req/s, burst 200), alarms and a monthly budget email (turn on by setting `alertEmail` in `cdk/lib/config.ts`). **Open:** no WAF (about $6 a month; recommended before a public push) and no per-user write limits. |
| Security headers | **Fixed.** CSP, HSTS, nosniff, frame deny, referrer policy from both CloudFront and the server; a CDK test keeps the two CSPs identical. |
| Push SSRF | **Fixed.** Only the real push services' hosts are accepted; redirects are off; unit-tested. |
| Login timing leak | **Fixed.** Unknown usernames pay for a hash check. |
| 400-day sessions | **Fixed.** 90 days (existing sessions end 90 days after they were made). |
| Log retention, table deletion protection | **Fixed** (the fork already kept logs one week; deletion protection added). |
| Privacy page drift | **Fixed.** AWS instead of Cloudflare, 35-day backups, feedback data, new date. |
| Doc drift, comments, `PUSH_CONTACT` pointing at the old repo | **Fixed.** `docs/aws.md` gained protections, notifications, alerts and a runbook (lost admin password, restore, rollback, logs, health check). |
| Dead `boosted` field on the test-pack request, `esc()` missing `'` | **Fixed.** |

### Still open (not changed)

- **Rollback** is "revert the commit and redeploy"; there are no Lambda versions or aliases (documented).
- **Failed-sign-in limiter is per Lambda instance** (documented; WAF is the real fix).
- **Admin audit full-table scan and account deletion run inside one API request** (28 s). Fine for hundreds of players.
- **Idempotency marker** can leave a retry answering `in_progress` for up to 2 days after a crash mid-request.
- **Per-user limits on opening/scrapping** (API-wide throttle only).
- **Accessibility pass and browser e2e in CI** (e2e is not wired up).
- **`cargo audit`** now runs weekly in CI; I could not run it locally.
- **Windows developers cannot install the site's tools from the lockfile.** The root `package-lock.json` records only the
  Linux native packages for TypeScript 7 and Rolldown, so `npm ci` on Windows gives `Unable to resolve
  @typescript/typescript-win32-x64` / `Cannot find native binding`. CI on Linux is unaffected. Regenerating the lockfile
  with all platforms (or installing those optional packages) fixes it. I worked around it locally with `--no-save` installs
  and did not touch the lockfile.
- **Service worker under the new CSP** should be checked in a real browser after the first deploy (install the app, turn
  on notifications).
- The fork's `deploy.yml` still has the account id and role name hard-coded (not secrets).
