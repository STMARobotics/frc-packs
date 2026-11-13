//! Respond: what an admin can do about a suspect, from Tripwire's tab in the admin panel. Every action is logged
//! (`AC#LOG`), and every change to what a player owns goes through the ledger like any other, so the audit still
//! balances. Banning is the panel's existing "disable account" (signed out everywhere, open trades called off).
//!
//! - Overview: Tripwire's settings, the watchlist (every flagged player, what their flag does, what they've done since),
//!   and the canary hits.
//! - Scan: runs every detection check (`detect`) and ranks the suspects.
//! - Flag: shadow (silent, watched) or paused (no trading or wagering; packs still open). The intake alarm flags on its
//!   own. A flag without a mode follows the settings (shadow by default).
//! - Clear: lifts a flag.
//! - Reverse: takes back what came in during a time window (packs, parts and the cards still in their binder), as new
//!   ledger lines. Previewed first; only applied when asked.
//! - Rollback: any account, back to a moment. Every change to its parts, packs, cards and Mythic meter since is undone
//!   (not trades or wagers: other players are in those), as new ledger lines. Previewed first too.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Shared;
use crate::auth::Admin;
use crate::db::{Db, Tx, from_item, get_n, get_s, key, n, pad, s as sv};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, LedgerLine, now_ms, upk};
use crate::retry;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/anticheat/overview", get(overview))
        .route("/anticheat/config", get(get_config).post(set_config))
        .route("/anticheat/scan", get(scan))
        .route("/anticheat/log", get(log))
        .route("/anticheat/users/{id}/flag", post(flag))
        .route("/anticheat/users/{id}/clear", post(clear))
        .route("/anticheat/users/{id}/reverse", post(reverse))
        .route("/anticheat/users/{id}/rollback", post(rollback))
}

/// The ledger reason for everything Tripwire takes back.
pub const REVERSAL: &str = "anticheat reversal";

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found")
}

