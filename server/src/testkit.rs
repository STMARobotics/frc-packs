//! Helpers for the API tests (server/tests): set up a player's holdings directly and look inside the table. Everything
//! that changes holdings goes through the same writes the game uses (with ledger lines, reason "test"), so the audit
//! still adds up after a test pokes at a player.

use serde_json::Value;
use uuid::Uuid;

use crate::db::{Cond, Db, Tx, from_item, get_n, get_s, item, key, n};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, CardRow, Day, PackRow, Profile, now_ms, upk};
use crate::retry;

const WHY: &str = "test";

/// The account behind a `sid=...` cookie.
pub async fn user_by_cookie(db: &Db, cookie: &str) -> Uuid {
    let token = cookie.strip_prefix("sid=").unwrap_or(cookie);
    let it = db.get(&crate::auth::session_pk(token), "SESSION").await.unwrap().expect("a session");
    Uuid::parse_str(&get_s(&it, "user_id").unwrap()).unwrap()
}

pub async fn user_by_name(db: &Db, name: &str) -> Uuid {
    crate::accounts::by_name(db, name).await.unwrap().expect("an account").id
}

/// An invite code for `uses` people, as shown (XXXX-XXXX-XXXX).
pub async fn invite(db: &Db, uses: i32) -> String {
    let code = crate::accounts::new_invite_code();
    crate::accounts::put_invite(db, &code, "", uses, None).await.unwrap();
    crate::accounts::show_code(&code)
}

/// Changes a player's profile (and anything else `f` adds) the way the game does: on their version.
pub async fn change(db: &Db, user: Uuid, f: impl Fn(&mut Profile, &mut Tx)) {
    let r: ApiResult<()> = retry!(async {
        let mut p = model::profile(db, user).await?.expect("a player");
        let parts = p.parts;
        let mut tx = Tx::new();
        f(&mut p, &mut tx);
        model::save_user(&mut tx, &mut p, parts, WHY);
        tx.commit(db).await.map_err(ApiError::from)
    });
    r.unwrap();
}

pub async fn make_admin(db: &Db, user: Uuid) {
    change(db, user, |p, _| p.is_admin = true).await;
}

pub async fn set_parts(db: &Db, user: Uuid, parts: i64) {
    change(db, user, |p, _| p.parts = parts).await;
}

pub async fn add_parts(db: &Db, user: Uuid, parts: i64) {
    change(db, user, |p, _| p.parts += parts).await;
}

/// Sets a player's sealed and boosted packs of a pack.
pub async fn set_packs(db: &Db, user: Uuid, pack: &str, sealed: i32, boosted: i32) {
    let before = model::pack_row(db, user, pack).await.unwrap();
    let after = PackRow { sealed, boosted, mythic: 0, ..before.clone() };
    change(db, user, move |_, tx| model::save_pack(tx, user, &before, &after, WHY)).await;
}

/// Gives a player this many more Mythic packs (boosted packs with three Mythics).
pub async fn set_mythic_packs(db: &Db, user: Uuid, pack: &str, mythic: i32) {
    let before = model::pack_row(db, user, pack).await.unwrap();
    let after = PackRow {
        sealed: before.sealed + mythic,
        boosted: before.boosted + mythic,
        mythic: before.mythic + mythic,
        ..before.clone()
    };
    change(db, user, move |_, tx| model::save_pack(tx, user, &before, &after, WHY)).await;
}

pub async fn add_sealed(db: &Db, user: Uuid, pack: &str, more: i32) {
    let before = model::pack_row(db, user, pack).await.unwrap();
    set_packs(db, user, pack, before.sealed + more, before.boosted).await;
}

/// Makes an account look this many hours old.
pub async fn age(db: &Db, user: Uuid, hours: i64) {
    change(db, user, |p, _| p.created_at = now_ms() - hours * 3_600_000).await;
}

/// Sets the streak as of `days_ago` days ago.
pub async fn set_streak(db: &Db, user: Uuid, streak: i32, days_ago: i64) {
    change(db, user, |p, _| {
        p.streak = streak;
        p.streak_day = Some(model::day_number() - days_ago);
    })
    .await;
}

/// Today's count of something toward the missions ("opened", "scrapped", ...).
pub async fn day_count(db: &Db, user: Uuid, what: &str) -> i64 {
    model::today(db, user).await.unwrap().counts.get(what).copied().unwrap_or(0)
}

/// Lots of progress on every mission kind today.
pub async fn finish_missions(db: &Db, user: Uuid) {
    let mut d: Day = model::today(db, user).await.unwrap();
    for k in ["opened", "scrapped", "traded", "new_teams", "rare_plus", "crafted", "claimed_packs"] {
        d.counts.insert(k.into(), 99);
    }
    change(db, user, move |_, tx| model::save_day(tx, user, &mut d.clone())).await;
}

/// Puts a pack in a player's hand with these cards (`[{num, tier}, ...]`).
pub async fn set_hand(db: &Db, user: Uuid, pack: &str, boosted: bool, cards: &Value) {
    let mut it = key(upk(user), format!("HAND#{pack}#{}", u8::from(boosted)));
    it.insert("cards".into(), crate::db::s(cards.to_string()));
    db.put(it).await.unwrap();
}

/// Gives a player a card with the team's next serial number, like a pack would. Returns the serial.
pub async fn give_card(db: &Db, user: Uuid, pack: &str, team: i32, tier: &str) -> i32 {
    give(db, user, pack, team, tier, None).await
}

/// Gives a player a card with a particular serial number (the team's counter is moved past it).
pub async fn give_card_serial(db: &Db, user: Uuid, pack: &str, team: i32, tier: &str, serial: i32) -> i32 {
    give(db, user, pack, team, tier, Some(serial)).await
}

