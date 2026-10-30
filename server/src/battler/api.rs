//! The Battler's HTTP API, under /api/battler. Every request reads the game fresh, applies one rule from
//! [`super::game`], and writes it back on condition the game's version is unchanged, so two tabs, a double tap or a
//! script can never apply an action twice or act on a stale game. Ownership is read from FRC Packs (the player's
//! cards) and never written here.
//!
//! Items (see docs/dynamodb.md):
//! - `BG#<id>` / `GAME`: the whole game as JSON, `ver`; while it's waiting for a second player, GSI1 `BGQUICK` for a
//!   Quick Play game (the queue) or `BGOPEN` for an old listed one. Private games are in no index.
//! - `BGCODE#<code>` / `CODE`: the private game a code invites to.
//! - `BG#<id>` / `WAGER`: a private game's wager (see crate::wagers, which moves the stakes; the Battler only says who
//!   won).
//! - `U#<id>` / `BTACTIVE`: the game a player is in (one at a time).
//! - `U#<id>` / `BTPROF`: rating and record.
//! - `U#<id>` / `BTDECK#<deck>`: a saved deck.
//! - `U#<id>` / `BTHIST#<time>#<game>`: a finished game, for match history.
//! - `BTFX#<team>` / `FX`: a robot's admin-written effect (draft and published); GSI1 `BTFX`. `BTFX#<team>` / `REV#<n>`:
//!   each published revision.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::content::{self, Kind, Robot};
use super::effects::{self, Effect, Owner};
use super::engine::{self, FieldRobot};
use super::game::{self, DeckPick, Game, Mode, RobotPick, Seat, Status};
use crate::Shared;
use crate::auth::{Admin, User};
use crate::db::{Cond, Db, Tx, from_item, get_n, get_s, item, n, pad, s};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, now_ms, upk};
use crate::retry;

/// Everyone gets this many copies of every starter Part and Lore card until they can be pulled from packs.
pub const STARTER_COPIES: usize = 3;
pub const START_ELO: i32 = 1000;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/battler/home", get(home))
        .route("/battler/leaderboard", get(leaderboard))
        .route("/battler/catalog", get(catalog))
        .route("/battler/decks", post(create_deck))
        .route("/battler/decks/{id}", put(save_deck).delete(delete_deck))
        .route("/battler/quick", post(quick))
        .route("/battler/games", post(create_game))
        .route("/battler/code/{code}", get(find_code))
        .route("/battler/games/{id}", get(view_game))
        .route("/battler/games/{id}/join", post(join_game))
        .route("/battler/games/{id}/act", post(act))
        .route("/battler/games/{id}/emote", post(emote))
        .route("/battler/games/{id}/wager", put(set_stake).delete(call_off))
        .route("/battler/games/{id}/wager/accept", post(accept_wager))
        .route("/battler/history", get(history))
        .route("/battler/admin/effects", get(admin_effects))
        .route("/battler/admin/effects/{team}", put(admin_save_effect))
        .route("/battler/admin/preview", post(admin_preview))
}

fn bad(code: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, code)
}

fn refused(code: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code)
}

// ---------- profiles, ownership, effects ----------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct BtProfile {
    pub elo: i32,
    pub games: i32,
    pub wins: i32,
    pub losses: i32,
    pub draws: i32,
}

pub(crate) async fn bt_profile(db: &Db, uid: Uuid) -> ApiResult<BtProfile> {
    Ok(db.get_as(&upk(uid), "BTPROF").await?.unwrap_or(BtProfile { elo: START_ELO, ..Default::default() }))
}

#[derive(Serialize)]
struct LeaderboardPlayer {
    rank: usize,
    name: String,
    #[serde(flatten)]
    profile: BtProfile,
    me: bool,
}

fn rank_leaderboard(mut players: Vec<LeaderboardPlayer>) -> Vec<LeaderboardPlayer> {
    players.retain(|p| p.profile.games > 0);
    players.sort_by(|a, b| b.profile.elo.cmp(&a.profile.elo).then_with(|| a.name.cmp(&b.name)));
    let mut rank = 0;
    let mut previous = None;
    for (i, player) in players.iter_mut().enumerate() {
        if previous != Some(player.profile.elo) {
            rank = i + 1;
        }
        player.rank = rank;
        previous = Some(player.profile.elo);
    }
    players.truncate(25);
    players
}

/// Read the existing account index and batch-load ratings, including players rated before the leaderboard existed.
/// No table scan, new index or migration is needed. Only public names and Battler records leave this endpoint.
async fn leaderboard(State(st): State<Shared>, user: User) -> ApiResult<Json<Vec<LeaderboardPlayer>>> {
    let players = crate::trades::all_players(&st.db).await?;
    let mut names: HashMap<String, (String, bool)> =
        players.into_iter().filter_map(|p| p.username.map(|name| (upk(p.id), (name, p.id == user.id)))).collect();
    let keys = names.keys().map(|pk| crate::db::key(pk, "BTPROF")).collect();
    let mut rows = vec![];
    for it in st.db.batch_get(keys).await? {
        let Some((name, me)) = get_s(&it, "pk").and_then(|pk| names.remove(&pk)) else { continue };
        let profile: BtProfile = from_item(it)?;
        rows.push(LeaderboardPlayer { rank: 0, name, profile, me });
    }
    Ok(Json(rank_leaderboard(rows)))
}

#[cfg(test)]
mod leaderboard_tests {
    use super::*;

