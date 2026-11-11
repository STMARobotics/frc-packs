//! Tripwire, the anticheat (v2; see docs/anticheat.md). Code and data say `anticheat`; the one place a player or admin
//! sees the name is `ANTICHEAT_NAME`, so renaming it is one line.
//!
//! - Prevent: the rules are enforced in the game's own writes (picking up opens a pack, wagers count toward the trade
//!   limits, new accounts can't give cards away). This module adds the intake alarm, run inside every pack write.
//! - Respond: flags are shadow flags by default: the player notices nothing, and Tripwire logs every trade and wager they
//!   make for an admin to watch. A paused flag (set by an admin, by the suite's setting, or by the intake alarm on a
//!   big dupe) stops trading and wagering instead. Packs always still open.
//! - Canaries: retired endpoints still answer "not found", but every call is logged: only scripts (and app tabs left
//!   open since before an update) call them.

pub mod detect;
pub mod respond;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::Shared;
use crate::db::{Db, key, n, pad, s as sv};
use crate::error::{ApiError, ApiResult};
use crate::model::{PackIn, Profile, now_ms};

/// What players and admins see the anticheat called.
pub const ANTICHEAT_NAME: &str = "Tripwire";

/// Packs taken in within an hour that flag the player. Legitimate play stays far below this: a banked timer is 2, a
/// streak reward 1, every division set bonus at once 8, a full day of trades 10, and crafting is limited by parts.
pub const PACKS_PER_HOUR: i64 = 30;

/// Packs in an hour past which a flag stops being silent and trading pauses, whatever the settings say: at this size it's
/// a dupe that has to stop spreading, even if that tips the player off.
pub const ESCALATE_PER_HOUR: i64 = 60;

/// How long watch events and canary hits are kept.
const KEEP_SECS: i64 = 30 * 86_400;

const HOUR_MS: i64 = 3_600_000;

/// Ledger reasons that aren't players taking packs in: a new account's starting packs, and test or dev-tools changes.
fn counts(reason: &str) -> bool {
    // Packs bought with parts (in the shop, or crafting) don't count: their parts are checked instead, and there's no
    // limit on buying.
    !matches!(reason, "new account" | "dev tools" | "test" | "shop pack" | "craft")
}

/// The intake alarm: records `gained` packs taken in now, forgets ones older than an hour, and flags the player if
/// the hour's total goes over `PACKS_PER_HOUR`. Called from `model::save_pack`, so every pack write goes through it, in
/// the same write as the profile (no extra reads or writes).
pub fn packs_in(p: &mut Profile, now: i64, gained: i64, reason: &str) {
    p.packs_in.retain(|x| x.at > now - HOUR_MS);
    if gained <= 0 || !counts(reason) {
        return;
    }
    p.packs_in.push(PackIn { at: now, n: gained, reason: reason.to_string() });
    let hour: i64 = p.packs_in.iter().map(|x| x.n).sum();
    if hour > PACKS_PER_HOUR && p.flagged.is_none() {
        // A flag that follows the suite's setting (shadow by default).
        p.flagged = Some(format!("intake: {hour} packs in an hour (limit {PACKS_PER_HOUR})"));
        p.flagged_at = Some(now);
    }
    if hour > ESCALATE_PER_HOUR && p.flag_mode.as_deref() != Some("paused") {
        p.flagged = Some(format!("intake: {hour} packs in an hour, trading paused (over {ESCALATE_PER_HOUR})"));
        p.flagged_at.get_or_insert(now);
        p.flag_mode = Some("paused".into());
    }
}

/// Tripwire's settings, changed in the suite.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Flags without a mode of their own are silent (true) or pause trading and wagering (false).
    #[serde(default = "on")]
    pub shadow_default: bool,
}

fn on() -> bool {
    true
}

impl Default for Config {
    fn default() -> Config {
        Config { shadow_default: true }
    }
}

/// The settings as each server last read them (per table): read at most every 30 seconds.
static CONFIG: Mutex<Option<HashMap<String, (Instant, Config)>>> = Mutex::new(None);
const CONFIG_FOR: Duration = Duration::from_secs(30);

pub async fn config(db: &Db) -> ApiResult<Config> {
    if let Some((at, c)) = CONFIG.lock().unwrap().get_or_insert_with(HashMap::new).get(&db.table)
        && at.elapsed() < CONFIG_FOR
    {
        return Ok(c.clone());
    }
    let c = db.get_as::<Config>("AC#CONFIG", "CONFIG").await?.unwrap_or_default();
    CONFIG.lock().unwrap().get_or_insert_with(HashMap::new).insert(db.table.clone(), (Instant::now(), c.clone()));
    Ok(c)
}

pub async fn save_config(db: &Db, c: &Config) -> ApiResult<()> {
    db.put(crate::db::item("AC#CONFIG", "CONFIG", c)).await?;
    CONFIG.lock().unwrap().get_or_insert_with(HashMap::new).insert(db.table.clone(), (Instant::now(), c.clone()));
    Ok(())
}

