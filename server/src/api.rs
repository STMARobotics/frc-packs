//! The JSON API under /api. Every rule that matters (odds, pity, timers, serials, sets) is enforced here.
//!
//! Each change to what a player owns reads the player, works out the result, and writes it in one DynamoDB transaction
//! that only goes through if nothing else changed the player in between (see docs/dynamodb.md). A request that loses
//! that race runs again from a fresh read (`retry!`).

use std::collections::{HashMap, HashSet};

use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Shared;
use crate::accounts;
use crate::auth::{self, User};
use crate::db::{Cond, Db, DbError, Tx, from_item, get_n, get_s, item, n, s as sv};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, CardRow, FeedEvent, Opening, PackRow, Profile, now_ms, upk};
use crate::packs::{Pack, Tier};
use crate::retry;
use crate::roll::{self, Opts, Pity, Rolled};

/// The free-pack rules, which the admin sets in the panel. Out of the box: a pack every 2 hours, missed timers bank up
/// to 2 (so sleeping through one doesn't cost a pack), and new accounts start with 2 packs and a free one ready.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    /// Minutes between free packs.
    pub claim_minutes: i32,
    /// Packs each timer gives.
    pub claim_packs: i32,
    /// How many missed timers wait to be claimed.
    pub bank: i32,
    /// Packs a new account starts with.
    pub start_packs: i32,
    /// Parts a boosted pack costs.
    pub boost_cost: i32,
    /// A donation page (https), shown in the game as "Support FRC Packs". None hides it.
    #[serde(default)]
    pub donate_url: Option<String>,
}

impl Default for Rules {
    fn default() -> Rules {
        Rules { claim_minutes: 120, claim_packs: 1, bank: 2, start_packs: 2, boost_cost: 250, donate_url: None }
    }
}

impl Rules {
    pub fn claim_ms(&self) -> i64 {
        i64::from(self.claim_minutes) * 60_000
    }

    /// 5 minutes to a week, 1 to 20 packs a timer, 1 to 10 timers banked, 0 to 50 starting packs.
    pub fn valid(&self) -> bool {
        (5..=10080).contains(&self.claim_minutes)
            && (1..=20).contains(&self.claim_packs)
            && (1..=10).contains(&self.bank)
            && (0..=50).contains(&self.start_packs)
            && (1..=100_000).contains(&self.boost_cost)
            && self
                .donate_url
                .as_deref()
                .is_none_or(|u| u.starts_with("https://") && u.len() <= 300 && !u.contains(char::is_whitespace))
    }

    /// How many timers have run out and wait to be claimed (at most `bank`). Times in ms.
    fn timers_ready(&self, now: i64, next: i64) -> i64 {
        if now < next { 0 } else { i64::from(self.bank).min(1 + (now - next) / self.claim_ms()) }
    }
}

pub async fn rules(db: &Db) -> ApiResult<Rules> {
    let it = model::settings_item(db).await?;
    let d = Rules::default();
    let num = |k: &str, def: i32| get_n(&it, k).map_or(def, |v| v as i32);
    Ok(Rules {
        claim_minutes: num("claim_minutes", d.claim_minutes),
        claim_packs: num("claim_packs", d.claim_packs),
        bank: num("bank", d.bank),
        start_packs: num("start_packs", d.start_packs),
        boost_cost: num("boost_cost", d.boost_cost),
        donate_url: get_s(&it, "donate_url").filter(|u| !u.is_empty()),
    })
}

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/health", get(health))
        .route("/session", post(session))
        .route("/signup", post(signup))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/password", post(change_password))
        .route("/account/username", post(change_username))
        .route("/account/name", post(change_first_name))
        .route("/state", get(state))
        .route("/notice/seen", post(notice_seen))
        .route("/claim", post(claim))
        .route("/hand", post(hand))
        .route("/open", post(open))
        .route("/openings/{id}/progress", post(progress))
        .route("/collection/{pack}", get(collection))
        .route("/craft/mythic", post(craft_mythic))
        .route("/scrap", post(scrap))
        .route("/copies/{pack}/{num}", get(copies))
        .route("/scrap/extras", post(scrap_extras))
        .route("/craft", post(craft))
        .route("/dev/demo", post(dev_demo))
        .route("/dev/pack", post(dev_pack))
        .route("/dev/skip-timer", post(dev_skip_timer))
        .route("/dev/reset", post(dev_reset))
        .route("/dev/invite", post(dev_invite))
}

pub(crate) fn err(status: StatusCode, code: &'static str) -> ApiError {
    ApiError::new(status, code)
}

pub(crate) async fn me(db: &Db, user: Uuid) -> ApiResult<Profile> {
    model::profile(db, user).await?.ok_or(err(StatusCode::UNAUTHORIZED, "no_session"))
}

// ---------- doing a request once ----------

/// A client-chosen id for one action, from the Idempotency-Key header. Sending the same request again with the same
/// key (say the connection dropped before the answer came back) returns the first answer instead of doing it twice.
pub struct IdemKey(pub Option<Uuid>);

impl<S: Send + Sync> FromRequestParts<S> for IdemKey {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<IdemKey, Self::Rejection> {
        Ok(IdemKey(
            parts
                .headers
                .get("idempotency-key")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| Uuid::parse_str(v.trim()).ok()),
        ))
    }
}

fn req_sk(k: Uuid) -> String {
    format!("REQ#{k}")
}

/// Call first. Some(answer) means this key was already done: send that answer and do nothing.
pub(crate) async fn idem_begin(db: &Db, user: Uuid, key: &IdemKey, kind: &str) -> ApiResult<Option<Response>> {
    let Some(k) = key.0 else { return Ok(None) };
    match db.get(&upk(user), &req_sk(k)).await? {
        None => Ok(None),
        Some(it) if get_s(&it, "kind").as_deref() != Some(kind) => Err(err(StatusCode::BAD_REQUEST, "key_reused")),
        Some(it) => match get_s(&it, "response") {
            Some(r) => {
                Ok(Some(Json(serde_json::from_str::<serde_json::Value>(&r).unwrap_or_default()).into_response()))
            }
            None => Err(err(StatusCode::CONFLICT, "in_progress")),
        },
    }
}

/// Adds the key to the transaction that does the work, so a second request with the same key can't also do it: its
/// transaction fails on this item (label "req").
pub(crate) fn idem_mark(tx: &mut Tx, user: Uuid, key: &IdemKey, kind: &str) {
    if let Some(k) = key.0 {
        let mut it = crate::db::key(upk(user), req_sk(k));
        it.insert("kind".into(), sv(kind));
        it.insert("expires_at".into(), n(Utc::now().timestamp() + 2 * 86_400));
        tx.put_if("req", it, Some(Cond::absent()));
    }
}

/// After the work is committed: keeps the answer for a retry with the same key.
pub(crate) async fn idem_end<T: Serialize>(db: &Db, user: Uuid, key: &IdemKey, kind: &str, out: &T) -> ApiResult<()> {
    if let Some(k) = key.0 {
        let mut it = crate::db::key(upk(user), req_sk(k));
        it.insert("kind".into(), sv(kind));
        it.insert("expires_at".into(), n(Utc::now().timestamp() + 2 * 86_400));
        it.insert("response".into(), sv(serde_json::to_string(out).unwrap_or_default()));
        db.put(it).await?;
    }
    Ok(())
}

/// A commit that failed because the same key was used by a request that got there first: answer like `idem_begin`.
pub(crate) async fn idem_lost(db: &Db, user: Uuid, key: &IdemKey, kind: &str) -> ApiResult<Response> {
    match idem_begin(db, user, key, kind).await? {
        Some(r) => Ok(r),
        None => Err(err(StatusCode::CONFLICT, "in_progress")),
    }
}

