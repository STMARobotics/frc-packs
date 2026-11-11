//! The shop (0.14, feedback #78). Two packs are always for sale (Standard and Boosted, up to a daily limit), and four
//! slots change every 4 hours on the game's clock: two cards (mostly Common), one card that's Rare or better (once in a
//! long while a Mythic), and a division pack. Each player has their own stock. It's worked out from a secret seed kept
//! in the settings, the player and the window, so nothing runs at midnight and nothing is stored until someone buys.
//! The code is public: without the secret anyone could work out their future shops.
//!
//! One slot can be frozen: it keeps what it had through every refresh until it's bought or unfrozen. A frozen slot
//! stops getting new stock, which is the price of holding it. Unfreezing shows that slot's stock for the window it is
//! now (already fixed, not a new roll), so freezing and unfreezing can't reroll anything.

use std::collections::HashSet;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::Shared;
use crate::api::{self, IdemKey, err, idem_begin, idem_end, idem_lost, idem_mark};
use crate::auth::User;
use crate::db::{Cond, Db, DbError, Tx, get_n, get_s, n, s as sv};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, CardRow, now_ms, upk};
use crate::packs::{Pack, Tier};
use crate::retry;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/shop", get(shop))
        .route("/shop/buy", post(buy))
        .route("/shop/freeze", post(freeze))
        .route("/shop/pack", post(pack))
}

// ---------- prices and limits (admin settings) ----------

/// The shop's prices (parts) and limits, saved with the other settings and kept in their history, so Tripwire knows
/// every price that ever applied.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShopRules {
    /// Off hides the Shop tab and refuses buying cards and division packs (Boosted packs can still be crafted).
    pub on: bool,
    pub std: i32,
    pub division: i32,
    pub common: i32,
    pub uncommon: i32,
    pub rare: i32,
    pub legendary: i32,
    pub mythic: i32,
    /// Standard and Boosted packs bought (or crafted) per player per day.
    pub packs_per_day: i32,
}

impl Default for ShopRules {
    fn default() -> ShopRules {
        ShopRules {
            on: true,
            std: 120,
            division: 200,
            common: 75,
            uncommon: 180,
            rare: 600,
            legendary: 2_500,
            mythic: 25_000,
            packs_per_day: 10,
        }
    }
}

impl ShopRules {
    pub fn valid(&self) -> bool {
        let p = 1..=100_000;
        [self.std, self.division, self.common, self.uncommon, self.rare, self.legendary].iter().all(|x| p.contains(x))
            && (1..=1_000_000).contains(&self.mythic)
            && (1..=50).contains(&self.packs_per_day)
    }

    pub fn card(&self, t: Tier) -> i32 {
        match t {
            Tier::Common => self.common,
            Tier::Uncommon => self.uncommon,
            Tier::Rare => self.rare,
            Tier::Legendary => self.legendary,
            Tier::Mythic => self.mythic,
        }
    }

    fn price(&self, st: &Stock) -> i32 {
        match st {
            Stock::Card { tier, .. } => self.card(*tier),
            Stock::Division { .. } => self.division,
        }
    }
}

// ---------- the stock ----------

/// The slots that change: two cards, a card that's Rare or better, a division pack.
pub const SLOTS: [&str; 4] = ["c1", "c2", "c3", "div"];

/// Out of 10,000: the everyday cards (slots 1 and 2) are Common below the first number, Uncommon below the second,
/// else Rare. The Rare-or-better card is Rare below the third, Legendary below the fourth, else Mythic (0.4%).
const COMMON: u64 = 7_000;
const UNCOMMON: u64 = 9_500;
const RARE: u64 = 8_500;
const LEGENDARY: u64 = 9_960;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Stock {
    Card { num: i32, tier: Tier },
    Division { division: String },
}

fn hash(seed: &str, user: Uuid, window: i64, slot: &str, salt: u32) -> u64 {
    let d = Sha256::digest(format!("{seed}|{user}|{window}|{slot}|{salt}").as_bytes());
    u64::from_be_bytes(d[..8].try_into().expect("8 bytes"))
}

