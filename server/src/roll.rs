//! Rolling a pack. Pure functions over a random source, so the odds can be tested with a seeded generator.

use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::packs::{Odds, Pack, Tier};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rolled {
    pub num: i32,
    pub tier: Tier,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pity {
    /// Packs since the last Mythic.
    pub m: u32,
    /// Packs since the last Legendary or better.
    pub l: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Opts {
    pub demo: bool,
    /// The scripted first pack: its last card is Legendary or better.
    pub first: bool,
    pub pity: Pity,
    /// A boosted pack, crafted from parts: the recipe's boosted odds.
    pub boosted: bool,
    /// A Mythic pack: boosted, with its last three cards guaranteed Mythic.
    pub mythic: bool,
}

/// Chance the last card is a Mythic when this is the `n`th pack since the last one.
pub fn mythic_chance(odds: &Odds, demo: bool, n: u32) -> f64 {
    let mut p = if demo { odds.demo_mythic } else { odds.mythic_base };
    if n > odds.soft {
        p = p.max((f64::from(n - odds.soft) / f64::from(odds.hard - odds.soft)).min(1.0));
    }
    p
}

/// The rarity the last card is promised to reach with these options (the first pack, or a full meter), if any.
pub fn promised(odds: &Odds, o: &Opts) -> Option<Tier> {
    let mult = if o.boosted { odds.boosted.mythic_mult } else { 1.0 };
    if o.mythic || mythic_chance(odds, o.demo, o.pity.m + 1) * mult >= 1.0 {
        Some(Tier::Mythic)
    } else if o.first || o.pity.l + 1 >= odds.leg_every {
        Some(Tier::Legendary)
    } else {
        None
    }
}

/// These cards keep what these options promise. A pack picked up earlier was rolled with the meter as it was then; if
/// the meter has filled since (other packs were opened meanwhile), it's rolled again so the promise still holds.
pub fn keeps(odds: &Odds, o: &Opts, cards: &[Rolled]) -> bool {
    promised(odds, o).is_none_or(|t| best(cards).rank() <= t.rank())
}

fn weighted<R: Rng + ?Sized>(rng: &mut R, w: &HashMap<Tier, f64>) -> Tier {
    let r: f64 = rng.random();
    let mut sum = 0.0;
    let mut last = Tier::Common;
    for tier in Tier::ORDER.iter().rev() {
        if let Some(p) = w.get(tier) {
            sum += p;
            last = *tier;
            if r < sum {
                return *tier;
            }
        }
    }
    last
}

/// Five cards, sorted with the best last. No team appears twice in one pack.
pub fn roll<R: Rng + ?Sized>(pack: &Pack, rng: &mut R, o: &Opts) -> Vec<Rolled> {
    let mut cards = draw(pack, rng, o);
    sort_best_last(&mut cards);
    cards
}

/// The five cards in the order they're drawn: slots 1 to 4, then the last card.
fn draw<R: Rng + ?Sized>(pack: &Pack, rng: &mut R, o: &Opts) -> Vec<Rolled> {
    let odds = &pack.recipe.odds;
    let (pm, pl) = (o.pity.m + 1, o.pity.l + 1);
    let (slots, last, mult) = if o.boosted {
        (&odds.boosted.slots, &odds.boosted.last, odds.boosted.mythic_mult)
    } else {
        (&odds.slots, &odds.last, 1.0)
    };
    let mut cards: Vec<Rolled> = Vec::with_capacity(5);
    for slot in 0..5 {
        let tier = if o.mythic && slot >= 2 {
            Tier::Mythic
        } else if slot < 4 {
            weighted(rng, slots)
        } else if rng.random::<f64>() < (mythic_chance(odds, o.demo, pm) * mult).min(1.0) {
            Tier::Mythic
        } else if o.first || pl >= odds.leg_every {
            Tier::Legendary
        } else {
            weighted(rng, last) // demo luck only boosts Mythic
        };
        let pool = &pack.pools[&tier];
        let free: Vec<i32> = pool.iter().copied().filter(|n| !cards.iter().any(|c| c.num == *n)).collect();
        let from = if free.is_empty() { pool.as_slice() } else { free.as_slice() };
        let num = from[rng.random_range(0..from.len())];
        cards.push(Rolled { num, tier });
    }
    cards
}

pub fn sort_best_last(cards: &mut [Rolled]) {
    cards.sort_by_key(|c| std::cmp::Reverse(c.tier.rank()));
}

pub fn best(cards: &[Rolled]) -> Tier {
    cards.iter().map(|c| c.tier).min_by_key(|t| t.rank()).unwrap_or(Tier::Common)
}

/// Pity counters after opening these cards.
pub fn next_pity(p: Pity, cards: &[Rolled]) -> Pity {
    let has_m = cards.iter().any(|c| c.tier == Tier::Mythic);
    let has_l = has_m || cards.iter().any(|c| c.tier == Tier::Legendary);
    Pity { m: if has_m { 0 } else { p.m + 1 }, l: if has_l { 0 } else { p.l + 1 } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packs::Catalog;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use std::collections::HashSet;

    fn cmp26() -> Pack {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/packs");
        let mut c = Catalog::load(&dir).unwrap();
        let i = c.packs.iter().position(|p| p.id() == "cmp26").unwrap();
        c.packs.remove(i)
    }

    #[test]
    fn odds_over_200k_packs() {
        let pack = cmp26();
        let mut rng = StdRng::seed_from_u64(7);
        let n = 200_000;
        let (mut myth, mut leg_plus, mut dupes, mut last_ok) = (0, 0, 0, 0);
        for _ in 0..n {
            let c = roll(&pack, &mut rng, &Opts::default());
            let set: HashSet<i32> = c.iter().map(|x| x.num).collect();
            if set.len() != 5 {
                dupes += 1;
            }
            if c.iter().any(|x| x.tier == Tier::Mythic) {
                myth += 1;
            }
            if c.iter().any(|x| x.tier == Tier::Mythic || x.tier == Tier::Legendary) {
                leg_plus += 1;
            }
            if c[4].tier.rank() <= Tier::Rare.rank() {
                last_ok += 1;
            }
            for x in &c {
                assert_eq!(pack.team_tier[&x.num], x.tier, "card tier must match the team's tier");
            }
        }
        assert_eq!(dupes, 0, "no team twice in one pack");
        assert_eq!(last_ok, n, "last card is always Rare or better");
        // 1 in 400 without pity: 500 expected in 200k.
        assert!((380..=640).contains(&myth), "mythic packs {myth}");
        // Without the pity meter, Legendary+ is about 8.9% of packs (0.25% + 7% last slot + 2% from slots 1-4).
        let rate = f64::from(leg_plus) / f64::from(n);
        assert!((0.08..0.10).contains(&rate), "legendary+ rate {rate}");
    }

    #[test]
    fn mythic_packs_hold_three_different_mythics() {
        let pack = cmp26();
        let mut rng = StdRng::seed_from_u64(3);
        for _ in 0..2000 {
            let c = roll(&pack, &mut rng, &Opts { boosted: true, mythic: true, ..Default::default() });
            assert_eq!(c.len(), 5);
            let mythics: HashSet<i32> = c.iter().filter(|x| x.tier == Tier::Mythic).map(|x| x.num).collect();
            assert!(mythics.len() >= 3, "three different Mythics, got {mythics:?}");
            let all: HashSet<i32> = c.iter().map(|x| x.num).collect();
            assert_eq!(all.len(), 5, "no team twice");
        }
    }

    #[test]
    fn pity_guarantees() {
        let pack = cmp26();
        let mut rng = StdRng::seed_from_u64(1);
        for _ in 0..2000 {
            let c = roll(&pack, &mut rng, &Opts { pity: Pity { m: 199, l: 0 }, ..Default::default() });
            assert_eq!(c[4].tier, Tier::Mythic, "pack 200 is always a Mythic");
            let c = roll(&pack, &mut rng, &Opts { pity: Pity { m: 0, l: 19 }, ..Default::default() });
            assert!(c[4].tier.rank() <= Tier::Legendary.rank(), "20th dry pack is Legendary or better");
            let c = roll(&pack, &mut rng, &Opts { first: true, ..Default::default() });
            assert!(c[4].tier.rank() <= Tier::Legendary.rank(), "first pack ends in Legendary or better");
        }
        let o = &pack.recipe.odds;
        assert_eq!(mythic_chance(o, false, 10), 1.0 / 400.0);
        assert!((mythic_chance(o, false, 175) - 0.5).abs() < 1e-9);
        assert_eq!(mythic_chance(o, true, 10), 0.2);
    }

    #[test]
    fn boosted_packs_are_better() {
        let pack = cmp26();
        let mut rng = StdRng::seed_from_u64(11);
        let n = 100_000;
        let (mut myth, mut leg_plus, mut rare_plus_slots) = (0, 0, 0);
        for _ in 0..n {
            let c = roll(&pack, &mut rng, &Opts { boosted: true, ..Default::default() });
            assert!(c[4].tier.rank() <= Tier::Rare.rank(), "last card Rare or better");
            myth += i32::from(c.iter().any(|x| x.tier == Tier::Mythic));
            leg_plus += i32::from(c.iter().any(|x| x.tier.rank() <= Tier::Legendary.rank()));
            rare_plus_slots += c[..4].iter().filter(|x| x.tier.rank() <= Tier::Rare.rank()).count();
        }
        // Mythic 4x: 1 in 100, so about 1000 in 100k.
        assert!((850..=1150).contains(&myth), "boosted mythic packs {myth}");
        let rate = f64::from(leg_plus) / f64::from(n);
        assert!((0.50..0.60).contains(&rate), "boosted legendary+ rate {rate}");
        assert!(rare_plus_slots > n as usize, "more than one Rare+ in slots 1-4 per pack on average");
    }

    #[test]
    fn simulated_player_hits_pity_targets() {
        // A player opening packs with the meter: Legendary+ about 1 pack in 10, and never more than 20 apart.
        let pack = cmp26();
        let mut rng = StdRng::seed_from_u64(3);
        let mut p = Pity::default();
        let (mut leg, mut worst_gap, mut gap, mut worst_m) = (0, 0, 0, 0);
        for _ in 0..100_000 {
            let c = roll(&pack, &mut rng, &Opts { pity: p, ..Default::default() });
            p = next_pity(p, &c);
            gap = if p.l == 0 { 0 } else { gap + 1 };
            worst_gap = worst_gap.max(gap);
            worst_m = worst_m.max(p.m);
            if p.l == 0 {
                leg += 1;
            }
        }
        assert!(worst_gap < 20, "longest dry run {worst_gap}");
        assert!(worst_m < 200, "longest run without a Mythic {worst_m}");
        let rate = f64::from(leg) / 100_000.0;
        assert!((0.09..0.12).contains(&rate), "legendary+ rate with the meter {rate}");
    }

    #[test]
    fn a_full_meter_is_kept_by_a_pack_picked_up_earlier() {
        let pack = cmp26();
        let o = &pack.recipe.odds;
        let common = vec![Rolled { num: pack.pools[&Tier::Common][0], tier: Tier::Common }];
        let rare = vec![Rolled { num: pack.pools[&Tier::Rare][0], tier: Tier::Rare }];
        let leg = vec![Rolled { num: pack.pools[&Tier::Legendary][0], tier: Tier::Legendary }];
        let full_m = Opts { pity: Pity { m: o.hard - 1, l: 0 }, ..Default::default() };
        let full_l = Opts { pity: Pity { m: 0, l: o.leg_every - 1 }, ..Default::default() };
        assert_eq!(promised(o, &Opts::default()), None);
        assert!(keeps(o, &Opts::default(), &common));
        assert_eq!(promised(o, &full_m), Some(Tier::Mythic));
        assert!(!keeps(o, &full_m, &leg), "a full Mythic meter wants a Mythic");
        assert_eq!(promised(o, &full_l), Some(Tier::Legendary));
        assert!(!keeps(o, &full_l, &rare) && keeps(o, &full_l, &leg));
        assert_eq!(promised(o, &Opts { first: true, ..Default::default() }), Some(Tier::Legendary));
        // Boosted packs reach a certain Mythic sooner (4x): 175 + 50/4.
        let boosted = Opts { boosted: true, pity: Pity { m: 187, l: 0 }, ..Default::default() };
        assert_eq!(promised(o, &boosted), Some(Tier::Mythic));
        for _ in 0..500 {
            assert!(keeps(o, &full_m, &roll(&pack, &mut rand::rng(), &full_m)));
            assert!(keeps(o, &full_l, &roll(&pack, &mut rand::rng(), &full_l)));
            assert!(keeps(o, &boosted, &roll(&pack, &mut rand::rng(), &boosted)));
        }
    }

    /// Chi-square statistic of observed counts against expected probabilities (cells expecting nothing are skipped).
    fn chi2(obs: &[u64], p: &[f64]) -> (f64, usize) {
        let n: u64 = obs.iter().sum();
        let mut x = 0.0;
        let mut cells = 0;
        for (o, p) in obs.iter().zip(p) {
            if *p > 0.0 {
                let e = n as f64 * p;
                x += (*o as f64 - e).powi(2) / e;
                cells += 1;
            } else {
                assert_eq!(*o, 0, "a tier with no chance came up");
            }
        }
        (x, cells - 1)
    }

    /// How far a chi-square statistic is above what a fair source gives, in standard deviations (Wilson-Hilferty).
    fn chi2_z(x: f64, df: usize) -> f64 {
        let k = df as f64;
        ((x / k).cbrt() - (1.0 - 2.0 / (9.0 * k))) / (2.0 / (9.0 * k)).sqrt()
    }

    /// The minting factory, statistically, with the generator the server really uses (not a seeded one): a million
    /// packs. Each check fails a fair generator about once in 100,000 runs (4.3 standard deviations).
    /// `cargo test --release fairness -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn fairness_over_a_million_packs() {
        const Z: f64 = 4.3;
        let pack = cmp26();
        let o = &pack.recipe.odds;
        let n = 1_000_000usize;
        let mut rng = rand::rng();
        let mut slot = [0u64; 5];
        let mut last = [0u64; 5];
        let mut per_slot = [[0u64; 5]; 4];
        let mut team: HashMap<i32, u64> = HashMap::new();
        let mut good: Vec<bool> = Vec::with_capacity(n);
        let mut best_rank: Vec<f64> = Vec::with_capacity(n);
        for _ in 0..n {
            let c = draw(&pack, &mut rng, &Opts::default());
            for (i, x) in c[..4].iter().enumerate() {
                slot[x.tier.rank()] += 1;
                per_slot[i][x.tier.rank()] += 1;
            }
            last[c[4].tier.rank()] += 1;
            for x in &c {
                *team.entry(x.num).or_default() += 1;
            }
            let b = best(&c);
            good.push(b.rank() <= Tier::Legendary.rank());
            best_rank.push(b.rank() as f64);
        }
        let mut report = Vec::new();

        // 1. Slots 1-4 follow the recipe's slot odds, each slot on its own and together.
        let p_slot: Vec<f64> = Tier::ORDER.iter().map(|t| o.slots.get(t).copied().unwrap_or(0.0)).collect();
        let (x, df) = chi2(&slot, &p_slot);
        report.push(format!("slots 1-4 tiers (M,L,R,U,C) {slot:?}: chi2 {x:.2} on {df} df, z {:.2}", chi2_z(x, df)));
        assert!(chi2_z(x, df) < Z, "slot tiers off the recipe");
        for (i, s) in per_slot.iter().enumerate() {
            let (x, df) = chi2(s, &p_slot);
            assert!(chi2_z(x, df) < Z, "slot {} tiers off the recipe: {s:?}", i + 1);
        }

        // 2. The last card: Mythic at the base chance, else the recipe's last-card odds.
        let p_last: Vec<f64> = Tier::ORDER
            .iter()
            .map(|t| {
                if *t == Tier::Mythic {
                    o.mythic_base
                } else {
                    (1.0 - o.mythic_base) * o.last.get(t).copied().unwrap_or(0.0)
                }
            })
            .collect();
        let (x, df) = chi2(&last, &p_last);
        report.push(format!("last card tiers (M,L,R,U,C) {last:?}: chi2 {x:.2} on {df} df, z {:.2}", chi2_z(x, df)));
        assert!(chi2_z(x, df) < Z, "last card tiers off the recipe");

        // 3. Within a rarity, every team is equally likely.
        for tier in Tier::ORDER {
            let pool = &pack.pools[&tier];
            let obs: Vec<u64> = pool.iter().map(|t| team.get(t).copied().unwrap_or(0)).collect();
            let p = vec![1.0 / pool.len() as f64; pool.len()];
            let (x, df) = chi2(&obs, &p);
            let (lo, hi) = (obs.iter().min().unwrap(), obs.iter().max().unwrap());
            report.push(format!(
                "{} teams ({}): {lo}..{hi} each, chi2 {x:.1} on {df} df, z {:.2}",
                tier.as_str(),
                pool.len(),
                chi2_z(x, df)
            ));
            assert!(chi2_z(x, df) < Z, "{} teams not equally likely", tier.as_str());
        }

        // 4. Packs don't run in streaks: a runs test on "Legendary or better" from one pack to the next.
        let n1 = good.iter().filter(|g| **g).count() as f64;
        let n0 = n as f64 - n1;
        let runs = 1 + good.windows(2).filter(|w| w[0] != w[1]).count();
        let mean = 2.0 * n1 * n0 / (n1 + n0) + 1.0;
        let var = (mean - 1.0) * (mean - 2.0) / (n1 + n0 - 1.0);
        let z_runs = (runs as f64 - mean) / var.sqrt();
        report.push(format!("runs of Legendary+ packs: {runs} vs {mean:.0} expected, z {z_runs:.2}"));
        assert!(z_runs.abs() < Z, "Legendary+ packs come in streaks or alternate");

        // 5. One pack says nothing about the next: lag-1 to lag-5 correlation of each pack's best rarity.
        let m = best_rank.iter().sum::<f64>() / n as f64;
        let v = best_rank.iter().map(|x| (x - m).powi(2)).sum::<f64>();
        for lag in 1..=5 {
            let c = best_rank.windows(lag + 1).map(|w| (w[0] - m) * (w[lag] - m)).sum::<f64>() / v;
            let z = c * (n as f64).sqrt();
            report.push(format!("lag-{lag} correlation of best rarity: {c:+.5}, z {z:+.2}"));
            assert!(z.abs() < Z, "packs correlate at lag {lag}");
        }

        // 6. Mythics with the meter: a player opening standard packs back to back.
        let mut p = Pity::default();
        let (mut gaps, mut since) = (Vec::new(), 0u32);
        for _ in 0..n {
            let c = roll(&pack, &mut rng, &Opts { pity: p, ..Default::default() });
            p = next_pity(p, &c);
            since += 1;
            if p.m == 0 {
                gaps.push(since);
                since = 0;
            }
        }
        gaps.sort_unstable();
        let mean_gap = f64::from(gaps.iter().sum::<u32>()) / gaps.len() as f64;
        let share = |f: &dyn Fn(u32) -> bool| 100.0 * gaps.iter().filter(|g| f(**g)).count() as f64 / gaps.len() as f64;
        report.push(format!(
            "with the meter: a Mythic every {mean_gap:.1} packs on average; {:.1}% by pack 150 (luck), {:.1}% on 151-199 (the meter climbing), {:.1}% at 200; median {}, 10th-90th percentile {}-{}",
            share(&|g| g <= o.soft),
            share(&|g| g > o.soft && g < o.hard),
            share(&|g| g >= o.hard),
            gaps[gaps.len() / 2],
            gaps[gaps.len() / 10],
            gaps[gaps.len() * 9 / 10],
        ));
        assert!(*gaps.last().unwrap() <= o.hard, "never more than {} packs without a Mythic", o.hard);
        for line in report {
            println!("{line}");
        }
    }
}