    #[test]
    fn orders_by_elo_shares_tied_ranks_and_excludes_unplayed_accounts() {
        let row = |name: &str, elo, games| LeaderboardPlayer {
            rank: 0,
            name: name.into(),
            profile: BtProfile { elo, games, ..Default::default() },
            me: false,
        };
        let mut rows = vec![row("new", 2000, 0), row("zebra", 1200, 2), row("alpha", 1200, 3), row("third", 1100, 1)];
        rows.extend((0..30).map(|i| row(&format!("player{i:02}"), 1000 - i, 1)));
        let ranked = rank_leaderboard(rows);
        assert_eq!(ranked.len(), 25);
        assert_eq!(ranked[0].name, "alpha");
        assert_eq!(ranked[1].name, "zebra");
        assert_eq!(ranked.iter().take(3).map(|p| p.rank).collect::<Vec<_>>(), vec![1, 1, 3]);
        assert!(ranked.iter().all(|p| p.profile.games > 0));
        assert!(ranked.windows(2).all(|p| p[0].profile.elo >= p[1].profile.elo));
        assert!(rank_leaderboard(vec![]).is_empty());
    }
}

/// The teams a player owns at least one card of, read from their FRC Packs collection.
async fn owned_teams(db: &Db, uid: Uuid) -> ApiResult<HashSet<i32>> {
    Ok(model::cards(db, uid, content::PACK).await?.into_iter().map(|c| c.team).collect())
}

fn support_owned(st: &Shared) -> HashMap<String, usize> {
    st.battler.support.iter().map(|c| (c.id.clone(), STARTER_COPIES)).collect()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct FxItem {
    team: i32,
    /// The admin's working copy.
    #[serde(default)]
    draft: Vec<Effect>,
    /// What players get; empty until published.
    #[serde(default)]
    published: Vec<Effect>,
    #[serde(default)]
    rev: i32,
    #[serde(default)]
    author: String,
    #[serde(default)]
    updated: i64,
}

/// Every robot's admin-written effect, by team.
async fn robot_effects(db: &Db) -> ApiResult<HashMap<i32, FxItem>> {
    let mut out = HashMap::new();
    for it in db.index("gsi1", "BTFX", None, false).await? {
        if let Ok(fx) = from_item::<FxItem>(it) {
            out.insert(fx.team, fx);
        }
    }
    Ok(out)
}

/// A robot's effect in play: the published one, else a test example, else none.
fn effect_for(st: &Shared, fx: &HashMap<i32, FxItem>, team: i32) -> (Vec<Effect>, bool) {
    match fx.get(&team) {
        Some(f) if !f.published.is_empty() => (f.published.clone(), false),
        _ => match st.battler.test_effects.get(&team) {
            Some(e) => (e.clone(), true),
            None => (vec![], false),
        },
    }
}

// ---------- catalog and home ----------

#[derive(Serialize)]
struct RobotOut<'a> {
    #[serde(flatten)]
    robot: &'a Robot,
    effect_text: String,
    effect_test: bool,
}

