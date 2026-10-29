//! Wagers on private Battler matches. Each player puts up a stake (parts, sealed packs, cards, special editions, or a
//! "pink slip": the robots in the deck they bring), both see both and accept, and then both stakes go into escrow: out
//! of the players' collections, so nothing staked can be spent, traded or scrapped during the match. When the match
//! ends the winner gets both stakes; a draw, or a match called off before anything was played, gives each their own
//! back. This is the FRC Packs side, the part that moves ownership; the Battler only says who won.
//!
//! Items: `BG#<game>` / `WAGER`: the stakes, who has accepted, what's in escrow, `ver`.

use std::collections::{HashMap, HashSet};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::held_cards;
use crate::db::{Cond, Db, DbError, Tx, item, n};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, CardRow, Profile, now_ms};

/// Special editions in escrow belong to nobody.
pub const ESCROW: Uuid = Uuid::nil();
/// Cards one stake can name (a pink slip adds its deck's robots on top).
pub const MAX_CARDS: usize = 20;

fn err(code: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Stake {
    #[serde(default)]
    pub parts: i64,
    /// Standard sealed packs.
    #[serde(default)]
    pub packs: i32,
    /// Boosted sealed packs (not Mythic packs).
    #[serde(default)]
    pub boosted: i32,
    /// Cards, by team: one copy per entry (a team listed twice is two copies).
    #[serde(default)]
    pub teams: Vec<i32>,
    #[serde(default)]
    pub specials: Vec<i64>,
    /// The robots in the deck this player brings to the match (one copy of each; Kept teams stay out).
    #[serde(default)]
    pub pink: bool,
}

impl Stake {
    /// Parts or packs in it: what a brand-new account can't stake or win, the same as in trades (so new accounts can't
    /// be used to pass goods along).
    pub fn has_goods(&self) -> bool {
        self.parts > 0 || self.packs > 0 || self.boosted > 0
    }

    pub fn is_empty(&self) -> bool {
        self.parts == 0
            && self.packs == 0
            && self.boosted == 0
            && self.teams.is_empty()
            && self.specials.is_empty()
            && !self.pink
    }
}

/// What actually went into escrow for one player: the exact cards, and the rest.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Held {
    #[serde(default)]
    pub parts: i64,
    #[serde(default)]
    pub packs: i32,
    #[serde(default)]
    pub boosted: i32,
    #[serde(default)]
    pub cards: Vec<CardRow>,
    #[serde(default)]
    pub specials: Vec<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Wager {
    pub game: String,
    pub stakes: [Stake; 2],
    pub accepted: [bool; 2],
    /// open (stakes on the table), locked (in escrow), settled (the winner has it all) or returned (each got theirs).
    pub status: String,
    #[serde(default)]
    pub held: [Held; 2],
    #[serde(default)]
    pub winner: Option<usize>,
    #[serde(default)]
    pub ver: i64,
}

impl Wager {
    pub fn new(game: &str) -> Wager {
        Wager { game: game.into(), status: "open".into(), ..Default::default() }
    }
}

fn pk(game: &str) -> String {
    format!("BG#{game}")
}

pub async fn load(db: &Db, game: &str) -> ApiResult<Option<Wager>> {
    Ok(db.get_as(&pk(game), "WAGER").await?)
}

/// Writes the wager in `tx`, on condition nobody changed it since it was read (label "wager_changed").
pub fn put(tx: &mut Tx, w: &mut Wager) {
    let cond = if w.ver == 0 { Cond::absent() } else { Cond::new("ver = :v").val(":v", n(w.ver)) };
    w.ver += 1;
    tx.put_if("wager_changed", item(pk(&w.game), "WAGER", &*w), Some(cond));
}

/// Cards a player can't stake: in a pack still being revealed, promised in an open trade, or a Kept team's.
async fn not_free(db: &Db, p: &Profile, pack: &str) -> ApiResult<(HashSet<i64>, HashSet<i32>)> {
    let held = held_cards(db, p).await?;
    let kept: HashSet<i32> = crate::profiles::favorites(db, p.id, pack).await?.into_iter().collect();
    Ok((held, kept))
}

pub fn too_new(p: &Profile) -> bool {
    p.created_at > now_ms() - crate::trades::NEW_ACCOUNT_HOURS * 3_600_000
}

/// Checks a stake against what the player has right now. A pink slip is checked when the wager locks (the deck is
/// known by then).
pub async fn check(db: &Db, pack: &str, p: &Profile, stake: &Stake) -> ApiResult<()> {
    if stake.is_empty() {
        return Ok(());
    }
    if stake.has_goods() && too_new(p) {
        return Err(err("too_new"));
    }
    if stake.parts < 0 || stake.packs < 0 || stake.boosted < 0 || stake.teams.len() > MAX_CARDS {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad_stake"));
    }
    let row = model::pack_row(db, p.id, pack).await?;
    if stake.parts > p.parts || stake.packs > row.standard() || stake.boosted > row.boosted - row.mythic {
        return Err(err("not_enough"));
    }
    let specials: HashSet<i64> = stake.specials.iter().copied().collect();
    if specials.len() != stake.specials.len()
        || crate::specials::owned_count(db, &stake.specials, p.id).await? != stake.specials.len()
    {
        return Err(err("not_owned"));
    }
    if !stake.teams.is_empty() {
        let (held, kept) = not_free(db, p, pack).await?;
        let mut want: HashMap<i32, usize> = HashMap::new();
        for t in &stake.teams {
            *want.entry(*t).or_default() += 1;
        }
        let cards = model::cards(db, p.id, pack).await?;
        for (team, n) in want {
            if kept.contains(&team) {
                return Err(err("kept_card"));
            }
            if cards.iter().filter(|c| c.team == team && !held.contains(&c.id)).count() < n {
                return Err(err("not_owned"));
            }
        }
    }
    Ok(())
}

/// The exact copies a stake takes: the newest free copy for each team listed (so a player keeps their earliest, lowest
/// serial longest), and for a pink slip one more of each robot in `deck` that isn't Kept.
pub async fn resolve(db: &Db, pack: &str, p: &Profile, stake: &Stake, deck: &[i32]) -> ApiResult<Held> {
    check(db, pack, p, stake).await?;
    let (held, kept) = not_free(db, p, pack).await?;
    let cards = model::cards(db, p.id, pack).await?;
    let mut teams = stake.teams.clone();
    if stake.pink {
        teams.extend(deck.iter().filter(|t| !kept.contains(t)));
    }
    let mut out: Vec<CardRow> = Vec::new();
    for team in teams {
        let pick = cards
            .iter()
            .rev()
            .find(|c| c.team == team && !held.contains(&c.id) && !out.iter().any(|o| o.id == c.id))
            .ok_or(err("not_owned"))?;
        out.push(pick.clone());
    }
    Ok(Held {
        parts: stake.parts,
        packs: stake.packs,
        boosted: stake.boosted,
        cards: out,
        specials: stake.specials.clone(),
    })
}

/// One player's collection being changed in a transaction: what's needed to keep their counts right.
struct Side {
    p: Profile,
    parts_before: i64,
    row_before: model::PackRow,
    row: model::PackRow,
    cards: Vec<CardRow>,
    stats: model::Stats,
}

async fn side(db: &Db, uid: Uuid, pack: &str) -> ApiResult<Side> {
    let p = crate::api::me(db, uid).await?;
    let row = model::pack_row(db, uid, pack).await?;
    Ok(Side {
        parts_before: p.parts,
        p,
        row_before: row.clone(),
        row,
        cards: model::cards(db, uid, pack).await?,
        stats: model::stats(db, uid, pack).await?,
    })
}

fn save_side(tx: &mut Tx, s: &mut Side, pack: &str, reason: &str) {
    model::save_pack(tx, s.p.id, &s.row_before, &s.row, reason);
    model::save_stats(tx, s.p.id, pack, &s.stats);
    let before = s.parts_before;
    model::save_user(tx, &mut s.p, before, reason);
}

/// Takes both stakes out of the players' collections into escrow, in `tx` (along with the wager and the game, written
/// by the caller). Fails the whole transaction if anything staked is gone.
pub async fn escrow(
    db: &Db,
    pack: &str,
    tx: &mut Tx,
    users: [Uuid; 2],
    held: &[Held; 2],
    reason: &str,
) -> ApiResult<()> {
    for (uid, h) in users.iter().zip(held) {
        let mut s = side(db, *uid, pack).await?;
        if h.parts > s.p.parts || h.packs > s.row.standard() || h.boosted > s.row.boosted - s.row.mythic {
            return Err(err("not_enough"));
        }
        for c in &h.cards {
            model::remove_card(tx, *uid, c, reason);
            s.cards.retain(|x| x.id != c.id);
            s.stats.cards -= 1;
            if !s.cards.iter().any(|x| x.team == c.team) {
                model::stats_team_lost(&mut s.stats, &c.tier);
            }
        }
        s.p.parts -= h.parts;
        s.row.sealed -= h.packs + h.boosted;
        s.row.boosted -= h.boosted;
        crate::specials::move_all(tx, &h.specials, *uid, ESCROW);
        save_side(tx, &mut s, pack, reason);
    }
    Ok(())
}

/// Gives what's in escrow out once the match is over: everything to `winner`, or (a draw, a match called off) each
/// stake back to its owner. Safe to call more than once: only a locked wager is paid out, and paying it out unlocks it
/// in the same write.
pub async fn settle(db: &Db, pack: &str, game: &str, users: [Uuid; 2], winner: Option<usize>) -> ApiResult<()> {
    for _ in 0..6 {
        let Some(mut w) = load(db, game).await?.filter(|w| w.status == "locked") else { return Ok(()) };
        let reason = format!("wager {game}");
        let now = now_ms();
        // Everything going to each player, so each player's records are written once.
        let mut gets: HashMap<Uuid, Held> = HashMap::new();
        for (from, h) in w.held.iter().enumerate() {
            let to = users[winner.unwrap_or(from)];
            let g = gets.entry(to).or_default();
            g.parts += h.parts;
            g.packs += h.packs;
            g.boosted += h.boosted;
            g.cards.extend(h.cards.iter().cloned());
            g.specials.extend(h.specials.iter().copied());
        }
        let mut tx = Tx::new();
        for (uid, g) in &gets {
            let mut s = side(db, *uid, pack).await?;
            for c in &g.cards {
                let had = s.cards.iter().any(|x| x.team == c.team);
                let got =
                    CardRow { opening_id: None, slot: None, obtained: "wager".into(), created_at: now, ..c.clone() };
                model::add_card(&mut tx, *uid, &got, &reason);
                s.cards.push(got);
                s.stats.cards += 1;
                if !had {
                    model::stats_team_gained(&mut s.stats, &c.tier);
                }
            }
            s.p.parts += g.parts;
            s.row.sealed += g.packs + g.boosted;
            s.row.boosted += g.boosted;
            crate::specials::move_all(&mut tx, &g.specials, ESCROW, *uid);
            save_side(&mut tx, &mut s, pack, &reason);
        }
        w.status = if winner.is_some() { "settled" } else { "returned" }.into();
        w.winner = winner;
        put(&mut tx, &mut w);
        match tx.commit(db).await {
            Ok(()) => return Ok(()),
            // Someone's collection changed while this was being put together (or it was paid out already): again.
            Err(DbError::Conflict(_)) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::busy())
}