/// For uptime checks: the server is up and can reach the database.
async fn health(State(s): State<Shared>) -> ApiResult<Json<serde_json::Value>> {
    model::settings_item(&s.db).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------- responses ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateOut {
    account: AccountOut,
    /// Server time, so the site can show timers without trusting the device clock.
    now: i64,
    next_claim_at: i64,
    claim_ms: i64,
    /// Packs each timer gives.
    claim_packs: i32,
    /// How many missed timers wait to be claimed.
    bank: i32,
    /// Parts from scrapping extra copies, spent on boosted packs.
    parts: i64,
    /// Where "Support FRC Packs" goes, if the admin set it.
    donate_url: Option<String>,
    boost_cost: i32,
    /// Parts for scrapping one extra copy, by tier.
    scrap_parts: HashMap<Tier, i32>,
    demo: bool,
    dev_tools: bool,
    packs: Vec<PackState>,
    /// A pack that was opened but not fully revealed (for example, the page closed mid-reveal).
    pending: Option<OpeningOut>,
    /// Today's missions and the pack-opening streak.
    missions: Vec<crate::missions::MissionOut>,
    streak: crate::missions::StreakOut,
    /// Collector level for the free pack.
    level: crate::missions::LevelOut,
    /// Teams on your wishlist, and the teams pinned to your profile (the free pack's).
    wishlist: Vec<i32>,
    showcase: Vec<i32>,
    /// Teams that are never scrapped.
    favorites: Vec<i32>,
    /// A note to show once (then the site calls /notice/seen).
    notice: Option<String>,
    /// Teams whose rarity differs from the pack recipe file the site loaded (the admin changed them), by team number.
    tiers: std::collections::BTreeMap<String, Tier>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountOut {
    username: String,
    admin: bool,
    first_name: Option<String>,
    badge: Option<String>,
    /// When the username can next be changed (ms), if it can't be right now.
    rename_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackState {
    id: String,
    sealed: i32,
    /// How many of the sealed packs are boosted (they open first).
    boosted: i32,
    /// How many of the boosted packs are Mythic packs (three Mythics each).
    mythic: i32,
    opened: i32,
    pity: PityOut,
}

#[derive(Serialize)]
struct PityOut {
    m: i32,
    l: i32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CardOut {
    num: i32,
    tier: Tier,
    serial: i32,
    is_new: bool,
    copy: i64,
    /// Copies of this team in the whole game right now, this one included.
    in_game: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpeningOut {
    id: i64,
    pack: String,
    revealed: i32,
    cards: Vec<CardOut>,
    sets: Vec<String>,
}

#[derive(Deserialize)]
struct PackReq {
    pack: String,
    /// Which kind to pick up or open: true for a boosted pack, false for a standard one. Left out, boosted packs go
    /// first.
    #[serde(default)]
    boosted: Option<bool>,
    /// Open a Mythic pack (a boosted pack with three Mythics) instead.
    #[serde(default)]
    mythic: bool,
}

/// The kind of pack to pick up or open (true = boosted), if the player has one of that kind.
fn pack_kind(up: &PackRow, asked: Option<bool>) -> ApiResult<bool> {
    let standard = up.sealed - up.boosted;
    // Mythic packs are counted inside `boosted` but are opened on purpose, never by default.
    let boosted = up.boosted - up.mythic;
    match asked {
        Some(true) if boosted > 0 => Ok(true),
        Some(false) if standard > 0 => Ok(false),
        None if standard + boosted > 0 => Ok(boosted > 0),
        _ => Err(err(StatusCode::CONFLICT, "no_packs")),
    }
}

// ---------- helpers ----------

pub(crate) async fn pack(s: &Shared, id: &str) -> ApiResult<crate::packs::PackRef> {
    crate::packs::PackRef::new(s.catalog().await, id).ok_or(err(StatusCode::NOT_FOUND, "unknown_pack"))
}

async fn roll_for(
    db: &Db,
    p: &Profile,
    pack: &Pack,
    up: &PackRow,
    boosted: bool,
    mythic: bool,
) -> ApiResult<Vec<Rolled>> {
    let opened_any: i32 = model::packs(db, p.id).await?.iter().map(|r| r.opened).sum();
    let opts = Opts {
        demo: p.demo,
        first: opened_any == 0,
        pity: Pity { m: up.pity_m.max(0) as u32, l: up.pity_l.max(0) as u32 },
        boosted,
        mythic,
    };
    let mut rng = rand::rng();
    Ok(roll::roll(pack, &mut rng, &opts))
}

/// One opening's cards as the reveal shows them: copy number among the player's copies of that team, and copies in
/// the game.
async fn load_opening(db: &Db, user: Uuid, o: &Opening) -> ApiResult<OpeningOut> {
    let all = model::cards(db, user, &o.pack).await?;
    let mut mine: Vec<(i32, CardOut)> = Vec::new();
    for c in all.iter().filter(|c| c.opening_id == Some(o.id)) {
        let copy = all.iter().filter(|x| x.team == c.team && x.id <= c.id).count() as i64;
        let in_game = model::printing(db, &o.pack, c.team).await?.live;
        let tier = Tier::parse(&c.tier).unwrap_or(Tier::Common);
        mine.push((
            c.slot.unwrap_or(0),
            CardOut { num: c.team, tier, serial: c.serial, is_new: copy == 1, copy, in_game },
        ));
    }
    mine.sort_by_key(|m| m.0);
    Ok(OpeningOut {
        id: o.id,
        pack: o.pack.clone(),
        revealed: o.revealed,
        cards: mine.into_iter().map(|m| m.1).collect(),
        sets: o.sets.clone(),
    })
}

pub async fn load_state(s: &Shared, user: Uuid) -> ApiResult<StateOut> {
    let db = &s.db;
    let free_id = s.catalog().await.claimable().id().to_string();
    let free = free_id.as_str();
    let (p, rows, r, day, level, wishlist, favorites) = tokio::try_join!(
        me(db, user),
        async { Ok::<_, ApiError>(model::packs(db, user).await?) },
        rules(db),
        async { Ok::<_, ApiError>(model::today(db, user).await?) },
        crate::missions::level(db, user, free),
        crate::profiles::wishlist(db, user, free),
        crate::profiles::favorites(db, user, free),
    )?;
    let (cat, _, overrides) = s.live.get(db).await;
    let packs = cat
        .packs
        .iter()
        .map(|pk| {
            let r = rows.iter().find(|r| r.pack == pk.id()).cloned().unwrap_or_else(|| PackRow::new(pk.id()));
            PackState {
                id: pk.id().to_string(),
                sealed: r.sealed,
                boosted: r.boosted,
                mythic: r.mythic,
                opened: r.opened,
                pity: PityOut { m: r.pity_m, l: r.pity_l },
            }
        })
        .collect();
    let pending = match p.pending_open {
        Some(id) => match model::opening(db, user, id).await? {
            Some(o) if o.revealed < 5 => Some(load_opening(db, user, &o).await?),
            _ => None,
        },
        None => None,
    };
    let (missions, streak) = crate::missions::load(&p, &day);
    let now = now_ms();
    // If the admin shortened the timer, nobody waits longer than one new timer.
    let next = p.next_claim_at.min(now + r.claim_ms());
    Ok(StateOut {
        account: AccountOut {
            username: p.username.clone().unwrap_or_default(),
            admin: p.is_admin,
            first_name: p.first_name.clone(),
            badge: p.badge.clone(),
            rename_at: p.username_changed_at.map(|t| t + RENAME_DAYS * 86_400_000).filter(|t| *t > now),
        },
        now,
        next_claim_at: next,
        claim_ms: r.claim_ms(),
        claim_packs: r.claim_packs,
        bank: r.bank,
        parts: p.parts,
        donate_url: r.donate_url.clone(),
        boost_cost: r.boost_cost,
        scrap_parts: Tier::ORDER.iter().map(|t| (*t, t.scrap_parts())).collect(),
        demo: p.demo,
        dev_tools: s.dev_tools,
        packs,
        pending,
        missions,
        streak,
        level,
        wishlist,
        favorites,
        showcase: p.showcase.clone(),
        notice: p.notice.clone(),
        tiers: overrides.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
    })
}

async fn state_json(s: &Shared, user: Uuid) -> ApiResult<Json<StateOut>> {
    Ok(Json(load_state(s, user).await?))
}

// ---------- accounts ----------

/// The signed-in account's state. Without one: 401 `sign_in`.
async fn session(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<Json<StateOut>> {
    match auth::session(&s.db, &headers).await? {
        Some(u) if !u.disabled && (!s.admin_only || u.is_admin) => {
            crate::retier::ensure(&s, u.id).await?;
            Ok(Json(load_state(&s, u.id).await?))
        }
        Some(u) if !u.disabled => Err(err(StatusCode::FORBIDDEN, "admin_only")),
        _ => Err(err(StatusCode::UNAUTHORIZED, "sign_in")),
    }
}

/// Failed sign-ins allowed per username, and per visitor (a whole school can share one IP), every 15 minutes.
const USER_FAILS: u32 = 10;
const VISITOR_FAILS: u32 = 50;
/// Wrong invite codes allowed per visitor every 15 minutes.
const INVITE_FAILS: u32 = 20;

fn too_many() -> ApiError {
    err(StatusCode::TOO_MANY_REQUESTS, "too_many_attempts")
}

fn signed_in(s: &Shared, token: &str, state: StateOut) -> (HeaderMap, Json<StateOut>) {
    let mut h = HeaderMap::new();
    h.insert(header::SET_COOKIE, auth::cookie(token, s.cookie_secure).parse().unwrap());
    (h, Json(state))
}

#[derive(Deserialize)]
struct SignupReq {
    code: String,
    username: String,
    password: String,
    #[serde(default, rename = "firstName")]
    first_name: String,
}

fn valid_first_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= 30 && !name.chars().any(|c| c.is_control())
}

/// Makes an account with an invite code and signs it in.
async fn signup(
    State(s): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<SignupReq>,
) -> ApiResult<(HeaderMap, Json<StateOut>)> {
    let visitor = format!("invite:{}", auth::visitor(&headers));
    if s.limiter.blocked(&visitor, INVITE_FAILS) {
        return Err(too_many());
    }
    if s.admin_only {
        return Err(err(StatusCode::FORBIDDEN, "admin_only"));
    }
    let username = req.username.trim();
    if !accounts::valid_username(username) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_username"));
    }
    if !accounts::decent_username(username) {
        return Err(err(StatusCode::BAD_REQUEST, "username_not_allowed"));
    }
    if !accounts::valid_password(&req.password) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_password"));
    }
    let first_name = req.first_name.trim();
    if !valid_first_name(first_name) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_first_name"));
    }
    let code = accounts::normalize_code(&req.code);
    let invite = if code.is_empty() { None } else { s.db.get(&format!("INV#{code}"), "INVITE").await? };
    let Some(invite) = invite else {
        s.limiter.fail(&visitor);
        return Err(err(StatusCode::BAD_REQUEST, "bad_invite"));
    };
    if get_n(&invite, "uses").unwrap_or(0) >= get_n(&invite, "max_uses").unwrap_or(1) {
        return Err(err(StatusCode::BAD_REQUEST, "invite_used"));
    }
    if s.db.get(&format!("NAME#{}", username.to_lowercase()), "NAME").await?.is_some() {
        return Err(err(StatusCode::CONFLICT, "username_taken"));
    }
    let password_hash = accounts::hash(req.password).await;
    let start = rules(&s.db).await?.start_packs;
    let mut tx = Tx::new();
    let mut p = accounts::new_profile(username, &password_hash, Some(&code), false);
    p.first_name = Some(first_name.to_string());
    accounts::create(&mut tx, &mut p, s.catalog().await.claimable().id(), start);
    // The invite's last use can only be taken once.
    tx.update(
        "invite",
        &format!("INV#{code}"),
        "INVITE",
        Cond::new("SET uses = uses + :one, used_by = list_append(if_not_exists(used_by, :empty), :me)")
            .val(":one", n(1))
            .val(":empty", aws_sdk_dynamodb::types::AttributeValue::L(vec![]))
            .val(":me", aws_sdk_dynamodb::types::AttributeValue::L(vec![sv(p.id.to_string())])),
        Some("attribute_exists(pk) AND uses < max_uses"),
    );
    let token = accounts::new_session(&mut tx, p.id);
    match tx.commit(&s.db).await {
        Ok(()) => {}
        Err(DbError::Conflict("name")) => return Err(err(StatusCode::CONFLICT, "username_taken")),
        Err(DbError::Conflict("invite")) => return Err(err(StatusCode::BAD_REQUEST, "invite_used")),
        Err(e) => return Err(e.into()),
    }
    let state = load_state(&s, p.id).await?;
    Ok(signed_in(&s, &token, state))
}

#[derive(Deserialize)]
struct LoginReq {
    username: String,
    password: String,
}

async fn login(
    State(s): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<LoginReq>,
) -> ApiResult<(HeaderMap, Json<StateOut>)> {
    let who = auth::visitor(&headers);
    let user_name = req.username.trim().to_lowercase();
    // Per username from this visitor, so someone else guessing wrong can't lock you out; per username overall at a
    // much higher cap, so guessing spread across many addresses still stops; and per visitor.
    let name = format!("user:{user_name}:{who}");
    let name_all = format!("user:{user_name}");
    let visitor = format!("login:{who}");
    if s.limiter.blocked(&name, USER_FAILS)
        || s.limiter.blocked(&name_all, USER_FAILS * 10)
        || s.limiter.blocked(&visitor, VISITOR_FAILS)
    {
        return Err(too_many());
    }
    let p = accounts::by_name(&s.db, &user_name).await?;
    // An unknown name still pays for a hash check, so the answer takes as long as for a real account.
    let ok = match p.as_ref().and_then(|p| p.password_hash.clone()) {
        Some(hash) => accounts::verify(req.password, hash).await,
        None => {
            accounts::verify(req.password, accounts::decoy_hash().to_string()).await;
            false
        }
    };
    let Some(p) = p.filter(|_| ok) else {
        s.limiter.fail(&name);
        s.limiter.fail(&name_all);
        s.limiter.fail(&visitor);
        return Err(err(StatusCode::UNAUTHORIZED, "bad_login"));
    };
    if p.disabled {
        return Err(err(StatusCode::FORBIDDEN, "disabled"));
    }
    if s.admin_only && !p.is_admin {
        return Err(err(StatusCode::FORBIDDEN, "admin_only"));
    }
    s.limiter.clear(&name);
    // Signing in again on this browser replaces its old session instead of leaving it behind.
    if let Some(old) = auth::token_from(&headers) {
        s.db.delete(&auth::session_pk(&old), "SESSION").await?;
    }
    let mut tx = Tx::new();
    let token = accounts::new_session(&mut tx, p.id);
    tx.commit(&s.db).await?;
    crate::retier::ensure(&s, p.id).await?;
    let state = load_state(&s, p.id).await?;
    Ok(signed_in(&s, &token, state))
}

/// Signs this browser out. Other devices stay signed in.
async fn logout(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<impl IntoResponse> {
    if let Some(token) = auth::token_from(&headers) {
        s.db.delete(&auth::session_pk(&token), "SESSION").await?;
    }
    let mut h = HeaderMap::new();
    h.insert(header::SET_COOKIE, auth::clear_cookie(s.cookie_secure).parse().unwrap());
    Ok((StatusCode::NO_CONTENT, h))
}

#[derive(Deserialize)]
struct PasswordReq {
    current: String,
    new: String,
}

/// Changes your password and signs out your other devices.
async fn change_password(
    State(s): State<Shared>,
    headers: HeaderMap,
    user: User,
    Json(req): Json<PasswordReq>,
) -> ApiResult<StatusCode> {
    let key = format!("password:{}", user.id);
    if s.limiter.blocked(&key, USER_FAILS) {
        return Err(too_many());
    }
    if !accounts::valid_password(&req.new) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_password"));
    }
    let p = me(&s.db, user.id).await?;
    if !accounts::verify(req.current, p.password_hash.clone().unwrap_or_default()).await {
        s.limiter.fail(&key);
        return Err(err(StatusCode::UNAUTHORIZED, "bad_login"));
    }
    let new_hash = accounts::hash(req.new).await;
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        let parts = p.parts;
        p.password_hash = Some(new_hash.clone());
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "password");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    let keep = auth::token_from(&headers).map(|t| auth::session_pk(&t));
    accounts::end_sessions(&s.db, user.id, keep.as_deref()).await?;
    s.limiter.clear(&key);
    Ok(StatusCode::NO_CONTENT)
}

const RENAME_DAYS: i64 = 14;

#[derive(Deserialize)]
struct UsernameReq {
    username: String,
    password: String,
}

/// Changes your username (needs your password, and only once every 14 days). Cards, trades and everything else stay.
async fn change_username(
    State(s): State<Shared>,
    user: User,
    Json(req): Json<UsernameReq>,
) -> ApiResult<Json<StateOut>> {
    let key = format!("rename:{}", user.id);
    if s.limiter.blocked(&key, USER_FAILS) {
        return Err(too_many());
    }
    let name = req.username.trim();
    if !accounts::valid_username(name) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_username"));
    }
    if !accounts::decent_username(name) {
        return Err(err(StatusCode::BAD_REQUEST, "username_not_allowed"));
    }
    let p = me(&s.db, user.id).await?;
    if p.username_changed_at.is_some_and(|t| t + RENAME_DAYS * 86_400_000 > now_ms()) {
        return Err(err(StatusCode::CONFLICT, "rename_too_soon"));
    }
    if !accounts::verify(req.password, p.password_hash.clone().unwrap_or_default()).await {
        s.limiter.fail(&key);
        return Err(err(StatusCode::UNAUTHORIZED, "bad_login"));
    }
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        let mut tx = Tx::new();
        accounts::rename(&mut tx, &mut p, name);
        p.username_changed_at = Some(now_ms());
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "rename");
        match tx.commit(&s.db).await {
            Err(DbError::Conflict("name")) => Err(err(StatusCode::CONFLICT, "username_taken")),
            r => r.map_err(ApiError::from),
        }
    })?;
    s.limiter.clear(&key);
    state_json(&s, user.id).await
}

