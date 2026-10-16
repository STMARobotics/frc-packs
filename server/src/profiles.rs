//! Player profiles: a showcase of up to 3 pinned cards, collection stats, rarest pulls and a wishlist. Other players
//! see them from the trading post; the wishlist also tells trade partners what you're after.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Shared;
use crate::accounts;
use crate::api;
use crate::auth::User;
use crate::db::{Cond, Db, Tx, get_n, key, n, pad};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, now_ms, upk};
use crate::packs::Tier;
use crate::retry;

pub const SHOWCASE: usize = 3;
pub const WISHLIST: i64 = 50;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/players/{name}/profile/{pack}", get(profile))
        .route("/wishlist", post(set_wish))
        .route("/favorites", post(set_favorite))
        .route("/showcase", post(set_showcase))
}

fn err(status: StatusCode, code: &'static str) -> ApiError {
    ApiError::new(status, code)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Card {
    num: i32,
    tier: Tier,
    serial: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileOut {
    username: String,
    badge: Option<String>,
    me: bool,
    joined: i64,
    /// Different teams owned, out of `total` in the pack.
    teams: i64,
    total: usize,
    cards: i64,
    sets: i64,
    trades: i64,
    streak: i32,
    /// Sealed standard packs and parts they have, so a trade partner knows what they can ask for.
    packs: i32,
    /// Sealed boosted packs they have.
    boosted: i32,
    parts: i64,
    showcase: Vec<Card>,
    /// Their three rarest cards (best tier, then lowest serial).
    rarest: Vec<Card>,
    wishlist: Vec<i32>,
}

async fn profile(
    State(s): State<Shared>,
    user: User,
    Path((name, pack)): Path<(String, String)>,
) -> ApiResult<Json<ProfileOut>> {
    let pack = api::pack(&s, &pack).await?;
    let db = &s.db;
    let Some(p) = accounts::by_name(db, &name).await?.filter(|p| !p.disabled) else {
        return Err(err(StatusCode::NOT_FOUND, "unknown_player"));
    };
    let id = p.id;
    let today = model::day_number();
    let streak = if p.streak_day.is_some_and(|d| d >= today - 1) { p.streak } else { 0 };
    let st = model::stats(db, id, pack.id()).await?;
    let row = model::pack_row(db, id, pack.id()).await?;
    let cards = model::cards(db, id, pack.id()).await?;
    // Each team's lowest serial: the copy a player would show.
    let mut best: std::collections::BTreeMap<i32, Card> = std::collections::BTreeMap::new();
    for c in &cards {
        let tier = Tier::parse(&c.tier).unwrap_or(Tier::Common);
        let e = best.entry(c.team).or_insert(Card { num: c.team, tier, serial: c.serial });
        if c.serial < e.serial {
            *e = Card { num: c.team, tier, serial: c.serial };
        }
    }
    let showcase: Vec<Card> = p
        .showcase
        .iter()
        .take(SHOWCASE)
        .filter_map(|t| best.get(t).map(|c| Card { num: c.num, tier: c.tier, serial: c.serial }))
        .collect();
    let mut owned: Vec<Card> = best.into_values().collect();
    // Rarest: best tier first, then the team's standing in the pack (the recipe lists teams best first), then serial.
    let order: std::collections::HashMap<i32, usize> =
        pack.recipe.teams.iter().enumerate().map(|(i, t)| (t.num, i)).collect();
    owned.sort_by_key(|c| (c.tier.rank(), order.get(&c.num).copied().unwrap_or(usize::MAX), c.serial));
    owned.truncate(3);
    Ok(Json(ProfileOut {
        username: p.username.clone().unwrap_or_default(),
        badge: p.badge.clone(),
        me: id == user.id,
        joined: p.created_at,
        teams: st.teams,
        total: pack.recipe.teams.len(),
        cards: cards.len() as i64,
        sets: st.sets,
        trades: st.trades,
        streak,
        packs: row.standard(),
        boosted: row.boosted - row.mythic,
        parts: p.parts,
        showcase,
        rarest: owned,
        wishlist: wishlist(db, id, pack.id()).await?,
    }))
}

#[derive(Deserialize)]
struct WishReq {
    pack: String,
    team: i32,
    on: bool,
}

/// A list of teams a player marked (wishlist or favorites), oldest first.
async fn marked(db: &Db, user: Uuid, kind: &str, pack: &str) -> ApiResult<Vec<i32>> {
    let mut rows: Vec<(i64, i32)> = db
        .query(&upk(user), &format!("{kind}#{pack}#"))
        .await?
        .iter()
        .map(|it| (get_n(it, "created_at").unwrap_or(0), get_n(it, "team").unwrap_or(0) as i32))
        .collect();
    rows.sort();
    Ok(rows.into_iter().map(|r| r.1).collect())
}

fn mark_sk(kind: &str, pack: &str, team: i32) -> String {
    format!("{kind}#{pack}#{}", pad(i64::from(team), 6))
}

async fn set_mark(db: &Db, user: Uuid, kind: &str, pack: &str, team: i32, on: bool) -> ApiResult<()> {
    if on {
        let mut it = key(upk(user), mark_sk(kind, pack, team));
        it.insert("team".into(), n(team));
        it.insert("created_at".into(), n(now_ms()));
        let mut tx = Tx::new();
        tx.put_if("", it, Some(Cond::absent()));
        match tx.commit(db).await {
            Ok(()) | Err(crate::db::DbError::Conflict(_)) => Ok(()),
            Err(e) => Err(e.into()),
        }
    } else {
        Ok(db.delete(&upk(user), &mark_sk(kind, pack, team)).await?)
    }
}

/// Adds a team to the wishlist, or takes it off. At most 50.
async fn set_wish(State(s): State<Shared>, user: User, Json(req): Json<WishReq>) -> ApiResult<Json<Vec<i32>>> {
    let pack = api::pack(&s, &req.pack).await?;
    if !pack.team_tier.contains_key(&req.team) {
        return Err(err(StatusCode::NOT_FOUND, "unknown_team"));
    }
    if req.on && wishlist(&s.db, user.id, pack.id()).await?.len() as i64 >= WISHLIST {
        return Err(err(StatusCode::CONFLICT, "wishlist_full"));
    }
    set_mark(&s.db, user.id, "WISH", pack.id(), req.team, req.on).await?;
    Ok(Json(wishlist(&s.db, user.id, pack.id()).await?))
}

pub async fn wishlist(db: &Db, user: Uuid, pack: &str) -> ApiResult<Vec<i32>> {
    marked(db, user, "WISH", pack).await
}

#[derive(Deserialize)]
struct ShowcaseReq {
    pack: String,
    teams: Vec<i32>,
}

/// Pins up to 3 teams you own to your profile, in order.
async fn set_showcase(State(s): State<Shared>, user: User, Json(req): Json<ShowcaseReq>) -> ApiResult<Json<Vec<i32>>> {
    let pack = api::pack(&s, &req.pack).await?;
    if req.teams.len() > SHOWCASE || req.teams.iter().enumerate().any(|(i, t)| req.teams[..i].contains(t)) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    for t in &req.teams {
        if model::team_cards(&s.db, user.id, pack.id(), *t).await?.is_empty() {
            return Err(err(StatusCode::CONFLICT, "not_owned"));
        }
    }
    retry!(async {
        let mut p = api::me(&s.db, user.id).await?;
        p.showcase = req.teams.clone();
        let parts = p.parts;
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "showcase");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    Ok(Json(req.teams))
}

#[derive(Deserialize)]
struct FavReq {
    pack: String,
    team: i32,
    on: bool,
}

pub async fn favorites(db: &Db, user: Uuid, pack: &str) -> ApiResult<Vec<i32>> {
    marked(db, user, "FAV", pack).await
}

/// Marks a team you own as a favorite (never scrapped), or unmarks it.
async fn set_favorite(State(s): State<Shared>, user: User, Json(req): Json<FavReq>) -> ApiResult<Json<Vec<i32>>> {
    let pack = api::pack(&s, &req.pack).await?;
    if req.on && model::team_cards(&s.db, user.id, pack.id(), req.team).await?.is_empty() {
        return Err(err(StatusCode::CONFLICT, "not_owned"));
    }
    set_mark(&s.db, user.id, "FAV", pack.id(), req.team, req.on).await?;
    Ok(Json(favorites(&s.db, user.id, pack.id()).await?))
}
