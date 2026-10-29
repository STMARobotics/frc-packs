//! Trading cards between players under /api: find a player, see what they have, offer some of your cards for some of
//! theirs, and accept, decline or cancel offers. Specific copies change hands, so serial numbers go with the cards.
//!
//! Accepting is one DynamoDB transaction over both players (each on condition nothing else changed them since they
//! were read), every card (each must still exist where the offer says), the special cards (each must still belong to
//! the giver) and the offer itself (still open). Any of those failing means nothing moves.

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Shared;
use crate::accounts;
use crate::api::{self, CollectionOut, IdemKey};
use crate::auth::User;
use crate::db::{Cond, Db, DbError, Item, Tx, from_item, get_s, item, key, n, pad, s as sv};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, CardRow, FeedEvent, PackRow, Profile, now_ms, upk};
use crate::packs::{Pack, Tier};
use crate::push;
use crate::retry;

/// Cards per side of one trade, and offers one player can have open at once.
pub const MAX_CARDS: usize = 5;
pub const MAX_OPEN: usize = 20;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/players", get(players))
        .route("/social/{pack}", get(social))
        .route("/trade-matches/{pack}", get(matches))
        .route("/players/{name}/collection/{pack}", get(player_collection))
        .route("/trades", get(list).post(offer))
        .route("/trades/{id}/accept", post(accept))
        .route("/trades/{id}/decline", post(decline))
        .route("/trades/{id}/cancel", post(cancel))
}

fn err(status: StatusCode, code: &'static str) -> ApiError {
    ApiError::new(status, code)
}

// ---------- the trade item ----------

/// One card in an offer, as it was when offered. The owner is the side it's on.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TradeCard {
    pub id: i64,
    pub team: i32,
    pub tier: String,
    pub serial: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Trade {
    pub id: i64,
    pub from_user: Uuid,
    pub to_user: Uuid,
    pub pack: String,
    /// Cards from_user gives, and cards from_user gets from to_user.
    pub give: Vec<TradeCard>,
    pub want: Vec<TradeCard>,
    #[serde(default)]
    pub give_packs: i32,
    #[serde(default)]
    pub want_packs: i32,
    #[serde(default)]
    pub give_parts: i32,
    #[serde(default)]
    pub want_parts: i32,
    #[serde(default)]
    pub give_boosted: i32,
    #[serde(default)]
    pub want_boosted: i32,
    #[serde(default)]
    pub give_specials: Vec<i64>,
    #[serde(default)]
    pub want_specials: Vec<i64>,
    /// open, accepted, declined, cancelled or failed.
    pub status: String,
    pub created_at: i64,
    pub decided_at: Option<i64>,
    // Indexes: offers a player made (gsi1) and offers made to them (gsi2), newest last.
    #[serde(default)]
    pub gsi1pk: String,
    #[serde(default)]
    pub gsi1sk: String,
    #[serde(default)]
    pub gsi2pk: String,
    #[serde(default)]
    pub gsi2sk: String,
}

fn trade_pk(id: i64) -> String {
    format!("TRADE#{id}")
}

async fn get_trade(db: &Db, id: i64) -> ApiResult<Option<Trade>> {
    Ok(db.get_as(&trade_pk(id), "TRADE").await?)
}

/// Every trade a player is in, either side, newest first (at most `limit` per side).
async fn trades_of(db: &Db, user: Uuid, limit: Option<i32>) -> ApiResult<Vec<Trade>> {
    let tu = format!("TU#{user}");
    let (made, got) = tokio::try_join!(db.index("gsi1", &tu, limit, true), db.index("gsi2", &tu, limit, true))?;
    // The indexes catch up a moment after a write; read each trade itself for its current status.
    let ids: HashSet<i64> = made.iter().chain(got.iter()).filter_map(|it| crate::db::get_n(it, "id")).collect();
    let keys: Vec<Item> = ids.iter().map(|id| key(trade_pk(*id), "TRADE")).collect();
    let mut out: Vec<Trade> = db.batch_get(keys).await?.into_iter().map(from_item).collect::<Result<_, _>>()?;
    out.sort_by_key(|t| std::cmp::Reverse(t.id));
    Ok(out)
}

/// A player's open offers, made or received.
pub async fn open_trades_of(db: &Db, user: Uuid) -> ApiResult<Vec<Trade>> {
    Ok(trades_of(db, user, None).await?.into_iter().filter(|t| t.status == "open").collect())
}

// ---------- finding players ----------

#[derive(Deserialize)]
struct PlayerQuery {
    #[serde(default)]
    q: String,
}

/// Every account that can play (has a username and isn't turned off).
pub(crate) async fn all_players(db: &Db) -> ApiResult<Vec<Profile>> {
    let rows = db.index("gsi1", "USERS", None, false).await?;
    Ok(rows
        .into_iter()
        .filter_map(|it| from_item::<Profile>(it).ok())
        .filter(|p| p.username.is_some() && !p.disabled)
        .collect())
}

/// Players whose username contains `q` (at most 10; ones starting with it first), for picking who to trade with.
async fn players(State(s): State<Shared>, user: User, Query(q): Query<PlayerQuery>) -> ApiResult<Json<Vec<String>>> {
    let q = q.q.trim().to_lowercase();
    if q.is_empty() || q.chars().count() > 20 {
        return Ok(Json(vec![]));
    }
    let mut names: Vec<(usize, String, String)> = all_players(&s.db)
        .await?
        .into_iter()
        .filter(|p| p.id != user.id)
        .filter_map(|p| {
            let name = p.username?;
            let lower = name.to_lowercase();
            lower.find(&q).map(|at| (at, lower, name))
        })
        .collect();
    names.sort();
    Ok(Json(names.into_iter().take(10).map(|n| n.2).collect()))
}