#[derive(Deserialize)]
struct FirstNameReq {
    #[serde(rename = "firstName")]
    first_name: String,
}

/// Changes the first name other players see next to your username.
async fn change_first_name(
    State(s): State<Shared>,
    user: User,
    Json(req): Json<FirstNameReq>,
) -> ApiResult<Json<StateOut>> {
    let name = req.first_name.trim();
    if !valid_first_name(name) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_first_name"));
    }
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        p.first_name = Some(name.to_string());
        let parts = p.parts;
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "name");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    state_json(&s, user.id).await
}

async fn state(State(s): State<Shared>, user: User) -> ApiResult<Json<StateOut>> {
    crate::retier::ensure(&s, user.id).await?;
    state_json(&s, user.id).await
}

/// The player has read their note; don't show it again.
async fn notice_seen(State(s): State<Shared>, user: User) -> ApiResult<StatusCode> {
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        if p.notice.is_none() {
            return Ok(());
        }
        p.notice = None;
        let parts = p.parts;
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "notice");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- free packs ----------

/// Chance that a pack collected from the timer is a boosted one.
const TIMER_BOOSTED_CHANCE: f64 = 0.05;

async fn claim(State(s): State<Shared>, user: User) -> ApiResult<Json<StateOut>> {
    let r = rules(&s.db).await?;
    let free_id = s.catalog().await.claimable().id().to_string();
    let free = free_id.as_str();
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        let now = now_ms();
        let window = r.claim_ms();
        let next = p.next_claim_at.min(now + window);
        let timers = r.timers_ready(now, next);
        if timers == 0 {
            return Err(err(StatusCode::CONFLICT, "not_ready"));
        }
        p.next_claim_at = if timers >= i64::from(r.bank) { now + window } else { next + window * timers };
        let total = timers as i32 * r.claim_packs;
        // Each pack from the timer has a small chance of arriving boosted.
        let lucky = {
            let mut rng = rand::rng();
            (0..total).filter(|_| rand::Rng::random::<f64>(&mut rng) < TIMER_BOOSTED_CHANCE).count() as i32
        };
        let before = model::pack_row(&s.db, user.id, free).await?;
        let mut after = before.clone();
        after.sealed += total;
        after.boosted += lucky;
        let mut day = model::today(&s.db, user.id).await?;
        crate::missions::count(&mut day, crate::missions::Kind::Claimed, i64::from(total));
        let mut tx = Tx::new();
        model::save_pack(&mut tx, user.id, &before, &after, "claim");
        model::save_day(&mut tx, user.id, &mut day);
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "claim");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    state_json(&s, user.id).await
}