async fn catalog(State(st): State<Shared>, _user: User) -> ApiResult<Json<Value>> {
    let fx = robot_effects(&st.db).await?;
    let robots: Vec<RobotOut> = st
        .battler
        .robots
        .iter()
        .map(|r| {
            let (e, test) = effect_for(&st, &fx, r.team);
            RobotOut {
                robot: r,
                effect_text: if e.is_empty() { String::new() } else { effects::describe(&e, Owner::Robot) },
                effect_test: test,
            }
        })
        .collect();
    Ok(Json(json!({
        "season": content::SEASON,
        "rp_names": content::rp_names(content::SEASON),
        "rules": {
            "rounds": game::ROUNDS, "deck_robots": game::DECK_ROBOTS, "support_cards": game::SUPPORT_CARDS,
            "draw": game::DRAW, "max_copies": game::MAX_COPIES, "pit_seconds": game::PIT_MS / 1000,
            "results_seconds": game::RESULTS_MS / 1000, "strikes": game::STRIKES, "start_elo": START_ELO,
            "pool_size": game::POOL_SIZE, "offer": game::OFFER, "draft_seconds": game::DRAFT_MS / 1000, "intro_seconds": game::INTRO_MS / 1000,
            "drain": game::DRAIN, "recharge": game::RECHARGE, "repair_battery": game::REPAIR_BATTERY,
        },
        "robots": robots,
        "support": st.battler.support,
        "tags": effects::TAGS,
    })))
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Deck {
    id: String,
    name: String,
    captain: Option<i32>,
    #[serde(default)]
    robots: Vec<i32>,
    #[serde(default)]
    support: Vec<String>,
    #[serde(default)]
    updated: i64,
}

/// What stops a deck from being played (empty = ready).
fn deck_problems(st: &Shared, owned: &HashSet<i32>, d: &Deck) -> Vec<String> {
    let c = &st.battler;
    let mut out = vec![];
    match d.captain {
        None => out.push("Pick an Alliance Captain.".to_string()),
        Some(t) if c.robot(t).is_none() => out.push(format!("Team {t} isn't in this set.")),
        Some(t) if !owned.contains(&t) => out.push(format!("You don't own team {t} (captain) any more.")),
        _ => {}
    }
    if d.robots.len() != game::DECK_ROBOTS {
        out.push(format!("Robots {}/{}.", d.robots.len(), game::DECK_ROBOTS));
    }
    let mut seen = HashSet::new();
    for t in d.captain.iter().chain(&d.robots) {
        if !seen.insert(*t) {
            out.push(format!("Team {t} is in the deck twice."));
        }
    }
    for t in &d.robots {
        if c.robot(*t).is_none() {
            out.push(format!("Team {t} isn't in this set."));
        } else if !owned.contains(t) {
            out.push(format!("You don't own team {t} any more."));
        }
    }
    if d.support.len() != game::SUPPORT_CARDS {
        out.push(format!("Support cards {}/{}.", d.support.len(), game::SUPPORT_CARDS));
    }
    let mut copies: HashMap<&str, usize> = HashMap::new();
    for id in &d.support {
        *copies.entry(id.as_str()).or_default() += 1;
    }
    let have = support_owned(st);
    for (id, k) in copies {
        match c.support(id) {
            None => out.push(format!("Unknown card {id}.")),
            Some(card) if k > game::MAX_COPIES => {
                out.push(format!("At most {} copies of {}.", game::MAX_COPIES, card.name))
            }
            Some(card) if k > have.get(id).copied().unwrap_or(0) => {
                out.push(format!("You only own {} {}.", have[id], card.name))
            }
            _ => {}
        }
    }
    out
}

async fn decks(db: &Db, uid: Uuid) -> ApiResult<Vec<Deck>> {
    Ok(db.query(&upk(uid), "BTDECK#").await?.into_iter().filter_map(|it| from_item(it).ok()).collect())
}

async fn active_game(db: &Db, uid: Uuid) -> ApiResult<Option<String>> {
    Ok(db.get(&upk(uid), "BTACTIVE").await?.and_then(|it| get_s(&it, "game")))
}

async fn home(State(st): State<Shared>, user: User) -> ApiResult<Json<Value>> {
    let db = &st.db;
    let (p, prof, owned, mut ds, active) = tokio::try_join!(
        async { model::profile(db, user.id).await.map_err(ApiError::from) },
        bt_profile(db, user.id),
        owned_teams(db, user.id),
        decks(db, user.id),
        active_game(db, user.id),
    )?;
    // A pointer to a game that's over is stale (cleared on the next write).
    let active = match active {
        Some(id) => match load(db, &id).await? {
            Some((g, _)) if !g.status.over() => Some(id),
            _ => None,
        },
        None => None,
    };
    ds.sort_by_key(|d| std::cmp::Reverse(d.updated));
    let decks: Vec<Value> =
        ds.iter().map(|d| json!({ "deck": d, "problems": deck_problems(&st, &owned, d) })).collect();
    let mut teams: Vec<i32> = owned.into_iter().filter(|t| st.battler.robot(*t).is_some()).collect();
    teams.sort_unstable();
    Ok(Json(json!({
        "name": p.and_then(|p| p.username).unwrap_or_default(),
        "is_admin": user.is_admin,
        "profile": prof,
        "active": active,
        "owned_teams": teams,
        "support_owned": support_owned(&st),
        "decks": decks,
    })))
}

// ---------- decks ----------

#[derive(Deserialize)]
struct DeckReq {
    name: String,
    captain: Option<i32>,
    #[serde(default)]
    robots: Vec<i32>,
    #[serde(default)]
    support: Vec<String>,
}

const MAX_DECKS: usize = 20;

async fn write_deck(st: &Shared, uid: Uuid, id: String, req: DeckReq) -> ApiResult<Json<Value>> {
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 30 {
        return Err(bad("bad_name"));
    }
    // A draft can be incomplete, but never bigger than a deck or full of unknown cards.
    if req.robots.len() > game::DECK_ROBOTS || req.support.len() > game::SUPPORT_CARDS {
        return Err(bad("too_many_cards"));
    }
    if req.support.iter().any(|c| st.battler.support(c).is_none())
        || req.robots.iter().chain(req.captain.iter()).any(|t| st.battler.robot(*t).is_none())
    {
        return Err(bad("unknown_card"));
    }
    let d = Deck {
        id: id.clone(),
        name: name.to_string(),
        captain: req.captain,
        robots: req.robots,
        support: req.support,
        updated: now_ms(),
    };
    st.db.put(item(upk(uid), format!("BTDECK#{id}"), &d)).await?;
    let owned = owned_teams(&st.db, uid).await?;
    Ok(Json(json!({ "deck": d, "problems": deck_problems(st, &owned, &d) })))
}

async fn create_deck(State(st): State<Shared>, user: User, Json(req): Json<DeckReq>) -> ApiResult<Json<Value>> {
    if decks(&st.db, user.id).await?.len() >= MAX_DECKS {
        return Err(refused("too_many_decks"));
    }
    write_deck(&st, user.id, Uuid::new_v4().simple().to_string()[..12].to_string(), req).await
}

async fn save_deck(
    State(st): State<Shared>,
    user: User,
    Path(id): Path<String>,
    Json(req): Json<DeckReq>,
) -> ApiResult<Json<Value>> {
    if st.db.get(&upk(user.id), &format!("BTDECK#{id}")).await?.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no_deck"));
    }
    write_deck(&st, user.id, id, req).await
}