/// Writes one line of Tripwire's action log, in the same transaction as the action.
fn note(tx: &mut Tx, admin: Uuid, user: Uuid, action: &str, detail: &str) {
    let at = now_ms();
    let mut it = key("AC#LOG", format!("{}#{}", pad(at, 15), &Uuid::new_v4().simple().to_string()[..8]));
    it.insert("at".into(), n(at));
    it.insert("admin".into(), sv(admin.to_string()));
    it.insert("user".into(), sv(user.to_string()));
    it.insert("action".into(), sv(action));
    it.insert("detail".into(), sv(detail));
    tx.put(it);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogOut {
    at: i64,
    admin: String,
    user: String,
    action: String,
    detail: String,
}

async fn name_of(db: &Db, id: &str) -> String {
    match Uuid::parse_str(id) {
        Ok(u) => model::profile(db, u).await.ok().flatten().and_then(|p| p.username).unwrap_or_else(|| "?".into()),
        Err(_) => "?".into(),
    }
}

/// The last 100 actions, newest first.
async fn log(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<Vec<LogOut>>> {
    let mut out = Vec::new();
    for it in s.db.query_desc("AC#LOG", "", 100).await? {
        out.push(LogOut {
            at: get_n(&it, "at").unwrap_or(0),
            admin: name_of(&s.db, &get_s(&it, "admin").unwrap_or_default()).await,
            user: name_of(&s.db, &get_s(&it, "user").unwrap_or_default()).await,
            action: get_s(&it, "action").unwrap_or_default(),
            detail: get_s(&it, "detail").unwrap_or_default(),
        });
    }
    Ok(Json(out))
}

async fn scan(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<super::detect::Report>> {
    let rules = crate::api::rules(&s.db).await?;
    let cat = s.catalog().await;
    Ok(Json(super::detect::scan(&s.db, cat.claimable(), &rules, s.dev_tools).await?))
}

#[derive(Deserialize)]
struct FlagReq {
    #[serde(default)]
    reason: String,
    /// "shadow" or "paused"; left out, the flag follows the settings.
    #[serde(default)]
    mode: Option<String>,
}

/// Flags a player by hand (or changes an existing flag's mode).
async fn flag(
    State(s): State<Shared>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<FlagReq>,
) -> ApiResult<StatusCode> {
    if req.mode.as_deref().is_some_and(|m| m != "shadow" && m != "paused") {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let reason = req.reason.trim();
    let reason: Option<String> = (!reason.is_empty()).then(|| reason.chars().take(200).collect());
    retry!(async {
        let mut p = model::profile(&s.db, id).await?.ok_or_else(not_found)?;
        if reason.is_some() || p.flagged.is_none() {
            p.flagged = Some(reason.clone().unwrap_or_else(|| "flagged by an admin".into()));
        }
        p.flagged_at.get_or_insert(now_ms());
        p.flag_mode = req.mode.clone();
        let mut tx = Tx::new();
        let what = format!(
            "{} ({})",
            p.flagged.clone().unwrap_or_default(),
            req.mode.as_deref().unwrap_or("follows the setting")
        );
        note(&mut tx, admin.id, id, "flag", &what);
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "anticheat flag");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    // A paused player's open offers can't go through: they're called off. A shadow flag leaves everything as it was.
    let p = model::profile(&s.db, id).await?.ok_or_else(not_found)?;
    if super::mode(&p, &super::config(&s.db).await?) == Some("paused") {
        crate::trades::cancel_all(&s.db, id).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn get_config(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<super::Config>> {
    Ok(Json(super::config(&s.db).await?))
}

async fn set_config(
    State(s): State<Shared>,
    admin: Admin,
    Json(c): Json<super::Config>,
) -> ApiResult<Json<super::Config>> {
    super::save_config(&s.db, &c).await?;
    let mut tx = Tx::new();
    note(
        &mut tx,
        admin.id,
        admin.id,
        "settings",
        if c.shadow_default { "shadow flags on" } else { "shadow flags off: flags pause trading" },
    );
    tx.commit(&s.db).await?;
    Ok(Json(c))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Seen {
    at: i64,
    what: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Watched {
    id: Uuid,
    username: Option<String>,
    reason: String,
    /// What the flag does now: "shadow" or "paused".
    mode: &'static str,
    /// Whether that mode was set for this player, or comes from the settings.
    mode_set: bool,
    flagged_at: Option<i64>,
    disabled: bool,
    /// What they've done since (trades and wagers), newest first.
    activity: Vec<Seen>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanaryHit {
    at: i64,
    path: String,
    username: Option<String>,
    visitor: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverviewOut {
    name: &'static str,
    config: super::Config,
    players: usize,
    watchlist: Vec<Watched>,
    canaries: Vec<CanaryHit>,
}

/// Everything the suite's front page shows, without the (heavier) scan.
async fn overview(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<OverviewOut>> {
    let db = &s.db;
    let config = super::config(db).await?;
    let profiles: Vec<model::Profile> =
        db.index("gsi1", "USERS", None, false).await?.into_iter().filter_map(|it| from_item(it).ok()).collect();
    let names: HashMap<Uuid, Option<String>> = profiles.iter().map(|p| (p.id, p.username.clone())).collect();
    let mut watchlist = Vec::new();
    for p in profiles.iter().filter(|p| p.flagged.is_some()) {
        let activity = db
            .query_desc(&format!("AC#WATCH#{}", p.id), "", 20)
            .await?
            .iter()
            .map(|it| Seen { at: get_n(it, "at").unwrap_or(0), what: get_s(it, "what").unwrap_or_default() })
            .collect();
        watchlist.push(Watched {
            id: p.id,
            username: p.username.clone(),
            reason: p.flagged.clone().unwrap_or_default(),
            mode: super::mode(p, &config).unwrap_or("shadow"),
            mode_set: p.flag_mode.is_some(),
            flagged_at: p.flagged_at,
            disabled: p.disabled,
            activity,
        });
    }
    watchlist.sort_by_key(|w| std::cmp::Reverse(w.flagged_at.unwrap_or(0)));
    let canaries = db
        .query_desc("AC#CANARY", "", 100)
        .await?
        .iter()
        .map(|it| CanaryHit {
            at: get_n(it, "at").unwrap_or(0),
            path: get_s(it, "path").unwrap_or_default(),
            username: get_s(it, "user_id")
                .and_then(|u| Uuid::parse_str(&u).ok())
                .and_then(|u| names.get(&u).cloned().flatten()),
            visitor: get_s(it, "visitor").unwrap_or_default(),
        })
        .collect();
    Ok(Json(OverviewOut { name: super::ANTICHEAT_NAME, config, players: profiles.len(), watchlist, canaries }))
}

/// Lifts a flag (and forgets the hour's intake, so the alarm doesn't go straight off again).
async fn clear(
    State(s): State<Shared>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<FlagReq>,
) -> ApiResult<StatusCode> {
    retry!(async {
        let mut p = model::profile(&s.db, id).await?.ok_or_else(not_found)?;
        let was = p.flagged.take().unwrap_or_default();
        p.flagged_at = None;
        p.flag_mode = None;
        p.packs_in.clear();
        let mut tx = Tx::new();
        note(&mut tx, admin.id, id, "clear", &format!("{} (was: {was})", req.reason.trim()));
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "anticheat clear");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ReverseReq {
    /// The window, in ms since 1970 (inclusive).
    from: i64,
    to: i64,
    /// False (the default) only shows what would be taken back.
    #[serde(default)]
    apply: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReverseOut {
    /// What came in during the window.
    packs: i64,
    boosted: i64,
    parts: i64,
    cards: Vec<String>,
    /// What was (or would be) taken back: never more than they still have.
    took_packs: i64,
    took_boosted: i64,
    took_parts: i64,
    took_cards: Vec<String>,
    /// Cards from the window they don't have any more (traded, staked or scrapped): follow them in the scan.
    gone: Vec<String>,
    applied: bool,
}

/// Cards per transaction (each is a delete and a ledger line; the player and their stats are saved too).
const BATCH: usize = 40;

/// Takes back what came in during a window: standard and boosted packs, parts, and the cards from then that are still
/// in the binder. Previews unless `apply`.
async fn reverse(
    State(s): State<Shared>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<ReverseReq>,
) -> ApiResult<Json<ReverseOut>> {
    if req.to < req.from {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let db = &s.db;
    let p = model::profile(db, id).await?.ok_or_else(not_found)?;
    let lines: Vec<LedgerLine> = db
        .query(&upk(id), "LED#")
        .await?
        .into_iter()
        .filter_map(|it| crate::db::from_item::<LedgerLine>(it).ok())
        // A new account's starting packs are never taken back, nor an earlier reversal's own lines.
        .filter(|l| {
            l.at >= req.from && l.at <= req.to && l.delta > 0 && l.reason != REVERSAL && l.reason != "new account"
        })
        .collect();
    let mut out = ReverseOut::default();
    // Packs by the pack they belong to (the ledger line's detail).
    let mut packs: HashMap<String, (i64, i64)> = HashMap::new();
    let mut wanted: Vec<(i32, i32)> = Vec::new();
    for l in &lines {
        match l.item.as_str() {
            "packs" => {
                out.packs += l.delta;
                packs.entry(l.detail.clone().unwrap_or_default()).or_default().0 += l.delta;
            }
            "boosted" => {
                out.boosted += l.delta;
                packs.entry(l.detail.clone().unwrap_or_default()).or_default().1 += l.delta;
            }
            "parts" => out.parts += l.delta,
            "card" => {
                if let Some(d) = &l.detail {
                    out.cards.push(d.clone());
                    let mut it = d.split(" #");
                    if let (Some(t), Some(sn)) =
                        (it.next().and_then(|x| x.trim().parse().ok()), it.next().and_then(|x| x.trim().parse().ok()))
                    {
                        wanted.push((t, sn));
                    }
                }
            }
            _ => {}
        }
    }
    // What they still have of it.
    out.took_parts = out.parts.min(p.parts.max(0));
    let mut rows = Vec::new();
    for (pack, (std_in, boosted_in)) in &packs {
        let row = model::pack_row(db, id, pack).await?;
        let took_b = (*boosted_in).min(i64::from(row.boosted));
        let took_s = (*std_in).min(i64::from(row.standard()));
        out.took_boosted += took_b;
        out.took_packs += took_s;
        rows.push((pack.clone(), took_s as i32, took_b as i32));
    }
    let catalog = s.catalog().await;
    let mut to_remove: Vec<model::CardRow> = Vec::new();
    for pack in &catalog.packs {
        for c in model::cards(db, id, pack.id()).await? {
            if wanted.contains(&(c.team, c.serial)) {
                out.took_cards.push(format!("{} #{}", c.team, c.serial));
                to_remove.push(c);
            }
        }
    }
    out.gone = out.cards.iter().filter(|c| !out.took_cards.contains(c)).cloned().collect();
    if !req.apply {
        return Ok(Json(out));
    }

    // Applying: their open offers go first (they may promise these cards), then packs and parts, then the cards.
    crate::trades::cancel_all(db, id).await?;
    let summary = format!(
        "{} to {}: took {} packs, {} boosted, {} parts, {} cards",
        req.from,
        req.to,
        out.took_packs,
        out.took_boosted,
        out.took_parts,
        out.took_cards.len()
    );
    retry!(async {
        let mut p = model::profile(db, id).await?.ok_or_else(not_found)?;
        let parts = p.parts;
        let mut tx = Tx::new();
        for (pack, took_s, took_b) in &rows {
            let before = model::pack_row(db, id, pack).await?;
            let mut after = before.clone();
            let b = (*took_b).min(after.boosted);
            after.boosted -= b;
            after.sealed -= b;
            after.sealed -= (*took_s).min(after.standard());
            model::save_pack(&mut tx, &mut p, &before, &after, REVERSAL);
        }
        p.parts -= out.took_parts.min(p.parts.max(0));
        note(&mut tx, admin.id, id, "reverse", &summary);
        model::save_user(&mut tx, &mut p, parts, REVERSAL);
        tx.commit(db).await.map_err(ApiError::from)
    })?;
    for chunk in to_remove.chunks(BATCH) {
        retry!(async {
            let mut p = model::profile(db, id).await?.ok_or_else(not_found)?;
            let mut tx = Tx::new();
            let mut by_pack: HashMap<String, Vec<&model::CardRow>> = HashMap::new();
            for c in chunk {
                by_pack.entry(c.pack.clone()).or_default().push(c);
            }
            for (pack, cards) in &by_pack {
                let mut st = model::stats(db, id, pack).await?;
                let mut left = model::cards(db, id, pack).await?;
                for c in cards {
                    model::remove_card(&mut tx, id, c, REVERSAL);
                    if model::printed(c) {
                        model::count_in_game(&mut tx, pack, c.team, -1);
                    }
                    left.retain(|x| x.id != c.id);
                    st.cards -= 1;
                    if !left.iter().any(|x| x.team == c.team) {
                        model::stats_team_lost(&mut st, &c.tier);
                    }
                }
                model::save_stats(&mut tx, id, pack, &st);
            }
            let parts = p.parts;
            model::save_user(&mut tx, &mut p, parts, REVERSAL);
            tx.commit(db).await.map_err(ApiError::from)
        })?;
    }
    out.applied = true;
    Ok(Json(out))
}

/// The ledger reason for everything a rollback changes.
pub const ROLLBACK: &str = "rollback";

/// Cards per rollback transaction (each is three writes; the player and their stats are saved too).
const ROLLBACK_BATCH: usize = 25;

#[derive(Deserialize)]
struct RollbackReq {
    /// Roll back to this moment, in ms since 1970: everything since is undone.
    to: i64,
    /// False (the default) only shows what would change.
    #[serde(default)]
    apply: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RollbackPack {
    pack: String,
    /// Now, and after the rollback.
    standard: [i64; 2],
    boosted: [i64; 2],
    division: [i64; 2],
    /// The Mythic meter (packs since the last Mythic) and the Legendary one, now and after. Unchanged when no pack was
    /// opened since.
    meter_m: [i64; 2],
    meter_l: [i64; 2],
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RollbackOut {
    /// Now, and after the rollback.
    parts: [i64; 2],
    packs: Vec<RollbackPack>,
    /// Cards they got since, still in their binder: taken away.
    remove: Vec<String>,
    /// Cards they lost since (scrapped, for example): given back, with the same serial numbers.
    restore: Vec<String>,
    /// Cards they got since that aren't in their binder any more (traded or staked): nothing to take.
    gone: Vec<String>,
    /// Ledger lines from trades and wagers since: left alone, because other players are in them.
    skipped: i64,
    applied: bool,
}

/// Packs gained since, per pack: standard, boosted and division, and the meter as it was then.
struct PackUndo {
    pack: String,
    standard: i64,
    boosted: i64,
    division: i64,
    meter: Option<(i32, i32)>,
}

/// What a rollback changes.
struct RollbackPlan {
    out: RollbackOut,
    parts_net: i64,
    packs: Vec<PackUndo>,
    remove: Vec<model::CardRow>,
    /// Pack, team, tier and serial of each card to give back.
    restore: Vec<(String, i32, String, i32)>,
}

async fn plan_rollback(s: &Shared, id: Uuid, to: i64) -> ApiResult<RollbackPlan> {
    let db = &s.db;
    let p = model::profile(db, id).await?.ok_or_else(not_found)?;
    let lines: Vec<LedgerLine> = db
        .query(&upk(id), "LED#")
        .await?
        .into_iter()
        .filter_map(|it| from_item::<LedgerLine>(it).ok())
        .filter(|l| l.at >= to)
        .collect();
    let mut out = RollbackOut::default();
    let mut parts_net = 0;
    // Pack -> (standard, boosted, division) gained since.
    let mut by_pack: HashMap<String, (i64, i64, i64)> = HashMap::new();
    // (team, serial) -> copies gained since (negative: lost).
    let mut cards: HashMap<(i32, i32), i64> = HashMap::new();
    for l in &lines {
        if l.reason.starts_with("trade ") || l.reason.starts_with("wager ") {
            out.skipped += 1;
            continue;
        }
        let detail = l.detail.clone().unwrap_or_default();
        match l.item.as_str() {
            "parts" => parts_net += l.delta,
            "packs" => by_pack.entry(detail).or_default().0 += l.delta,
            "boosted" => by_pack.entry(detail).or_default().1 += l.delta,
            "division" => by_pack.entry(detail).or_default().2 += l.delta,
            "card" => {
                let mut it = detail.split(" #");
                if let (Some(t), Some(sn)) =
                    (it.next().and_then(|x| x.trim().parse().ok()), it.next().and_then(|x| x.trim().parse().ok()))
                {
                    *cards.entry((t, sn)).or_default() += l.delta;
                }
            }
            _ => {}
        }
    }
    out.parts = [p.parts, (p.parts - parts_net).max(0)];

    // The meter as it was: what the first pack opened since was rolled with.
    let mut first_open: HashMap<String, model::Opening> = HashMap::new();
    for o in db.query(&upk(id), "OPEN#").await?.into_iter().filter_map(|it| from_item::<model::Opening>(it).ok()) {
        if o.opened_at < to {
            continue;
        }
        match first_open.get(&o.pack) {
            Some(e) if e.opened_at <= o.opened_at => {}
            _ => {
                first_open.insert(o.pack.clone(), o);
            }
        }
    }
    let catalog = s.catalog().await;
    let mut packs = Vec::new();
    for pack in &catalog.packs {
        let (std_in, boosted_in, div_in) = by_pack.get(pack.id()).copied().unwrap_or_default();
        let meter = first_open.get(pack.id()).and_then(|o| Some((o.pity_m?, o.pity_l?)));
        if std_in == 0 && boosted_in == 0 && div_in == 0 && meter.is_none() {
            continue;
        }
        let row = model::pack_row(db, id, pack.id()).await?;
        let (std_now, b_now, d_now) = (i64::from(row.standard()), i64::from(row.boosted), row.division.len() as i64);
        let (m, l) = meter.unwrap_or((row.pity_m, row.pity_l));
        // A division pack opened since was bought before: there's no telling which division it was, so it isn't
        // given back.
        let div_in = div_in.max(0);
        out.packs.push(RollbackPack {
            pack: pack.id().to_string(),
            standard: [std_now, (std_now - std_in).max(0)],
            boosted: [b_now, (b_now - boosted_in).max(0)],
            division: [d_now, (d_now - div_in).max(0)],
            meter_m: [i64::from(row.pity_m), i64::from(m)],
            meter_l: [i64::from(row.pity_l), i64::from(l)],
        });
        packs.push(PackUndo {
            pack: pack.id().to_string(),
            standard: std_in,
            boosted: boosted_in,
            division: div_in,
            meter,
        });
    }

    // Cards: what they hold now, to find the ones to take, and to never give back one they still have.
    let mut held: HashMap<(i32, i32), model::CardRow> = HashMap::new();
    for pack in &catalog.packs {
        for c in model::cards(db, id, pack.id()).await? {
            held.insert((c.team, c.serial), c);
        }
    }
    let mut remove = Vec::new();
    let mut restore = Vec::new();
    let mut changed: Vec<((i32, i32), i64)> = cards.into_iter().filter(|(_, d)| *d != 0).collect();
    changed.sort_unstable();
    for ((team, serial), d) in changed {
        let name = format!("{team} #{serial}");
        if d > 0 {
            match held.get(&(team, serial)) {
                Some(c) => {
                    out.remove.push(name);
                    remove.push(c.clone());
                }
                None => out.gone.push(name),
            }
        } else if !held.contains_key(&(team, serial))
            && let Some(pack) = catalog.packs.iter().find(|p| p.team_tier.contains_key(&team))
        {
            out.restore.push(name);
            restore.push((pack.id().to_string(), team, pack.team_tier[&team].as_str().to_string(), serial));
        }
    }
    Ok(RollbackPlan { out, parts_net, packs, remove, restore })
}

/// Rolls a player's account back to a moment: undoes every change to their parts, packs, cards and Mythic meter since,
/// except trades and wagers (other players are in those). Cards they scrapped come back with the same serial numbers.
/// Previews unless `apply`.
async fn rollback(
    State(s): State<Shared>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<RollbackReq>,
) -> ApiResult<Json<RollbackOut>> {
    if req.to > now_ms() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let RollbackPlan { mut out, parts_net, packs, remove, restore } = plan_rollback(&s, id, req.to).await?;
    if !req.apply {
        return Ok(Json(out));
    }
    let db = &s.db;
    // Their open offers go first (they may promise cards that are about to go), then parts, packs and the meter, then
    // the cards.
    crate::trades::cancel_all(db, id).await?;
    let summary = format!(
        "to {}: parts {} -> {}, {} cards taken, {} given back",
        req.to,
        out.parts[0],
        out.parts[1],
        out.remove.len(),
        out.restore.len()
    );
    retry!(async {
        let mut p = model::profile(db, id).await?.ok_or_else(not_found)?;
        let parts = p.parts;
        let mut tx = Tx::new();
        for u in &packs {
            let before = model::pack_row(db, id, &u.pack).await?;
            let mut after = before.clone();
            let boosted = (i64::from(before.boosted) - u.boosted).max(0) as i32;
            let standard = (i64::from(before.standard()) - u.standard).max(0) as i32;
            after.boosted = boosted;
            after.sealed = standard + boosted;
            let keep = after.division.len().saturating_sub(u.division as usize);
            after.division.truncate(keep);
            if let Some((m, l)) = u.meter {
                after.pity_m = m;
                after.pity_l = l;
            }
            if after != before {
                model::save_pack(&mut tx, &mut p, &before, &after, ROLLBACK);
            }
        }
        p.parts = (p.parts - parts_net).max(0);
        note(&mut tx, admin.id, id, "rollback", &summary);
        model::save_user(&mut tx, &mut p, parts, ROLLBACK);
        tx.commit(db).await.map_err(ApiError::from)
    })?;

    // Cards, a batch at a time.
    let first = if restore.is_empty() { 0 } else { db.ids("card", restore.len() as i64).await? };
    let now = now_ms();
    let restore: Vec<model::CardRow> = restore
        .into_iter()
        .enumerate()
        .map(|(i, (pack, team, tier, serial))| model::CardRow {
            id: first + i as i64,
            pack,
            team,
            tier,
            serial,
            opening_id: None,
            slot: None,
            obtained: "pack".into(),
            created_at: now,
        })
        .collect();
    let changes: Vec<(bool, &model::CardRow)> =
        remove.iter().map(|c| (false, c)).chain(restore.iter().map(|c| (true, c))).collect();
    for chunk in changes.chunks(ROLLBACK_BATCH) {
        retry!(async {
            let mut p = model::profile(db, id).await?.ok_or_else(not_found)?;
            let mut tx = Tx::new();
            let mut by_pack: HashMap<&str, Vec<(bool, &model::CardRow)>> = HashMap::new();
            for (add, c) in chunk {
                by_pack.entry(c.pack.as_str()).or_default().push((*add, *c));
            }
            for (pack, cards) in &by_pack {
                let mut st = model::stats(db, id, pack).await?;
                let mut left = model::cards(db, id, pack).await?;
                // The game's count per team, once each (a transaction can't write one item twice).
                let mut counts: HashMap<i32, i64> = HashMap::new();
                for (add, c) in cards {
                    if model::printed(c) {
                        *counts.entry(c.team).or_default() += if *add { 1 } else { -1 };
                    }
                    if *add {
                        if !left.iter().any(|x| x.team == c.team) {
                            model::stats_team_gained(&mut st, &c.tier);
                        }
                        model::add_card(&mut tx, id, c, ROLLBACK);
                        left.push((*c).clone());
                        st.cards += 1;
                    } else {
                        model::remove_card(&mut tx, id, c, ROLLBACK);
                        left.retain(|x| x.id != c.id);
                        st.cards -= 1;
                        if !left.iter().any(|x| x.team == c.team) {
                            model::stats_team_lost(&mut st, &c.tier);
                        }
                    }
                }
                for (team, by) in counts.into_iter().filter(|(_, by)| *by != 0) {
                    model::count_in_game(&mut tx, pack, team, by);
                }
                model::save_stats(&mut tx, id, pack, &st);
            }
            let parts = p.parts;
            model::save_user(&mut tx, &mut p, parts, ROLLBACK);
            tx.commit(db).await.map_err(ApiError::from)
        })?;
    }
    out.applied = true;
    Ok(Json(out))
}
