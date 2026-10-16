//! Moving players' cards to new rarities after a pack recipe changes them (October 2026: only twelve teams stay Mythic).
//!
//! Each card keeps the rarity it had when it was pulled, so after the recipe changes, every player is brought up to
//! date once: their cards and per-pack stats take the recipe's rarities, packs in hand are rolled again, and anyone who
//! lost a Mythic gets parts and a note saying sorry. It happens the next time they open the game (and the admin can run
//! it for everyone from the panel). `Profile::retier` records that a player is done, and it is saved on the player's
//! version like every other change, so two requests at once can't both pay the parts.

use std::collections::HashSet;

use uuid::Uuid;

use crate::Shared;
use crate::db::{Cond, DbError, Tx, get_s, s};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, upk};
use crate::packs::Tier;
use crate::retry;

/// Bump this whenever a recipe changes a team's rarity, so everyone is brought up to date again.
pub const VERSION: i32 = 1;
/// Parts for each player who lost a Mythic in the change.
pub const COMPENSATION: i64 = 1000;
/// What those players see the next time they open the game.
pub const NOTICE: &str = "Mythics have changed: only 12 teams are Mythic now. Your former Mythic cards are Legendary, \
    and nothing else changed. Sorry about that! Here are 1,000 parts to make up for it.";

/// Card rarity updates per transaction (DynamoDB allows 100 items, and the last one also saves the player).
const BATCH: usize = 80;

/// Brings one player's cards up to the current recipes if they aren't yet. Returns true when they lost a Mythic (and
/// so got the parts and the note) in this call.
pub async fn ensure(st: &Shared, user: Uuid) -> ApiResult<bool> {
    let db = &st.db;
    let Some(p) = model::profile(db, user).await? else { return Ok(false) };
    if p.retier >= VERSION {
        return Ok(false);
    }
    // Cards whose stored rarity differs from the recipe; and whether any of them was a Mythic that no longer is.
    let mut stale: Vec<(String, String)> = Vec::new();
    let mut lost_mythic = false;
    let mut new_stats: Vec<(String, model::Stats)> = Vec::new();
    for pack in &st.catalog.packs {
        let cards = model::cards(db, user, pack.id()).await?;
        if cards.is_empty() {
            continue;
        }
        let mut teams: HashSet<i32> = HashSet::new();
        for c in &cards {
            teams.insert(c.team);
            let Some(now) = pack.team_tier.get(&c.team).map(|t| t.as_str()) else { continue };
            if c.tier != now {
                lost_mythic |= c.tier == Tier::Mythic.as_str();
                stale.push((model::card_sk(pack.id(), c.team, c.id), now.to_string()));
            }
        }
        let mut stats = model::stats(db, user, pack.id()).await?;
        let tier_of = |t: &i32| pack.team_tier.get(t).copied();
        stats.mythic_teams = teams.iter().filter(|t| tier_of(t) == Some(Tier::Mythic)).count() as i64;
        stats.legendary_teams = teams.iter().filter(|t| tier_of(t) == Some(Tier::Legendary)).count() as i64;
        new_stats.push((pack.id().to_string(), stats));
    }
    // The rarities themselves are safe to write more than once, so they go first, in batches.
    for chunk in stale.chunks(BATCH) {
        let mut tx = Tx::new();
        for (sk, tier) in chunk {
            tx.update(
                "",
                &upk(user),
                sk,
                Cond::new("SET tier = :t").val(":t", s(tier.clone())),
                Some("attribute_exists(pk)"),
            );
        }
        match tx.commit(db).await {
            // A card traded or scrapped meanwhile: the next pass picks up whatever is left.
            Ok(()) | Err(DbError::Conflict(_)) => {}
            Err(e) => return Err(e.into()),
        }
    }
    // Then the player: stats, packs in hand rolled again, and the parts and note, on their version.
    let hands: Vec<String> = db.query(&upk(user), "HAND#").await?.iter().filter_map(|it| get_s(it, "sk")).collect();
    let paid: ApiResult<bool> = retry!(async {
        let Some(mut p) = model::profile(db, user).await? else { return Ok(false) };
        if p.retier >= VERSION {
            return Ok(false);
        }
        let mut tx = Tx::new();
        for (pack, stats) in &new_stats {
            model::save_stats(&mut tx, user, pack, stats);
        }
        for sk in &hands {
            tx.delete_if("", &upk(user), sk, None);
        }
        let parts = p.parts;
        if lost_mythic {
            p.parts += COMPENSATION;
            p.notice = Some(NOTICE.to_string());
        }
        p.retier = VERSION;
        model::save_user(&mut tx, &mut p, parts, "mythic change");
        tx.commit(db).await.map(|_| lost_mythic).map_err(ApiError::from)
    });
    let paid = paid?;
    if paid {
        crate::push::notify(
            db,
            user,
            crate::push::Note {
                title: "Mythics have changed".into(),
                body: "Your former Mythics are Legendary now. Sorry! 1,000 parts are waiting for you.".into(),
                url: "/#binder".into(),
                tag: "mythic-change".into(),
            },
        )
        .await;
    }
    Ok(paid)
}

/// Brings every player up to date (from the admin panel). Returns (players checked, players compensated).
pub async fn ensure_all(st: &Shared) -> ApiResult<(i64, i64)> {
    let mut checked = 0;
    let mut paid = 0;
    let ids: Vec<Uuid> = st
        .db
        .index("gsi1", "USERS", None, false)
        .await?
        .into_iter()
        .filter_map(|it| get_s(&it, "id").and_then(|v| Uuid::parse_str(&v).ok()))
        .collect();
    for id in ids {
        checked += 1;
        if ensure(st, id).await? {
            paid += 1;
        }
    }
    Ok((checked, paid))
}