async fn player(db: &Db, name: &str) -> ApiResult<Profile> {
    accounts::by_name(db, name)
        .await?
        .filter(|p| !p.disabled && p.username.is_some())
        .ok_or(err(StatusCode::NOT_FOUND, "unknown_player"))
}

/// Another player's cards, so you can ask for some of them.
async fn player_collection(
    State(s): State<Shared>,
    _user: User,
    Path((name, pack)): Path<(String, String)>,
) -> ApiResult<Json<CollectionOut>> {
    let pack = api::pack(&s, &pack).await?;
    let p = player(&s.db, &name).await?;
    Ok(Json(api::load_collection(&s.db, p.id, &pack).await?))
}

// ---------- offering ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfferReq {
    to: String,
    pack: String,
    /// Teams you give, one copy per entry (list a team twice for two copies).
    #[serde(default)]
    give: Vec<i32>,
    /// Teams you want from them, one copy per entry.
    #[serde(default)]
    want: Vec<i32>,
    /// Sealed standard packs and parts each way.
    #[serde(default)]
    give_packs: i32,
    #[serde(default)]
    want_packs: i32,
    #[serde(default)]
    give_parts: i32,
    #[serde(default)]
    want_parts: i32,
    /// A particular serial number for each card in `give` / `want` (same order); 0 or missing means any copy.
    #[serde(default)]
    give_serials: Vec<i32>,
    #[serde(default)]
    want_serials: Vec<i32>,
    /// Special edition cards each way, by id.
    #[serde(default)]
    give_specials: Vec<i64>,
    #[serde(default)]
    want_specials: Vec<i64>,
    /// Sealed boosted packs each way.
    #[serde(default)]
    give_boosted: i32,
    #[serde(default)]
    want_boosted: i32,
}

pub const MAX_PACKS: i32 = 50;
pub const MAX_PARTS: i32 = 100_000;

/// Against farming free packs on extra accounts and passing them to a main one: an account has to be a day old before
/// it can give packs or parts away, and a player can take in at most this many packs and parts through trades a day.
pub const NEW_ACCOUNT_HOURS: i64 = 24;
pub const DAILY_PACKS_IN: i64 = 10;
pub const DAILY_PARTS_IN: i64 = 2_000;

fn too_new(p: &Profile) -> bool {
    p.created_at > now_ms() - NEW_ACCOUNT_HOURS * 3_600_000
}

fn over_daily(p: &Profile, packs: i32, parts: i32) -> bool {
    if packs == 0 && parts == 0 {
        return false;
    }
    let (a, b) = p.taken_in(now_ms());
    a + i64::from(packs) > DAILY_PACKS_IN || b + i64::from(parts) > DAILY_PARTS_IN
}

/// Whether a player has these standard sealed packs, boosted packs (not Mythic packs) and parts.
fn has_goods(p: &Profile, row: &PackRow, packs: i32, boosted: i32, parts: i32) -> bool {
    p.parts >= i64::from(parts) && row.standard() >= packs && row.boosted - row.mythic >= boosted
}

/// Picks one tradeable copy for each team listed (a team listed twice gets two different copies): the newest one, so a
/// player keeps their earliest (lowest) serial longest. Cards still being revealed, or (for your own side) already
/// promised in another of your open offers, are left out.
async fn pick_copies(
    db: &Db,
    owner: &Profile,
    pack: &Pack,
    teams: &[i32],
    serials: &[i32],
    own_side: bool,
) -> ApiResult<Vec<TradeCard>> {
    if teams.is_empty() {
        return Ok(vec![]);
    }
    let mut blocked: HashSet<i64> = HashSet::new();
    if let Some(id) = owner.pending_open
        && model::opening(db, owner.id, id).await?.is_some_and(|o| o.revealed < 5)
    {
        blocked.extend(
            model::cards(db, owner.id, pack.id()).await?.iter().filter(|c| c.opening_id == Some(id)).map(|c| c.id),
        );
    }
    if own_side {
        for t in open_trades_of(db, owner.id).await? {
            if t.from_user == owner.id {
                blocked.extend(t.give.iter().map(|c| c.id));
            }
        }
    }
    let mut out: Vec<TradeCard> = Vec::with_capacity(teams.len());
    for (i, num) in teams.iter().enumerate() {
        let want_serial = serials.get(i).copied().unwrap_or(0);
        let copies = model::team_cards(db, owner.id, pack.id(), *num).await?;
        let pick = copies
            .iter()
            .rev()
            .find(|c| {
                !blocked.contains(&c.id)
                    && !out.iter().any(|o| o.id == c.id)
                    && (want_serial == 0 || c.serial == want_serial)
            })
            .ok_or(err(StatusCode::CONFLICT, "not_owned"))?;
        out.push(TradeCard { id: pick.id, team: pick.team, tier: pick.tier.clone(), serial: pick.serial });
    }
    Ok(out)
}