// ---------- picking up and opening packs ----------

#[derive(Serialize)]
struct HandOut {
    best: Tier,
    /// The pack in hand is a boosted one.
    boosted: bool,
}

fn hand_sk(pack: &str, boosted: bool) -> String {
    format!("HAND#{pack}#{}", u8::from(boosted))
}

/// Picks up a pack. Its cards are decided now and kept if you put it back; only the best rarity is revealed, to
/// color the glow while you tear it open.
async fn hand(State(s): State<Shared>, user: User, Json(req): Json<PackReq>) -> ApiResult<Json<HandOut>> {
    let pack = pack(&s, &req.pack).await?;
    let up = model::pack_row(&s.db, user.id, pack.id()).await?;
    if req.mythic {
        // A Mythic pack's best card is always a Mythic; nothing to keep in hand.
        if up.mythic < 1 {
            return Err(err(StatusCode::CONFLICT, "no_packs"));
        }
        return Ok(Json(HandOut { best: Tier::Mythic, boosted: true }));
    }
    let kind = pack_kind(&up, req.boosted)?;
    let sk = hand_sk(pack.id(), kind);
    if let Some(it) = s.db.get(&upk(user.id), &sk).await? {
        let cards: Vec<Rolled> = serde_json::from_str(&get_s(&it, "cards").unwrap_or_default()).unwrap_or_default();
        if !cards.is_empty() {
            return Ok(Json(HandOut { best: roll::best(&cards), boosted: kind }));
        }
    }
    let p = me(&s.db, user.id).await?;
    let cards = roll_for(&s.db, &p, &pack, &up, kind, false).await?;
    let mut it = crate::db::key(upk(user.id), &sk);
    it.insert("cards".into(), sv(serde_json::to_string(&cards).unwrap()));
    let mut tx = Tx::new();
    // Two pick-ups at once: the first one's cards stand.
    tx.put_if("hand", it, Some(Cond::absent()));
    match tx.commit(&s.db).await {
        Ok(()) => Ok(Json(HandOut { best: roll::best(&cards), boosted: kind })),
        Err(DbError::Conflict("hand")) => {
            let it = s.db.get(&upk(user.id), &sk).await?.unwrap_or_default();
            let held: Vec<Rolled> = serde_json::from_str(&get_s(&it, "cards").unwrap_or_default()).unwrap_or_default();
            Ok(Json(HandOut { best: roll::best(&held), boosted: kind }))
        }
        Err(e) => Err(e.into()),
    }
}

