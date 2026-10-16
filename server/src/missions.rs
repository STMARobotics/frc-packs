//! Daily missions and the pack-opening streak, so there's a reason to come back every day.
//!
//! - Three missions a day, drawn from a pool of about twenty (open packs, scrap extras, trade, pull new teams or rare
//!   cards, craft a boosted pack, claim packs), each worth parts once done. Each player's three change every day and
//!   never repeat a kind. Progress is counted by the server as things happen; the player taps to collect.
//! - The streak counts days in a row with at least one pack opened. Every 7th day gives a boosted pack. Missing a
//!   day halves the streak instead of wiping it, so one busy day isn't crushing.
//!
//! Days follow the game's time zone (GAME_TZ, default America/Chicago), so missions reset at local midnight.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::Shared;
use crate::api::{self, StateOut};
use crate::auth::User;
use crate::db::{Db, Tx};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, Day, Profile};
use crate::retry;

pub fn routes() -> Router<Shared> {
    Router::new().route("/missions/{id}/claim", post(claim)).route("/level/claim", post(claim_level))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Opened,
    Scrapped,
    Traded,
    /// Teams pulled that the player didn't have yet.
    NewTeams,
    /// Rare, Legendary or Mythic cards pulled.
    RarePlus,
    /// Boosted packs crafted.
    Crafted,
    /// Packs collected from the timer.
    Claimed,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Opened => "opened",
            Kind::Scrapped => "scrapped",
            Kind::Traded => "traded",
            Kind::NewTeams => "new_teams",
            Kind::RarePlus => "rare_plus",
            Kind::Crafted => "crafted",
            Kind::Claimed => "claimed_packs",
        }
    }
}

type Mission = (&'static str, &'static str, Kind, i32, i32);

/// id, what the player sees, what it counts, how many, parts it pays. Harder ones pay more.
const MISSIONS: [Mission; 21] = [
    ("open1", "Open a pack", Kind::Opened, 1, 20),
    ("open", "Open 2 packs", Kind::Opened, 2, 40),
    ("open4", "Open 4 packs", Kind::Opened, 4, 80),
    ("scrap3", "Scrap 3 extra copies", Kind::Scrapped, 3, 20),
    ("scrap", "Scrap 5 extra copies", Kind::Scrapped, 5, 30),
    ("scrap12", "Scrap 12 extra copies", Kind::Scrapped, 12, 70),
    ("trade", "Send or accept a trade", Kind::Traded, 1, 60),
    ("trade2", "Make 2 trades", Kind::Traded, 2, 100),
    ("new2", "Pull 2 teams you don't have", Kind::NewTeams, 2, 30),
    ("new4", "Pull 4 new teams", Kind::NewTeams, 4, 60),
    ("new7", "Pull 7 new teams", Kind::NewTeams, 7, 110),
    ("rare1", "Pull a Rare or better", Kind::RarePlus, 1, 30),
    ("rare3", "Pull 3 Rare or better cards", Kind::RarePlus, 3, 70),
    ("rare5", "Pull 5 Rare or better cards", Kind::RarePlus, 5, 120),
    ("craft", "Craft a boosted pack", Kind::Crafted, 1, 100),
    ("claim", "Collect a timer pack", Kind::Claimed, 1, 20),
    ("claim3", "Collect 3 timer packs", Kind::Claimed, 3, 50),
    ("open6", "Open 6 packs", Kind::Opened, 6, 110),
    ("scrap20", "Scrap 20 extra copies", Kind::Scrapped, 20, 100),
    ("new10", "Pull 10 new teams", Kind::NewTeams, 10, 160),
    ("trade3", "Make 3 trades", Kind::Traded, 3, 150),
];

/// How many missions a player gets each day.
const PER_DAY: usize = 3;

/// A player's missions for a day: a stable shuffle of the pool by who they are and which day it is, taking the first
/// few of different kinds.
fn todays(user: Uuid, day: i64) -> Vec<&'static Mission> {
    let u = user.as_u128();
    let mut x = (u as u64) ^ ((u >> 64) as u64) ^ (day as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut order: Vec<usize> = (0..MISSIONS.len()).collect();
    for k in (1..order.len()).rev() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        order.swap(k, (x % (k as u64 + 1)) as usize);
    }
    let mut out: Vec<&Mission> = Vec::with_capacity(PER_DAY);
    for i in order {
        let m = &MISSIONS[i];
        if out.len() < PER_DAY && out.iter().all(|o| o.2 != m.2) {
            out.push(m);
        }
    }
    out
}

/// A boosted pack every this many days of streak.
pub const STREAK_REWARD_EVERY: i32 = 7;

/// Counts something toward today's missions (the caller saves the day in its transaction).
pub fn count(day: &mut Day, kind: Kind, n: i64) {
    if n > 0 {
        *day.counts.entry(kind.key().to_string()).or_default() += n;
    }
}