async fn delete_deck(State(st): State<Shared>, user: User, Path(id): Path<String>) -> ApiResult<StatusCode> {
    st.db.delete(&upk(user.id), &format!("BTDECK#{id}")).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- games: storage ----------

fn gpk(id: &str) -> String {
    format!("BG#{id}")
}

async fn load(db: &Db, id: &str) -> ApiResult<Option<(Game, i64)>> {
    let Some(it) = db.get(&gpk(id), "GAME").await? else { return Ok(None) };
    let ver = get_n(&it, "ver").unwrap_or(0);
    let g: Game = serde_json::from_str(&get_s(&it, "state").unwrap_or_default())
        .map_err(|e| ApiError::from(crate::db::DbError::Other(format!("bad game {id}: {e}"))))?;
    Ok(Some((g, ver)))
}

fn game_item(g: &Game, ver: i64) -> crate::db::Item {
    let mut it = crate::db::key(gpk(&g.id), "GAME");
    it.insert("state".into(), s(serde_json::to_string(g).expect("games serialize")));
    it.insert("ver".into(), n(ver));
    it.insert("status".into(), s(format!("{:?}", g.status)));
    it.insert("created_at".into(), n(g.created_at));
    let queue = match g.mode {
        Mode::Quick => Some("BGQUICK"),
        Mode::Open => Some("BGOPEN"),
        Mode::Private => None,
    };
    if let (Status::Open, Some(q)) = (g.status, queue) {
        it.insert("gsi1pk".into(), s(q));
        it.insert("gsi1sk".into(), s(format!("{}#{}", pad(g.created_at, 15), g.id)));
    }
    it
}

/// Writes a game back on condition nobody changed it since `ver` was read, plus whatever the change implies: freeing
/// both players when the game ends, and (once, the moment it ends) the new ratings and the history lines.
async fn save(db: &Db, g: &mut Game, ver: i64, was_over: bool, mut tx: Tx) -> ApiResult<()> {
    let cond = if ver == 0 { Cond::absent() } else { Cond::new("ver = :v").val(":v", n(ver)) };
    if g.status.over() && !was_over {
        let uids: Vec<Uuid> = g.seats.iter().flatten().map(|s| s.uid).collect();
        for uid in &uids {
            tx.delete_if("", &upk(*uid), "BTACTIVE", Some(Cond::new("game = :g").val(":g", s(&g.id))));
        }
        if g.status == Status::Final && uids.len() == 2 {
            let profs = [bt_profile(db, uids[0]).await?, bt_profile(db, uids[1]).await?];
            let after = g.rate([profs[0].elo, profs[1].elo]);
            let o = g.outcome.clone().expect("finished");
            for side in 0..2 {
                let mut p = profs[side].clone();
                let games_before = p.games;
                p.elo = after[side];
                p.games += 1;
                match o.winner {
                    Some(w) if w == side => p.wins += 1,
                    Some(_) => p.losses += 1,
                    None => p.draws += 1,
                }
                let pc = if games_before == 0 {
                    Cond::new("attribute_not_exists(pk) OR games = :z").val(":z", n(0))
                } else {
                    Cond::new("games = :g").val(":g", n(games_before))
                };
                tx.put_if("race", item(upk(uids[side]), "BTPROF", &p), Some(pc));
                let opp = g.seat(1 - side);
                tx.put(item(
                    upk(uids[side]),
                    format!("BTHIST#{}#{}", pad(now_ms(), 15), g.id),
                    &json!({
                        "game": g.id, "opponent": opp.name, "winner": o.winner.map(|w| w == side),
                        "reason": o.reason, "rp": [o.rp[side], o.rp[1 - side]],
                        "points": [o.points[side], o.points[1 - side]],
                        "elo_before": o.elo_before[side], "elo_after": o.elo_after[side], "at": now_ms(),
                    }),
                ));
            }
        }
    }
    tx.put_if("ver", game_item(g, ver + 1), Some(cond));
    tx.commit(db).await?;
    if g.status.over() && g.wager == game::Wager::Locked {
        settle_wager(db, g).await?;
    }
    Ok(())
}

/// Pays out a finished game's wager: the winner gets both stakes; a draw or a game called off gives each theirs back.
/// Safe to repeat (it's also tried whenever a finished game is looked at, in case the server stopped in between).
async fn settle_wager(db: &Db, g: &Game) -> ApiResult<()> {
    let users = [g.seat(0).uid, g.seat(1).uid];
    let winner = if g.status == Status::Final { g.outcome.as_ref().and_then(|o| o.winner) } else { None };
    crate::wagers::settle(db, content::PACK, &g.id, users, winner).await
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no_game")
}

// ---------- finding a game ----------
//
// Quick Play puts you in a queue: you join whoever has waited longest, or start a game and wait in it. A private game
// is hosted for someone in particular: it's in no list, and the server only lets someone see or join it with its code
// (from the invite link, or typed in), so nobody else can take the seat.

/// Makes sure the player isn't already in a game; returns the stale pointer to overwrite, if any.
async fn ensure_free(db: &Db, uid: Uuid) -> ApiResult<Option<String>> {
    match active_game(db, uid).await? {
        Some(id) => match load(db, &id).await? {
            Some((mut g, ver)) if !g.status.over() => {
                // The old game may only be over on the clock.
                let was = g.status.over();
                if g.tick(now_ms()) && g.status.over() {
                    save(db, &mut g, ver, was, Tx::new()).await?;
                    return Ok(Some(id));
                }
                Err(ApiError::new(StatusCode::CONFLICT, "in_game"))
            }
            _ => Ok(Some(id)),
        },
        None => Ok(None),
    }
}

fn claim_active(tx: &mut Tx, uid: Uuid, game: &str, stale: Option<String>) {
    let cond = match stale {
        Some(old) => Cond::new("attribute_not_exists(pk) OR game = :o").val(":o", s(old)),
        None => Cond::absent(),
    };
    tx.put_if("in_game", item(upk(uid), "BTACTIVE", &json!({ "game": game, "at": now_ms() })), Some(cond));
}

async fn seat_for(db: &Db, uid: Uuid) -> ApiResult<Seat> {
    let p = model::profile(db, uid).await?.ok_or(ApiError::new(StatusCode::UNAUTHORIZED, "no_session"))?;
    let prof = bt_profile(db, uid).await?;
    Ok(Seat::new(uid, p.username.unwrap_or_default(), prof.elo))
}

/// Letters for invite codes: no 0/O, 1/I/L, so a code read out loud or typed from a screenshot comes out right.
const CODE_CHARS: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn new_game(seat: Seat, mode: Mode) -> Game {
    let id = Uuid::new_v4().simple().to_string()[..12].to_string();
    let mut g = Game::new(id, seat, rand::random::<u64>(), now_ms());
    g.mode = mode;
    g
}

/// Hosts a private game: in no list, joined only with its code.
async fn create_game(State(st): State<Shared>, user: User) -> ApiResult<Json<Value>> {
    let db = &st.db;
    let stale = ensure_free(db, user.id).await?;
    let seat = seat_for(db, user.id).await?;
    let mut g = new_game(seat, Mode::Private);
    // A new code, claimed along with the game, until one isn't taken (31^6 of them, so that's almost always the first).
    for attempt in 0.. {
        g.code = (0..6).map(|_| CODE_CHARS[rand::random::<u32>() as usize % CODE_CHARS.len()] as char).collect();
        let mut tx = Tx::new();
        claim_active(&mut tx, user.id, &g.id, stale.clone());
        tx.put_if(
            "code_taken",
            item(format!("BGCODE#{}", g.code), "CODE", &json!({ "game": g.id })),
            Some(Cond::absent()),
        );
        match save(db, &mut g, 0, false, tx).await {
            Err(e) if e.code == "code_taken" && attempt < 4 => continue,
            r => r?,
        }
        break;
    }
    Ok(Json(view_json(g.view(Some(0)))))
}

/// The private game a code invites to.
async fn find_code(State(st): State<Shared>, _user: User, Path(code): Path<String>) -> ApiResult<Json<Value>> {
    let code = code.trim().to_ascii_uppercase();
    let it =
        st.db.get(&format!("BGCODE#{code}"), "CODE").await?.ok_or(ApiError::new(StatusCode::NOT_FOUND, "bad_code"))?;
    let id = get_s(&it, "game").unwrap_or_default();
    match load(&st.db, &id).await? {
        Some((g, _)) if g.status == Status::Open && g.deadline >= now_ms() => {
            Ok(Json(json!({ "id": id, "code": code })))
        }
        Some(_) => Err(ApiError::new(StatusCode::CONFLICT, "game_full")),
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "bad_code")),
    }
}