/// Division sets the player finishes by now owning `owned` teams, among those not done yet. The caller records each
/// (and a bonus pack for each).
pub(crate) fn finished_sets(pack: &Pack, owned: &HashSet<i32>, done: &[String], new_teams: &[i32]) -> Vec<String> {
    let mut sets: Vec<String> = Vec::new();
    for num in new_teams {
        let Some(div) = pack.team_div.get(num) else { continue };
        if done.contains(div) || sets.contains(div) {
            continue;
        }
        if pack.divisions[div].iter().all(|t| owned.contains(t)) {
            sets.push(div.clone());
        }
    }
    sets
}

pub(crate) async fn sets_done(db: &Db, user: Uuid, pack: &str) -> ApiResult<Vec<String>> {
    Ok(db.query(&upk(user), &format!("SET#{pack}#")).await?.iter().filter_map(|it| get_s(it, "division")).collect())
}

pub(crate) fn record_set(tx: &mut Tx, user: Uuid, pack: &str, division: &str) {
    let mut it = crate::db::key(upk(user), format!("SET#{pack}#{division}"));
    it.insert("division".into(), sv(division));
    it.insert("completed_at".into(), n(now_ms()));
    tx.put_if("set", it, Some(Cond::absent()));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenOut {
    opening: OpeningOut,
    /// This pack hit a streak milestone and earned a boosted pack.
    streak_reward: bool,
    state: StateOut,
}

/// A serial number for one new card: a number back in circulation from a deleted account if there is one (taken by
/// deleting its item, so two packs can't both take it), else the team's next new number (the counter moves only if
/// nobody else moved it first).
async fn take_serials(db: &Db, tx: &mut Tx, pack: &str, nums: &[i32]) -> ApiResult<HashMap<usize, i32>> {
    let mut out = HashMap::new();
    let mut teams: Vec<i32> = nums.to_vec();
    teams.sort_unstable();
    teams.dedup();
    for team in teams {
        let slots: Vec<usize> = nums.iter().enumerate().filter(|(_, n)| **n == team).map(|(i, _)| i).collect();
        let freed = db.query(&format!("FREE#{pack}#{team}"), "").await?;
        let mut serials: Vec<i32> = Vec::new();
        for it in freed.iter().take(slots.len()) {
            let serial = get_n(it, "serial").unwrap_or(0) as i32;
            tx.delete_if(
                "free",
                &format!("FREE#{pack}#{team}"),
                &get_s(it, "sk").unwrap_or_default(),
                Some(Cond::exists()),
            );
            serials.push(serial);
        }
        let printed = model::printing(db, pack, team).await?;
        let fresh = slots.len() - serials.len();
        let new_minted = printed.minted + fresh as i32;
        for k in 0..fresh {
            serials.push(printed.minted + 1 + k as i32);
        }
        let cond = if printed.minted == 0 { "attribute_not_exists(minted) OR minted = :m" } else { "minted = :m" };
        tx.update(
            "print",
            &format!("PRINT#{pack}#{team}"),
            "PRINT",
            Cond::new("SET minted = :new ADD live :d")
                .val(":new", n(new_minted))
                .val(":d", n(slots.len()))
                .val(":m", n(printed.minted)),
            Some(cond),
        );
        for (slot, serial) in slots.into_iter().zip(serials) {
            out.insert(slot, serial);
        }
    }
    Ok(out)
}

/// Opens one sealed pack: the pack in hand if there is one, otherwise a fresh roll. Mints serial numbers, updates the
/// pity meter, and awards a bonus pack for each division set this pack completes.
async fn open(State(s): State<Shared>, user: User, key: IdemKey, Json(req): Json<PackReq>) -> ApiResult<Response> {
    let pack = pack(&s, &req.pack).await?;
    if let Some(done) = idem_begin(&s.db, user.id, &key, "open").await? {
        return Ok(done);
    }
    let mythic = req.mythic;
    let r = retry!(async {
        let db = &s.db;
        let mut p = me(db, user.id).await?;
        let before = model::pack_row(db, user.id, pack.id()).await?;
        if mythic && before.mythic < 1 {
            return Err(err(StatusCode::CONFLICT, "no_packs"));
        }
        let kind = if mythic { true } else { pack_kind(&before, req.boosted)? };
        let hand_key = hand_sk(pack.id(), kind);
        let held: Option<Vec<Rolled>> = if mythic {
            None
        } else {
            db.get(&upk(user.id), &hand_key)
                .await?
                .and_then(|it| serde_json::from_str(&get_s(&it, "cards").unwrap_or_default()).ok())
        };
        let valid = |c: &[Rolled]| {
            c.len() == 5
                && c.iter().all(|x| pack.team_tier.get(&x.num) == Some(&x.tier))
                && c.iter().enumerate().all(|(i, x)| !c[..i].iter().any(|y| y.num == x.num))
        };
        let mut cards = match &held {
            Some(c) if valid(c) => c.clone(),
            _ => roll_for(db, &p, &pack, &before, kind, mythic).await?,
        };
        roll::sort_best_last(&mut cards);

        let mut tx = Tx::new();
        idem_mark(&mut tx, user.id, &key, "open");
        if held.is_some() {
            tx.delete_if("ver", &upk(user.id), &hand_key, Some(Cond::exists()));
        }
        // Only one pack can be mid-reveal at a time; an older unfinished one counts as seen.
        if let Some(old) = p.pending_open {
            tx.update(
                "",
                &upk(user.id),
                &model::open_sk(old),
                Cond::new("SET revealed = :five").val(":five", n(5)),
                Some("attribute_exists(pk)"),
            );
        }
        let opening_id = db.ids("open", 1).await?;
        let first_card = db.ids("card", 5).await?;
        let nums: Vec<i32> = cards.iter().map(|c| c.num).collect();
        let serials = take_serials(db, &mut tx, pack.id(), &nums).await?;

        // What the player has now, to number the copies and to see which teams are new.
        let owned_cards = model::cards(db, user.id, pack.id()).await?;
        let mut copies: HashMap<i32, i64> = HashMap::new();
        for c in &owned_cards {
            *copies.entry(c.team).or_default() += 1;
        }
        let mut st = model::stats(db, user.id, pack.id()).await?;
        let st_before = st.clone();
        let mut out = Vec::with_capacity(5);
        let now = now_ms();
        let who = p.username.clone().unwrap_or_default();
        for (slot, c) in cards.iter().enumerate() {
            let serial = serials[&slot];
            let have = copies.entry(c.num).or_default();
            let before_n = *have;
            *have += 1;
            let row = CardRow {
                id: first_card + slot as i64,
                pack: pack.id().to_string(),
                team: c.num,
                tier: c.tier.as_str().to_string(),
                serial,
                opening_id: Some(opening_id),
                slot: Some(slot as i32),
                obtained: "pack".into(),
                created_at: now,
            };
            model::add_card(&mut tx, user.id, &row, "open");
            if before_n == 0 {
                model::stats_team_gained(&mut st, c.tier.as_str());
            }
            st.cards += 1;
            let in_game = model::printing(db, pack.id(), c.num).await?.live
                + nums[..=slot].iter().filter(|x| **x == c.num).count() as i64;
            if matches!(c.tier, Tier::Mythic | Tier::Legendary) || serial <= 3 {
                model::feed(
                    &mut tx,
                    pack.id(),
                    FeedEvent {
                        kind: "pull".into(),
                        who: who.clone(),
                        at: now,
                        team: Some(c.num),
                        tier: Some(c.tier.as_str().into()),
                        serial: Some(serial),
                        division: None,
                        to: None,
                        gave: None,
                        got: None,
                        gave_packs: None,
                        got_packs: None,
                        expires_at: 0,
                    },
                );
            }
            out.push(CardOut { num: c.num, tier: c.tier, serial, is_new: before_n == 0, copy: before_n + 1, in_game });
        }
        let pity = roll::next_pity(Pity { m: before.pity_m.max(0) as u32, l: before.pity_l.max(0) as u32 }, &cards);
        // Division sets this pack completed.
        let done = sets_done(db, user.id, pack.id()).await?;
        let owned: HashSet<i32> = copies.iter().filter(|(_, v)| **v > 0).map(|(k, _)| *k).collect();
        let sets = finished_sets(&pack, &owned, &done, &nums);
        for d in &sets {
            record_set(&mut tx, user.id, pack.id(), d);
            model::feed(
                &mut tx,
                pack.id(),
                FeedEvent {
                    kind: "set".into(),
                    who: who.clone(),
                    at: now,
                    team: None,
                    tier: None,
                    serial: None,
                    division: Some(d.clone()),
                    to: None,
                    gave: None,
                    got: None,
                    gave_packs: None,
                    got_packs: None,
                    expires_at: 0,
                },
            );
        }
        st.sets += sets.len() as i64;
        let mut after = before.clone();
        after.sealed += sets.len() as i32 - 1;
        after.boosted -= i32::from(kind);
        after.mythic -= i32::from(mythic);
        after.opened += 1;
        after.pity_m = pity.m as i32;
        after.pity_l = pity.l as i32;
        let mut day = model::today(db, user.id).await?;
        let streak_reward = crate::missions::on_open(&mut p, &mut day);
        if streak_reward {
            after.sealed += 1;
            after.boosted += 1;
        }
        crate::missions::count(
            &mut day,
            crate::missions::Kind::NewTeams,
            out.iter().filter(|c| c.is_new).count() as i64,
        );
        crate::missions::count(
            &mut day,
            crate::missions::Kind::RarePlus,
            out.iter().filter(|c| c.tier.rank() <= Tier::Rare.rank()).count() as i64,
        );
        model::save_pack(&mut tx, user.id, &before, &after, if streak_reward { "open, streak" } else { "open" });
        if st != st_before {
            model::save_stats(&mut tx, user.id, pack.id(), &st);
        }
        model::save_day(&mut tx, user.id, &mut day);
        let o = Opening {
            id: opening_id,
            pack: pack.id().to_string(),
            revealed: 0,
            sets: sets.clone(),
            boosted: kind,
            opened_at: now,
        };
        tx.put(item(upk(user.id), model::open_sk(opening_id), &o));
        p.pending_open = Some(opening_id);
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "open");
        match tx.commit(db).await {
            Ok(()) => Ok(Ok((
                OpeningOut { id: opening_id, pack: pack.id().to_string(), revealed: 0, cards: out, sets },
                streak_reward,
            ))),
            Err(DbError::Conflict("req")) => Ok(Err(())),
            Err(e) => Err(e.into()),
        }
    })?;
    let Ok((opening, streak_reward)) = r else { return idem_lost(&s.db, user.id, &key, "open").await };
    let state = load_state(&s, user.id).await?;
    let done = OpenOut { opening, streak_reward, state };
    idem_end(&s.db, user.id, &key, "open", &done).await?;
    Ok(Json(done).into_response())
}

