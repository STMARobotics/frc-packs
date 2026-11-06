//! Detect: looks over the whole game for what got past the rules, and ranks the players worth an admin's look. Run from
//! the admin panel (one table scan). Nothing here changes anything: it only reports, with the evidence for each finding.
//!
//! Every check is built not to false flag:
//! - **Supply** compares what each source paid against the most its rule can pay (not a statistical guess).
//! - **Luck** only scores openings that recorded their own odds and Mythics (the meter they were rolled with, and the
//!   rarities as they were then); older openings are counted but never scored.
//! - **Funnel**, **thrown wagers** and **pacing** are softer signals with low scores: reasons to look, not proof.
//! - **Integrity** is the ledger audit: holdings that don't match the ledger can't happen without a bug or tampering.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use uuid::Uuid;

use crate::api::Rules;
use crate::db::{Db, Item, from_item, get_n, get_s};
use crate::error::ApiResult;
use crate::model::{LedgerLine, Opening, PackRow, Profile, now_ms};
use crate::packs::{Pack, Tier};

const DAY_MS: i64 = 86_400_000;

#[derive(Serialize, Clone, Debug)]
pub struct Finding {
    /// supply, luck, funnel, wager, pacing, canary.
    pub check: &'static str,
    /// 0 to 100: how strongly this alone says "look at this player".
    pub score: u8,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Suspect {
    pub id: Uuid,
    pub username: Option<String>,
    pub score: u8,
    /// Already flagged, and why.
    pub flagged: Option<String>,
    /// The flag's own mode ("shadow" or "paused"), if it has one; otherwise it follows the settings.
    pub flag_mode: Option<String>,
    pub disabled: bool,
    pub findings: Vec<Finding>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub at: i64,
    pub players: usize,
    /// Highest score first. Players with no findings appear only if they're flagged.
    pub suspects: Vec<Suspect>,
    /// What the checks couldn't cover this run (e.g. no settings history yet for the timer).
    pub notes: Vec<String>,
}

/// Value in parts, to compare cards, packs and parts in one unit (a card is worth what it scraps for).
pub fn value(item: &str, tier: Option<Tier>, boost_cost: i64) -> i64 {
    match item {
        "parts" => 1,
        "packs" => boost_cost / 2,
        "boosted" => boost_cost,
        "card" => tier.map_or(5, |t| i64::from(t.scrap_parts())),
        _ => 0,
    }
}

/// P(X >= k) for X the number of successes in independent trials with these chances (Poisson binomial).
pub fn tail(ps: &[f64], k: usize) -> f64 {
    if k == 0 {
        return 1.0;
    }
    // dist[j] = P(exactly j successes so far), for j < k; everything at k or above is tracked as `over`.
    let mut dist = vec![0.0f64; k];
    dist[0] = 1.0;
    let mut over = 0.0f64;
    for &p in ps {
        let p = p.clamp(0.0, 1.0);
        over += dist[k - 1] * p;
        for j in (1..k).rev() {
            dist[j] = dist[j] * (1.0 - p) + dist[j - 1] * p;
        }
        dist[0] *= 1.0 - p;
    }
    over.clamp(0.0, 1.0)
}

/// The most a timer can have paid between `from` and `to` under these rule versions (at, rules), oldest first: every
/// timer that could have run out, plus a full bank carried in. Generous on purpose: rounding goes the player's way.
pub fn claim_ceiling(versions: &[(i64, Rules)], from: i64, to: i64) -> i64 {
    if versions.is_empty() || to <= from {
        return 0;
    }
    let mut total = 0f64;
    let carry = versions.iter().map(|(_, r)| i64::from(r.bank) * i64::from(r.claim_packs)).max().unwrap_or(0);
    for (i, (at, r)) in versions.iter().enumerate() {
        let start = (*at).max(from);
        let end = versions.get(i + 1).map_or(to, |(next, _)| *next).min(to);
        if end > start {
            total += (end - start) as f64 / r.claim_ms() as f64 * f64::from(r.claim_packs);
        }
    }
    total.ceil() as i64 + carry + 1
}

/// The most opens in any `window_ms`.
pub fn busiest(times: &mut [i64], window_ms: i64) -> usize {
    times.sort_unstable();
    let (mut best, mut lo) = (0, 0);
    for hi in 0..times.len() {
        while times[hi] - times[lo] > window_ms {
            lo += 1;
        }
        best = best.max(hi - lo + 1);
    }
    best
}

fn user_of(pk: &str) -> Option<Uuid> {
    pk.strip_prefix("U#").and_then(|v| Uuid::parse_str(v).ok())
}

fn team_of(detail: &Option<String>) -> Option<i32> {
    detail.as_deref()?.split(" #").next()?.trim().parse().ok()
}

fn fmt_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map_or(ms.to_string(), |d| d.format("%b %-d %H:%M UTC").to_string())
}