/// What a player's flag does right now: "shadow" (silent, watched) or "paused" (no trading or wagering). None if they
/// aren't flagged.
pub fn mode(p: &Profile, c: &Config) -> Option<&'static str> {
    p.flagged.as_ref()?;
    Some(match p.flag_mode.as_deref() {
        Some("paused") => "paused",
        Some("shadow") => "shadow",
        _ if c.shadow_default => "shadow",
        _ => "paused",
    })
}

/// The check before a trade or wager. An unflagged player passes. A shadow-flagged one passes too, and what they're
/// doing goes on their watch log. A paused one is refused (`you`: the one asking, else the other side).
pub async fn gate(db: &Db, p: &Profile, you: bool, what: &str) -> ApiResult<()> {
    if p.flagged.is_none() {
        return Ok(());
    }
    match mode(p, &config(db).await?) {
        Some("paused") => {
            Err(ApiError::new(StatusCode::CONFLICT, if you { "under_review" } else { "they_under_review" }))
        }
        _ => watch(db, p.id, what).await,
    }
}

/// One line on a flagged player's watch log, kept 30 days.
pub async fn watch(db: &Db, user: Uuid, what: &str) -> ApiResult<()> {
    let at = now_ms();
    let mut it =
        key(format!("AC#WATCH#{user}"), format!("{}#{}", pad(at, 15), &Uuid::new_v4().simple().to_string()[..6]));
    it.insert("at".into(), n(at));
    it.insert("what".into(), sv(what));
    it.insert("expires_at".into(), n(at / 1000 + KEEP_SECS));
    db.put(it).await?;
    Ok(())
}

/// A retired endpoint. It answers "not found" like any unknown one, and logs the call: the app doesn't make it any more,
/// so it's a script, or an app tab left open since before the update.
pub async fn canary(State(s): State<Shared>, OriginalUri(uri): OriginalUri, headers: HeaderMap) -> ApiError {
    let at = now_ms();
    let user = crate::auth::session(&s.db, &headers).await.ok().flatten().map(|x| x.id);
    let mut it = key("AC#CANARY", format!("{}#{}", pad(at, 15), &Uuid::new_v4().simple().to_string()[..6]));
    it.insert("at".into(), n(at));
    it.insert("path".into(), sv(uri.path()));
    it.insert("visitor".into(), sv(crate::auth::visitor(&headers)));
    if let Some(u) = user {
        it.insert("user_id".into(), sv(u.to_string()));
    }
    it.insert("expires_at".into(), n(at / 1000 + KEEP_SECS));
    if let Err(e) = s.db.put(it).await {
        tracing::warn!("canary not logged: {e}");
    }
    ApiError::new(StatusCode::NOT_FOUND, "not_found")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intake_alarm_flags_over_the_hourly_limit_only() {
        let mut p = Profile::default();
        let t = 1_000_000_000;
        for i in 0..15 {
            packs_in(&mut p, t + i, 2, "claim");
        }
        assert!(p.flagged.is_none(), "30 in an hour is allowed");
        packs_in(&mut p, t + 20, 1, "trade 7");
        assert!(p.flagged.as_deref().unwrap().contains("31 packs"));
        assert_eq!(p.flag_mode, None, "it follows the setting (shadow by default)");
        assert_eq!(mode(&p, &Config::default()), Some("shadow"));
        assert_eq!(mode(&p, &Config { shadow_default: false }), Some("paused"));
    }

    #[test]
    fn a_big_dupe_pauses_trading_whatever_the_setting() {
        let mut p = Profile::default();
        let t = 1_000_000_000;
        packs_in(&mut p, t, 40, "claim");
        assert_eq!(mode(&p, &Config::default()), Some("shadow"));
        packs_in(&mut p, t + 1, 25, "claim");
        assert_eq!(p.flag_mode.as_deref(), Some("paused"));
        assert_eq!(mode(&p, &Config::default()), Some("paused"));
        assert!(p.flagged.as_deref().unwrap().contains("65 packs"));
    }

    #[test]
    fn old_intake_and_setup_reasons_dont_count() {
        let mut p = Profile::default();
        let t = 1_000_000_000;
        packs_in(&mut p, t, 25, "claim");
        packs_in(&mut p, t + HOUR_MS + 1, 25, "claim");
        assert!(p.flagged.is_none(), "an hour apart");
        packs_in(&mut p, t + HOUR_MS + 2, 50, "new account");
        packs_in(&mut p, t + HOUR_MS + 3, 50, "dev tools");
        packs_in(&mut p, t + HOUR_MS + 4, 50, "test");
        assert!(p.flagged.is_none());
        assert_eq!(p.packs_in.len(), 1, "only the last hour's counted intake is kept");
    }
}