#[derive(Deserialize)]
struct JoinQuery {
    code: Option<String>,
}

/// A private game only lets in someone with its code.
fn code_ok(g: &Game, code: Option<&str>) -> bool {
    g.mode != Mode::Private || code.is_some_and(|c| c.trim().eq_ignore_ascii_case(&g.code))
}

async fn join_game(
    State(st): State<Shared>,
    user: User,
    Path(id): Path<String>,
    Query(q): Query<JoinQuery>,
) -> ApiResult<Json<Value>> {
    let stale = ensure_free(&st.db, user.id).await?;
    join_into(&st.db, user.id, &id, q.code.as_deref(), stale).await
}

async fn join_into(db: &Db, uid: Uuid, id: &str, code: Option<&str>, stale: Option<String>) -> ApiResult<Json<Value>> {
    let seat = seat_for(db, uid).await?;
    retry!(async {
        let (mut g, ver) = load(db, id).await?.ok_or_else(not_found)?;
        if !code_ok(&g, code) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "private_game"));
        }
        let was = g.status.over();
        g.tick(now_ms());
        g.join(seat.clone(), now_ms()).map_err(refused)?;
        let mut tx = Tx::new();
        claim_active(&mut tx, uid, id, stale.clone());
        save(db, &mut g, ver, was, tx).await?;
        Ok::<_, ApiError>(Json(view_json(g.view(Some(1)))))
    })
}

/// Quick Play. Joins whoever in the queue has waited longest, or starts a game and waits in the queue. The waiting player
/// asks again every few seconds: if two people queued at the same moment and both started a game, the newer one gives
/// theirs up and joins the older, so they end up playing each other. Already in another game: that game.
async fn quick(State(st): State<Shared>, user: User) -> ApiResult<Json<Value>> {
    let db = &st.db;
    let now = now_ms();
    let mut mine = match active_game(db, user.id).await? {
        Some(id) => load(db, &id).await?,
        None => None,
    };
    if let Some((g, _)) = &mine {
        let waiting = g.status == Status::Open && g.mode == Mode::Quick && g.deadline >= now;
        if !g.status.over() && !waiting {
            return Ok(Json(view_json(g.view(g.side_of(user.id)))));
        }
        if !waiting {
            mine = None;
        }
    }
    for it in db.index("gsi1", "BGQUICK", Some(25), false).await? {
        let Ok(g) = serde_json::from_str::<Game>(&get_s(&it, "state").unwrap_or_default()) else { continue };
        if g.status != Status::Open || g.deadline < now || g.side_of(user.id).is_some() {
            continue;
        }
        if let Some((m, _)) = &mine {
            // Only games that were waiting before ours.
            if (g.created_at, &g.id) >= (m.created_at, &m.id) {
                break;
            }
            // Give ours up first. Somebody may have just joined it, and then that's our game.
            let (mut m, ver) = load(db, &m.id).await?.ok_or_else(not_found)?;
            if m.cancel(0).is_err() {
                return Ok(Json(view_json(m.view(Some(0)))));
            }
            save(db, &mut m, ver, false, Tx::new()).await?;
            mine = None;
        }
        let stale = ensure_free(db, user.id).await?;
        match join_into(db, user.id, &g.id, None, stale).await {
            Ok(view) => return Ok(view),
            Err(e) if e.status == StatusCode::CONFLICT => continue, // someone else got there first: the next one
            Err(e) => return Err(e),
        }
    }
    if let Some((m, _)) = mine {
        return Ok(Json(view_json(m.view(Some(0)))));
    }
    let stale = ensure_free(db, user.id).await?;
    let mut g = new_game(seat_for(db, user.id).await?, Mode::Quick);
    let mut tx = Tx::new();
    claim_active(&mut tx, user.id, &g.id, stale);
    save(db, &mut g, 0, false, tx).await?;
    Ok(Json(view_json(g.view(Some(0)))))
}

// ---------- playing ----------

