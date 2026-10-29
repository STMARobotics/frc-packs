//! The game's items in DynamoDB and the few writes everything else is built from. Anything that changes a player's
//! packs, parts or cards goes through the helpers here, which write the ledger line in the same transaction, so no code path can change holdings without the ledger seeing it.

use std::collections::HashMap;

use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{Cond, Db, DbResult, Item, Tx, from_item, item, n, pad, s};

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub fn upk(id: Uuid) -> String {
    format!("U#{id}")
}

// ---------- the player ----------

/// A player's profile. Saved whole, and only through [`save_user`], which bumps `ver` on condition it's unchanged:
/// that's what lines up every change to one player (see docs/dynamodb.md).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Profile {
    pub id: Uuid,
    pub username: Option<String>,
    pub password_hash: Option<String>,
    #[serde(default)]
    pub is_admin: bool,
    #[serde(default)]
    pub disabled: bool,
    pub first_name: Option<String>,
    pub badge: Option<String>,
    #[serde(default)]
    pub parts: i64,
    /// When the next free pack can be claimed (ms).
    pub next_claim_at: i64,
    #[serde(default)]
    pub demo: bool,
    #[serde(default)]
    pub streak: i32,
    /// The last day (game day number) a pack was opened.
    pub streak_day: Option<i64>,
    #[serde(default)]
    pub level_claimed: i32,
    #[serde(default)]
    pub showcase: Vec<i32>,
    /// A line or two about themselves, on their profile.
    #[serde(default)]
    pub bio: Option<String>,
    /// The team whose card is their picture, and the one across the top of their profile (picked from cards they
    /// owned at the time; they stay if the card is traded away later).
    #[serde(default)]
    pub avatar: Option<i32>,
    #[serde(default)]
    pub banner: Option<i32>,
    pub username_changed_at: Option<i64>,
    pub invite_code: Option<String>,
    pub created_at: i64,
    pub pack_ping_at: Option<i64>,
    /// The opening still being revealed, if any.
    pub pending_open: Option<i64>,
    /// The rarity version this player's cards are up to (see `retier`).
    #[serde(default)]
    pub retier: i32,
    /// A note for the player, shown once the next time they open the game (then cleared).
    #[serde(default)]
    pub notice: Option<String>,
    /// How many one-time announcements they've been given (see `announce`).
    #[serde(default)]
    pub announced: i32,
    /// Packs and parts taken in through trades lately (the last 24 hours count against the daily limit).
    #[serde(default)]
    pub intake: Vec<Intake>,
    pub ver: i64,
    // Index: every account, oldest first.
    #[serde(default)]
    pub gsi1pk: String,
    #[serde(default)]
    pub gsi1sk: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Intake {
    pub at: i64,
    pub packs: i64,
    pub parts: i64,
}

impl Profile {
    /// Packs and parts taken in through trades in the last 24 hours.
    pub fn taken_in(&self, now: i64) -> (i64, i64) {
        self.intake.iter().filter(|i| i.at > now - 86_400_000).fold((0, 0), |(a, b), i| (a + i.packs, b + i.parts))
    }

    /// Records packs and parts taken in now, and forgets ones older than a day.
    pub fn take_in(&mut self, now: i64, packs: i64, parts: i64) {
        self.intake.retain(|i| i.at > now - 86_400_000);
        if packs > 0 || parts > 0 {
            self.intake.push(Intake { at: now, packs, parts });
        }
    }
}

pub async fn profile(db: &Db, id: Uuid) -> DbResult<Option<Profile>> {
    db.get_as(&upk(id), "PROFILE").await
}

/// Writes the player back with `ver` bumped, on condition nothing else changed them since they were read (a new
/// account: on condition it doesn't exist). A change in parts is written to the ledger with `reason`.
pub fn save_user(tx: &mut Tx, p: &mut Profile, parts_before: i64, reason: &str) {
    let cond = if p.ver == 0 { Cond::absent() } else { Cond::new("ver = :v").val(":v", n(p.ver)) };
    p.ver += 1;
    p.gsi1pk = "USERS".into();
    p.gsi1sk = format!("{}#{}", pad(p.created_at, 15), p.id);
    tx.put_if("ver", item(upk(p.id), "PROFILE", p), Some(cond));
    if p.parts != parts_before {
        ledger(tx, p.id, "parts", p.parts - parts_before, None, reason);
    }
}

// ---------- packs ----------

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PackRow {
    pub pack: String,
    #[serde(default)]
    pub sealed: i32,
    /// How many of the sealed packs are boosted.
    #[serde(default)]
    pub boosted: i32,
    /// How many of the boosted packs are Mythic packs.
    #[serde(default)]
    pub mythic: i32,
    #[serde(default)]
    pub opened: i32,
    #[serde(default)]
    pub pity_m: i32,
    #[serde(default)]
    pub pity_l: i32,
}

impl PackRow {
    pub fn new(pack: &str) -> PackRow {
        PackRow { pack: pack.to_string(), ..Default::default() }
    }

