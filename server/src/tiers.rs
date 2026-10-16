//! The rarity editor's API (under /api/admin): see every team's rarity, preview a change, and apply it. The changes are
//! saved in the settings item on top of the recipe files, so changing who is Mythic needs no code change or deploy.
//! Players' cards move to the new rarities the next time they open the game (see `retier`).

use std::collections::BTreeMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::Shared;
use crate::auth::Admin;
use crate::db::{Cond, DbError, Tx, n, s as sv};
use crate::error::{ApiError, ApiResult};
use crate::model;
use crate::packs::{Overrides, Tier};

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/tiers", get(overview))
        .route("/tiers/preview", post(preview))
        .route("/tiers/apply", post(apply))
}

fn err(status: StatusCode, code: &'static str) -> ApiError {
    ApiError::new(status, code)
}

#[derive(Serialize)]
struct TeamOut {
    num: i32,
    name: String,
    div: String,
    /// The rarity now.
    tier: Tier,
    /// The rarity in the recipe file (what "reset" goes back to).
    base: Tier,
}

#[derive(Serialize)]
struct Overview {
    pack: String,
    version: i64,
    teams: Vec<TeamOut>,
    /// Parts and note chosen for the last change.
    parts: i64,
    note: String,
}

async fn overview(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<Overview>> {
    let (cat, version, _) = s.live.get(&s.db).await;
    let pack = cat.claimable();
    let base = s.live.base().get(pack.id()).ok_or(err(StatusCode::INTERNAL_SERVER_ERROR, "server_error"))?;
    let settings = model::settings_item(&s.db).await?;
    let teams = pack
        .recipe
        .teams
        .iter()
        .map(|t| TeamOut {
            num: t.num,
            name: t.name.clone(),
            div: t.div.clone(),
            tier: t.tier,
            base: base.team_tier.get(&t.num).copied().unwrap_or(t.tier),
        })
        .collect();
    Ok(Json(Overview {
        pack: pack.id().to_string(),
        version,
        teams,
        parts: crate::db::get_n(&settings, "comp_parts").unwrap_or(1000),
        note: crate::db::get_s(&settings, "comp_note")
            .unwrap_or_else(|| "Rarities have changed. Sorry about that!".into()),
    }))
}

#[derive(Deserialize)]
struct Wanted {
    /// Every team whose rarity should differ from the recipe file (team number to rarity); the rest follow the file.
    tiers: BTreeMap<String, Tier>,
}

/// The wanted changes as overrides of the recipe file, checked against the claimable pack's teams.
fn parse(s: &Shared, w: &Wanted) -> ApiResult<Overrides> {
    let base = s.live.base().claimable();
    let mut out = Overrides::new();
    for (k, tier) in &w.tiers {
        let num: i32 = k.parse().map_err(|_| err(StatusCode::BAD_REQUEST, "bad_request"))?;
        let Some(was) = base.team_tier.get(&num) else { return Err(err(StatusCode::BAD_REQUEST, "unknown_team")) };
        if was != tier {
            out.insert(num, *tier);
        }
    }
    Ok(out)
}

#[derive(Serialize)]
struct Change {
    num: i32,
    name: String,
    from: Tier,
    to: Tier,
    /// Copies of this team that exist in the game right now.
    copies: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    changes: Vec<Change>,
    /// Copies of cards that stop being Mythic (their owners are the ones who can be paid).
    mythic_copies_lost: i64,
    /// Why this can't be applied, if it can't (for example, a rarity left with fewer than 5 teams).
    problem: Option<String>,
}

async fn preview(State(s): State<Shared>, _admin: Admin, Json(w): Json<Wanted>) -> ApiResult<Json<Preview>> {
    let overrides = parse(&s, &w)?;
    let (cat, ..) = s.live.get(&s.db).await;
    let now = cat.claimable();
    let problem = s.live.base().with_overrides(&overrides).err().map(|e| e.to_string());
    let mut changes = Vec::new();
    let mut lost = 0;
    for t in &now.recipe.teams {
        let want = overrides.get(&t.num).copied().unwrap_or_else(|| s.live.base().claimable().team_tier[&t.num]);
        if want == t.tier {
            continue;
        }
        let copies = model::printing(&s.db, now.id(), t.num).await?.live;
        if t.tier == Tier::Mythic {
            lost += copies;
        }
        changes.push(Change { num: t.num, name: t.name.clone(), from: t.tier, to: want, copies });
    }
    Ok(Json(Preview { changes, mythic_copies_lost: lost, problem }))
}

#[derive(Deserialize)]
struct Apply {
    #[serde(flatten)]
    wanted: Wanted,
    /// Parts for each player who loses a Mythic, and the note they see (0 / empty for neither).
    #[serde(default)]
    parts: i64,
    #[serde(default)]
    note: String,
}

async fn apply(State(s): State<Shared>, _admin: Admin, Json(req): Json<Apply>) -> ApiResult<Json<Overview>> {
    if !(0..=100_000).contains(&req.parts) || req.note.chars().count() > 300 || req.note.chars().any(|c| c.is_control())
    {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let overrides = parse(&s, &req.wanted)?;
    if s.live.base().with_overrides(&overrides).is_err() {
        return Err(err(StatusCode::BAD_REQUEST, "bad_tiers"));
    }
    let item = model::settings_item(&s.db).await?;
    let old = crate::db::get_n(&item, "tiers_ver").unwrap_or(0);
    let map: BTreeMap<String, Tier> = overrides.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    let set =
        Cond::new("SET tier_overrides = :o, tiers_ver = :new, comp_ver = :new, comp_parts = :p, comp_note = :note")
            .val(":o", sv(serde_json::to_string(&map).unwrap_or_default()))
            .val(":new", n(old + 1))
            .val(":p", n(req.parts))
            .val(":note", sv(req.note.trim()))
            .val(":old", n(old));
    let mut tx = Tx::new();
    tx.update("race", "SETTINGS", "SETTINGS", set, Some("attribute_not_exists(tiers_ver) OR tiers_ver = :old"));
    match tx.commit(&s.db).await {
        Ok(()) => {}
        Err(DbError::Conflict("race")) => return Err(ApiError::busy()),
        Err(e) => return Err(e.into()),
    }
    s.live.adopt((overrides, old + 1));
    overview(State(s), _admin).await
}