/// A game as a player sees it, with the wager on it if there is one.
async fn game_json(db: &Db, g: &Game, side: Option<usize>) -> ApiResult<Json<Value>> {
    let mut v = view_json(g.view(side));
    if g.wager != game::Wager::None
        && let Some(w) = crate::wagers::load(db, &g.id).await?
    {
        let held = |h: &crate::wagers::Held| {
            json!({ "parts": h.parts, "packs": h.packs, "boosted": h.boosted, "specials": h.specials,
                "cards": h.cards.iter().map(|c| json!({ "num": c.team, "serial": c.serial, "tier": c.tier })).collect::<Vec<_>>() })
        };
        v["stakes"] = json!({ "stakes": w.stakes, "accepted": w.accepted, "status": w.status, "winner": w.winner,
            "held": [held(&w.held[0]), held(&w.held[1])] });
    }
    Ok(Json(v))
}

fn view_json(mut v: game::GameView<'_>) -> Value {
    v.now = now_ms();
    serde_json::to_value(v).expect("views serialize")
}

#[derive(Deserialize)]
struct EmoteReq {
    emote: String,
}

/// A quick-chat emote. Not part of the game, so it needs no version and never makes the other player's tap stale.
async fn emote(
    State(st): State<Shared>,
    user: User,
    Path(id): Path<String>,
    Json(req): Json<EmoteReq>,
) -> ApiResult<StatusCode> {
    let db = &st.db;
    retry!(async {
        let (mut g, ver) = load(db, &id).await?.ok_or_else(not_found)?;
        let side = g.side_of(user.id).ok_or(ApiError::new(StatusCode::FORBIDDEN, "not_your_game"))?;
        g.emote(side, &req.emote, now_ms()).map_err(refused)?;
        let was = g.status.over();
        save(db, &mut g, ver, was, Tx::new()).await?;
        Ok::<_, ApiError>(StatusCode::NO_CONTENT)
    })
}

#[derive(Deserialize)]
struct ViewQuery {
    /// A private game's code: someone not in the game needs it to see who's waiting.
    code: Option<String>,
    rev: Option<u64>,
    /// The emote count the player has seen: a view is only "the same" when neither changed.
    e: Option<u64>,
}

async fn view_game(
    State(st): State<Shared>,
    user: User,
    Path(id): Path<String>,
    Query(q): Query<ViewQuery>,
) -> ApiResult<Json<Value>> {
    let db = &st.db;
    retry!(async {
        let (mut g, ver) = load(db, &id).await?.ok_or_else(not_found)?;
        let side = g.side_of(user.id);
        // Deadlines are applied whenever anyone looks (there's no background worker on Lambda).
        let was = g.status.over();
        if g.tick(now_ms()) {
            save(db, &mut g, ver, was, Tx::new()).await?;
        } else if q.rev == Some(g.rev) && q.e.unwrap_or(0) == g.emote_seq {
            return Ok(Json(json!({ "same": true, "rev": g.rev })));
        }
        if side.is_none() && (g.status != Status::Open || !code_ok(&g, q.code.as_deref())) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "not_your_game"));
        }
        if g.status.over() && g.wager == game::Wager::Locked {
            settle_wager(db, &g).await?;
        }
        game_json(db, &g, side).await
    })
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Action {
    PickDeck { deck: String },
    Attach { part: u32, robot: u32 },
    Detach { part: u32 },
    Lore { card: Option<u32> },
    Stations { robots: [u32; 3] },
    DraftPick { robot: u32 },
    Partners { robots: [u32; 2] },
    Lock,
    Ack,
    Forfeit,
    Cancel,
}

#[derive(Deserialize)]
struct ActReq {
    /// The game version the player was looking at. An action based on an older version is refused (409 `stale`), so a
    /// player never acts on something that already changed.
    rev: u64,
    action: Action,
}

/// Builds the frozen deck for a game from a saved deck, checking ownership again right now (fails closed).
async fn deck_pick(st: &Shared, uid: Uuid, deck: &str) -> ApiResult<DeckPick> {
    let d: Deck = st
        .db
        .get_as(&upk(uid), &format!("BTDECK#{deck}"))
        .await?
        .ok_or(ApiError::new(StatusCode::NOT_FOUND, "no_deck"))?;
    let owned = owned_teams(&st.db, uid).await?;
    if !deck_problems(st, &owned, &d).is_empty() {
        return Err(refused("deck_not_ready"));
    }
    let fx = robot_effects(&st.db).await?;
    let pick = |t: i32| {
        let (effects, effect_test) = effect_for(st, &fx, t);
        RobotPick { robot: st.battler.robot(t).expect("checked").clone(), effects, effect_test }
    };
    Ok(DeckPick {
        deck_id: d.id.clone(),
        captain: pick(d.captain.expect("checked")),
        robots: d.robots.iter().map(|t| pick(*t)).collect(),
        support: d.support.iter().map(|c| st.battler.support(c).expect("checked").clone()).collect(),
    })
}

async fn act(
    State(st): State<Shared>,
    user: User,
    Path(id): Path<String>,
    Json(req): Json<ActReq>,
) -> ApiResult<Json<Value>> {
    let db = &st.db;
    // Deck picks need reads of their own; do them once, before the retry loop.
    let pick = match &req.action {
        Action::PickDeck { deck } => Some(deck_pick(&st, user.id, deck).await?),
        _ => None,
    };
    retry!(async {
        let (mut g, ver) = load(db, &id).await?.ok_or_else(not_found)?;
        let side = g.side_of(user.id).ok_or(ApiError::new(StatusCode::FORBIDDEN, "not_your_game"))?;
        let was = g.status.over();
        let now = now_ms();
        if g.tick(now) {
            // A deadline passed first: save that, and tell the player the game moved on.
            save(db, &mut g, ver, was, Tx::new()).await?;
            return Err(refused("stale"));
        }
        if req.rev != g.rev {
            return Err(refused("stale"));
        }
        let r = match &req.action {
            Action::PickDeck { .. } => g.pick_deck(side, pick.clone().expect("loaded above"), now),
            Action::Attach { part, robot } => g.attach(side, *part, *robot),
            Action::Detach { part } => g.detach(side, *part),
            Action::Lore { card } => g.set_lore(side, *card),
            Action::Stations { robots } => g.set_stations(side, *robots),
            Action::DraftPick { robot } => g.draft_pick(side, *robot, now),
            Action::Partners { robots } => g.set_partners(side, *robots),
            Action::Lock => g.lock(side, now),
            Action::Ack => g.ack(side, now),
            Action::Forfeit => g.forfeit(side),
            Action::Cancel => g.cancel(side),
        };
        r.map_err(refused)?;
        save(db, &mut g, ver, was, Tx::new()).await?;
        game_json(db, &g, Some(side)).await
    })
}