    /// Standard (not boosted) sealed packs.
    pub fn standard(&self) -> i32 {
        self.sealed - self.boosted
    }
}

pub async fn packs(db: &Db, user: Uuid) -> DbResult<Vec<PackRow>> {
    db.query(&upk(user), "PACK#").await?.into_iter().map(from_item).collect()
}

pub async fn pack_row(db: &Db, user: Uuid, pack: &str) -> DbResult<PackRow> {
    Ok(db.get_as(&upk(user), &format!("PACK#{pack}")).await?.unwrap_or_else(|| PackRow::new(pack)))
}

/// Writes a player's pack counts, with ledger lines for any change in standard or boosted sealed packs. Only within a
/// transaction that also saves the player (so it's lined up with their other changes).
pub fn save_pack(tx: &mut Tx, user: Uuid, before: &PackRow, after: &PackRow, reason: &str) {
    assert!(
        after.sealed >= 0
            && after.boosted >= 0
            && after.boosted <= after.sealed
            && after.mythic >= 0
            && after.mythic <= after.boosted
    );
    tx.put(item(upk(user), format!("PACK#{}", after.pack), after));
    if after.standard() != before.standard() {
        ledger(tx, user, "packs", i64::from(after.standard() - before.standard()), Some(after.pack.clone()), reason);
    }
    if after.boosted != before.boosted {
        ledger(tx, user, "boosted", i64::from(after.boosted - before.boosted), Some(after.pack.clone()), reason);
    }
}

// ---------- cards ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CardRow {
    pub id: i64,
    pub pack: String,
    pub team: i32,
    pub tier: String,
    pub serial: i32,
    pub opening_id: Option<i64>,
    pub slot: Option<i32>,
    /// "pack" or "trade".
    pub obtained: String,
    pub created_at: i64,
}

pub fn card_sk(pack: &str, team: i32, id: i64) -> String {
    format!("CARD#{pack}#{}#{}", pad(i64::from(team), 6), pad(id, 12))
}

/// A player's cards of one pack, by team, then oldest first (so each team's first copy comes first).
pub async fn cards(db: &Db, user: Uuid, pack: &str) -> DbResult<Vec<CardRow>> {
    db.query(&upk(user), &format!("CARD#{pack}#")).await?.into_iter().map(from_item).collect()
}

/// A player's copies of one team, oldest first.
pub async fn team_cards(db: &Db, user: Uuid, pack: &str, team: i32) -> DbResult<Vec<CardRow>> {
    db.query(&upk(user), &format!("CARD#{pack}#{}#", pad(i64::from(team), 6)))
        .await?
        .into_iter()
        .map(from_item)
        .collect()
}

pub fn add_card(tx: &mut Tx, user: Uuid, c: &CardRow, reason: &str) {
    tx.put_if("card", item(upk(user), card_sk(&c.pack, c.team, c.id), c), Some(Cond::absent()));
    ledger(tx, user, "card", 1, Some(format!("{} #{}", c.team, c.serial)), reason);
}

/// Takes a card away; fails the transaction (label "card_gone") if the player doesn't have it any more.
pub fn remove_card(tx: &mut Tx, user: Uuid, c: &CardRow, reason: &str) {
    tx.delete_if("card_gone", &upk(user), &card_sk(&c.pack, c.team, c.id), Some(Cond::exists()));
    ledger(tx, user, "card", -1, Some(format!("{} #{}", c.team, c.serial)), reason);
}

/// Copies of a team in the whole game: changes with every card made or scrapped.
pub fn count_in_game(tx: &mut Tx, pack: &str, team: i32, by: i64) {
    tx.update("", &format!("PRINT#{pack}#{team}"), "PRINT", Cond::new("ADD live :d").val(":d", n(by)), None);
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Printing {
    #[serde(default)]
    pub minted: i32,
    #[serde(default)]
    pub live: i64,
}

pub async fn printing(db: &Db, pack: &str, team: i32) -> DbResult<Printing> {
    Ok(db.get_as(&format!("PRINT#{pack}#{team}"), "PRINT").await?.unwrap_or_default())
}

// ---------- openings ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Opening {
    pub id: i64,
    pub pack: String,
    pub revealed: i32,
    #[serde(default)]
    pub sets: Vec<String>,
    #[serde(default)]
    pub boosted: bool,
    pub opened_at: i64,
}

pub fn open_sk(id: i64) -> String {
    format!("OPEN#{}", pad(id, 15))
}

pub async fn opening(db: &Db, user: Uuid, id: i64) -> DbResult<Option<Opening>> {
    db.get_as(&upk(user), &open_sk(id)).await
}

// ---------- per-pack stats (for profiles, Social and the collector level) ----------

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Stats {
    /// Different teams owned.
    #[serde(default)]
    pub teams: i64,
    #[serde(default)]
    pub cards: i64,
    /// Different Mythic / Legendary teams owned.
    #[serde(default)]
    pub mythic_teams: i64,
    #[serde(default)]
    pub legendary_teams: i64,
    /// Trades finished (accepted), either side.
    #[serde(default)]
    pub trades: i64,
    #[serde(default)]
    pub sets: i64,
}