async fn give(db: &Db, user: Uuid, pack: &str, team: i32, tier: &str, want: Option<i32>) -> i32 {
    let r: ApiResult<i32> = retry!(async {
        let mut p = model::profile(db, user).await?.expect("a player");
        let printed = model::printing(db, pack, team).await?;
        let serial = want.unwrap_or(printed.minted + 1);
        let id = db.ids("card", 1).await?;
        let mine = model::team_cards(db, user, pack, team).await?;
        let mut st = model::stats(db, user, pack).await?;
        let mut tx = Tx::new();
        let c = CardRow {
            id,
            pack: pack.into(),
            team,
            tier: tier.into(),
            serial,
            opening_id: None,
            slot: None,
            obtained: "pack".into(),
            created_at: now_ms(),
        };
        model::add_card(&mut tx, user, &c, WHY);
        let cond = if printed.minted == 0 { "attribute_not_exists(minted) OR minted = :m" } else { "minted = :m" };
        tx.update(
            "print",
            &format!("PRINT#{pack}#{team}"),
            "PRINT",
            Cond::new("SET minted = :new ADD live :one")
                .val(":new", n(printed.minted.max(serial)))
                .val(":one", n(1))
                .val(":m", n(printed.minted)),
            Some(cond),
        );
        if mine.is_empty() {
            model::stats_team_gained(&mut st, tier);
        }
        st.cards += 1;
        model::save_stats(&mut tx, user, pack, &st);
        let parts = p.parts;
        model::save_user(&mut tx, &mut p, parts, WHY);
        tx.commit(db).await.map_err(ApiError::from)?;
        Ok::<_, ApiError>(serial)
    });
    r.unwrap()
}

/// Takes away every copy of a team from a player (as if scrapped), keeping the ledger and stats right.
pub async fn remove_team(db: &Db, user: Uuid, pack: &str, team: i32) {
    let cards = model::team_cards(db, user, pack, team).await.unwrap();
    if cards.is_empty() {
        return;
    }
    let mut st = model::stats(db, user, pack).await.unwrap();
    st.cards -= cards.len() as i64;
    model::stats_team_lost(&mut st, &cards[0].tier);
    change(db, user, move |_, tx| {
        for c in &cards {
            model::remove_card(tx, user, c, WHY);
        }
        model::count_in_game(tx, pack, team, -(cards.len() as i64));
        model::save_stats(tx, user, pack, &st);
    })
    .await;
}

/// Who owns the cards of a team with this serial (more than one would be a duplicate).
pub async fn owners_of(db: &Db, pack: &str, team: i32, serial: i32) -> Vec<Uuid> {
    let mut out = Vec::new();
    for it in db.scan_all().await.unwrap() {
        if get_s(&it, "sk").is_some_and(|s| s.starts_with(&format!("CARD#{pack}#")))
            && get_n(&it, "team") == Some(i64::from(team))
            && get_n(&it, "serial") == Some(i64::from(serial))
        {
            let pk = get_s(&it, "pk").unwrap();
            out.push(Uuid::parse_str(pk.trim_start_matches("U#")).unwrap());
        }
    }
    out
}

pub async fn count_cards(db: &Db, user: Uuid, pack: &str, team: i32) -> i64 {
    model::team_cards(db, user, pack, team).await.unwrap().len() as i64
}

pub async fn all_cards(db: &Db, user: Uuid, pack: &str) -> Vec<CardRow> {
    model::cards(db, user, pack).await.unwrap()
}

pub async fn parts(db: &Db, user: Uuid) -> i64 {
    model::profile(db, user).await.unwrap().map_or(0, |p| p.parts)
}

pub async fn packs(db: &Db, user: Uuid, pack: &str) -> PackRow {
    model::pack_row(db, user, pack).await.unwrap()
}

pub async fn trade_status(db: &Db, id: i64) -> String {
    get_s(&db.get(&format!("TRADE#{id}"), "TRADE").await.unwrap().unwrap(), "status").unwrap()
}

pub async fn special_owner(db: &Db, id: i64) -> Uuid {
    Uuid::parse_str(&get_s(&db.get(&format!("SP#{id}"), "SPECIAL").await.unwrap().unwrap(), "owner").unwrap()).unwrap()
}

pub async fn exists(db: &Db, user: Uuid) -> bool {
    model::profile(db, user).await.unwrap().is_some()
}

/// The player's latest opening was of a boosted pack.
pub async fn last_opening_boosted(db: &Db, user: Uuid) -> bool {
    let it = db.query_desc(&upk(user), "OPEN#", 1).await.unwrap().pop().unwrap();
    from_item::<model::Opening>(it).unwrap().boosted
}

pub async fn free_serial(db: &Db, pack: &str, team: i32, serial: i32) -> bool {
    db.get(&format!("FREE#{pack}#{team}"), &crate::db::pad(i64::from(serial), 8)).await.unwrap().is_some()
}

pub async fn minted(db: &Db, pack: &str, teams: &[i32]) -> i64 {
    let mut total = 0;
    for t in teams {
        total += i64::from(model::printing(db, pack, *t).await.unwrap().minted);
    }
    total
}

/// Items in a player's partition whose sort key starts with `prefix` (e.g. "LED#", "OPEN#", "HAND#").
pub async fn count_items(db: &Db, user: Uuid, prefix: &str) -> usize {
    db.query(&upk(user), prefix).await.unwrap().len()
}

/// A raw write straight into the table, bypassing the game's rules: for proving the rules catch tampering.
pub async fn raw_put(db: &Db, pk: &str, sk: &str, v: &Value) {
    let mut it = item(pk, sk, v);
    it.extend(key(pk, sk));
    db.put(it).await.unwrap();
}
