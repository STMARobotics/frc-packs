//! One-time announcements: a short note every existing player sees once, the next time they open the game. It goes in
//! the profile's notice, so it shows on whichever device they use next and is marked read like any other note. New
//! accounts start up to date and never see the old ones.

use uuid::Uuid;

use crate::Shared;
use crate::db::Tx;
use crate::error::{ApiError, ApiResult};
use crate::model;
use crate::retry;

/// Every announcement so far, oldest first. Add one at the end to tell everyone something once.
pub const NOTES: [&str; 1] = [
    // 2026-10-29: the Mythic meter changed (base 1/400 -> 1/250, climbing from pack 200 instead of 150, sure by 300).
    "The Mythic meter has changed. Every pack now has a 1 in 250 chance of a Mythic (it was 1 in 400), so more Mythics \
     come by pure luck. The meter starts helping after 200 packs and makes sure you get one by pack 300. Your count \
     carries over.",
];

/// How many announcements an account has seen (what a new account starts at).
pub const SEEN: i32 = NOTES.len() as i32;

/// Adds the announcements this player hasn't seen to their notice.
pub async fn ensure(st: &Shared, user: Uuid) -> ApiResult<()> {
    let db = &st.db;
    match model::profile(db, user).await? {
        Some(p) if p.announced < SEEN => {}
        _ => return Ok(()),
    }
    retry!(async {
        let Some(mut p) = model::profile(db, user).await? else { return Ok(()) };
        if p.announced >= SEEN {
            return Ok(());
        }
        let add = NOTES[p.announced.max(0) as usize..].join("\n\n");
        p.notice = Some(match p.notice.take() {
            Some(old) if !old.is_empty() => format!("{old}\n\n{add}"),
            _ => add,
        });
        p.announced = SEEN;
        let parts = p.parts;
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "announcement");
        tx.commit(db).await.map_err(ApiError::from)
    })
}