#[derive(Deserialize)]
struct ProgressReq {
    revealed: i32,
}

/// How many cards of an opened pack have been dealt. At 5 the pack is done and no longer resumes (and its cards can be
/// traded and scrapped).
async fn progress(
    State(s): State<Shared>,
    user: User,
    Path(id): Path<i64>,
    Json(req): Json<ProgressReq>,
) -> ApiResult<StatusCode> {
    retry!(async {
        let Some(o) = model::opening(&s.db, user.id, id).await? else {
            return Err(err(StatusCode::NOT_FOUND, "unknown_opening"));
        };
        let to = o.revealed.max(req.revealed.clamp(0, 5));
        if to == o.revealed {
            return Ok(());
        }
        let mut tx = Tx::new();
        tx.update(
            "race",
            &upk(user.id),
            &model::open_sk(id),
            Cond::new("SET revealed = :to").val(":to", n(to)).val(":was", n(o.revealed)),
            Some("revealed = :was"),
        );
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- collections ----------

#[derive(Serialize)]
struct OwnedOut {
    num: i32,
    serials: Vec<i32>,
}

#[derive(Serialize)]
pub(crate) struct CollectionOut {
    pack: String,
    cards: Vec<OwnedOut>,
    sets: Vec<String>,
}

pub(crate) async fn load_collection(db: &Db, user: Uuid, pack: &Pack) -> ApiResult<CollectionOut> {
    let rows = model::cards(db, user, pack.id()).await?;
    let mut cards: Vec<OwnedOut> = Vec::new();
    for c in rows {
        match cards.last_mut() {
            Some(o) if o.num == c.team => o.serials.push(c.serial),
            _ => cards.push(OwnedOut { num: c.team, serials: vec![c.serial] }),
        }
    }
    let mut sets = sets_done(db, user, pack.id()).await?;
    sets.sort();
    Ok(CollectionOut { pack: pack.id().to_string(), cards, sets })
}

async fn collection(State(s): State<Shared>, user: User, Path(id): Path<String>) -> ApiResult<Json<CollectionOut>> {
    let pack = pack(&s, &id).await?;
    Ok(Json(load_collection(&s.db, user.id, &pack).await?))
}

// ---------- scrapping and crafting ----------

#[derive(Deserialize)]
struct ScrapReq {
    pack: String,
    num: i32,
    /// How many extra copies to scrap. The first copy you got is never scrapped.
    count: i32,
    /// Scrap this copy in particular (one that isn't the team's first).
    #[serde(default)]
    serial: Option<i32>,
}

#[derive(Deserialize)]
struct ScrapExtrasReq {
    pack: String,
    /// Scrap every extra copy of these tiers.
    tiers: Vec<Tier>,
}

#[derive(Serialize)]
struct ScrapOut {
    /// Parts this gave.
    gained: i64,
    /// Copies scrapped.
    scrapped: i64,
    /// Extra copies that matched but were held back: in a pack still being revealed, or in an open trade offer.
    held: i64,
    state: StateOut,
    collection: CollectionOut,
}

/// Cards a player can't scrap or trade right now: in a pack still being revealed, or promised in an open trade (as the
/// giver, or as the one asked).
pub(crate) async fn held_cards(db: &Db, p: &Profile) -> ApiResult<HashSet<i64>> {
    let mut held = HashSet::new();
    if let Some(id) = p.pending_open
        && model::opening(db, p.id, id).await?.is_some_and(|o| o.revealed < 5)
    {
        for c in db.query(&upk(p.id), "CARD#").await? {
            if get_n(&c, "opening_id") == Some(id) {
                held.insert(get_n(&c, "id").unwrap_or(0));
            }
        }
    }
    for t in crate::trades::open_trades_of(db, p.id).await? {
        if t.from_user == p.id {
            held.extend(t.give.iter().map(|c| c.id));
        } else {
            held.extend(t.want.iter().map(|c| c.id));
        }
    }
    Ok(held)
}

/// Cards per scrapping transaction (each card is a delete and a ledger line).
const SCRAP_BATCH: usize = 25;

/// Scraps extra copies: deletes them (their serial numbers are not reused) and adds their parts. Keeps each team's
/// first copy, and never touches a card from a pack that is still being revealed or one in an open trade offer, or a
/// favorite team. `teams` limits it to some teams (None = every team in `tiers`); `limit` caps copies per team.
/// Returns (parts gained, copies scrapped, copies held back).
#[allow(clippy::too_many_arguments)]
async fn scrap_copies(
    s: &Shared,
    user: Uuid,
    pack: &Pack,
    teams: Option<&[i32]>,
    tiers: &[Tier],
    limit: usize,
    only: Option<i32>,
    key: &IdemKey,
    kind: &str,
) -> ApiResult<Option<(i64, i64, i64)>> {
    // Teams by their tier in the recipe. Extra Legendary copies can be scrapped (you always keep one); Mythic copies
    // never are.
    let wanted: HashSet<i32> = tiers
        .iter()
        .filter(|t| !matches!(t, Tier::Mythic))
        .flat_map(|t| pack.pools.get(t).into_iter().flatten().copied())
        .filter(|n| teams.is_none_or(|only| only.contains(n)))
        .collect();
    let mut gained_total = 0;
    let mut scrapped_total = 0;
    let mut held_total = 0;
    let mut first = true;
    loop {
        let r = retry!(async {
            let db = &s.db;
            let mut p = me(db, user).await?;
            let faves: HashSet<i32> = crate::profiles::favorites(db, user, pack.id()).await?.into_iter().collect();
            let held = held_cards(db, &p).await?;
            let all = model::cards(db, user, pack.id()).await?;
            let mut by_team: HashMap<i32, Vec<&CardRow>> = HashMap::new();
            for c in all.iter().filter(|c| wanted.contains(&c.team) && !faves.contains(&c.team)) {
                by_team.entry(c.team).or_default().push(c);
            }
            let mut extras = 0usize;
            let mut pick: Vec<&CardRow> = Vec::new();
            for copies in by_team.values() {
                extras += copies.len().saturating_sub(1).min(limit);
                // The first copy that's free to scrap is kept; then the newest ones go, up to `limit`.
                let free: Vec<&&CardRow> = copies.iter().filter(|c| !held.contains(&c.id)).collect();
                if let Some(serial) = only {
                    pick.extend(free.iter().skip(1).filter(|c| c.serial == serial).take(1).map(|c| **c));
                    continue;
                }
                let take = free.len().saturating_sub(1).min(limit);
                pick.extend(free[free.len() - take..].iter().map(|c| **c));
            }
            pick.sort_by_key(|c| (c.team, c.id));
            let batch: Vec<&CardRow> = pick.iter().take(SCRAP_BATCH).copied().collect();
            let rest = pick.len() - batch.len();
            let mut tx = Tx::new();
            if first {
                idem_mark(&mut tx, user, key, kind);
            }
            let mut st = model::stats(db, user, pack.id()).await?;
            let mut per_team: HashMap<i32, i64> = HashMap::new();
            let mut gained = 0i64;
            for c in &batch {
                model::remove_card(&mut tx, user, c, "scrap");
                *per_team.entry(c.team).or_default() += 1;
                gained += i64::from(pack.team_tier.get(&c.team).map_or(0, |t| t.scrap_parts()));
            }
            for (team, k) in &per_team {
                model::count_in_game(&mut tx, pack.id(), *team, -k);
            }
            if !batch.is_empty() {
                st.cards -= batch.len() as i64;
                model::save_stats(&mut tx, user, pack.id(), &st);
                let mut day = model::today(db, user).await?;
                crate::missions::count(&mut day, crate::missions::Kind::Scrapped, batch.len() as i64);
                model::save_day(&mut tx, user, &mut day);
                let parts = p.parts;
                p.parts += gained;
                model::save_user(&mut tx, &mut p, parts, "scrap");
            }
            match tx.commit(db).await {
                Ok(()) => Ok::<_, ApiError>(Some((gained, batch.len() as i64, extras as i64, rest))),
                Err(DbError::Conflict("req")) => Ok(None),
                Err(e) => Err(e.into()),
            }
        })?;
        let Some((gained, scrapped, extras, rest)) = r else { return Ok(None) };
        if first {
            held_total = extras;
        }
        first = false;
        gained_total += gained;
        scrapped_total += scrapped;
        if rest == 0 || scrapped == 0 {
            break;
        }
    }
    Ok(Some((gained_total, scrapped_total, (held_total - scrapped_total).max(0))))
}

async fn scrapped(
    s: &Shared,
    user: Uuid,
    pack: &Pack,
    r: (i64, i64, i64),
    key: &IdemKey,
    kind: &str,
) -> ApiResult<Response> {
    let state = load_state(s, user).await?;
    let collection = load_collection(&s.db, user, pack).await?;
    let out = ScrapOut { gained: r.0, scrapped: r.1, held: r.2, state, collection };
    idem_end(&s.db, user, key, kind, &out).await?;
    Ok(Json(out).into_response())
}

#[derive(Serialize)]
struct CopyOut {
    serial: i32,
    /// "pack", "trade" or "wager".
    obtained: String,
    at: i64,
    /// The team's first copy (the one that's never scrapped).
    first: bool,
    /// In a pack still being revealed or promised in an open trade: can't be scrapped or offered again right now.
    held: bool,
}

/// Every copy you have of one team, oldest first: serial, how and when you got it, and whether it's free right now.
async fn copies(
    State(s): State<Shared>,
    user: User,
    Path((pack_id, num)): Path<(String, i32)>,
) -> ApiResult<Json<Vec<CopyOut>>> {
    let pack = pack(&s, &pack_id).await?;
    let db = &s.db;
    let p = me(db, user.id).await?;
    let held = held_cards(db, &p).await?;
    let rows = model::team_cards(db, user.id, pack.id(), num).await?;
    let first = rows.iter().find(|c| !held.contains(&c.id)).map(|c| c.id);
    Ok(Json(
        rows.iter()
            .map(|c| CopyOut {
                serial: c.serial,
                obtained: c.obtained.clone(),
                at: c.created_at,
                first: Some(c.id) == first,
                held: held.contains(&c.id),
            })
            .collect(),
    ))
}

/// Scraps extra copies of one team.
async fn scrap(State(s): State<Shared>, user: User, key: IdemKey, Json(req): Json<ScrapReq>) -> ApiResult<Response> {
    let pack = pack(&s, &req.pack).await?;
    let tier = *pack.team_tier.get(&req.num).ok_or(err(StatusCode::NOT_FOUND, "unknown_team"))?;
    if req.count < 1 {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    if let Some(done) = idem_begin(&s.db, user.id, &key, "scrap").await? {
        return Ok(done);
    }
    let Some(r) =
        scrap_copies(&s, user.id, &pack, Some(&[req.num]), &[tier], req.count as usize, req.serial, &key, "scrap")
            .await?
    else {
        return idem_lost(&s.db, user.id, &key, "scrap").await;
    };
    if r.1 == 0 {
        return Err(err(StatusCode::CONFLICT, if r.2 > 0 { "extras_held" } else { "no_extras" }));
    }
    scrapped(&s, user.id, &pack, r, &key, "scrap").await
}

/// Scraps every extra copy of the chosen tiers.
async fn scrap_extras(
    State(s): State<Shared>,
    user: User,
    key: IdemKey,
    Json(req): Json<ScrapExtrasReq>,
) -> ApiResult<Response> {
    let pack = pack(&s, &req.pack).await?;
    if req.tiers.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    if let Some(done) = idem_begin(&s.db, user.id, &key, "scrap_extras").await? {
        return Ok(done);
    }
    let Some(r) = scrap_copies(&s, user.id, &pack, None, &req.tiers, usize::MAX, None, &key, "scrap_extras").await?
    else {
        return idem_lost(&s.db, user.id, &key, "scrap_extras").await;
    };
    scrapped(&s, user.id, &pack, r, &key, "scrap_extras").await
}

/// Spends parts on a pack of the free pack: a boosted one (`mythic` false) or a Mythic pack.
async fn spend_parts(
    s: &Shared,
    user: Uuid,
    key: &IdemKey,
    kind: &str,
    cost: i64,
    mythic: bool,
) -> ApiResult<Response> {
    if let Some(done) = idem_begin(&s.db, user, key, kind).await? {
        return Ok(done);
    }
    let free_id = s.catalog().await.claimable().id().to_string();
    let free = free_id.as_str();
    let r = retry!(async {
        let db = &s.db;
        let mut p = me(db, user).await?;
        if p.parts < cost {
            return Err(err(StatusCode::CONFLICT, "not_enough_parts"));
        }
        let before = model::pack_row(db, user, free).await?;
        let mut after = before.clone();
        after.sealed += 1;
        after.boosted += 1;
        after.mythic += i32::from(mythic);
        let mut day = model::today(db, user).await?;
        if !mythic {
            crate::missions::count(&mut day, crate::missions::Kind::Crafted, 1);
        }
        let mut tx = Tx::new();
        idem_mark(&mut tx, user, key, kind);
        model::save_pack(&mut tx, user, &before, &after, kind);
        model::save_day(&mut tx, user, &mut day);
        let parts = p.parts;
        p.parts -= cost;
        model::save_user(&mut tx, &mut p, parts, kind);
        match tx.commit(db).await {
            Ok(()) => Ok(true),
            Err(DbError::Conflict("req")) => Ok(false),
            Err(e) => Err(e.into()),
        }
    })?;
    if !r {
        return idem_lost(&s.db, user, key, kind).await;
    }
    let out = load_state(s, user).await?;
    idem_end(&s.db, user, key, kind, &out).await?;
    Ok(Json(out).into_response())
}

/// Spends parts on a boosted pack of the free pack. Boosted packs open before plain ones.
async fn craft(State(s): State<Shared>, user: User, key: IdemKey) -> ApiResult<Response> {
    let cost = i64::from(rules(&s.db).await?.boost_cost);
    spend_parts(&s, user.id, &key, "craft", cost, false).await
}

/// What a Mythic pack costs in parts.
pub(crate) const MYTHIC_PACK_COST: i64 = 10_000;
/// The Mythic pack is taken down for now; flip this back to bring it back (and unhide `#craftMythicBtn` in web/index.html).
const MYTHIC_PACKS_ON: bool = false;

/// Spends parts on a Mythic pack: a boosted pack holding three Mythics.
async fn craft_mythic(State(s): State<Shared>, user: User, key: IdemKey) -> ApiResult<Response> {
    if !MYTHIC_PACKS_ON {
        return Err(err(StatusCode::FORBIDDEN, "mythic_pack_off"));
    }
    spend_parts(&s, user.id, &key, "craft mythic", MYTHIC_PACK_COST, true).await
}

// ---------- testing helpers (DEV_TOOLS=1 only) ----------

fn dev(s: &Shared) -> ApiResult<()> {
    if s.dev_tools { Ok(()) } else { Err(err(StatusCode::FORBIDDEN, "dev_tools_off")) }
}

#[derive(Deserialize)]
struct DemoReq {
    on: bool,
}

async fn dev_demo(State(s): State<Shared>, user: User, Json(req): Json<DemoReq>) -> ApiResult<Json<StateOut>> {
    dev(&s)?;
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        p.demo = req.on;
        let mut tx = Tx::new();
        // Packs in hand were rolled with the old odds; roll them again.
        for h in s.db.query(&upk(user.id), "HAND#").await? {
            tx.delete_if("", &upk(user.id), &get_s(&h, "sk").unwrap_or_default(), None);
        }
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "dev tools");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    state_json(&s, user.id).await
}

async fn dev_pack(State(s): State<Shared>, user: User, Json(req): Json<PackReq>) -> ApiResult<Json<StateOut>> {
    dev(&s)?;
    let pack = pack(&s, &req.pack).await?;
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        let before = model::pack_row(&s.db, user.id, pack.id()).await?;
        let mut after = before.clone();
        after.sealed += 1;
        let mut tx = Tx::new();
        model::save_pack(&mut tx, user.id, &before, &after, "dev tools");
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "dev tools");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    state_json(&s, user.id).await
}

async fn dev_skip_timer(State(s): State<Shared>, user: User) -> ApiResult<Json<StateOut>> {
    dev(&s)?;
    let claim_ms = rules(&s.db).await?.claim_ms();
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        p.next_claim_at = (p.next_claim_at - claim_ms).min(now_ms());
        let parts = p.parts;
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "dev tools");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    state_json(&s, user.id).await
}

/// Empties the account's collection and gives it the starting packs again.
async fn dev_reset(State(s): State<Shared>, user: User) -> ApiResult<Json<StateOut>> {
    dev(&s)?;
    let start = rules(&s.db).await?.start_packs;
    let free_id = s.catalog().await.claimable().id().to_string();
    let free = free_id.as_str();
    let pk = upk(user.id);
    // Cards first, in batches, then the rest in one go with the player.
    loop {
        let cards = s.db.query(&pk, "CARD#").await?;
        if cards.is_empty() {
            break;
        }
        retry!(async {
            let mut p = me(&s.db, user.id).await?;
            let mut tx = Tx::new();
            for it in cards.iter().take(40) {
                let c: CardRow = from_item(it.clone())?;
                model::remove_card(&mut tx, user.id, &c, "dev tools");
            }
            let parts = p.parts;
            model::save_user(&mut tx, &mut p, parts, "dev tools");
            match tx.commit(&s.db).await {
                Err(DbError::Conflict("card_gone")) => Err(ApiError::busy()),
                r => r.map_err(ApiError::from),
            }
        })?;
    }
    retry!(async {
        let mut p = me(&s.db, user.id).await?;
        let mut tx = Tx::new();
        for prefix in ["OPEN#", "HAND#", "SET#", "STATS#"] {
            for it in s.db.query(&pk, prefix).await? {
                tx.delete_if("", &pk, &get_s(&it, "sk").unwrap_or_default(), None);
            }
        }
        for before in model::packs(&s.db, user.id).await? {
            let mut after = PackRow::new(&before.pack);
            if before.pack == free {
                after.sealed = start;
            }
            model::save_pack(&mut tx, user.id, &before, &after, "dev tools");
        }
        p.next_claim_at = now_ms();
        p.pending_open = None;
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "dev tools");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    state_json(&s, user.id).await
}

/// A single-use invite code, for automated tests and local development.
async fn dev_invite(State(s): State<Shared>) -> ApiResult<Json<serde_json::Value>> {
    dev(&s)?;
    let code = accounts::new_invite_code();
    accounts::put_invite(&s.db, &code, "dev tools", 1, None).await?;
    Ok(Json(serde_json::json!({ "code": accounts::show_code(&code) })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timers_bank_up_and_each_gives_its_packs() {
        let r =
            Rules { claim_minutes: 120, claim_packs: 3, bank: 2, start_packs: 0, boost_cost: 250, donate_url: None };
        let next = now_ms();
        let min = 60_000;
        assert_eq!(r.timers_ready(next - min, next), 0, "not yet");
        assert_eq!(r.timers_ready(next, next), 1);
        assert_eq!(r.timers_ready(next + 119 * min, next), 1);
        assert_eq!(r.timers_ready(next + 120 * min, next), 2);
        assert_eq!(r.timers_ready(next + 3 * 1440 * min, next), 2, "missed timers bank up to 2");
        assert!(r.valid());
        assert!(!Rules { claim_minutes: 4, ..r.clone() }.valid());
        assert!(!Rules { claim_packs: 0, ..r.clone() }.valid());
        assert!(!Rules { bank: 11, ..r.clone() }.valid());
        assert!(!Rules { start_packs: -1, ..r.clone() }.valid());
        assert!(Rules { donate_url: Some("https://ko-fi.com/frcpacks".into()), ..r.clone() }.valid());
        assert!(!Rules { donate_url: Some("http://example.com".into()), ..r.clone() }.valid());
        assert!(!Rules { donate_url: Some("javascript:alert(1)".into()), ..r.clone() }.valid());
    }

    #[test]
    fn default_rules_are_a_pack_every_two_hours() {
        let r = Rules::default();
        assert_eq!((r.claim_minutes, r.claim_packs), (120, 1));
        assert!(r.valid());
    }
}
