//! The admin panel's API under /api/admin: invite codes and managing accounts. Only the admin account can use it.

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::Shared;
use crate::accounts;
use crate::api::{self, Rules};
use crate::auth::Admin;
use crate::db::{Cond, Db, DbError, Tx, from_item, get_n, get_s, key, n, pad, s as sv};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, CardRow, PackRow, Profile, now_ms, upk};
use crate::retry;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/invites", get(invites).post(create_invites))
        .route("/invites/{code}/delete", post(delete_invite))
        .route("/users", get(users))
        .route("/users/{id}/password", post(reset_password))
        .route("/users/{id}/packs", post(give_packs))
        .route("/users/{id}/disabled", post(set_disabled))
        .route("/users/{id}/admin", post(set_admin))
        .route("/users/{id}/delete", post(delete_user))
        .route("/settings", get(settings).post(save_settings))
        .route("/reports", get(reports))
        .route("/reports/{id}/resolve", post(resolve_report))
        .route("/users/{id}/rename", post(rename_user))
        .route("/users/{id}/badge", post(set_badge))
        .route("/users/{id}/clear-bio", post(clear_bio))
        .route("/users/{id}/ledger", get(ledger))
        .route("/test-pack", post(test_pack))
        .route("/audit", get(audit))
        .route("/retier", post(retier_all))
}

fn err(status: StatusCode, code: &'static str) -> ApiError {
    ApiError::new(status, code)
}

#[derive(Deserialize)]
struct TestPackReq {
    pack: String,
}

#[derive(Serialize)]
struct TestPackOut {
    /// One team of each rarity, best last.
    cards: Vec<crate::roll::Rolled>,
}

