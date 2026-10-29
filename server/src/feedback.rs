//! Feedback from beta testers: bug reports, feature requests and anything else. Players send it from Settings; the admin
//! sees it in the panel, sets a status, and players can see how their own are doing. A bug report or idea the admin
//! accepts (moves to planned or done) earns its sender a sealed pack, once.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::Shared;
use crate::auth::{Admin, User};
use crate::db::{Cond, DbError, Item, Tx, get_n, get_s, key, n, pad, s};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, now_ms};
use crate::push;

pub const KINDS: [&str; 3] = ["bug", "idea", "other"];
pub const STATUSES: [&str; 4] = ["open", "planned", "done", "wontfix"];
/// Packs a sender gets when their bug report or idea is accepted.
pub const REWARD_PACKS: i32 = 1;
/// Ten a day per player is plenty and stops anyone flooding the admin.
pub const PER_DAY: usize = 10;
const TITLE_MAX: usize = 80;
const DETAILS_MAX: usize = 1500;
const CONTEXT_MAX: usize = 300;

pub fn routes() -> Router<Shared> {
    Router::new().route("/feedback", post(send)).route("/feedback/mine", get(mine))
}

pub fn admin_routes() -> Router<Shared> {
    Router::new().route("/feedback", get(all)).route("/feedback/{id}/status", post(set_status))
}

fn err(status: StatusCode, code: &'static str) -> ApiError {
    ApiError::new(status, code)
}

#[derive(Deserialize)]
struct SendReq {
    kind: String,
    title: String,
    #[serde(default)]
    details: String,
    /// Where in the app they were and what they're using (sent by the site): page, app version, device.
    #[serde(default)]
    context: String,
}

fn has_control(v: &str) -> bool {
    v.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
}

async fn send(State(st): State<Shared>, user: User, Json(req): Json<SendReq>) -> ApiResult<StatusCode> {
    let title = req.title.trim();
    let details = req.details.trim();
    let context = req.context.trim();
    if !KINDS.contains(&req.kind.as_str())
        || title.chars().count() < 3
        || title.chars().count() > TITLE_MAX
        || details.chars().count() > DETAILS_MAX
        || context.chars().count() > CONTEXT_MAX
        || has_control(title)
        || has_control(details)
        || has_control(context)
    {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let db = &st.db;
    let now = now_ms();
    let today = db
        .index("gsi2", &format!("FBU#{}", user.id), None, false)
        .await?
        .iter()
        .filter(|it| get_n(it, "created_at").is_some_and(|t| t > now - 86_400_000))
        .count();
    if today >= PER_DAY {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "too_much_feedback"));
    }
    let id = db.ids("feedback", 1).await?;
    let who = crate::model::profile(db, user.id).await?.and_then(|p| p.username).unwrap_or_default();
    let mut it = key(format!("FB#{id}"), "FB");
    it.insert("id".into(), n(id));
    it.insert("user_id".into(), s(user.id.to_string()));
    it.insert("username".into(), s(who));
    it.insert("kind".into(), s(req.kind.clone()));
    it.insert("title".into(), s(title));
    it.insert("details".into(), s(details));
    it.insert("context".into(), s(context));
    it.insert("status".into(), s("open"));
    it.insert("created_at".into(), n(now));
    // All feedback, newest last in the index (read newest first); and each player's own.
    it.insert("gsi1pk".into(), s("FEEDBACK"));
    it.insert("gsi1sk".into(), s(format!("{}#{}", pad(now, 15), pad(id, 12))));
    it.insert("gsi2pk".into(), s(format!("FBU#{}", user.id)));
    it.insert("gsi2sk".into(), s(format!("{}#{}", pad(now, 15), pad(id, 12))));
    db.put(it).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackOut {
    id: i64,
    kind: String,
    title: String,
    details: String,
    status: String,
    note: String,
    created_at: i64,
    /// It earned its sender a pack (accepted).
    rewarded: bool,
    /// Only the admin gets these two.
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<String>,
}

fn out(it: &Item, admin: bool) -> Option<FeedbackOut> {
    Some(FeedbackOut {
        id: get_n(it, "id")?,
        kind: get_s(it, "kind")?,
        title: get_s(it, "title")?,
        details: get_s(it, "details").unwrap_or_default(),
        status: get_s(it, "status").unwrap_or_else(|| "open".into()),
        note: get_s(it, "note").unwrap_or_default(),
        created_at: get_n(it, "created_at").unwrap_or(0),
        rewarded: get_n(it, "rewarded").is_some(),
        username: admin.then(|| get_s(it, "username").unwrap_or_default()),
        context: admin.then(|| get_s(it, "context").unwrap_or_default()),
    })
}

/// The player's own feedback and where each stands, newest first. Read from the items themselves, not the index, so a
/// status change shows at once.
async fn mine(State(st): State<Shared>, user: User) -> ApiResult<Json<Vec<FeedbackOut>>> {
    fresh(&st, "gsi2", &format!("FBU#{}", user.id), 50, false).await.map(Json)
}