/// After a pack is opened: count it, and move the streak along (on the profile the caller saves). Returns true when
/// this pack earned the streak's boosted pack, which the caller adds.
pub fn on_open(p: &mut Profile, day: &mut Day) -> bool {
    count(day, Kind::Opened, 1);
    let today = model::day_number();
    let advanced = p.streak_day != Some(today);
    p.streak = match p.streak_day {
        Some(d) if d == today => p.streak,
        Some(d) if d == today - 1 => p.streak + 1,
        _ => 1.max(p.streak / 2),
    };
    p.streak_day = Some(today);
    advanced && p.streak > 0 && p.streak % STREAK_REWARD_EVERY == 0
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionOut {
    id: &'static str,
    label: &'static str,
    goal: i32,
    progress: i32,
    reward: i32,
    claimed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreakOut {
    /// Days in a row, counting today if a pack was opened today.
    days: i32,
    /// A pack has been opened today.
    today: bool,
    /// The streak is still alive (a pack was opened today or yesterday).
    alive: bool,
    every: i32,
}

fn progress(day: &Day, kind: Kind) -> i64 {
    day.counts.get(kind.key()).copied().unwrap_or(0)
}

pub fn load(p: &Profile, day: &Day) -> (Vec<MissionOut>, StreakOut) {
    let today = model::day_number();
    let missions = todays(p.id, today)
        .into_iter()
        .map(|(id, label, kind, goal, reward)| MissionOut {
            id,
            label,
            goal: *goal,
            progress: progress(day, *kind).min(i64::from(*goal)) as i32,
            reward: *reward,
            claimed: day.claimed.iter().any(|c| c == id),
        })
        .collect();
    let alive = p.streak_day.is_some_and(|d| d >= today - 1);
    let streak = StreakOut {
        days: if alive { p.streak } else { 0 },
        today: p.streak_day == Some(today),
        alive,
        every: STREAK_REWARD_EVERY,
    };
    (missions, streak)
}

/// Collects a finished mission's parts, once.
async fn claim(State(s): State<Shared>, user: User, Path(id): Path<String>) -> ApiResult<Json<StateOut>> {
    let Some((mid, _, kind, goal, reward)) = todays(user.id, model::day_number()).into_iter().find(|m| m.0 == id)
    else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown_mission"));
    };
    retry!(async {
        let mut p = api::me(&s.db, user.id).await?;
        let mut day = model::today(&s.db, user.id).await?;
        if progress(&day, *kind) < i64::from(*goal) || day.claimed.iter().any(|c| c == mid) {
            return Err(ApiError::new(StatusCode::CONFLICT, "mission_not_ready"));
        }
        day.claimed.push(mid.to_string());
        let mut tx = Tx::new();
        model::save_day(&mut tx, user.id, &mut day);
        let parts = p.parts;
        p.parts += i64::from(*reward);
        model::save_user(&mut tx, &mut p, parts, "mission");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    Ok(Json(api::load_state(&s, user.id).await?))
}

/// Collector level: one level for every this many different teams you own.
pub const LEVEL_TEAMS: i64 = 25;
/// Parts each new level pays, collected by tapping.
pub const LEVEL_PARTS: i32 = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelOut {
    teams: i64,
    level: i32,
    claimed: i32,
    per: i64,
    reward: i32,
}

fn level_of(teams: i64, claimed: i32) -> LevelOut {
    LevelOut { teams, level: (teams / LEVEL_TEAMS) as i32, claimed, per: LEVEL_TEAMS, reward: LEVEL_PARTS }
}

pub async fn level(db: &Db, user: Uuid, pack: &str) -> ApiResult<LevelOut> {
    let teams = model::stats(db, user, pack).await?.teams;
    let claimed = api::me(db, user).await?.level_claimed;
    Ok(level_of(teams, claimed))
}

/// Collects the parts for every level reached since the last collect.
async fn claim_level(State(s): State<Shared>, user: User) -> ApiResult<Json<StateOut>> {
    let free_id = s.catalog().await.claimable().id().to_string();
    let free = free_id.as_str();
    retry!(async {
        let mut p = api::me(&s.db, user.id).await?;
        let l = level_of(model::stats(&s.db, user.id, free).await?.teams, p.level_claimed);
        if l.level <= l.claimed {
            return Err(ApiError::new(StatusCode::CONFLICT, "nothing_to_claim"));
        }
        let parts = p.parts;
        p.parts += i64::from((l.level - l.claimed) * LEVEL_PARTS);
        p.level_claimed = l.level;
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "level");
        tx.commit(&s.db).await.map_err(ApiError::from)
    })?;
    Ok(Json(api::load_state(&s, user.id).await?))
}
