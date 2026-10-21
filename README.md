# frc-packs

Pokémon-style packs, but every card is an FRC team's robot.

- `web/` and `server/`: the real site. A Rust server decides what's in every pack and keeps everyone's cards; the site shows it.
- `prototype/`: the original single-file prototype (everything in the browser). Still playable: open `prototype/index.html`. See `prototype/README.md`.
- `data/`: shared data. Rosters, robot photos, and the pack recipes the server and site both read.

## How it fits together

```
browser (web/, Vite + TypeScript)
   │  JSON over /api, photos from /photos, pack recipes from /packs
   ▼
server/ (Rust: Axum)  ──►  DynamoDB (one table, see docs/dynamodb.md)
   reads data/packs/*.json (what's in each pack, odds, pity rules)
```

- **Packs are data.** `data/packs/cmp26.json` holds the 2026 Championship pack: its 515 teams with their rarity, the odds and the Mythic meter rules. `tools/build_packs.py` builds it from `data/cmp-2026.txt`. Adding a pack means adding a recipe there, not code.
- **Battler stats.** `tools/battler_stats.py` computes each team's AUTO / TELE / END (normalized season EPA × phase share) and RP1–3 chances from Statbotics, per the Battler spec, into `data/battler-2026.txt`; rerun `build_packs.py` afterwards and they show up on the cards. The battler card itself is prototyped in `design/battler/`.
- **The server owns everything that matters.** It rolls packs, mints serial numbers (No. 1, No. 2, ... per card), runs the free-pack timer and the Mythic meter, and stores every card. The browser can't change any of it.
- **Accounts by invite.** New players join with an invite code, then sign in with a username and password on any device. Passwords are stored as argon2 hashes and sessions as hashes of a cookie token; repeated wrong guesses get blocked for 15 minutes. One admin account makes invite codes and manages accounts at `/admin`.
- **Scrap and craft.** Extra copies of a card can be scrapped for parts in the binder (the first copy is always kept): 5 for a Common up to 600 for a Mythic. Parts buy a boosted pack (250 by default, set in the admin panel) with better odds, Legendary or better in about half of them and Mythic 4x as likely. A recipe can set its own boosted odds under `odds.boosted`.
- **Controller support.** Any standard gamepad plays the whole thing: A takes, opens and flips, B goes back, X turns the pack over, Y reveals the rest, the d-pad moves (and spins the wheel), the sticks tilt what you're holding, LB/RB switch tabs and Start claims free packs.

## Run it locally

You need Rust (rustup.rs), Node 20 or newer, and a local DynamoDB (Docker is easiest; or AWS's DynamoDB Local jar with Java).

```sh
docker compose up -d                       # DynamoDB Local on localhost:8765

cd server
DYNAMODB_ENDPOINT=http://localhost:8765 DEV_TOOLS=1 cargo run
                                           # API on http://127.0.0.1:3000; makes its table on start

cd web                                     # in another terminal
npm install
npm run dev                                # open http://localhost:5173 (proxies /api to the server)
```

To try it the way it will run in production, `npm run build` in `web/`, then open http://127.0.0.1:3000: the server serves the built site itself.

To sign in, make the admin account (it prints the password), then make invite codes for other test accounts at `/admin`:

```sh
cd server
DYNAMODB_ENDPOINT=http://localhost:8765 cargo run -- create-admin
```

### Server settings

| Variable | Default | What it does |
| --- | --- | --- |
| `TABLE_NAME` | `frc-packs` | The DynamoDB table |
| `DYNAMODB_ENDPOINT` | AWS | A local DynamoDB to use instead of AWS (the table is made on start) |
| `ADMIN_ONLY` | off | Only admin accounts can sign in or play (for testing on the real domain) |
| `GAME_TZ` | `America/Chicago` | When daily missions and the streak roll over |
| `BIND` | `127.0.0.1:3000` | Address to listen on |
| `DATA_DIR` | `../data` | Where `packs/` and `photos/` are |
| `WEB_DIR` | `../web/dist` | The built site; skipped if it isn't there |
| `DEV_TOOLS` | off | Testing helpers in Settings (demo luck, +1 pack, skip timer, reset) and free invite codes for the browser test. **Never turn on in production.** |
| `COOKIE_SECURE` | off | Mark the session cookie HTTPS-only. Turn on when hosted over HTTPS. |
| `LAMBDA_TASK` | off | On AWS only: `ready-check` makes a function run the "free pack ready" check instead of serving the API. |
| `PUSH_CONTACT` | this repository's URL | Who push services can contact about notifications (an `https:` or `mailto:` address). |

## Host it

On AWS: CDK manages DynamoDB, the API Lambda, and S3 + CloudFront. See [docs/aws.md](docs/aws.md).

## Tests

```sh
cd server && DYNAMODB_ENDPOINT=http://localhost:8765 cargo test
```
Odds over 200,000 simulated packs, the pity guarantees, and API tests against a real database (claims, packs in hand, opening, serial numbers, division sets, two tabs opening at once, resuming a pack mid-reveal, invite codes, signing in on two devices, password guessing, the admin panel). The API tests also try to cheat: simultaneous opens, claims, crafts and mission claims, two offers racing for one card, serials pulled at the same moment, forged packs in hand, and trading cards still being revealed. They're skipped without `DYNAMODB_ENDPOINT`.

```sh
cd web && npx playwright install chromium   # once
npm run build                               # then start the server with DEV_TOOLS=1 (it serves web/dist)
npm test                                    # a browser bot signs up and plays packs against the server
```
Set `ADMIN_USER` and `ADMIN_PASSWORD` to the admin account to check the admin panel too.

## Not done yet

- Signing in with Google (needs a Google Cloud OAuth client) or the 7028 portal.
- Rate limiting on pack opening (sign-in and invite codes are limited, and API Gateway caps total requests).
- More packs.