pub async fn stats(db: &Db, user: Uuid, pack: &str) -> DbResult<Stats> {
    Ok(db.get_as(&upk(user), &format!("STATS#{pack}")).await?.unwrap_or_default())
}

pub fn save_stats(tx: &mut Tx, user: Uuid, pack: &str, st: &Stats) {
    tx.put(item(upk(user), format!("STATS#{pack}"), st));
}

/// Teams owned before and after a change, for keeping [`Stats`] right: `tier` of each team that went from 0 copies
/// to some, or from some to 0.
pub fn stats_team_gained(st: &mut Stats, tier: &str) {
    st.teams += 1;
    match tier {
        "mythic" => st.mythic_teams += 1,
        "legendary" => st.legendary_teams += 1,
        _ => {}
    }
}

pub fn stats_team_lost(st: &mut Stats, tier: &str) {
    st.teams -= 1;
    match tier {
        "mythic" => st.mythic_teams -= 1,
        "legendary" => st.legendary_teams -= 1,
        _ => {}
    }
}

// ---------- ledger ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LedgerLine {
    pub at: i64,
    pub item: String,
    pub delta: i64,
    pub detail: Option<String>,
    pub reason: String,
}

/// One ledger line. Every change to a player's packs, boosted packs, parts or cards writes one.
pub fn ledger(tx: &mut Tx, user: Uuid, what: &str, delta: i64, detail: Option<String>, reason: &str) {
    let at = now_ms();
    let line = LedgerLine { at, item: what.into(), delta, detail, reason: reason.into() };
    let sk = format!("LED#{}#{}", pad(at, 15), &Uuid::new_v4().simple().to_string()[..10]);
    tx.put(item(upk(user), sk, &line));
}

pub async fn ledger_lines(db: &Db, user: Uuid, limit: i32) -> DbResult<Vec<LedgerLine>> {
    db.query_desc(&upk(user), "LED#", limit).await?.into_iter().map(from_item).collect()
}

// ---------- the Social feed ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FeedEvent {
    /// "pull", "set" or "trade".
    pub kind: String,
    pub who: String,
    pub at: i64,
    pub team: Option<i32>,
    pub tier: Option<String>,
    pub serial: Option<i32>,
    pub division: Option<String>,
    /// A finished trade: the other player and what changed hands (as offered).
    pub to: Option<String>,
    pub gave: Option<serde_json::Value>,
    pub got: Option<serde_json::Value>,
    pub gave_packs: Option<i32>,
    pub got_packs: Option<i32>,
    pub expires_at: i64,
}

pub fn feed(tx: &mut Tx, pack: &str, mut ev: FeedEvent) {
    ev.expires_at = ev.at / 1000 + 30 * 86_400;
    let sk = format!("{}#{}", pad(ev.at, 15), &Uuid::new_v4().simple().to_string()[..10]);
    tx.put(item(format!("FEED#{pack}"), sk, &ev));
}

// ---------- settings ----------

pub async fn settings_item(db: &Db) -> DbResult<Item> {
    Ok(db.get("SETTINGS", "SETTINGS").await?.unwrap_or_default())
}

// ---------- game days ----------

pub fn tz() -> chrono_tz::Tz {
    std::env::var("GAME_TZ").ok().and_then(|t| t.parse().ok()).unwrap_or(chrono_tz::America::Chicago)
}

/// Today in the game's time zone, as a day number since 2020-01-01 (missions and the streak use it).
pub fn day_number() -> i64 {
    let today = Utc::now().with_timezone(&tz()).date_naive();
    i64::from(today.num_days_from_ce() - chrono::NaiveDate::from_ymd_opt(2020, 1, 1).unwrap().num_days_from_ce())
}

/// What each player did today toward the missions, and which missions they've collected.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Day {
    #[serde(default)]
    pub counts: HashMap<String, i64>,
    #[serde(default)]
    pub claimed: Vec<String>,
    #[serde(default)]
    pub expires_at: i64,
}

pub fn day_sk(day: i64) -> String {
    format!("DAY#{day}")
}

pub async fn today(db: &Db, user: Uuid) -> DbResult<Day> {
    Ok(db.get_as(&upk(user), &day_sk(day_number())).await?.unwrap_or_default())
}

pub fn save_day(tx: &mut Tx, user: Uuid, d: &mut Day) {
    d.expires_at = Utc::now().timestamp() + 40 * 86_400;
    tx.put(item(upk(user), day_sk(day_number()), d));
}

/// A string attribute as an `S` value, or skip it.
pub fn s_opt(v: &Option<String>) -> Option<aws_sdk_dynamodb::types::AttributeValue> {
    v.as_ref().map(|x| s(x.clone()))
}
