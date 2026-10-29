//! Player profiles: a picture and a banner picked from your cards, a short bio, a showcase of up to 3 pinned cards,
//! collection and battle stats, rarest and recent pulls and a wishlist. Anyone signed in can see them; the wishlist
//! also tells trade partners what you're after.

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
/// A bio's length, in characters and lines.
pub const BIO_CHARS: usize = 160;
pub const BIO_LINES: usize = 3;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/players/{name}/profile/{pack}", get(profile))
        .route("/profile", post(edit_profile))
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
struct Pull {
    num: i32,
    tier: Tier,
    serial: i32,
    at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Battle {
    rating: i32,
    games: i32,
    wins: i32,
    losses: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileOut {
    username: String,
    first_name: Option<String>,
    badge: Option<String>,
    bio: Option<String>,
    avatar: Option<i32>,
    banner: Option<i32>,
    /// Teams owned of each rarity, Mythic first.
    tiers: [i64; 5],
    /// Their Battler record, once they've played.
    battle: Option<Battle>,
    /// Their latest Mythic and Legendary pulls (at most 6).
    pulls: Vec<Pull>,
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
    let mut tiers = [0i64; 5];
    for c in best.values() {
        tiers[c.tier.rank()] += 1;
    }
    let mut owned: Vec<Card> = best.into_values().collect();
    // Rarest: best tier first, then the team's standing in the pack (the recipe lists teams best first), then serial.
    let order: std::collections::HashMap<i32, usize> =
        pack.recipe.teams.iter().enumerate().map(|(i, t)| (t.num, i)).collect();
    owned.sort_by_key(|c| (c.tier.rank(), order.get(&c.num).copied().unwrap_or(usize::MAX), c.serial));
    owned.truncate(3);
    let name = p.username.clone().unwrap_or_default();
    let bt = crate::battler::api::bt_profile(db, id).await?;
    let pulls: Vec<Pull> = db
        .query_desc(&format!("FEED#{}", pack.id()), "", 200)
        .await?
        .into_iter()
        .filter_map(|it| crate::db::from_item::<model::FeedEvent>(it).ok())
        .filter(|e| e.kind == "pull" && e.who == name)
        .filter_map(|e| {
            let num = e.team?;
            // The team's rarity now, not the one recorded at the time.
            let tier = *pack.team_tier.get(&num)?;
            matches!(tier, Tier::Mythic | Tier::Legendary).then_some(Pull {
                num,
                tier,
                serial: e.serial.unwrap_or(0),
                at: e.at,
            })
        })
        .take(6)
        .collect();
    Ok(Json(ProfileOut {
        username: name.clone(),
        first_name: p.first_name.clone(),
        badge: p.badge.clone(),
        bio: p.bio.clone(),
        avatar: p.avatar,
        banner: p.banner,
        tiers,
        battle: (bt.games > 0).then_some(Battle { rating: bt.elo, games: bt.games, wins: bt.wins, losses: bt.losses }),
        pulls,
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

#[derive(Deserialize)]
struct EditReq {
    pack: String,
    #[serde(default)]
    bio: String,
    avatar: Option<i32>,
    banner: Option<i32>,
}

#[derive(Serialize)]
struct EditOut {
    bio: Option<String>,
    avatar: Option<i32>,
    banner: Option<i32>,
}

/// A bio as it's kept: trimmed, at most 160 characters and 3 lines, no control characters but line breaks, and no
/// blank lines. None when it's empty; an error when it's too long.
pub fn clean_bio(raw: &str) -> Result<Option<String>, &'static str> {
    let lines: Vec<&str> = raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let bio = lines.join("\n");
    if bio.chars().count() > BIO_CHARS || lines.len() > BIO_LINES || bio.chars().any(|c| c.is_control() && c != '\n') {
        return Err("bad_bio");
    }
    Ok((!bio.is_empty()).then_some(bio))
}

/// Saves your bio, picture and banner (both picked from teams you own; none for the default).
async fn edit_profile(State(s): State<Shared>, user: User, Json(req): Json<EditReq>) -> ApiResult<Json<EditOut>> {
    let pack = api::pack(&s, &req.pack).await?;
    let bio = clean_bio(&req.bio).map_err(|e| err(StatusCode::BAD_REQUEST, e))?;
    for t in [req.avatar, req.banner].into_iter().flatten() {
        if !pack.team_tier.contains_key(&t) {
            return Err(err(StatusCode::NOT_FOUND, "unknown_team"));
        }
    }
    let p0 = api::me(&s.db, user.id).await?;
    // Only a newly picked card has to be owned; one picked before stays even if it was traded away since.
    for (t, was) in [(req.avatar, p0.avatar), (req.banner, p0.banner)] {
        if let Some(t) = t
            && Some(t) != was
            && model::team_cards(&s.db, user.id, pack.id(), t).await?.is_empty()
        {
            return Err(err(StatusCode::CONFLICT, "not_owned"));
        }
    }
    retry!(async {
        let mut p = api::me(&s.db, user.id).await?;
        p.bio = bio.clone();
        p.avatar = req.avatar;
        p.banner = req.banner;
        let parts = p.parts;
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "profile");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    Ok(Json(EditOut { bio, avatar: req.avatar, banner: req.banner }))
}

#[cfg(test)]
mod tests {
    use super::clean_bio;

    #[test]
    fn bios_are_tidied_and_limited() {
        assert_eq!(clean_bio("  "), Ok(None));
        assert_eq!(clean_bio(" Hi! \n\n\n  Team 7028 "), Ok(Some("Hi!\nTeam 7028".into())));
        assert_eq!(clean_bio(&"a".repeat(160)), Ok(Some("a".repeat(160))));
        assert!(clean_bio(&"a".repeat(161)).is_err());
        assert!(clean_bio("a\nb\nc\nd").is_err());
        assert!(clean_bio("tab\there").is_err());
        assert!(clean_bio("bell\u{7}").is_err());
    }
}