async fn history(State(st): State<Shared>, user: User) -> ApiResult<Json<Value>> {
    let items = st.db.query_desc(&upk(user.id), "BTHIST#", 30).await?;
    let games: Vec<Value> = items
        .into_iter()
        .filter_map(|it| serde_dynamo::from_item::<_, Value>(it).ok())
        .map(|mut v| {
            if let Some(o) = v.as_object_mut() {
                o.remove("pk");
                o.remove("sk");
            }
            v
        })
        .collect();
    Ok(Json(json!({ "games": games })))
}

// ---------- admin: robot effects ----------

async fn admin_effects(State(st): State<Shared>, _admin: Admin) -> ApiResult<Json<Value>> {
    let fx = robot_effects(&st.db).await?;
    let list: Vec<Value> = fx
        .values()
        .map(|f| {
            json!({
                "team": f.team, "draft": f.draft, "published": f.published, "rev": f.rev, "author": f.author,
                "updated": f.updated,
                "draft_text": if f.draft.is_empty() { String::new() } else { effects::describe(&f.draft, Owner::Robot) },
                "published_text": if f.published.is_empty() { String::new() } else { effects::describe(&f.published, Owner::Robot) },
            })
        })
        .collect();
    let tests: HashMap<String, String> =
        st.battler.test_effects.iter().map(|(t, e)| (t.to_string(), effects::describe(e, Owner::Robot))).collect();
    Ok(Json(json!({ "effects": list, "test_effects": tests })))
}

#[derive(Deserialize)]
struct SaveFxReq {
    effects: Vec<Effect>,
    /// Publish this version (players get it in games that start from now on).
    #[serde(default)]
    publish: bool,
}

async fn admin_save_effect(
    State(st): State<Shared>,
    admin: Admin,
    Path(team): Path<i32>,
    Json(req): Json<SaveFxReq>,
) -> ApiResult<Json<Value>> {
    if st.battler.robot(team).is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no_robot"));
    }
    if req.publish || !req.effects.is_empty() {
        effects::validate(&req.effects, Owner::Robot).map_err(|e| {
            tracing::info!("effect refused: {e}");
            bad("bad_effect")
        })?;
    }
    let db = &st.db;
    let pk = format!("BTFX#{team}");
    let mut fx: FxItem = db.get_as(&pk, "FX").await?.unwrap_or(FxItem { team, ..Default::default() });
    let name = model::profile(db, admin.id).await?.and_then(|p| p.username).unwrap_or_default();
    fx.draft = req.effects.clone();
    fx.author = name.clone();
    fx.updated = now_ms();
    let mut tx = Tx::new();
    if req.publish {
        fx.rev += 1;
        fx.published = req.effects.clone();
        tx.put_if(
            "race",
            item(
                &pk,
                format!("REV#{}", pad(i64::from(fx.rev), 6)),
                &json!({ "effects": req.effects, "author": name, "at": fx.updated }),
            ),
            Some(Cond::absent()),
        );
    }
    let mut it = item(&pk, "FX", &fx);
    it.insert("gsi1pk".into(), s("BTFX"));
    it.insert("gsi1sk".into(), s(pad(i64::from(team), 6)));
    tx.put(it);
    tx.commit(db).await?;
    Ok(Json(json!({
        "team": team, "draft": fx.draft, "published": fx.published, "rev": fx.rev,
        "draft_text": if fx.draft.is_empty() { String::new() } else { effects::describe(&fx.draft, Owner::Robot) },
    })))
}

#[derive(Deserialize)]
struct PreviewReq {
    team: i32,
    effects: Vec<Effect>,
    /// Part card ids to attach to the robot in the preview.
    #[serde(default)]
    parts: Vec<String>,
    #[serde(default = "one")]
    station: u8,
    #[serde(default)]
    captain: bool,
    #[serde(default)]
    seed: u64,
}

fn one() -> u8 {
    1
}

/// Runs the effect in a sample round (this robot plus five average robots) so the admin can see what it does before
/// publishing. Nothing is saved.
async fn admin_preview(State(st): State<Shared>, _admin: Admin, Json(req): Json<PreviewReq>) -> ApiResult<Json<Value>> {
    let r = st.battler.robot(req.team).ok_or(ApiError::new(StatusCode::NOT_FOUND, "no_robot"))?;
    let check = effects::validate(&req.effects, Owner::Robot);
    let filler = content::test_stats(0, Some(135.0));
    let station = req.station.clamp(1, 3);
    let others: Vec<u8> = (1..=3).filter(|s| *s != station).collect();
    let mut field = vec![FieldRobot {
        inst: 1,
        name: format!("{} {}", r.team, r.name),
        side: 0,
        captain: req.captain,
        station,
        stats: r.stats,
        power: 100,
        battery: 100,
        breaks: false,
        effects: if check.is_ok() { req.effects.clone() } else { vec![] },
        parts: req
            .parts
            .iter()
            .filter_map(|id| st.battler.support(id))
            .filter(|c| c.kind == Kind::Part)
            .enumerate()
            .map(|(i, c)| engine::FieldPart {
                inst: 100 + i as u32,
                name: c.name.clone(),
                tags: c.tags.clone(),
                effects: c.effects.clone(),
            })
            .collect(),
    }];
    for (k, st_) in others.iter().enumerate() {
        field.push(FieldRobot {
            inst: 2 + k as u32,
            name: "Ally".into(),
            side: 0,
            captain: false,
            station: *st_,
            stats: filler,
            power: 100,
            battery: 100,
            breaks: false,
            effects: vec![],
            parts: vec![],
        });
    }
    for k in 0..3u8 {
        field.push(FieldRobot {
            inst: 4 + u32::from(k),
            name: "Opponent".into(),
            side: 1,
            captain: k == 0,
            station: k + 1,
            stats: filler,
            power: 100,
            battery: 100,
            breaks: false,
            effects: vec![],
            parts: vec![],
        });
    }
    let without = engine::resolve(
        &{
            let mut f = field.clone();
            f[0].effects.clear();
            f
        },
        &[],
        req.seed,
    );
    let with = engine::resolve(&field, &[], req.seed);
    Ok(Json(json!({
        "valid": check.is_ok(),
        "error": check.err(),
        "text": if req.effects.is_empty() { String::new() } else { effects::describe(&req.effects, Owner::Robot) },
        "with": with,
        "without": without,
    })))
}