async fn fresh(st: &Shared, index: &str, pk: &str, limit: i32, admin: bool) -> ApiResult<Vec<FeedbackOut>> {
    let ids: Vec<i64> =
        st.db.index(index, pk, Some(limit), true).await?.iter().filter_map(|it| get_n(it, "id")).collect();
    let rows = st.db.batch_get(ids.iter().map(|id| key(format!("FB#{id}"), "FB")).collect()).await?;
    let mut v: Vec<FeedbackOut> = rows.iter().filter_map(|it| out(it, admin)).collect();
    v.sort_by_key(|f| std::cmp::Reverse(f.id));
    Ok(v)
}

/// Everything players sent, newest first (admin only).
async fn all(State(st): State<Shared>, _admin: Admin) -> ApiResult<Json<Vec<FeedbackOut>>> {
    fresh(&st, "gsi1", "FEEDBACK", 300, true).await.map(Json)
}

#[derive(Deserialize)]
struct StatusReq {
    status: String,
    /// A short note players see next to the status ("Fixed in the next update").
    #[serde(default)]
    note: String,
}

#[derive(Serialize)]
struct StatusOut {
    /// This change gave the sender their pack (it's only ever given once).
    rewarded: bool,
}

async fn set_status(
    State(st): State<Shared>,
    _admin: Admin,
    Path(id): Path<i64>,
    Json(req): Json<StatusReq>,
) -> ApiResult<Json<StatusOut>> {
    let note = req.note.trim();
    if !STATUSES.contains(&req.status.as_str()) || note.chars().count() > 200 || has_control(note) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let db = &st.db;
    let free = st.catalog().await.claimable().id().to_string();
    for _ in 0..5 {
        let it = db.get(&format!("FB#{id}"), "FB").await?.ok_or(err(StatusCode::NOT_FOUND, "not_found"))?;
        let kind = get_s(&it, "kind").unwrap_or_default();
        let title = get_s(&it, "title").unwrap_or_default();
        let sender = get_s(&it, "user_id").and_then(|u| uuid::Uuid::parse_str(&u).ok());
        // A bug report or idea accepted for the first time: its sender gets a pack, in the same write as the status, so
        // it's given exactly once however the status moves later.
        let reward = matches!(req.status.as_str(), "planned" | "done")
            && matches!(kind.as_str(), "bug" | "idea")
            && get_n(&it, "rewarded").is_none();
        let mut tx = Tx::new();
        let mut set = Cond::new("SET #st = :st, note = :note, updated_at = :at")
            .name("#st", "status")
            .val(":st", s(req.status.clone()))
            .val(":note", s(note))
            .val(":at", n(now_ms()));
        let mut cond = "attribute_exists(pk)";
        let mut sender_profile = None;
        if reward
            && let Some(uid) = sender
            && let Some(mut p) = model::profile(db, uid).await?
            && !p.disabled
        {
            set = Cond::new("SET #st = :st, note = :note, updated_at = :at, rewarded = :at")
                .name("#st", "status")
                .val(":st", s(req.status.clone()))
                .val(":note", s(note))
                .val(":at", n(now_ms()));
            cond = "attribute_exists(pk) AND attribute_not_exists(rewarded)";
            let before = model::pack_row(db, uid, &free).await?;
            let mut after = before.clone();
            after.sealed += REWARD_PACKS;
            model::save_pack(&mut tx, uid, &before, &after, "feedback reward");
            let what = if kind == "bug" { "bug report" } else { "idea" };
            let thanks = format!("Your {what} \"{title}\" was accepted. Thank you! Here's a free pack.");
            p.notice = Some(match p.notice.take() {
                Some(old) if !old.is_empty() => format!("{old}\n\n{thanks}"),
                _ => thanks,
            });
            let parts = p.parts;
            model::save_user(&mut tx, &mut p, parts, "feedback reward");
            sender_profile = Some((uid, what));
        }
        tx.update("not_found", &format!("FB#{id}"), "FB", set, Some(cond));
        match tx.commit(db).await {
            Ok(()) => {
                if let Some((uid, what)) = sender_profile {
                    push::notify(
                        db,
                        uid,
                        push::Note {
                            title: format!("Your {what} was accepted"),
                            body: "Thanks! A free pack is waiting for you.".into(),
                            url: "/#open".into(),
                            tag: format!("feedback-{id}"),
                        },
                    )
                    .await;
                }
                return Ok(Json(StatusOut { rewarded: sender_profile.is_some() }));
            }
            // Rewarded meanwhile, or the sender's account changed: look again.
            Err(DbError::Conflict("not_found" | "ver")) if reward => continue,
            Err(DbError::Conflict("not_found")) => return Err(err(StatusCode::NOT_FOUND, "not_found")),
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::busy())
}