async fn offer(State(s): State<Shared>, user: User, key: IdemKey, Json(req): Json<OfferReq>) -> ApiResult<Response> {
    let pack = api::pack(&s, &req.pack).await?;
    let goods = 0..=MAX_PACKS;
    let parts = 0..=MAX_PARTS;
    let side_ok = |cards: &[i32], packs: i32, boosted: i32, pts: i32, sp: &[i64]| {
        sp.len() <= MAX_CARDS
            && sp.iter().enumerate().all(|(i, x)| !sp[..i].contains(x))
            && (!sp.is_empty() || !cards.is_empty() || packs > 0 || boosted > 0 || pts > 0)
            && cards.len() <= MAX_CARDS
            && goods.contains(&packs)
            && goods.contains(&boosted)
            && parts.contains(&pts)
    };
    if !side_ok(&req.give, req.give_packs, req.give_boosted, req.give_parts, &req.give_specials)
        || !side_ok(&req.want, req.want_packs, req.want_boosted, req.want_parts, &req.want_specials)
    {
        return Err(err(StatusCode::BAD_REQUEST, "bad_trade"));
    }
    if let Some(done) = api::idem_begin(&s.db, user.id, &key, "offer").await? {
        return Ok(done);
    }
    let db = &s.db;
    let to = player(db, &req.to).await?;
    if to.id == user.id {
        return Err(err(StatusCode::BAD_REQUEST, "not_yourself"));
    }
    let r = retry!(async {
        let mut p = api::me(db, user.id).await?;
        let to = api::me(db, to.id).await?;
        if open_trades_of(db, user.id).await?.iter().filter(|t| t.from_user == user.id).count() >= MAX_OPEN {
            return Err(err(StatusCode::CONFLICT, "too_many_offers"));
        }
        let give = pick_copies(db, &p, &pack, &req.give, &req.give_serials, true).await?;
        let want = pick_copies(db, &to, &pack, &req.want, &req.want_serials, false).await?;
        if crate::specials::owned_count(db, &req.give_specials, user.id).await? != req.give_specials.len()
            || crate::specials::owned_count(db, &req.want_specials, to.id).await? != req.want_specials.len()
        {
            return Err(err(StatusCode::CONFLICT, "not_owned"));
        }
        let (my_row, their_row) =
            tokio::try_join!(model::pack_row(db, user.id, pack.id()), model::pack_row(db, to.id, pack.id()))?;
        if !has_goods(&p, &my_row, req.give_packs, req.give_boosted, req.give_parts) {
            return Err(err(StatusCode::CONFLICT, "not_enough_to_trade"));
        }
        if !has_goods(&to, &their_row, req.want_packs, req.want_boosted, req.want_parts) {
            return Err(err(StatusCode::CONFLICT, "they_lack"));
        }
        if (req.give_packs > 0 || req.give_boosted > 0 || req.give_parts > 0) && too_new(&p) {
            return Err(err(StatusCode::CONFLICT, "too_new"));
        }
        if (req.want_packs > 0 || req.want_boosted > 0 || req.want_parts > 0) && too_new(&to) {
            return Err(err(StatusCode::CONFLICT, "they_too_new"));
        }
        if over_daily(&p, req.want_packs + req.want_boosted, req.want_parts) {
            return Err(err(StatusCode::CONFLICT, "trade_limit"));
        }
        if over_daily(&to, req.give_packs + req.give_boosted, req.give_parts) {
            return Err(err(StatusCode::CONFLICT, "their_trade_limit"));
        }
        let id = db.ids("trade", 1).await?;
        let now = now_ms();
        let sk = format!("{}#{}", pad(now, 15), pad(id, 12));
        let t = Trade {
            id,
            from_user: user.id,
            to_user: to.id,
            pack: pack.id().to_string(),
            give: give.clone(),
            want: want.clone(),
            give_packs: req.give_packs,
            want_packs: req.want_packs,
            give_parts: req.give_parts,
            want_parts: req.want_parts,
            give_boosted: req.give_boosted,
            want_boosted: req.want_boosted,
            give_specials: req.give_specials.clone(),
            want_specials: req.want_specials.clone(),
            status: "open".into(),
            created_at: now,
            decided_at: None,
            gsi1pk: format!("TU#{}", user.id),
            gsi1sk: sk.clone(),
            gsi2pk: format!("TU#{}", to.id),
            gsi2sk: sk,
        };
        let mut tx = Tx::new();
        api::idem_mark(&mut tx, user.id, &key, "offer");
        tx.put_if("", item(trade_pk(id), "TRADE", &t), Some(Cond::absent()));
        let mut day = model::today(db, user.id).await?;
        crate::missions::count(&mut day, crate::missions::Kind::Traded, 1);
        model::save_day(&mut tx, user.id, &mut day);
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, "offer");
        match tx.commit(db).await {
            Ok(()) => Ok(Some((p.username.clone().unwrap_or_else(|| "Someone".into()), give.len(), want.len()))),
            Err(DbError::Conflict("req")) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })?;
    let Some((me, gave, wanted)) = r else { return api::idem_lost(db, user.id, &key, "offer").await };
    let out = list_in(db, user.id).await?;
    api::idem_end(db, user.id, &key, "offer", &out).await?;
    let stuff = |n: usize, packs: i32, parts: i32| {
        let mut bits = Vec::new();
        if n > 0 {
            bits.push(if n == 1 { "1 card".to_string() } else { format!("{n} cards") });
        }
        if packs > 0 {
            bits.push(if packs == 1 { "1 pack".to_string() } else { format!("{packs} packs") });
        }
        if parts > 0 {
            bits.push(format!("{parts} parts"));
        }
        bits.join(" + ")
    };
    push::notify(
        db,
        to.id,
        push::Note {
            title: format!("{me} wants to trade"),
            body: format!(
                "They offer {} for {} of yours.",
                stuff(gave, req.give_packs + req.give_boosted, req.give_parts),
                stuff(wanted, req.want_packs + req.want_boosted, req.want_parts)
            ),
            url: "/#trade".into(),
            tag: format!("trade-{me}"),
        },
    )
    .await;
    Ok(Json(out).into_response())
}