/// The rarity a card slot rolls for a window.
fn tier_of(seed: &str, user: Uuid, window: i64, slot: &str) -> Tier {
    let r = hash(seed, user, window, slot, 0) % 10_000;
    if slot == "c3" {
        if r < RARE {
            Tier::Rare
        } else if r < LEGENDARY {
            Tier::Legendary
        } else {
            Tier::Mythic
        }
    } else if r < COMMON {
        Tier::Common
    } else if r < UNCOMMON {
        Tier::Uncommon
    } else {
        Tier::Rare
    }
}

/// The teams a card slot can pick for a window, in order (the first one not to avoid is the one).
fn candidates(pack: &Pack, seed: &str, user: Uuid, window: i64, slot: &str) -> (Tier, Vec<i32>) {
    let tier = tier_of(seed, user, window, slot);
    let mut pool = pack.pools.get(&tier).cloned().unwrap_or_default();
    pool.sort_unstable();
    if pool.is_empty() {
        return (tier, vec![]);
    }
    let picks = (1..=8).map(|salt| pool[(hash(seed, user, window, slot, salt) % pool.len() as u64) as usize]).collect();
    (tier, picks)
}

/// What one slot holds for a player in a window. `avoid`: a team already in another card slot.
pub fn roll(pack: &Pack, seed: &str, user: Uuid, window: i64, slot: &str, avoid: Option<i32>) -> Stock {
    if slot == "div" {
        let ds: Vec<&String> = pack.divisions.keys().collect();
        let i = (hash(seed, user, window, slot, 0) % ds.len().max(1) as u64) as usize;
        return Stock::Division { division: ds.get(i).map(|d| d.to_string()).unwrap_or_default() };
    }
    let (tier, picks) = candidates(pack, seed, user, window, slot);
    let num = picks.iter().copied().find(|n| Some(*n) != avoid).or(picks.first().copied()).unwrap_or(0);
    Stock::Card { num, tier }
}