#[derive(Default)]
struct Player {
    p: Option<Profile>,
    lines: Vec<LedgerLine>,
    openings: Vec<Opening>,
    opened: i64,
    sets: Vec<i64>,
    feedback_rewards: i64,
    sessions: HashSet<String>,
    canaries: Vec<String>,
    findings: Vec<Finding>,
}

/// Runs every check over the whole table.
pub async fn scan(db: &Db, pack: &Pack, rules: &Rules, dev_tools: bool) -> ApiResult<Report> {
    let all = db.scan_all().await?;
    run(&all, pack, rules, dev_tools, now_ms())
}

/// The checks themselves, over a table's items (separate from the scan so they can be tested on made-up data).
pub fn run(all: &[Item], pack: &Pack, rules: &Rules, dev_tools: bool, now: i64) -> ApiResult<Report> {
    let mut players: HashMap<Uuid, Player> = HashMap::new();
    let mut history: Vec<(i64, Rules)> = Vec::new();
    let mut wagers: Vec<(crate::wagers::Wager, [Uuid; 2])> = Vec::new();
    let mut games: HashMap<String, [Uuid; 2]> = HashMap::new();
    let mut wager_items: Vec<crate::wagers::Wager> = Vec::new();
    // What each transfer moved, by its ledger reason ("trade <id>", "wager <game>"): cards, parts, packs (standard and
    // boosted). What its players received can't be more than this, whoever's account is still around.
    let mut moved: HashMap<String, (i64, i64, i64)> = HashMap::new();
    for it in all {
        let pk = get_s(it, "pk").unwrap_or_default();
        let sk = get_s(it, "sk").unwrap_or_default();
        if let Some(uid) = user_of(&pk) {
            let pl = players.entry(uid).or_default();
            if sk == "PROFILE" {
                pl.p = from_item::<Profile>(it.clone()).ok();
            } else if sk.starts_with("LED#") {
                if let Ok(l) = from_item::<LedgerLine>(it.clone()) {
                    pl.lines.push(l);
                }
            } else if sk.starts_with("OPEN#") {
                if let Ok(o) = from_item::<Opening>(it.clone()) {
                    pl.openings.push(o);
                }
            } else if sk.starts_with("PACK#") {
                if let Ok(r) = from_item::<PackRow>(it.clone()) {
                    pl.opened += i64::from(r.opened);
                }
            } else if sk.starts_with("SET#") {
                pl.sets.push(get_n(it, "completed_at").unwrap_or(0));
            }
        } else if sk == "SESSION" {
            if let (Some(u), Some(v)) =
                (get_s(it, "user_id").and_then(|v| Uuid::parse_str(&v).ok()), get_s(it, "visitor"))
            {
                players.entry(u).or_default().sessions.insert(v);
            }
        } else if pk == "AC#CANARY" {
            if let Some(u) = get_s(it, "user_id").and_then(|v| Uuid::parse_str(&v).ok()) {
                players.entry(u).or_default().canaries.push(get_s(it, "path").unwrap_or_default());
            }
        } else if pk == "SETTINGS" && sk.starts_with("HIST#") {
            if let (Some(at), Some(r)) =
                (get_n(it, "at"), get_s(it, "rules").and_then(|v| serde_json::from_str::<Rules>(&v).ok()))
            {
                history.push((at, r));
            }
        } else if pk.starts_with("FB#") && sk == "FB" {
            if get_n(it, "rewarded").is_some()
                && let Some(u) = get_s(it, "user_id").and_then(|v| Uuid::parse_str(&v).ok())
            {
                players.entry(u).or_default().feedback_rewards += 1;
            }
        } else if pk.starts_with("BG#") && sk == "GAME" {
            if let Some(g) =
                get_s(it, "state").and_then(|v| serde_json::from_str::<crate::battler::game::Game>(&v).ok())
                && let (Some(a), Some(b)) = (&g.seats[0], &g.seats[1])
            {
                games.insert(g.id.clone(), [a.uid, b.uid]);
            }
        } else if pk.starts_with("BG#") && sk == "WAGER" {
            if let Ok(w) = from_item::<crate::wagers::Wager>(it.clone()) {
                let held = w.held.iter().fold((0, 0, 0), |(c, p, k), h| {
                    (c + h.cards.len() as i64, p + h.parts, k + i64::from(h.packs + h.boosted))
                });
                moved.insert(format!("wager {}", w.game), held);
                wager_items.push(w);
            }
        } else if pk.starts_with("TRADE#") && sk == "TRADE" {
            if let Ok(t) = from_item::<crate::trades::Trade>(it.clone()) {
                moved.insert(
                    format!("trade {}", t.id),
                    (
                        (t.give.len() + t.want.len()) as i64,
                        i64::from(t.give_parts + t.want_parts),
                        i64::from(t.give_packs + t.want_packs + t.give_boosted + t.want_boosted),
                    ),
                );
            }
        }
    }
    for w in wager_items {
        if let Some(u) = games.get(&w.game) {
            let u = *u;
            wagers.push((w, u));
        }
    }
    history.sort_by_key(|(at, _)| *at);
    let mut notes = Vec::new();
    let tier_of = |team: Option<i32>| team.and_then(|t| pack.team_tier.get(&t).copied());
    let boost_cost = i64::from(rules.boost_cost);
    let min_cost = history.iter().map(|(_, r)| i64::from(r.boost_cost)).chain([boost_cost]).min().unwrap_or(1).max(1);

    // ---------- supply: each source against the most its rule can pay ----------
    let history_from = history.first().map(|(at, _)| *at);
    if history_from.is_none() {
        notes.push("Timer claims aren't checked yet: the settings have no saved history (it starts the next time the settings are saved in the admin panel).".into());
    }
    let max_level_parts =
        (pack.recipe.teams.len() as i64 / crate::missions::LEVEL_TEAMS) * i64::from(crate::missions::LEVEL_PARTS);
    let max_mission_day = crate::missions::max_daily_parts();
    for pl in players.values_mut() {
        let Some(p) = &pl.p else { continue };
        let days = ((now - p.created_at).max(0) / DAY_MS) + 1;
        let mut ev: Vec<String> = Vec::new();
        let sum = |reason: &dyn Fn(&str) -> bool, items: &[&str], positive: bool| -> i64 {
            pl.lines
                .iter()
                .filter(|l| reason(&l.reason) && items.contains(&l.item.as_str()) && (!positive || l.delta > 0))
                .map(|l| l.delta)
                .sum()
        };
        // Anything coming in from a source that has no business paying it.
        for l in &pl.lines {
            if l.delta <= 0 {
                continue;
            }
            let r = l.reason.as_str();
            let trade_like = r.starts_with("trade ") || r.starts_with("wager ");
            let setup = matches!(r, "test" | "dev tools") && dev_tools;
            let known = setup
                || trade_like
                || match l.item.as_str() {
                    "packs" | "boosted" => matches!(
                        r,
                        "claim" | "new account" | "craft" | "open" | "open, streak" | "feedback reward" | "admin gift"
                    ),
                    "parts" => matches!(r, "scrap" | "level" | "mission" | "rarity change"),
                    "card" => matches!(r, "open" | "open, streak"),
                    _ => true,
                };
            if !known {
                ev.push(format!("+{} {} from \"{r}\" ({}): no rule pays that", l.delta, l.item, fmt_time(l.at)));
            }
        }
        let start = sum(&|r| r == "new account", &["packs", "boosted"], true);
        if start > 50 {
            ev.push(format!("{start} starting packs (the most a new account can get is 50)"));
        }
        if let Some(from) = history_from {
            let claimed: i64 = pl
                .lines
                .iter()
                .filter(|l| {
                    l.reason == "claim" && l.delta > 0 && l.at >= from && matches!(l.item.as_str(), "packs" | "boosted")
                })
                .map(|l| l.delta)
                .sum();
            let ceiling = claim_ceiling(&history, from.max(p.created_at), now);
            if claimed > ceiling {
                ev.push(format!(
                    "{claimed} packs from the timer since {}, but the timer could pay at most {ceiling}",
                    fmt_time(from.max(p.created_at))
                ));
            }
        }
        let crafted = sum(&|r| r == "craft", &["boosted"], true);
        let spent = -sum(&|r| r == "craft", &["parts"], false);
        if crafted * min_cost > spent {
            ev.push(format!("{crafted} boosted packs crafted for {spent} parts (each costs at least {min_cost})"));
        }
        let open_net = sum(&|r| r == "open" || r == "open, streak", &["packs", "boosted"], false);
        let bonus = open_net + pl.opened;
        let allowed = pl.sets.len() as i64 + days / i64::from(crate::missions::STREAK_REWARD_EVERY) + 1;
        if bonus > allowed {
            ev.push(format!("{bonus} bonus packs from opening (division sets and streaks allow {allowed})"));
        }
        let from_open = sum(&|r| r == "open" || r == "open, streak", &["card"], true);
        if from_open > 5 * pl.opened {
            ev.push(format!("{from_open} cards from {} packs opened (5 each)", pl.opened));
        }
        let fb = sum(&|r| r == "feedback reward", &["packs", "boosted"], true);
        let fb_max = pl.feedback_rewards * i64::from(crate::feedback::REWARD_PACKS);
        if fb > fb_max {
            ev.push(format!("{fb} packs from feedback rewards, for {} accepted reports", pl.feedback_rewards));
        }
        let level = sum(&|r| r == "level", &["parts"], true);
        if level > max_level_parts {
            ev.push(format!("{level} parts from collector levels (the most there is: {max_level_parts})"));
        }
        let missions = sum(&|r| r == "mission", &["parts"], true);
        if missions > days * max_mission_day {
            ev.push(format!("{missions} parts from missions in {days} days (at most {max_mission_day} a day)"));
        }
        let scrapped = -sum(&|r| r == "scrap", &["card"], false);
        let scrap_parts = sum(&|r| r == "scrap", &["parts"], true);
        let scrap_max = scrapped * i64::from(Tier::Legendary.scrap_parts());
        if scrap_parts > scrap_max {
            ev.push(format!("{scrap_parts} parts from scrapping {scrapped} cards (at most {scrap_max})"));
        }
        if !ev.is_empty() {
            pl.findings.push(Finding { check: "supply", score: 90, evidence: ev });
        }
    }

    // Trades and wagers only move things: per trade or match, its players can't receive more than its record says it
    // moved (a trade can also add one pack per division set it finishes). This holds even when one side's account was
    // deleted later (and its ledger with it). A transfer with no record left falls back to its ledger lines summing to
    // nothing, which is only checked while every player in it still exists.
    let mut by_transfer: HashMap<String, Vec<(Uuid, LedgerLine)>> = HashMap::new();
    for (uid, pl) in &players {
        for l in &pl.lines {
            if l.reason.starts_with("trade ") || l.reason.starts_with("wager ") {
                by_transfer.entry(l.reason.clone()).or_default().push((*uid, l.clone()));
            }
        }
    }
    let mut unchecked = 0;
    for (reason, lines) in &by_transfer {
        let received = |items: &[&str]| -> i64 {
            lines.iter().filter(|(_, l)| l.delta > 0 && items.contains(&l.item.as_str())).map(|(_, l)| l.delta).sum()
        };
        let net = |items: &[&str]| -> i64 {
            lines.iter().filter(|(_, l)| items.contains(&l.item.as_str())).map(|(_, l)| l.delta).sum()
        };
        let users: HashSet<Uuid> = lines.iter().map(|(u, _)| *u).collect();
        let (lo, hi) = lines.iter().fold((i64::MAX, i64::MIN), |(a, b), (_, l)| (a.min(l.at), b.max(l.at)));
        let sets_then = users
            .iter()
            .filter_map(|u| players.get(u))
            .flat_map(|pl| pl.sets.iter())
            .filter(|t| **t >= lo - 10_000 && **t <= hi + 10_000)
            .count() as i64;
        let set_packs = if reason.starts_with("trade ") { sets_then } else { 0 };
        let mut ev = Vec::new();
        if let Some(&(cards, parts, packs)) = moved.get(reason) {
            let (got_c, got_p, got_k) = (received(&["card"]), received(&["parts"]), received(&["packs", "boosted"]));
            if got_c > cards {
                ev.push(format!("\"{reason}\" gave out {got_c} cards, but only {cards} went into it"));
            }
            if got_p > parts {
                ev.push(format!("\"{reason}\" gave out {got_p} parts, but only {parts} went into it"));
            }
            if got_k > packs + set_packs {
                ev.push(format!("\"{reason}\" gave out {got_k} packs, but only {} went into it", packs + set_packs));
            }
        } else if users.iter().all(|u| players.get(u).is_some_and(|pl| pl.p.is_some())) {
            if net(&["packs", "boosted"]) > set_packs {
                ev.push(format!("\"{reason}\" made {} packs out of nothing", net(&["packs", "boosted"])));
            }
            for item in ["parts", "card"] {
                let t = net(&[item]);
                if t > 0 {
                    ev.push(format!("\"{reason}\" made {t} {item} out of nothing"));
                }
            }
        } else {
            unchecked += 1;
        }
        if !ev.is_empty() {
            for (u, l) in lines {
                if l.delta > 0
                    && let Some(pl) = players.get_mut(u)
                {
                    pl.findings.push(Finding { check: "supply", score: 95, evidence: ev.clone() });
                }
            }
        }
    }
    if unchecked > 0 {
        notes.push(format!(
            "{unchecked} old trades or matches weren't checked: their record is gone and a player in them has deleted their account."
        ));
    }

    // ---------- luck: Mythics against each opening's real odds ----------
    let odds = &pack.recipe.odds;
    for pl in players.values_mut() {
        // Demo luck (dev tools only) rolls Mythics far more often on purpose: not something to score.
        if dev_tools && pl.p.as_ref().is_some_and(|p| p.demo) {
            continue;
        }
        let recorded: Vec<&Opening> =
            pl.openings.iter().filter(|o| o.mythics.is_some() && o.pity_m.is_some()).collect();
        if recorded.is_empty() {
            continue;
        }
        let ps: Vec<f64> = recorded
            .iter()
            .map(|o| {
                let base = crate::roll::mythic_chance(odds, false, o.pity_m.unwrap_or(0).max(0) as u32 + 1);
                let mult = if o.boosted { odds.boosted.mythic_mult } else { 1.0 };
                (base * mult).min(1.0)
            })
            .collect();
        let got = recorded.iter().filter(|o| o.mythics.unwrap_or(0) > 0).count();
        let expected: f64 = ps.iter().sum();
        let p = tail(&ps, got);
        let score = if got >= 2 && p < 1e-7 {
            95
        } else if got >= 2 && p < 1e-5 {
            80
        } else {
            0
        };
        if score > 0 {
            pl.findings.push(Finding {
                check: "luck",
                score,
                evidence: vec![format!(
                    "{got} packs with a Mythic out of {} (about {expected:.1} expected with their odds): chance {p:.1e}",
                    recorded.len()
                )],
            });
        }
    }

    // ---------- funnel: value moving one way between two players, last 7 days ----------
    let since = now - 7 * DAY_MS;
    let mut flow: HashMap<(Uuid, Uuid), i64> = HashMap::new();
    for lines in by_transfer.values() {
        let recent: Vec<&(Uuid, LedgerLine)> = lines.iter().filter(|(_, l)| l.at >= since).collect();
        let users: Vec<Uuid> = recent.iter().map(|(u, _)| *u).collect::<HashSet<_>>().into_iter().collect();
        if users.len() != 2 {
            continue;
        }
        for (u, l) in &recent {
            if l.delta <= 0 {
                continue;
            }
            let from = if *u == users[0] { users[1] } else { users[0] };
            *flow.entry((from, *u)).or_default() += l.delta * value(&l.item, tier_of(team_of(&l.detail)), boost_cost);
        }
    }
    let linked = |a: &Player, b: &Player| -> Option<String> {
        let (pa, pb) = (a.p.as_ref()?, b.p.as_ref()?);
        let real = |v: &str| v != "direct" && !v.is_empty();
        if let (Some(x), Some(y)) = (&pa.signup_visitor, &pb.signup_visitor)
            && real(x)
            && x == y
        {
            return Some("signed up from the same address".into());
        }
        if a.sessions.iter().any(|v| real(v) && b.sessions.contains(v)) {
            return Some("signed in from the same address".into());
        }
        None
    };
    let mut seen: HashSet<(Uuid, Uuid)> = HashSet::new();
    let pairs: Vec<((Uuid, Uuid), i64)> = flow.iter().map(|(k, v)| (*k, *v)).collect();
    for ((from, to), v) in pairs {
        if !seen.insert((from.min(to), from.max(to))) {
            continue;
        }
        let back = flow.get(&(to, from)).copied().unwrap_or(0);
        let (giver, taker, net) = if v >= back { (from, to, v - back) } else { (to, from, back - v) };
        let link = match (players.get(&giver), players.get(&taker)) {
            (Some(a), Some(b)) => linked(a, b),
            _ => None,
        };
        let score = if link.is_some() && net > 2_000 {
            70
        } else if net > 20_000 {
            50
        } else {
            0
        };
        if score > 0 {
            let name = |u: Uuid| {
                players.get(&u).and_then(|p| p.p.as_ref()).and_then(|p| p.username.clone()).unwrap_or_default()
            };
            let mut ev =
                vec![format!("took in {net} parts' worth more from {} than they gave back, in 7 days", name(giver))];
            if let Some(l) = &link {
                ev.push(format!("{} and {}: {l}", name(giver), name(taker)));
            }
            if let Some(pl) = players.get_mut(&taker) {
                pl.findings.push(Finding { check: "funnel", score, evidence: ev });
            }
        }
    }

    // ---------- thrown wagers: goods staked, then a forfeit or timeout within two minutes ----------
    let mut thrown: HashMap<(Uuid, Uuid), Vec<String>> = HashMap::new();
    for (w, users) in &wagers {
        let (Some(locked), Some(done), Some(ended), Some(winner)) = (w.locked_at, w.finished_at, &w.ended, w.winner)
        else {
            continue;
        };
        if !matches!(ended.as_str(), "forfeit" | "timeout") || done - locked > 120_000 {
            continue;
        }
        let lost = &w.held[1 - winner];
        let worth = lost.parts
            + i64::from(lost.packs) * value("packs", None, boost_cost)
            + i64::from(lost.boosted) * value("boosted", None, boost_cost)
            + lost.cards.iter().map(|c| value("card", Tier::parse(&c.tier), boost_cost)).sum::<i64>();
        if worth >= 1_000 {
            thrown.entry((users[1 - winner], users[winner])).or_default().push(format!(
                "match {}: {ended} {}s after the stakes locked, {worth} parts' worth handed over",
                w.game,
                (done - locked) / 1000
            ));
        }
    }
    for ((loser, winner), ev) in thrown {
        let score = if ev.len() >= 3 { 70 } else { 60 };
        if let Some(pl) = players.get_mut(&winner) {
            pl.findings.push(Finding { check: "wager", score, evidence: ev.clone() });
        }
        if let Some(pl) = players.get_mut(&loser) {
            pl.findings.push(Finding { check: "wager", score: score - 20, evidence: ev });
        }
    }

    // ---------- pacing: more packs a minute than a person opens ----------
    for pl in players.values_mut() {
        let mut times: Vec<i64> = pl.openings.iter().map(|o| o.opened_at).collect();
        let most = busiest(&mut times, 60_000);
        if most > 30 {
            pl.findings.push(Finding {
                check: "pacing",
                score: 30,
                evidence: vec![format!("{most} packs opened within one minute")],
            });
        }
    }

    // ---------- canaries: calls to endpoints the app no longer makes ----------
    for pl in players.values_mut() {
        if pl.canaries.is_empty() {
            continue;
        }
        let mut by: HashMap<&str, usize> = HashMap::new();
        for c in &pl.canaries {
            *by.entry(c.as_str()).or_default() += 1;
        }
        let mut ev: Vec<String> = by.iter().map(|(p, k)| format!("called {p} {k} times")).collect();
        ev.sort();
        ev.push("The app doesn't call these any more: a script, or an app left open since before the update.".into());
        pl.findings.push(Finding {
            check: "canary",
            score: if pl.canaries.len() >= 10 { 45 } else { 25 },
            evidence: ev,
        });
    }

    // ---------- the report ----------
    let total = players.values().filter(|p| p.p.is_some()).count();
    let mut suspects: Vec<Suspect> = players
        .into_iter()
        .filter_map(|(id, pl)| {
            let p = pl.p?;
            if pl.findings.is_empty() && p.flagged.is_none() {
                return None;
            }
            let top = pl.findings.iter().map(|f| f.score).max().unwrap_or(0);
            let extra = pl.findings.len().saturating_sub(1) as u8 * 10;
            Some(Suspect {
                id,
                username: p.username.clone(),
                score: top.saturating_add(extra).min(100),
                flagged: p.flagged.clone(),
                flag_mode: p.flag_mode.clone(),
                disabled: p.disabled,
                findings: pl.findings,
            })
        })
        .collect();
    suspects.sort_by(|a, b| b.score.cmp(&a.score).then(a.username.cmp(&b.username)));
    Ok(Report { at: now, players: total, suspects, notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poisson_binomial_tail() {
        assert!((tail(&[0.5, 0.5], 1) - 0.75).abs() < 1e-12);
        assert!((tail(&[0.5, 0.5], 2) - 0.25).abs() < 1e-12);
        assert_eq!(tail(&[0.1; 10], 0), 1.0);
        // 6 Mythics in 55 packs at 1 in 250: about 1 in 10 million, well past the luck check's line.
        let p = tail(&[0.004; 55], 6);
        assert!(p < 1e-6 && p > 1e-8, "{p}");
        // 2 in 7 boosted packs at 1.6%: about 1 in 200, not suspicious.
        let p = tail(&[0.016; 7], 2);
        assert!((0.003..0.008).contains(&p), "{p}");
    }

    #[test]
    fn the_timer_ceiling_is_generous() {
        let r = Rules::default(); // a pack every 2 hours, 2 banked
        let day = claim_ceiling(&[(0, r.clone())], 0, DAY_MS);
        assert!(day >= 12 + 2, "a day of timers plus the bank: {day}");
        assert!(day <= 16);
        let faster = Rules { claim_minutes: 60, ..r.clone() };
        let mixed = claim_ceiling(&[(0, r), (DAY_MS / 2, faster)], 0, DAY_MS);
        assert!(mixed >= 6 + 12, "half a day at each speed: {mixed}");
    }

    fn line(at: i64, item: &str, delta: i64, detail: &str, reason: &str) -> LedgerLine {
        LedgerLine { at, item: item.into(), delta, detail: Some(detail.into()), reason: reason.into() }
    }

    /// A won wager: the winner's ledger, a wager record holding `staked` cards, and (unless deleted) the loser's.
    fn wager_table(staked: usize, paid: i64, loser_deleted: bool) -> (Vec<Item>, Uuid) {
        use crate::db::item;
        let (win, lose) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let mut all = Vec::new();
        for (u, name) in [(win, "winner"), (lose, "loser")] {
            if u == lose && loser_deleted {
                continue;
            }
            let p = Profile { id: u, username: Some(name.into()), created_at: 0, ..Default::default() };
            all.push(item(crate::model::upk(u), "PROFILE", &p));
        }
        let card = |i: usize| crate::model::CardRow {
            id: i as i64,
            pack: "cmp26".into(),
            team: 100 + i as i32,
            tier: "common".into(),
            serial: 1,
            opening_id: None,
            slot: None,
            obtained: "pack".into(),
            created_at: 0,
        };
        let mut w = crate::wagers::Wager::new("g1");
        w.held[1].cards = (0..staked).map(card).collect();
        w.status = "settled".into();
        w.winner = Some(0);
        all.push(item("BG#g1", "WAGER", &w));
        for i in 0..paid {
            all.push(item(
                crate::model::upk(win),
                format!("LED#{i}"),
                &line(1, "card", 1, &format!("{} #1", 100 + i), "wager g1"),
            ));
        }
        if !loser_deleted {
            for i in 0..staked {
                all.push(item(
                    crate::model::upk(lose),
                    format!("LED#{i}"),
                    &line(0, "card", -1, &format!("{} #1", 100 + i), "wager g1"),
                ));
            }
        }
        (all, win)
    }

    #[test]
    fn a_wager_is_checked_against_its_record() {
        let pack = {
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/packs");
            let mut c = crate::packs::Catalog::load(&dir).unwrap();
            c.packs.remove(c.packs.iter().position(|p| p.id() == "cmp26").unwrap())
        };
        let rules = Rules::default();
        let supply = |all: &[Item], u: Uuid| {
            let r = run(all, &pack, &rules, false, DAY_MS).unwrap();
            r.suspects
                .iter()
                .find(|s| s.id == u)
                .map(|s| s.findings.iter().any(|f| f.check == "supply"))
                .unwrap_or(false)
        };
        let (all, win) = wager_table(1, 1, false);
        assert!(!supply(&all, win), "a fair wager");
        let (all, win) = wager_table(1, 1, true);
        assert!(!supply(&all, win), "the loser deleting their account later doesn't make it look like a dupe");
        let (all, win) = wager_table(1, 2, true);
        assert!(supply(&all, win), "paying out more than went in is caught, even with the loser gone");
        let (all, win) = wager_table(1, 2, false);
        assert!(supply(&all, win), "and with both still here");
    }

    #[test]
    fn busiest_minute() {
        let mut t: Vec<i64> = (0..40).map(|i| i * 1_000).collect();
        assert_eq!(busiest(&mut t, 60_000), 40);
        let mut t: Vec<i64> = (0..40).map(|i| i * 10_000).collect();
        assert_eq!(busiest(&mut t, 60_000), 7);
    }
}