// ---------- listing ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CardRef {
    num: i32,
    tier: Tier,
    serial: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TradeOut {
    id: i64,
    /// True when you made the offer.
    mine: bool,
    /// The other player.
    with: String,
    pack: String,
    /// What you give and what you get, from your side of the trade.
    you_give: Vec<CardRef>,
    you_get: Vec<CardRef>,
    you_give_packs: i32,
    you_get_packs: i32,
    you_give_boosted: i32,
    you_get_boosted: i32,
    you_give_specials: Vec<crate::specials::SpecialOut>,
    you_get_specials: Vec<crate::specials::SpecialOut>,
    you_give_parts: i32,
    you_get_parts: i32,
    status: String,
    created_at: i64,
    decided_at: Option<i64>,
}

#[derive(Serialize)]
struct TradesOut {
    /// Open offers to you, open offers you made, then the last ones that were decided.
    incoming: Vec<TradeOut>,
    outgoing: Vec<TradeOut>,
    recent: Vec<TradeOut>,
}

fn refs(cards: &[TradeCard]) -> Vec<CardRef> {
    cards
        .iter()
        .map(|c| CardRef { num: c.team, tier: Tier::parse(&c.tier).unwrap_or(Tier::Common), serial: c.serial })
        .collect()
}

/// An open offer shows only the cards still there (one that was scrapped or traded away is left out); a finished one
/// shows the cards as they were offered.
async fn still_there(db: &Db, owner: Uuid, pack: &str, cards: &[TradeCard]) -> ApiResult<Vec<TradeCard>> {
    let keys: Vec<Item> = cards.iter().map(|c| key(upk(owner), model::card_sk(pack, c.team, c.id))).collect();
    let found: HashSet<i64> = db.batch_get(keys).await?.iter().filter_map(|it| crate::db::get_n(it, "id")).collect();
    Ok(cards.iter().filter(|c| found.contains(&c.id)).cloned().collect())
}

async fn list_in(db: &Db, me: Uuid) -> ApiResult<TradesOut> {
    let rows = trades_of(db, me, Some(150)).await?;
    let mut out = TradesOut { incoming: vec![], outgoing: vec![], recent: vec![] };
    let mut names: std::collections::HashMap<Uuid, String> = std::collections::HashMap::new();
    let mut open_n = 0;
    let mut done_n = 0;
    for t in rows {
        let open = t.status == "open";
        if (open && open_n >= 50) || (!open && done_n >= 100) {
            continue;
        }
        if open {
            open_n += 1
        } else {
            done_n += 1
        }
        let mine = t.from_user == me;
        let other = if mine { t.to_user } else { t.from_user };
        if let std::collections::hash_map::Entry::Vacant(e) = names.entry(other) {
            let name = model::profile(db, other).await?.and_then(|p| p.username).unwrap_or_else(|| "guest".into());
            e.insert(name);
        }
        let (give, want) = if open {
            (still_there(db, t.from_user, &t.pack, &t.give).await?, still_there(db, t.to_user, &t.pack, &t.want).await?)
        } else {
            (t.give.clone(), t.want.clone())
        };
        let (gives, gets) = if mine { (refs(&give), refs(&want)) } else { (refs(&want), refs(&give)) };
        let (gs, ws) = (
            crate::specials::by_ids(db, &t.give_specials).await?,
            crate::specials::by_ids(db, &t.want_specials).await?,
        );
        let (you_give_specials, you_get_specials) = if mine { (gs, ws) } else { (ws, gs) };
        let row = TradeOut {
            id: t.id,
            mine,
            with: names[&other].clone(),
            pack: t.pack.clone(),
            you_give: gives,
            you_get: gets,
            you_give_packs: if mine { t.give_packs } else { t.want_packs },
            you_get_packs: if mine { t.want_packs } else { t.give_packs },
            you_give_boosted: if mine { t.give_boosted } else { t.want_boosted },
            you_get_boosted: if mine { t.want_boosted } else { t.give_boosted },
            you_give_specials,
            you_get_specials,
            you_give_parts: if mine { t.give_parts } else { t.want_parts },
            you_get_parts: if mine { t.want_parts } else { t.give_parts },
            status: t.status.clone(),
            created_at: t.created_at,
            decided_at: t.decided_at,
        };
        match (open, mine) {
            (true, false) => out.incoming.push(row),
            (true, true) => out.outgoing.push(row),
            _ => out.recent.push(row),
        }
    }
    out.recent.sort_by_key(|t| std::cmp::Reverse(t.decided_at.unwrap_or(t.created_at)));
    Ok(out)
}

async fn list(State(s): State<Shared>, user: User) -> ApiResult<Json<TradesOut>> {
    Ok(Json(list_in(&s.db, user.id).await?))
}