/// Whether this slot could have held this team in that window (the anticheat's check of a bought card), at the
/// rarities as they are now.
pub fn could_hold(pack: &Pack, seed: &str, user: Uuid, window: i64, slot: &str, num: i32) -> bool {
    candidates(pack, seed, user, window, slot).1.contains(&num)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Freeze {
    slot: String,
    window: i64,
}

/// Each slot's stock as the player sees it now: (slot, the window it's from, what it is).
fn stock(pack: &Pack, seed: &str, user: Uuid, now_window: i64, fz: Option<&Freeze>) -> Vec<(String, i64, Stock)> {
    let mut out: Vec<(String, i64, Stock)> = Vec::new();
    for slot in SLOTS {
        let w = fz.filter(|f| f.slot == slot).map_or(now_window, |f| f.window);
        let avoid = match slot {
            "c2" => out.iter().find_map(|(s, _, st)| match st {
                Stock::Card { num, .. } if s == "c1" => Some(*num),
                _ => None,
            }),
            _ => None,
        };
        out.push((slot.to_string(), w, roll(pack, seed, user, w, slot, avoid)));
    }
    out
}

/// The shop's secret, made the first time it's needed and kept in the settings (an admin saving the settings
/// leaves it alone).
pub async fn seed(db: &Db) -> ApiResult<String> {
    if let Some(s) = get_s(&model::settings_item(db).await?, "shop_seed") {
        return Ok(s);
    }
    let fresh = hex::encode(rand::random::<[u8; 32]>());
    let mut tx = Tx::new();
    tx.update(
        "",
        "SETTINGS",
        "SETTINGS",
        Cond::new("SET shop_seed = if_not_exists(shop_seed, :s)").val(":s", sv(fresh.clone())),
        None,
    );
    tx.commit(db).await?;
    Ok(get_s(&model::settings_item(db).await?, "shop_seed").unwrap_or(fresh))
}

async fn freeze_of(db: &Db, user: Uuid) -> ApiResult<Option<Freeze>> {
    Ok(db.get_as::<Freeze>(&upk(user), "SHOPFREEZE").await?)
}

fn sold_sk(window: i64, slot: &str) -> String {
    format!("SHOP#{window}#{slot}")
}

fn bought_sk(day: i64) -> String {
    format!("SHOPBUY#{day}")
}

// ---------- what the app sees ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemOut {
    slot: String,
    window: i64,
    #[serde(flatten)]
    stock: Stock,
    price: i32,
    sold: bool,
    frozen: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShopOut {
    on: bool,
    window: i64,
    /// When the stock changes next (ms).
    ends_at: i64,
    items: Vec<ItemOut>,
    std_price: i32,
    boosted_price: i32,
    /// Packs bought (or crafted) today, and how many a day.
    packs_today: i64,
    packs_per_day: i32,
}

async fn shop_out(s: &Shared, user: Uuid) -> ApiResult<ShopOut> {
    let db = &s.db;
    let rules = api::rules(db).await?;
    let id = s.catalog().await.claimable().id().to_string();
    let pack = api::pack(s, &id).await?;
    let seed = seed(db).await?;
    let now = now_ms();
    let w = model::shop_window(now);
    let fz = freeze_of(db, user).await?;
    let st = stock(&pack, &seed, user, w, fz.as_ref());
    let mut keys: Vec<crate::db::Item> =
        st.iter().map(|(slot, win, _)| crate::db::key(upk(user), sold_sk(*win, slot))).collect();
    keys.push(crate::db::key(upk(user), bought_sk(model::day_number())));
    let found = db.batch_get(keys).await?;
    let sks: HashSet<String> = found.iter().filter_map(|it| get_s(it, "sk")).collect();
    let packs_today = found
        .iter()
        .find(|it| get_s(it, "sk").as_deref() == Some(bought_sk(model::day_number()).as_str()))
        .and_then(|it| get_n(it, "n"))
        .unwrap_or(0);
    Ok(ShopOut {
        on: rules.shop.on,
        window: w,
        ends_at: model::shop_window_end(now),
        items: st
            .into_iter()
            .map(|(slot, win, stock)| ItemOut {
                sold: sks.contains(&sold_sk(win, &slot)),
                frozen: fz.as_ref().is_some_and(|f| f.slot == slot),
                price: rules.shop.price(&stock),
                slot,
                window: win,
                stock,
            })
            .collect(),
        std_price: rules.shop.std,
        boosted_price: rules.boost_cost,
        packs_today,
        packs_per_day: rules.shop.packs_per_day,
    })
}

async fn shop(State(s): State<Shared>, user: User) -> ApiResult<Json<ShopOut>> {
    Ok(Json(shop_out(&s, user.id).await?))
}

// ---------- buying a card or a division pack ----------

#[derive(Deserialize)]
struct BuyReq {
    slot: String,
    /// The window the item the player saw is from (a frozen item's is older).
    window: i64,
    /// The price the player saw: if it changed since, nothing is bought.
    price: i32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Bought {
    num: i32,
    tier: Tier,
    serial: i32,
    is_new: bool,
    copy: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuyOut {
    state: api::StateOut,
    shop: ShopOut,
    /// The card bought, or the division pack (open it next, with /api/open and this division).
    card: Option<Bought>,
    division: Option<String>,
    /// Division sets the card finished (each paid a bonus pack).
    sets: Vec<String>,
}

async fn buy(State(s): State<Shared>, user: User, key: IdemKey, Json(req): Json<BuyReq>) -> ApiResult<Response> {
    if !SLOTS.contains(&req.slot.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let db = &s.db;
    let rules = api::rules(db).await?;
    if !rules.shop.on {
        return Err(err(StatusCode::FORBIDDEN, "shop_off"));
    }
    if let Some(done) = idem_begin(db, user.id, &key, "shop").await? {
        return Ok(done);
    }
    let id = s.catalog().await.claimable().id().to_string();
    let pack = api::pack(&s, &id).await?;
    let seed = seed(db).await?;
    let r = retry!(async {
        let now = now_ms();
        let fz = freeze_of(db, user.id).await?;
        let st = stock(&pack, &seed, user.id, model::shop_window(now), fz.as_ref());
        let (_, used, item) = st.iter().find(|(slot, _, _)| *slot == req.slot).expect("a known slot");
        if *used != req.window {
            return Err(err(StatusCode::CONFLICT, "shop_changed"));
        }
        let price = rules.shop.price(item);
        if price != req.price {
            return Err(err(StatusCode::CONFLICT, "price_changed"));
        }
        let mut p = api::me(db, user.id).await?;
        if p.parts < i64::from(price) {
            return Err(err(StatusCode::CONFLICT, "not_enough_parts"));
        }
        let mut tx = Tx::new();
        idem_mark(&mut tx, user.id, &key, "shop");
        // The record of this buy, once per slot and window. Kept (no expiry): the anticheat checks each one.
        let mut mark = crate::db::key(upk(user.id), sold_sk(*used, &req.slot));
        mark.insert("slot".into(), sv(req.slot.clone()));
        mark.insert("window".into(), n(*used));
        mark.insert("price".into(), n(price));
        mark.insert("at".into(), n(now));
        match item {
            Stock::Card { num, tier } => {
                mark.insert("num".into(), n(*num));
                mark.insert("tier".into(), sv(tier.as_str()));
            }
            Stock::Division { division } => {
                mark.insert("division".into(), sv(division.clone()));
            }
        }
        tx.put_if("sold", mark, Some(Cond::absent()));
        if fz.as_ref().is_some_and(|f| f.slot == req.slot) {
            tx.delete_if("", &upk(user.id), "SHOPFREEZE", None);
        }
        let before = model::pack_row(db, user.id, pack.id()).await?;
        let mut after = before.clone();
        let mut bought: Option<Bought> = None;
        let mut sets: Vec<String> = Vec::new();
        let mut reason = "shop division";
        match item {
            Stock::Card { num, tier } => {
                reason = "shop, set";
                let serial = api::take_serials(db, &mut tx, pack.id(), &[*num], true).await?[&0];
                let owned = model::cards(db, user.id, pack.id()).await?;
                let had = owned.iter().filter(|c| c.team == *num).count() as i64;
                let row = CardRow {
                    id: db.ids("card", 1).await?,
                    pack: pack.id().to_string(),
                    team: *num,
                    tier: tier.as_str().to_string(),
                    serial,
                    opening_id: None,
                    slot: None,
                    obtained: "shop".into(),
                    created_at: now,
                };
                model::add_card(&mut tx, user.id, &row, "shop");
                let mut stats = model::stats(db, user.id, pack.id()).await?;
                stats.cards += 1;
                if had == 0 {
                    model::stats_team_gained(&mut stats, tier.as_str());
                }
                // A card that finishes a division set pays its bonus pack, as from a pack or a trade.
                let mut have: HashSet<i32> = owned.iter().map(|c| c.team).collect();
                have.insert(*num);
                let done = api::sets_done(db, user.id, pack.id()).await?;
                sets = api::finished_sets(&pack, &have, &done, &[*num]);
                for d in &sets {
                    api::record_set(&mut tx, user.id, pack.id(), d);
                }
                stats.sets += sets.len() as i64;
                after.sealed += sets.len() as i32;
                model::save_stats(&mut tx, user.id, pack.id(), &stats);
                bought = Some(Bought { num: *num, tier: *tier, serial, is_new: had == 0, copy: had + 1 });
            }
            Stock::Division { division } => after.division.push(division.clone()),
        }
        if after != before {
            model::save_pack(&mut tx, &mut p, &before, &after, reason);
        }
        let parts = p.parts;
        p.parts -= i64::from(price);
        model::save_user(&mut tx, &mut p, parts, "shop");
        match tx.commit(db).await {
            Ok(()) => Ok(Some((bought, sets, if let Stock::Division { division } = item { Some(division.clone()) } else { None }))),
            Err(DbError::Conflict("sold")) => Err(err(StatusCode::CONFLICT, "sold_out")),
            Err(DbError::Conflict("req")) => Ok(None),
            Err(e) => Err(ApiError::from(e)),
        }
    })?;
    let Some((card, sets, division)) = r else { return idem_lost(db, user.id, &key, "shop").await };
    if let Some(c) = &card {
        crate::profiles::unwish(db, user.id, pack.id(), [c.num]).await;
    }
    let out = BuyOut { state: api::load_state(&s, user.id).await?, shop: shop_out(&s, user.id).await?, card, division, sets };
    idem_end(db, user.id, &key, "shop", &out).await?;
    Ok(Json(out).into_response())
}

// ---------- freezing ----------

#[derive(Deserialize)]
struct FreezeReq {
    /// The slot to freeze, or none to unfreeze.
    slot: Option<String>,
    /// The window the player is looking at (only what's in the shop now can be frozen).
    #[serde(default)]
    window: i64,
}

async fn freeze(State(s): State<Shared>, user: User, Json(req): Json<FreezeReq>) -> ApiResult<Json<ShopOut>> {
    let db = &s.db;
    match &req.slot {
        None => db.delete(&upk(user.id), "SHOPFREEZE").await?,
        Some(slot) => {
            if !SLOTS.contains(&slot.as_str()) {
                return Err(err(StatusCode::BAD_REQUEST, "bad_request"));
            }
            let w = model::shop_window(now_ms());
            if req.window != w {
                return Err(err(StatusCode::CONFLICT, "shop_changed"));
            }
            if db.get(&upk(user.id), &sold_sk(w, slot)).await?.is_some() {
                return Err(err(StatusCode::CONFLICT, "sold_out"));
            }
            let mut it = crate::db::key(upk(user.id), "SHOPFREEZE");
            it.insert("slot".into(), sv(slot.clone()));
            it.insert("window".into(), n(w));
            db.put(it).await?;
        }
    }
    Ok(Json(shop_out(&s, user.id).await?))
}

// ---------- packs ----------

#[derive(Deserialize)]
struct PackBuyReq {
    /// "std" or "boosted".
    kind: String,
}

async fn pack(State(s): State<Shared>, user: User, key: IdemKey, Json(req): Json<PackBuyReq>) -> ApiResult<Response> {
    match req.kind.as_str() {
        "std" => buy_pack(&s, user.id, &key, false).await,
        "boosted" => buy_pack(&s, user.id, &key, true).await,
        _ => Err(err(StatusCode::BAD_REQUEST, "bad_request")),
    }
}

/// Buys a Standard or Boosted pack of the free pack for parts (a Boosted one is "crafting", as it always was), up to
/// the daily limit. The limit keeps buying well under the anticheat's intake alarm (packs taken in per hour), which is
/// there for duplicated packs, not for someone spending their parts.
pub async fn buy_pack(s: &Shared, user: Uuid, key: &IdemKey, boosted: bool) -> ApiResult<Response> {
    let kind = if boosted { "craft" } else { "shop pack" };
    let db = &s.db;
    let rules = api::rules(db).await?;
    if !boosted && !rules.shop.on {
        return Err(err(StatusCode::FORBIDDEN, "shop_off"));
    }
    if let Some(done) = idem_begin(db, user, key, kind).await? {
        return Ok(done);
    }
    let cost = i64::from(if boosted { rules.boost_cost } else { rules.shop.std });
    let free = s.catalog().await.claimable().id().to_string();
    let r = retry!(async {
        let mut p = api::me(db, user).await?;
        if p.parts < cost {
            return Err(err(StatusCode::CONFLICT, "not_enough_parts"));
        }
        let before = model::pack_row(db, user, &free).await?;
        let mut after = before.clone();
        after.sealed += 1;
        after.boosted += i32::from(boosted);
        let mut day = model::today(db, user).await?;
        if boosted {
            crate::missions::count(&mut day, crate::missions::Kind::Crafted, 1);
        }
        let mut tx = Tx::new();
        idem_mark(&mut tx, user, key, kind);
        tx.update(
            "limit",
            &upk(user),
            &bought_sk(model::day_number()),
            Cond::new("ADD n :one SET expires_at = :e")
                .val(":one", n(1))
                .val(":e", n(chrono::Utc::now().timestamp() + 40 * 86_400))
                .val(":max", n(rules.shop.packs_per_day)),
            Some("attribute_not_exists(n) OR n < :max"),
        );
        model::save_pack(&mut tx, &mut p, &before, &after, kind);
        model::save_day(&mut tx, user, &mut day);
        let parts = p.parts;
        p.parts -= cost;
        model::save_user(&mut tx, &mut p, parts, kind);
        match tx.commit(db).await {
            Ok(()) => Ok(true),
            Err(DbError::Conflict("limit")) => Err(err(StatusCode::CONFLICT, "pack_limit")),
            Err(DbError::Conflict("req")) => Ok(false),
            Err(e) => Err(e.into()),
        }
    })?;
    if !r {
        return idem_lost(db, user, key, kind).await;
    }
    let out = api::load_state(s, user).await?;
    idem_end(db, user, key, kind, &out).await?;
    Ok(Json(out).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packs::Catalog;

    fn cmp26() -> Pack {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/packs");
        let mut c = Catalog::load(&dir).unwrap();
        let i = c.packs.iter().position(|p| p.id() == "cmp26").unwrap();
        c.packs.swap_remove(i)
    }

    #[test]
    fn the_same_window_always_has_the_same_stock() {
        let pack = cmp26();
        let u = Uuid::from_u128(7);
        let a = stock(&pack, "seed", u, 1000, None);
        assert_eq!(a, stock(&pack, "seed", u, 1000, None));
        assert_ne!(a, stock(&pack, "seed", u, 1001, None), "the next window has new stock");
        assert_ne!(a, stock(&pack, "other seed", u, 1000, None), "the secret changes everything");
        assert_ne!(a, stock(&pack, "seed", Uuid::from_u128(8), 1000, None), "each player has their own");
    }

    #[test]
    fn slots_hold_what_they_should_at_the_odds_planned() {
        let pack = cmp26();
        let u = Uuid::from_u128(1);
        let mut tiers: std::collections::HashMap<(&str, Tier), u32> = std::collections::HashMap::new();
        let windows = 200_000;
        for w in 0..windows {
            let st = stock(&pack, "s", u, w, None);
            let num = |i: usize| match &st[i].2 {
                Stock::Card { num, tier } => {
                    assert_eq!(pack.team_tier[num], *tier);
                    *num
                }
                Stock::Division { .. } => panic!("slot {i} is a card"),
            };
            assert_ne!(num(0), num(1), "the two everyday cards are different teams");
            for (i, slot) in ["c1", "c2", "c3"].into_iter().enumerate() {
                let Stock::Card { tier, .. } = &st[i].2 else { unreachable!() };
                *tiers.entry((slot, *tier)).or_default() += 1;
            }
            assert!(matches!(&st[3].2, Stock::Division { division } if pack.divisions.contains_key(division)));
        }
        let pct = |slot: &'static str, t: Tier| f64::from(tiers.get(&(slot, t)).copied().unwrap_or(0)) / windows as f64;
        assert_eq!(pct("c1", Tier::Mythic) + pct("c1", Tier::Legendary), 0.0, "everyday cards are Rare at most");
        assert_eq!(pct("c3", Tier::Common) + pct("c3", Tier::Uncommon), 0.0, "the third card is Rare or better");
        assert!((pct("c1", Tier::Common) - 0.70).abs() < 0.01);
        assert!((pct("c2", Tier::Rare) - 0.05).abs() < 0.005);
        assert!((pct("c3", Tier::Legendary) - 0.146).abs() < 0.005);
        assert!((pct("c3", Tier::Mythic) - 0.004).abs() < 0.001, "Mythics: {}", pct("c3", Tier::Mythic));
    }

    #[test]
    fn a_frozen_slot_keeps_its_stock() {
        let pack = cmp26();
        let u = Uuid::from_u128(3);
        let held = stock(&pack, "s", u, 50, None)[2].2.clone();
        let fz = Freeze { slot: "c3".into(), window: 50 };
        for w in 51..60 {
            let st = stock(&pack, "s", u, w, Some(&fz));
            assert_eq!(st[2], ("c3".to_string(), 50, held.clone()));
            assert_eq!(st[0].1, w, "the other slots move on");
        }
    }

    #[test]
    fn a_bought_card_can_be_checked() {
        let pack = cmp26();
        let u = Uuid::from_u128(4);
        let Stock::Card { num, .. } = roll(&pack, "s", u, 9, "c3", None) else { unreachable!() };
        assert!(could_hold(&pack, "s", u, 9, "c3", num));
        assert!(!could_hold(&pack, "other", u, 9, "c3", num) || num == 0);
    }

    #[test]
    fn windows_change_every_four_hours_on_the_clock() {
        // 2026-11-10 13:30 in Chicago (CST, UTC-6) is 19:30 UTC; the window ends at 16:00 local, 22:00 UTC.
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-10T19:30:00Z").unwrap().timestamp_millis();
        let end = model::shop_window_end(at);
        assert_eq!(end, chrono::DateTime::parse_from_rfc3339("2026-11-10T22:00:00Z").unwrap().timestamp_millis());
        assert_eq!(model::shop_window(end), model::shop_window(at) + 1);
        assert_eq!(model::shop_window(end - 1), model::shop_window(at));
    }
}