// ---------- wagers ----------
//
// In a private match, before it starts, each player can put up a stake. Changing either stake takes back both
// acceptances; once both accept, both stakes go into escrow (crate::wagers) and the match starts as soon as both decks
// are picked. Calling it off takes the stakes off the table.

async fn set_stake(
    State(st): State<Shared>,
    user: User,
    Path(id): Path<String>,
    Json(stake): Json<crate::wagers::Stake>,
) -> ApiResult<Json<Value>> {
    let db = &st.db;
    let p = crate::api::me(db, user.id).await?;
    crate::wagers::check(db, content::PACK, &p, &stake).await?;
    retry!(async {
        let (mut g, ver) = load(db, &id).await?.ok_or_else(not_found)?;
        let side = g.side_of(user.id).ok_or(ApiError::new(StatusCode::FORBIDDEN, "not_your_game"))?;
        let mut w = crate::wagers::load(db, &id).await?.unwrap_or_else(|| crate::wagers::Wager::new(&id));
        if w.status != "open" {
            return Err(refused("no_wager_here"));
        }
        w.stakes[side] = stake.clone();
        w.accepted = [false, false];
        let was = g.status.over();
        g.set_wager(!w.stakes.iter().all(crate::wagers::Stake::is_empty), now_ms()).map_err(refused)?;
        let mut tx = Tx::new();
        crate::wagers::put(&mut tx, &mut w);
        save(db, &mut g, ver, was, tx).await?;
        game_json(db, &g, Some(side)).await
    })
}

/// Takes both stakes off the table: the match goes ahead without a wager.
async fn call_off(State(st): State<Shared>, user: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let db = &st.db;
    retry!(async {
        let (mut g, ver) = load(db, &id).await?.ok_or_else(not_found)?;
        let side = g.side_of(user.id).ok_or(ApiError::new(StatusCode::FORBIDDEN, "not_your_game"))?;
        let mut w =
            crate::wagers::load(db, &id).await?.filter(|w| w.status == "open").ok_or(refused("no_wager_here"))?;
        w.stakes = Default::default();
        w.accepted = [false, false];
        let was = g.status.over();
        g.set_wager(false, now_ms()).map_err(refused)?;
        let mut tx = Tx::new();
        crate::wagers::put(&mut tx, &mut w);
        save(db, &mut g, ver, was, tx).await?;
        game_json(db, &g, Some(side)).await
    })
}

/// Agrees to both stakes as they stand. When both have, the stakes go into escrow in the same write as the game.
async fn accept_wager(State(st): State<Shared>, user: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let db = &st.db;
    retry!(async {
        let (mut g, ver) = load(db, &id).await?.ok_or_else(not_found)?;
        let side = g.side_of(user.id).ok_or(ApiError::new(StatusCode::FORBIDDEN, "not_your_game"))?;
        let mut w =
            crate::wagers::load(db, &id).await?.filter(|w| w.status == "open").ok_or(refused("no_wager_here"))?;
        if g.wager != game::Wager::Open {
            return Err(refused("no_wager_here"));
        }
        // A pink slip stakes the deck being brought, so it has to be picked first.
        if w.stakes[side].pink && g.deck_teams(side).is_none() {
            return Err(refused("pick_deck_first"));
        }
        w.accepted[side] = true;
        let was = g.status.over();
        let mut tx = Tx::new();
        if w.accepted == [true, true] {
            let uids = [g.seat(0).uid, g.seat(1).uid];
            let mut held: [crate::wagers::Held; 2] = Default::default();
            for s in 0..2 {
                let p = crate::api::me(db, uids[s]).await?;
                // A brand-new account can't win parts or packs (nor stake them: checked with the stake).
                if w.stakes[1 - s].has_goods() && crate::wagers::too_new(&p) {
                    return Err(ApiError::new(
                        StatusCode::CONFLICT,
                        if s == side { "too_new" } else { "they_too_new" },
                    ));
                }
                held[s] =
                    crate::wagers::resolve(db, content::PACK, &p, &w.stakes[s], &g.deck_teams(s).unwrap_or_default())
                        .await?;
            }
            crate::wagers::escrow(db, content::PACK, &mut tx, uids, &held, &format!("wager {id}")).await?;
            w.held = held;
            w.status = "locked".into();
            g.lock_wager(now_ms()).map_err(refused)?;
        } else {
            g.set_wager(true, now_ms()).map_err(refused)?; // so the other player sees the acceptance
        }
        crate::wagers::put(&mut tx, &mut w);
        save(db, &mut g, ver, was, tx).await?;
        game_json(db, &g, Some(side)).await
    })
}