// ---------- deciding ----------

/// Marks an open offer decided (only if it's still open).
async fn close(db: &Db, id: i64, status: &str) -> ApiResult<bool> {
    let mut tx = Tx::new();
    tx.update(
        "trade_gone",
        &trade_pk(id),
        "TRADE",
        Cond::new("SET #st = :st, decided_at = :at")
            .name("#st", "status")
            .val(":st", sv(status))
            .val(":at", n(now_ms()))
            .val(":open", sv("open")),
        Some("#st = :open"),
    );
    match tx.commit(db).await {
        Ok(()) => Ok(true),
        Err(DbError::Conflict("trade_gone")) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Calls off every open offer from or to the player (for example when the admin turns the account off).
pub async fn cancel_all(db: &Db, user: Uuid) -> ApiResult<()> {
    for t in open_trades_of(db, user).await? {
        close(db, t.id, "cancelled").await?;
    }
    Ok(())
}

#[derive(Serialize)]
struct AcceptOut {
    /// Division sets the trade completed for you (a bonus pack each).
    sets: Vec<String>,
    state: api::StateOut,
    collection: CollectionOut,
    trades: TradesOut,
}

/// One player's side of a trade being accepted: what they lose and gain.
struct Side<'a> {
    p: Profile,
    parts_before: i64,
    row_before: PackRow,
    row: PackRow,
    cards: Vec<CardRow>,
    stats: model::Stats,
    pack: &'a Pack,
}

/// The cards behind an offer's list, from the owner's collection. None if any is gone.
async fn load_cards(db: &Db, owner: Uuid, pack: &str, cards: &[TradeCard]) -> ApiResult<Option<Vec<CardRow>>> {
    let mut out = Vec::with_capacity(cards.len());
    for c in cards {
        match db.get_as::<CardRow>(&upk(owner), &model::card_sk(pack, c.team, c.id)).await? {
            Some(row) => out.push(row),
            None => return Ok(None),
        }
    }
    Ok(Some(out))
}

/// Accepting swaps the cards, if both players still have every card in the offer. If not, the offer fails.
async fn accept(State(s): State<Shared>, user: User, Path(id): Path<i64>) -> ApiResult<Json<AcceptOut>> {
    let db = &s.db;
    let r = retry!(async {
        let Some(t) = get_trade(db, id).await?.filter(|t| t.status == "open") else {
            return Err(err(StatusCode::NOT_FOUND, "trade_gone"));
        };
        if t.to_user != user.id {
            return Err(err(StatusCode::FORBIDDEN, "not_your_trade"));
        }
        let pack = api::pack(&s, &t.pack).await?;
        let (from_p, to_p) = tokio::try_join!(api::me(db, t.from_user), api::me(db, t.to_user))?;
        if over_daily(&to_p, t.give_packs + t.give_boosted, t.give_parts) {
            return Err(err(StatusCode::CONFLICT, "trade_limit"));
        }
        if over_daily(&from_p, t.want_packs + t.want_boosted, t.want_parts) {
            return Err(err(StatusCode::CONFLICT, "their_trade_limit"));
        }
        if from_p.disabled {
            close(db, id, "failed").await?;
            return Ok(None);
        }
        // Every card still where the offer says, and not in a pack still being revealed.
        let gives = load_cards(db, t.from_user, pack.id(), &t.give).await?;
        let wants = load_cards(db, t.to_user, pack.id(), &t.want).await?;
        let (Some(gives), Some(wants)) = (gives, wants) else {
            close(db, id, "failed").await?;
            return Ok(None);
        };
        let (from_row, to_row) =
            tokio::try_join!(model::pack_row(db, t.from_user, pack.id()), model::pack_row(db, t.to_user, pack.id()))?;
        let specials_ok = crate::specials::owned_count(db, &t.give_specials, t.from_user).await?
            == t.give_specials.len()
            && crate::specials::owned_count(db, &t.want_specials, t.to_user).await? == t.want_specials.len();
        if !has_goods(&from_p, &from_row, t.give_packs, t.give_boosted, t.give_parts)
            || !has_goods(&to_p, &to_row, t.want_packs, t.want_boosted, t.want_parts)
            || !specials_ok
        {
            close(db, id, "failed").await?;
            return Ok(None);
        }
        let mut tx = Tx::new();
        tx.update(
            "trade_gone",
            &trade_pk(id),
            "TRADE",
            Cond::new("SET #st = :ok, decided_at = :at")
                .name("#st", "status")
                .val(":ok", sv("accepted"))
                .val(":at", n(now_ms()))
                .val(":open", sv("open")),
            Some("#st = :open"),
        );
        for (owner, cards) in [(&from_p, &gives), (&to_p, &wants)] {
            if let Some(o) = owner.pending_open
                && cards.iter().any(|c| c.opening_id == Some(o))
            {
                // A card from the pack still being revealed: only once the reveal is done.
                tx.check(
                    "still_revealing",
                    &upk(owner.id),
                    &model::open_sk(o),
                    Cond::new("revealed >= :five").val(":five", n(5)),
                );
            }
        }
        let (fs, ts) =
            tokio::try_join!(model::stats(db, t.from_user, pack.id()), model::stats(db, t.to_user, pack.id()))?;
        let mut from = Side {
            parts_before: from_p.parts,
            p: from_p,
            row_before: from_row.clone(),
            row: from_row,
            cards: model::cards(db, t.from_user, pack.id()).await?,
            stats: fs,
            pack: &pack,
        };
        let mut to = Side {
            parts_before: to_p.parts,
            p: to_p,
            row_before: to_row.clone(),
            row: to_row,
            cards: model::cards(db, t.to_user, pack.id()).await?,
            stats: ts,
            pack: &pack,
        };
        let reason = format!("trade {id}");
        let now = now_ms();
        move_cards(&mut tx, &mut from, &mut to, &gives, &reason, now);
        move_cards(&mut tx, &mut to, &mut from, &wants, &reason, now);
        // Packs and parts.
        move_goods(&mut from, &mut to, t.give_packs, t.give_boosted, t.give_parts, now);
        move_goods(&mut to, &mut from, t.want_packs, t.want_boosted, t.want_parts, now);
        crate::specials::move_all(&mut tx, &t.give_specials, t.from_user, t.to_user);
        crate::specials::move_all(&mut tx, &t.want_specials, t.to_user, t.from_user);
        // Completing a division set by trade earns its bonus pack, same as from a pack.
        let mut my_sets = Vec::new();
        for (side, got) in [(&mut to, &gives), (&mut from, &wants)] {
            let owned: HashSet<i32> = side.cards.iter().map(|c| c.team).collect();
            let done = api::sets_done(db, side.p.id, pack.id()).await?;
            let teams: Vec<i32> = got.iter().map(|c| c.team).collect();
            let sets = api::finished_sets(&pack, &owned, &done, &teams);
            for d in &sets {
                api::record_set(&mut tx, side.p.id, pack.id(), d);
                model::feed(
                    &mut tx,
                    pack.id(),
                    FeedEvent {
                        kind: "set".into(),
                        who: side.p.username.clone().unwrap_or_default(),
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
            side.row.sealed += sets.len() as i32;
            side.stats.sets += sets.len() as i64;
            side.stats.trades += 1;
            if side.p.id == user.id {
                my_sets = sets;
            }
        }
        model::feed(
            &mut tx,
            pack.id(),
            FeedEvent {
                kind: "trade".into(),
                who: from.p.username.clone().unwrap_or_default(),
                at: now,
                team: None,
                tier: None,
                serial: None,
                division: None,
                to: to.p.username.clone(),
                gave: Some(serde_json::to_value(refs(&t.give)).unwrap_or_default()),
                got: Some(serde_json::to_value(refs(&t.want)).unwrap_or_default()),
                gave_packs: Some(t.give_packs),
                got_packs: Some(t.want_packs),
                expires_at: 0,
            },
        );
        let mut day = model::today(db, user.id).await?;
        crate::missions::count(&mut day, crate::missions::Kind::Traded, 1);
        model::save_day(&mut tx, user.id, &mut day);
        for side in [&mut from, &mut to] {
            model::save_pack(&mut tx, side.p.id, &side.row_before, &side.row, &reason);
            model::save_stats(&mut tx, side.p.id, pack.id(), &side.stats);
            let parts = side.parts_before;
            model::save_user(&mut tx, &mut side.p, parts, &reason);
        }
        match tx.commit(db).await {
            Ok(()) => Ok(Some((my_sets, t, to.p.username.clone()))),
            Err(DbError::Conflict("trade_gone")) => Err(err(StatusCode::NOT_FOUND, "trade_gone")),
            Err(DbError::Conflict("card_gone" | "special" | "still_revealing")) => {
                close(db, id, "failed").await?;
                Ok(None)
            }
            Err(e) => Err(e.into()),
        }
    })?;
    let Some((mine, t, me)) = r else { return Err(err(StatusCode::CONFLICT, "trade_stale")) };
    // Other open offers that promised any of these cards can't happen any more.
    let moved: HashSet<i64> = t.give.iter().chain(t.want.iter()).map(|c| c.id).collect();
    let moved_sp: HashSet<i64> = t.give_specials.iter().chain(t.want_specials.iter()).copied().collect();
    let mut others = open_trades_of(db, t.from_user).await?;
    others.extend(open_trades_of(db, t.to_user).await?);
    for o in others {
        let clash = o.give.iter().chain(o.want.iter()).any(|c| moved.contains(&c.id))
            || o.give_specials.iter().chain(o.want_specials.iter()).any(|x| moved_sp.contains(x));
        if o.id != t.id && clash {
            close(db, o.id, "failed").await?;
        }
    }
    let pack = api::pack(&s, &t.pack).await?;
    push::notify(
        db,
        t.from_user,
        push::Note {
            title: format!("{} accepted your trade", me.unwrap_or_else(|| "Someone".into())),
            body: if t.want.is_empty() {
                "Check your packs and parts.".to_string()
            } else {
                format!(
                    "{} {} in your binder.",
                    t.want.len(),
                    if t.want.len() == 1 { "new card is" } else { "new cards are" }
                )
            },
            url: "/#binder".into(),
            tag: format!("trade-done-{id}"),
        },
    )
    .await;
    let state = api::load_state(&s, user.id).await?;
    let collection = api::load_collection(db, user.id, &pack).await?;
    let trades = list_in(db, user.id).await?;
    Ok(Json(AcceptOut { sets: mine, state, collection, trades }))
}

/// Moves these cards from one side to the other in the transaction (each delete fails the whole trade if the card is
/// gone), keeping both players' stats right.
fn move_cards(tx: &mut Tx, from: &mut Side, to: &mut Side, cards: &[CardRow], reason: &str, now: i64) {
    for c in cards {
        model::remove_card(tx, from.p.id, c, reason);
        from.cards.retain(|x| x.id != c.id);
        from.stats.cards -= 1;
        if !from.cards.iter().any(|x| x.team == c.team) {
            model::stats_team_lost(&mut from.stats, team_tier(from.pack, c));
        }
        let had = to.cards.iter().any(|x| x.team == c.team);
        let moved = CardRow { opening_id: None, slot: None, obtained: "trade".into(), created_at: now, ..c.clone() };
        model::add_card(tx, to.p.id, &moved, reason);
        to.cards.push(moved);
        to.stats.cards += 1;
        if !had {
            model::stats_team_gained(&mut to.stats, team_tier(to.pack, c));
        }
    }
}

fn team_tier<'a>(pack: &'a Pack, c: &CardRow) -> &'a str {
    pack.team_tier.get(&c.team).map_or("common", |t| t.as_str())
}

/// Moves standard packs, boosted packs and parts; the receiver's daily intake counts them.
fn move_goods(from: &mut Side, to: &mut Side, packs: i32, boosted: i32, parts: i32, now: i64) {
    from.p.parts -= i64::from(parts);
    to.p.parts += i64::from(parts);
    from.row.sealed -= packs + boosted;
    from.row.boosted -= boosted;
    to.row.sealed += packs + boosted;
    to.row.boosted += boosted;
    to.p.take_in(now, i64::from(packs + boosted), i64::from(parts));
}

async fn decline(State(s): State<Shared>, user: User, Path(id): Path<i64>) -> ApiResult<Json<TradesOut>> {
    decide(&s, user, id, false).await
}

async fn cancel(State(s): State<Shared>, user: User, Path(id): Path<i64>) -> ApiResult<Json<TradesOut>> {
    decide(&s, user, id, true).await
}

/// The other player declines an offer, or the player who made it cancels it.
async fn decide(s: &Shared, user: User, id: i64, by_maker: bool) -> ApiResult<Json<TradesOut>> {
    let Some(t) = get_trade(&s.db, id).await?.filter(|t| t.status == "open") else {
        return Err(err(StatusCode::NOT_FOUND, "trade_gone"));
    };
    if (by_maker && t.from_user != user.id) || (!by_maker && t.to_user != user.id) {
        return Err(err(StatusCode::FORBIDDEN, "not_your_trade"));
    }
    if !close(&s.db, id, if by_maker { "cancelled" } else { "declined" }).await? {
        return Err(err(StatusCode::NOT_FOUND, "trade_gone"));
    }
    Ok(Json(list_in(&s.db, user.id).await?))
}

// ---------- social ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SocialPlayer {
    name: String,
    first_name: Option<String>,
    badge: Option<String>,
    avatar: Option<i32>,
    teams: i64,
    mythics: i64,
    legendaries: i64,
    trades: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SocialTrade {
    from: String,
    to: String,
    /// Cards the first player gave and got, as they were offered.
    gave: serde_json::Value,
    got: serde_json::Value,
    gave_packs: i32,
    got_packs: i32,
    at: i64,
}

/// Something worth seeing in the Social feed: a big pull or a finished set.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SocialEvent {
    kind: &'static str,
    who: String,
    team: Option<i32>,
    tier: Option<String>,
    serial: Option<i32>,
    division: Option<String>,
    at: i64,
}

#[derive(Serialize)]
struct SocialOut {
    players: Vec<SocialPlayer>,
    recent: Vec<SocialTrade>,
    activity: Vec<SocialEvent>,
}

/// Every player with a few stats, and the latest finished trades, so anyone can see who has what.
async fn social(State(s): State<Shared>, _user: User, Path(pack): Path<String>) -> ApiResult<Json<SocialOut>> {
    let pack = api::pack(&s, &pack).await?;
    let db = &s.db;
    let people = all_players(db).await?;
    let keys: Vec<Item> = people.iter().map(|p| key(upk(p.id), format!("STATS#{}", pack.id()))).collect();
    let stats: std::collections::HashMap<String, model::Stats> =
        db.batch_get(keys).await?.into_iter().filter_map(|it| Some((get_s(&it, "pk")?, from_item(it).ok()?))).collect();
    let mut players: Vec<SocialPlayer> = people
        .iter()
        .map(|p| {
            let st = stats.get(&upk(p.id)).cloned().unwrap_or_default();
            SocialPlayer {
                name: p.username.clone().unwrap_or_default(),
                first_name: p.first_name.clone(),
                badge: p.badge.clone(),
                avatar: p.avatar,
                teams: st.teams,
                mythics: st.mythic_teams,
                legendaries: st.legendary_teams,
                trades: st.trades,
            }
        })
        .collect();
    players.sort_by(|a, b| b.teams.cmp(&a.teams).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    players.truncate(200);
    let active: HashSet<String> = people.iter().filter_map(|p| p.username.clone()).collect();
    let events: Vec<FeedEvent> = db
        .query_desc(&format!("FEED#{}", pack.id()), "", 200)
        .await?
        .into_iter()
        .filter_map(|it| from_item(it).ok())
        .collect();
    let recent: Vec<SocialTrade> = events
        .iter()
        .filter(|e| e.kind == "trade")
        .take(12)
        .map(|e| SocialTrade {
            from: e.who.clone(),
            to: e.to.clone().unwrap_or_default(),
            gave: e.gave.clone().unwrap_or(serde_json::Value::Null),
            got: e.got.clone().unwrap_or(serde_json::Value::Null),
            gave_packs: e.gave_packs.unwrap_or(0),
            got_packs: e.got_packs.unwrap_or(0),
            at: e.at,
        })
        .collect();
    let mut activity: Vec<SocialEvent> = events
        .iter()
        .filter(|e| (e.kind == "pull" || e.kind == "set") && active.contains(&e.who))
        .map(|e| SocialEvent {
            kind: if e.kind == "pull" { "pull" } else { "set" },
            who: e.who.clone(),
            team: e.team,
            tier: e.tier.clone(),
            serial: e.serial,
            division: e.division.clone(),
            at: e.at,
        })
        .collect();
    activity.truncate(30);
    Ok(Json(SocialOut { players, recent, activity }))
}

// ---------- trade matches ----------

/// One player worth trading with: their spare copies of teams you don't have, and yours of teams they don't.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MatchOut {
    name: String,
    first_name: Option<String>,
    badge: Option<String>,
    avatar: Option<i32>,
    /// Teams they have two or more of and you have none of; the ones on your wishlist first, then the rarest.
    they_have: Vec<i32>,
    /// Teams you have two or more of and they have none of; the ones on their wishlist first, then the rarest.
    you_have: Vec<i32>,
}

/// Everyone's copies per team and wishlist, read at most every 30 seconds (one read per player), and again as soon as
/// someone new joins.
type Holdings = std::collections::HashMap<Uuid, (std::collections::HashMap<i32, u32>, Vec<i32>)>;
static HOLDINGS: std::sync::Mutex<Option<(std::time::Instant, String, std::sync::Arc<Holdings>)>> =
    std::sync::Mutex::new(None);

async fn holdings(db: &Db, pack: &str, people: &[Profile]) -> ApiResult<std::sync::Arc<Holdings>> {
    if let Some((at, p, h)) = &*HOLDINGS.lock().unwrap()
        && p == pack
        && at.elapsed() < std::time::Duration::from_secs(30)
        && people.iter().all(|x| h.contains_key(&x.id))
    {
        return Ok(h.clone());
    }
    let mut out = Holdings::new();
    for p in people {
        let mut counts = std::collections::HashMap::new();
        for c in model::cards(db, p.id, pack).await? {
            *counts.entry(c.team).or_insert(0) += 1;
        }
        let wish = crate::profiles::wishlist(db, p.id, pack).await?;
        out.insert(p.id, (counts, wish));
    }
    let h = std::sync::Arc::new(out);
    *HOLDINGS.lock().unwrap() = Some((std::time::Instant::now(), pack.to_string(), h.clone()));
    Ok(h)
}

/// The spares one side has that the other lacks, wanted ones first, then the rarest.
fn spares(
    pack: &Pack,
    has: &std::collections::HashMap<i32, u32>,
    lacks: &std::collections::HashMap<i32, u32>,
    wants: &[i32],
) -> Vec<i32> {
    let mut out: Vec<i32> =
        has.iter().filter(|(t, n)| **n >= 2 && lacks.get(t).copied().unwrap_or(0) == 0).map(|(t, _)| *t).collect();
    let rank = |t: &i32| pack.team_tier.get(t).map_or(9, |x| x.rank());
    out.sort_by_key(|t| (!wants.contains(t), rank(t), *t));
    out
}

/// Players worth trading with, best first: each has spares you need and needs spares of yours (at most 20).
async fn matches(State(s): State<Shared>, user: User, Path(pack): Path<String>) -> ApiResult<Json<Vec<MatchOut>>> {
    let pack = api::pack(&s, &pack).await?;
    let db = &s.db;
    let people = all_players(db).await?;
    let h = holdings(db, pack.id(), &people).await?;
    // Your own copies right now, not the cached ones.
    let mut mine = std::collections::HashMap::new();
    for c in model::cards(db, user.id, pack.id()).await? {
        *mine.entry(c.team).or_insert(0) += 1;
    }
    let my_wish = crate::profiles::wishlist(db, user.id, pack.id()).await?;
    let mut out: Vec<(usize, usize, MatchOut)> = people
        .iter()
        .filter(|p| p.id != user.id)
        .filter_map(|p| {
            let (theirs, their_wish) = h.get(&p.id)?;
            let they_have = spares(&pack, theirs, &mine, &my_wish);
            let you_have = spares(&pack, &mine, theirs, their_wish);
            if they_have.is_empty() || you_have.is_empty() {
                return None;
            }
            let wished = they_have.iter().filter(|t| my_wish.contains(t)).count()
                + you_have.iter().filter(|t| their_wish.contains(t)).count();
            let even = they_have.len().min(you_have.len());
            Some((
                wished,
                even,
                MatchOut {
                    name: p.username.clone().unwrap_or_default(),
                    first_name: p.first_name.clone(),
                    badge: p.badge.clone(),
                    avatar: p.avatar,
                    they_have,
                    you_have,
                },
            ))
        })
        .collect();
    out.sort_by(|a, b| (b.0, b.1).cmp(&(a.0, a.1)).then_with(|| a.2.name.to_lowercase().cmp(&b.2.name.to_lowercase())));
    Ok(Json(out.into_iter().take(20).map(|m| m.2).collect()))
}