/// A throwaway pack for the admin to try the opening flow: one sample team of every rarity, but it
/// reads and writes nothing. No pack is used, no serial number is minted, nothing joins the binder, the pity counters
/// don't move, and the ledger and circulation counts never see it.
async fn test_pack(
    State(s): State<Shared>,
    _admin: Admin,
    Json(req): Json<TestPackReq>,
) -> ApiResult<Json<TestPackOut>> {
    let pack = api::pack(&s, &req.pack).await?;
    // One sample team of every rarity, so the whole range can be seen in one pack (best last).
    let mut rng = rand::rng();
    let mut cards: Vec<crate::roll::Rolled> = crate::packs::Tier::ORDER
        .iter()
        .filter_map(|t| {
            let pool = pack.pools.get(t)?;
            (!pool.is_empty())
                .then(|| crate::roll::Rolled { num: pool[rand::Rng::random_range(&mut rng, 0..pool.len())], tier: *t })
        })
        .collect();
    crate::roll::sort_best_last(&mut cards);
    Ok(Json(TestPackOut { cards }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerOut {
    at: i64,
    item: String,
    delta: i64,
    detail: Option<String>,
    reason: String,
}

/// Everything that changed one player's packs, parts and cards, newest first: for answering "where did my card go?"
async fn ledger(State(s): State<Shared>, _admin: Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Vec<LedgerOut>>> {
    Ok(Json(
        model::ledger_lines(&s.db, id, 500)
            .await?
            .into_iter()
            .map(|l| LedgerOut { at: l.at, item: l.item, delta: l.delta, detail: l.detail, reason: l.reason })
            .collect(),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditOut {
    /// Players checked.
    players: i64,
    /// Players whose packs, parts or cards don't match their ledger (should always be empty).
    mismatches: Vec<Value>,
    /// Serial numbers that two cards share, or that are higher than were ever printed (should always be empty).
    bad_serials: i64,
    /// Open offers for cards their maker no longer has.
    stale_offers: i64,
}

/// Brings every player's cards up to the current rarities now, instead of when each next opens the game.
async fn retier_all(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<Value>> {
    let (checked, paid) = crate::retier::ensure_all(&s).await?;
    Ok(Json(serde_json::json!({ "players": checked, "compensated": paid })))
}

/// Checks the whole game adds up: every player's packs, parts and cards against their ledger, and every serial number.
async fn audit(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<AuditOut>> {
    Ok(Json(audit_all(&s.db).await?))
}

async fn audit_all(db: &Db) -> ApiResult<AuditOut> {
    let all = db.scan_all().await?;
    let mut names: HashMap<String, (Uuid, Option<String>)> = HashMap::new();
    // (player pk, item) -> (have, booked in the ledger)
    let mut sums: HashMap<(String, String), (i64, i64)> = HashMap::new();
    let mut serials: HashMap<(String, i64, i64), i64> = HashMap::new();
    let mut minted: HashMap<(String, i64), i64> = HashMap::new();
    let mut card_ids: HashSet<(String, i64)> = HashSet::new();
    let mut trades: Vec<crate::trades::Trade> = Vec::new();
    for it in &all {
        let pk = get_s(it, "pk").unwrap_or_default();
        let sk = get_s(it, "sk").unwrap_or_default();
        if sk == "PROFILE" {
            if let Ok(p) = from_item::<Profile>(it.clone()) {
                names.insert(pk.clone(), (p.id, p.username.clone()));
                sums.entry((pk.clone(), "parts".into())).or_default().0 += p.parts;
            }
        } else if sk.starts_with("PACK#") {
            if let Ok(r) = from_item::<PackRow>(it.clone()) {
                sums.entry((pk.clone(), "packs".into())).or_default().0 += i64::from(r.standard());
                sums.entry((pk.clone(), "boosted".into())).or_default().0 += i64::from(r.boosted);
            }
        } else if sk.starts_with("CARD#") {
            if let Ok(c) = from_item::<CardRow>(it.clone()) {
                sums.entry((pk.clone(), "card".into())).or_default().0 += 1;
                *serials.entry((c.pack.clone(), i64::from(c.team), i64::from(c.serial))).or_default() += 1;
                card_ids.insert((pk.clone(), c.id));
            }
        } else if sk.starts_with("LED#") {
            if let (Some(what), Some(d)) = (get_s(it, "item"), get_n(it, "delta")) {
                sums.entry((pk.clone(), what)).or_default().1 += d;
            }
        } else if sk == "PRINT" {
            let parts: Vec<&str> = pk.splitn(3, '#').collect();
            if let [_, pack, team] = parts[..] {
                minted.insert((pack.to_string(), team.parse().unwrap_or(0)), get_n(it, "minted").unwrap_or(0));
            }
        } else if sk == "TRADE"
            && let Ok(t) = from_item::<crate::trades::Trade>(it.clone())
        {
            trades.push(t);
        }
    }
    let mut mismatches: Vec<Value> = sums
        .iter()
        .filter(|(_, (have, booked))| have != booked)
        .filter_map(|((pk, item), (have, booked))| {
            let (id, name) = names.get(pk)?;
            Some(json!({ "id": id, "username": name, "item": item, "have": have, "ledger": booked }))
        })
        .collect();
    mismatches.sort_by_key(|m| m["username"].as_str().unwrap_or_default().to_lowercase());
    mismatches.truncate(200);
    let bad_serials = serials
        .iter()
        .filter(|((pack, team, serial), count)| {
            **count > 1 || *serial < 1 || minted.get(&(pack.clone(), *team)).is_none_or(|m| serial > m)
        })
        .count() as i64;
    let stale_offers = trades
        .iter()
        .filter(|t| t.status == "open" && t.give.iter().any(|c| !card_ids.contains(&(upk(t.from_user), c.id))))
        .count() as i64;
    Ok(AuditOut { players: names.len() as i64, mismatches, bad_serials, stale_offers })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportOut {
    id: i64,
    target_id: Uuid,
    target: String,
    reporter: String,
    reason: String,
    details: String,
    created_at: i64,
}

async fn name_of(db: &Db, id: Uuid) -> ApiResult<String> {
    Ok(model::profile(db, id).await?.and_then(|p| p.username).unwrap_or_else(|| "guest".into()))
}

/// Open reports, newest first.
async fn reports(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<Vec<ReportOut>>> {
    let mut out = Vec::new();
    for it in s.db.index("gsi1", "REPORTS", Some(200), true).await? {
        let uuid = |k: &str| get_s(&it, k).and_then(|v| Uuid::parse_str(&v).ok());
        let (Some(target), Some(reporter)) = (uuid("target"), uuid("reporter")) else { continue };
        out.push(ReportOut {
            id: get_n(&it, "id").unwrap_or(0),
            target_id: target,
            target: name_of(&s.db, target).await?,
            reporter: name_of(&s.db, reporter).await?,
            reason: get_s(&it, "reason").unwrap_or_default(),
            details: get_s(&it, "details").unwrap_or_default(),
            created_at: get_n(&it, "created_at").unwrap_or(0),
        });
    }
    Ok(Json(out))
}

/// Marks a report handled: it leaves the open list.
async fn resolve_report(State(s): State<Shared>, _admin: Admin, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    let mut tx = Tx::new();
    tx.update(
        "",
        &format!("REPORT#{id}"),
        "REPORT",
        Cond::new("SET resolved_at = :t REMOVE gsi1pk, gsi1sk").val(":t", n(now_ms())),
        Some("attribute_exists(pk)"),
    );
    match tx.commit(&s.db).await {
        Ok(()) | Err(DbError::Conflict(_)) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err(e.into()),
    }
}

/// Changes one player (on their version, like every other change to them). `f` can add writes to the transaction.
async fn change_user(
    db: &Db,
    id: Uuid,
    reason: &str,
    f: impl Fn(&mut Profile, &mut Tx) -> ApiResult<()>,
) -> ApiResult<()> {
    retry!(async {
        let mut p = model::profile(db, id).await?.ok_or(err(StatusCode::NOT_FOUND, "not_found"))?;
        let parts = p.parts;
        let mut tx = Tx::new();
        f(&mut p, &mut tx)?;
        model::save_user(&mut tx, &mut p, parts, reason);
        tx.commit(db).await.map_err(ApiError::from)
    })
}

#[derive(Deserialize)]
struct BadgeReq {
    badge: String,
}

/// Sets the short tag shown next to a player's name ("Beta tester"); empty clears it.
async fn set_badge(
    State(s): State<Shared>,
    _admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<BadgeReq>,
) -> ApiResult<StatusCode> {
    let badge = req.badge.trim();
    if badge.chars().count() > 20 || badge.chars().any(|c| c.is_control()) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let badge = (!badge.is_empty()).then(|| badge.to_string());
    change_user(&s.db, id, "badge", |p, _| {
        p.badge = badge.clone();
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Clears a player's bio (one that's offensive; they can write a new one).
async fn clear_bio(State(s): State<Shared>, _admin: Admin, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    change_user(&s.db, id, "clear bio", |p, _| {
        p.bio = None;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RenameReq {
    username: String,
}

/// Gives an account a new username (for one that's offensive). Their cards, trades and password stay.
async fn rename_user(
    State(s): State<Shared>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<RenameReq>,
) -> ApiResult<StatusCode> {
    other_user(&s, &admin, id).await?;
    let name = req.username.trim();
    if !accounts::valid_username(name) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_username"));
    }
    if !accounts::decent_username(name) {
        return Err(err(StatusCode::BAD_REQUEST, "username_not_allowed"));
    }
    let r = change_user(&s.db, id, "rename", |p, tx| {
        accounts::rename(tx, p, name);
        Ok(())
    })
    .await;
    match r {
        Err(e) if e.code == "name" => Err(err(StatusCode::CONFLICT, "username_taken")),
        r => r.map(|_| StatusCode::NO_CONTENT),
    }
}

/// The free-pack rules: how often, how many, how many missed timers wait, and how many packs new accounts get.
async fn settings(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<Rules>> {
    Ok(Json(api::rules(&s.db).await?))
}

/// Changes the free-pack rules for everyone from the next claim on. A shorter timer takes effect at once: nobody's
/// next free pack is further away than one new timer (claims and the state both cap it).
async fn save_settings(State(s): State<Shared>, _admin: Admin, Json(r): Json<Rules>) -> ApiResult<Json<Rules>> {
    if !r.valid() {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let set = Cond::new(
        "SET claim_minutes = :a, claim_packs = :b, bank = :c, start_packs = :d, boost_cost = :e, donate_url = :f",
    )
    .val(":a", n(r.claim_minutes))
    .val(":b", n(r.claim_packs))
    .val(":c", n(r.bank))
    .val(":d", n(r.start_packs))
    .val(":e", n(r.boost_cost))
    .val(":f", sv(r.donate_url.clone().unwrap_or_default()));
    let mut tx = Tx::new();
    tx.update("", "SETTINGS", "SETTINGS", set, None);
    tx.commit(&s.db).await?;
    Ok(Json(r))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InviteOut {
    code: String,
    note: String,
    max_uses: i32,
    uses: i32,
    created_at: i64,
    used_by: Vec<String>,
}

async fn list_invites(s: &Shared) -> ApiResult<Vec<InviteOut>> {
    let mut out = Vec::new();
    for it in s.db.index("gsi1", "INVITES", None, true).await? {
        let mut used_by = Vec::new();
        if let Some(aws_sdk_dynamodb::types::AttributeValue::L(ids)) = it.get("used_by") {
            for id in ids.iter().filter_map(|v| v.as_s().ok()).filter_map(|v| Uuid::parse_str(v).ok()) {
                if let Some(name) = model::profile(&s.db, id).await?.and_then(|p| p.username) {
                    used_by.push(name);
                }
            }
        }
        out.push(InviteOut {
            code: accounts::show_code(&get_s(&it, "code").unwrap_or_default()),
            note: get_s(&it, "note").unwrap_or_default(),
            max_uses: get_n(&it, "max_uses").unwrap_or(1) as i32,
            uses: get_n(&it, "uses").unwrap_or(0) as i32,
            created_at: get_n(&it, "created_at").unwrap_or(0),
            used_by,
        });
    }
    Ok(out)
}

async fn invites(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<Vec<InviteOut>>> {
    Ok(Json(list_invites(&s).await?))
}

#[derive(Deserialize)]
struct NewInvites {
    #[serde(default)]
    note: String,
    /// How many people can use each code.
    uses: i32,
    /// How many codes to make.
    count: i32,
}

async fn create_invites(
    State(s): State<Shared>,
    admin: Admin,
    Json(req): Json<NewInvites>,
) -> ApiResult<Json<Vec<InviteOut>>> {
    if !(1..=500).contains(&req.uses) || !(1..=50).contains(&req.count) || req.note.chars().count() > 80 {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    for _ in 0..req.count {
        accounts::put_invite(&s.db, &accounts::new_invite_code(), req.note.trim(), req.uses, Some(admin.id)).await?;
    }
    Ok(Json(list_invites(&s).await?))
}

async fn delete_invite(State(s): State<Shared>, _admin: Admin, Path(code): Path<String>) -> ApiResult<StatusCode> {
    let mut tx = Tx::new();
    tx.delete_if("not_found", &format!("INV#{}", accounts::normalize_code(&code)), "INVITE", Some(Cond::exists()));
    match tx.commit(&s.db).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(DbError::Conflict("not_found")) => Err(err(StatusCode::NOT_FOUND, "not_found")),
        Err(e) => Err(e.into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserOut {
    id: Uuid,
    /// None for a guest account from before sign-in existed.
    username: Option<String>,
    admin: bool,
    disabled: bool,
    created_at: i64,
    invite: Option<String>,
    invite_note: Option<String>,
    sealed: i64,
    opened: i64,
    cards: i64,
    last_opened_at: Option<i64>,
    badge: Option<String>,
    bio: Option<String>,
}

async fn users(State(s): State<Shared>, _admin: Admin) -> ApiResult<Json<Vec<UserOut>>> {
    let db = &s.db;
    let mut out = Vec::new();
    for it in db.index("gsi1", "USERS", None, false).await? {
        let Ok(p) = from_item::<Profile>(it) else { continue };
        let rows = model::packs(db, p.id).await?;
        let mut cards = 0;
        for pk in &s.catalog().await.packs {
            cards += model::stats(db, p.id, pk.id()).await?.cards;
        }
        let last = db.query_desc(&upk(p.id), "OPEN#", 1).await?.first().and_then(|o| get_n(o, "opened_at"));
        let note = match &p.invite_code {
            Some(c) => db.get(&format!("INV#{c}"), "INVITE").await?.and_then(|i| get_s(&i, "note")),
            None => None,
        };
        out.push(UserOut {
            id: p.id,
            username: p.username.clone(),
            admin: p.is_admin,
            disabled: p.disabled,
            created_at: p.created_at,
            invite: p.invite_code.as_deref().map(accounts::show_code),
            invite_note: note,
            sealed: rows.iter().map(|r| i64::from(r.sealed)).sum(),
            opened: rows.iter().map(|r| i64::from(r.opened)).sum(),
            cards,
            last_opened_at: last,
            badge: p.badge.clone(),
            bio: p.bio.clone(),
        });
    }
    out.sort_by_key(|u| (!u.admin, u.username.is_none(), u.username.as_ref().map(|n| n.to_lowercase()), u.created_at));
    Ok(Json(out))
}

/// The account being changed, which must exist and must not be the admin's own (so the admin can't lock themself
/// out from the panel).
async fn other_user(s: &Shared, admin: &Admin, id: Uuid) -> ApiResult<Profile> {
    if id == admin.id {
        return Err(err(StatusCode::BAD_REQUEST, "not_yourself"));
    }
    model::profile(&s.db, id).await?.ok_or(err(StatusCode::NOT_FOUND, "not_found"))
}

/// Gives the account a new generated password (shown once) and signs it out everywhere.
async fn reset_password(State(s): State<Shared>, admin: Admin, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let p = other_user(&s, &admin, id).await?;
    if p.username.is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "guest"));
    }
    let password = accounts::new_password();
    let hash = accounts::hash(password.clone()).await;
    change_user(&s.db, id, "password", |p, _| {
        p.password_hash = Some(hash.clone());
        Ok(())
    })
    .await?;
    accounts::end_sessions(&s.db, id, None).await?;
    Ok(Json(json!({ "password": password })))
}

#[derive(Deserialize)]
struct GivePacks {
    count: i32,
}

/// Adds sealed packs of the current pack to the account, e.g. as a reward.
async fn give_packs(
    State(s): State<Shared>,
    _admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<GivePacks>,
) -> ApiResult<StatusCode> {
    if !(1..=100).contains(&req.count) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let free_id = s.catalog().await.claimable().id().to_string();
    let free = free_id.as_str();
    let db = &s.db;
    retry!(async {
        let mut p = model::profile(db, id).await?.ok_or(err(StatusCode::NOT_FOUND, "not_found"))?;
        let before = model::pack_row(db, id, free).await?;
        let mut after = before.clone();
        after.sealed += req.count;
        let mut tx = Tx::new();
        model::save_pack(&mut tx, id, &before, &after, "admin gift");
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "admin gift");
        tx.commit(db).await.map_err(ApiError::from)
    })?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SetAdmin {
    admin: bool,
}

/// Makes an account an admin, or takes admin away. An admin can't change their own.
async fn set_admin(
    State(s): State<Shared>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<SetAdmin>,
) -> ApiResult<StatusCode> {
    let p = other_user(&s, &admin, id).await?;
    if p.username.is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    change_user(&s.db, id, "admin", |p, _| {
        p.is_admin = req.admin;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SetDisabled {
    disabled: bool,
}

/// A disabled account is signed out everywhere and can't sign in until it's enabled again. Its cards are kept.
async fn set_disabled(
    State(s): State<Shared>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<SetDisabled>,
) -> ApiResult<StatusCode> {
    other_user(&s, &admin, id).await?;
    change_user(&s.db, id, "disabled", |p, _| {
        p.disabled = req.disabled;
        Ok(())
    })
    .await?;
    if req.disabled {
        accounts::end_sessions(&s.db, id, None).await?;
        // Their open trade offers, both ways, are called off.
        crate::trades::cancel_all(&s.db, id).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DeleteUser {
    /// The account's username typed again (or "guest" for a guest account), so a slip can't delete the wrong one.
    confirm: String,
}

/// Deletes the account and all its cards. Their serial numbers go back into circulation: each can be pulled again.
async fn delete_user(
    State(s): State<Shared>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<DeleteUser>,
) -> ApiResult<StatusCode> {
    let p = other_user(&s, &admin, id).await?;
    if !req.confirm.trim().eq_ignore_ascii_case(p.username.as_deref().unwrap_or("guest")) {
        return Err(err(StatusCode::BAD_REQUEST, "confirm_mismatch"));
    }
    let db = &s.db;
    // Turned off first, so nothing changes it while it's taken apart.
    change_user(db, id, "account deleted", |p, _| {
        p.disabled = true;
        Ok(())
    })
    .await?;
    accounts::end_sessions(db, id, None).await?;
    crate::trades::cancel_all(db, id).await?;
    let pk = upk(id);
    // Cards: each serial is freed and leaves the game's count, a batch per transaction.
    let cards: Vec<CardRow> = db.query(&pk, "CARD#").await?.into_iter().filter_map(|it| from_item(it).ok()).collect();
    for batch in cards.chunks(30) {
        let mut tx = Tx::new();
        let mut per_team: HashMap<(String, i32), i64> = HashMap::new();
        for c in batch {
            tx.delete_if("", &pk, &model::card_sk(&c.pack, c.team, c.id), None);
            let mut free = key(format!("FREE#{}#{}", c.pack, c.team), pad(i64::from(c.serial), 8));
            free.insert("serial".into(), n(c.serial));
            tx.put(free);
            *per_team.entry((c.pack.clone(), c.team)).or_default() += 1;
        }
        for ((pack, team), k) in per_team {
            model::count_in_game(&mut tx, &pack, team, -k);
        }
        tx.commit(db).await?;
    }
    // Their special cards are deleted, so those numbers can be granted again.
    for sp in crate::specials::load(db, id).await? {
        db.delete(&format!("SP#{}", sp.id), "SPECIAL").await?;
        db.delete(&format!("SPSER#{}", sp.edition), &pad(i64::from(sp.serial), 6)).await?;
    }
    for it in db.index("gsi2", &pk, None, false).await? {
        if get_s(&it, "sk").as_deref() == Some("PUSH") {
            db.delete(&get_s(&it, "pk").unwrap_or_default(), "PUSH").await?;
        }
    }
    if let Some(name) = &p.username {
        db.delete(&format!("NAME#{}", name.to_lowercase()), "NAME").await?;
    }
    for it in db.query(&pk, "").await? {
        db.delete(&pk, &get_s(&it, "sk").unwrap_or_default()).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Makes the admin account if there isn't one yet. Returns its username and, when it was just made, its generated
/// password. Used by `frc-packs-server create-admin`.
pub async fn create_admin(db: &Db, username: &str, start_pack: &str) -> anyhow::Result<(String, Option<String>)> {
    for it in db.index("gsi1", "USERS", None, false).await? {
        if let Ok(p) = from_item::<Profile>(it)
            && p.is_admin
        {
            return Ok((p.username.unwrap_or_default(), None));
        }
    }
    anyhow::ensure!(accounts::valid_username(username), "usernames are 3 to 20 letters, digits or underscores");
    let password = accounts::new_password();
    let hash = accounts::hash(password.clone()).await;
    let start = api::rules(db).await.map_err(|e| anyhow::anyhow!("{}", e.code))?.start_packs;
    let mut p = accounts::new_profile(username, &hash, None, true);
    let mut tx = Tx::new();
    accounts::create(&mut tx, &mut p, start_pack, start);
    match tx.commit(db).await {
        Ok(()) => Ok((username.to_string(), Some(password))),
        Err(DbError::Conflict("name")) => {
            anyhow::bail!("an account named {username} already exists; pick another name: create-admin <name>")
        }
        Err(e) => Err(e.into()),
    }
}

/// Gives an account a new generated password and signs it out everywhere. Used by
/// `frc-packs-server reset-password <username>`, e.g. when the admin password is lost.
pub async fn reset_password_by_name(db: &Db, username: &str) -> anyhow::Result<String> {
    let p = accounts::by_name(db, username).await?.ok_or_else(|| anyhow::anyhow!("no account named {username}"))?;
    let password = accounts::new_password();
    let hash = accounts::hash(password.clone()).await;
    change_user(db, p.id, "password", |p, _| {
        p.password_hash = Some(hash.clone());
        p.disabled = false;
        Ok(())
    })
    .await
    .map_err(|e| anyhow::anyhow!("{}", e.code))?;
    accounts::end_sessions(db, p.id, None).await?;
    Ok(password)
}
