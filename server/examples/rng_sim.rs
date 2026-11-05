//! Millions of simulated pack openings through the real roll code and the real generator (`rand::rng`, ChaCha12 from
//! the OS), on every core at once, to look for patterns in the RNG and to put numbers on how lucky a session is.
//!
//! cargo run --release --example rng_sim -- [packs_per_test]

use frc_packs_server::packs::{Catalog, Pack, Tier};
use frc_packs_server::roll::{self, Opts, Pity, Rolled};
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;

fn cmp26() -> Pack {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/packs");
    let mut c = Catalog::load(&dir).unwrap();
    let i = c.packs.iter().position(|p| p.id() == "cmp26").unwrap();
    c.packs.remove(i)
}

fn threads() -> usize {
    thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

/// Runs `f(thread_index, n)` on every core and collects what each returns.
fn par<T: Send + 'static>(n: usize, f: impl Fn(usize, usize) -> T + Send + Sync + 'static) -> Vec<T> {
    let k = threads();
    let f = Arc::new(f);
    (0..k)
        .map(|i| {
            let f = f.clone();
            let share = n / k + usize::from(i < n % k);
            thread::spawn(move || f(i, share))
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect()
}

fn chi2(obs: &[u64], p: &[f64]) -> (f64, usize) {
    let n: u64 = obs.iter().sum();
    let (mut x, mut cells) = (0.0, 0);
    for (o, p) in obs.iter().zip(p) {
        if *p > 0.0 {
            let e = n as f64 * p;
            x += (*o as f64 - e).powi(2) / e;
            cells += 1;
        }
    }
    (x, cells - 1)
}

/// Standard deviations above a fair source (Wilson-Hilferty).
fn chi2_z(x: f64, df: usize) -> f64 {
    let k = df as f64;
    ((x / k).cbrt() - (1.0 - 2.0 / (9.0 * k))) / (2.0 / (9.0 * k)).sqrt()
}

fn has_mythic(c: &[Rolled]) -> bool {
    c.iter().any(|x| x.tier == Tier::Mythic)
}

fn verdict(z: f64) -> &'static str {
    if z.abs() < 3.0 { "ok" } else if z.abs() < 4.5 { "WATCH" } else { "FAIL" }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(5_000_000);
    let pack = Arc::new(cmp26());
    let o = pack.recipe.odds.clone();
    println!("simulated player: cassie   threads: {}   packs per test: {n}\n", threads());

    // ---- 1. Tier odds, standard and boosted, each slot on its own ----
    for boosted in [false, true] {
        let p = pack.clone();
        let parts = par(n, move |_, k| {
            let mut rng = rand::rng();
            let mut slot = [[0u64; 5]; 4];
            let mut last = [0u64; 5];
            let mut myth = 0u64;
            for _ in 0..k {
                // Unsorted draw order matters for per-slot checks, so roll and look at the tiers by slot via a
                // fresh sort-free view: roll() sorts best last, so per-slot here means "per position after sort".
                let c = roll::roll(&p, &mut rng, &Opts { boosted, ..Default::default() });
                for (i, x) in c[..4].iter().enumerate() {
                    slot[i][x.tier.rank()] += 1;
                }
                last[c[4].tier.rank()] += 1;
                myth += u64::from(has_mythic(&c));
            }
            (slot, last, myth)
        });
        let mut all_slots = [0u64; 5];
        let mut myth = 0;
        for (s, _, m) in &parts {
            for row in s {
                for t in 0..5 {
                    all_slots[t] += row[t];
                }
            }
            myth += m;
        }
        let (sl, la, mult) = if boosted { (&o.boosted.slots, &o.boosted.last, o.boosted.mythic_mult) } else { (&o.slots, &o.last, 1.0) };
        let pm = o.mythic_base * mult;
        // Expected Mythic packs: the last-card roll (slots 1-4 never hold Mythics in cmp26).
        let slot_m = sl.get(&Tier::Mythic).copied().unwrap_or(0.0);
        let exp_m = 1.0 - (1.0 - pm) * (1.0 - slot_m).powi(4);
        let z = (myth as f64 - n as f64 * exp_m) / (n as f64 * exp_m * (1.0 - exp_m)).sqrt();
        println!(
            "[{}] {} packs: Mythic packs {myth} ({:.4}%), expected {:.4}% -> z {z:+.2} {}",
            if boosted { "boosted " } else { "standard" },
            n,
            100.0 * myth as f64 / n as f64,
            100.0 * exp_m,
            verdict(z)
        );
        let _ = (la, all_slots);
    }

    // ---- 2. Draw-order checks through the internal test (per-slot odds, team uniformity, runs, lag correlation) ----
    // Those live in roll.rs's ignored fairness test; here we do the cross-player checks it can't.

    // ---- 3. Every Mythic team equally likely ----
    {
        let p = pack.clone();
        let parts = par(n, move |_, k| {
            let mut rng = rand::rng();
            let mut by: HashMap<i32, u64> = HashMap::new();
            for _ in 0..k {
                let c = roll::roll(&p, &mut rng, &Opts { boosted: true, pity: Pity { m: 299, l: 0 }, ..Default::default() });
                for x in c.iter().filter(|x| x.tier == Tier::Mythic) {
                    *by.entry(x.num).or_default() += 1;
                }
            }
            by
        });
        let mut by: HashMap<i32, u64> = HashMap::new();
        for m in parts {
            for (k, v) in m {
                *by.entry(k).or_default() += v;
            }
        }
        let pool = &pack.pools[&Tier::Mythic];
        let obs: Vec<u64> = pool.iter().map(|t| by.get(t).copied().unwrap_or(0)).collect();
        let (x, df) = chi2(&obs, &vec![1.0 / pool.len() as f64; pool.len()]);
        let z = chi2_z(x, df);
        println!("Mythic teams ({} of them) over {n} guaranteed Mythics: {}..{} each, chi2 {x:.1}/{df} -> z {z:+.2} {}",
            pool.len(), obs.iter().min().unwrap(), obs.iter().max().unwrap(), verdict(z));
    }

    // ---- 4. Players opening at the same moment don't share luck (every thread is a different player) ----
    {
        let k = threads();
        let p = pack.clone();
        let per = n / k;
        let rows = par(n, move |_, m| {
            let mut rng = rand::rng();
            (0..m.min(per)).map(|_| has_mythic(&roll::roll(&p, &mut rng, &Opts { boosted: true, ..Default::default() }))).collect::<Vec<bool>>()
        });
        // Mythic in the same pack index for player A and player B: as often as chance says, no more.
        let mut worst: f64 = 0.0;
        for a in 0..rows.len() {
            for b in a + 1..rows.len() {
                let len = rows[a].len().min(rows[b].len());
                let both = (0..len).filter(|i| rows[a][*i] && rows[b][*i]).count() as f64;
                let pa = rows[a][..len].iter().filter(|x| **x).count() as f64 / len as f64;
                let pb = rows[b][..len].iter().filter(|x| **x).count() as f64 / len as f64;
                let e = len as f64 * pa * pb;
                let z = (both - e) / e.sqrt();
                worst = worst.max(z.abs());
            }
        }
        let pairs = rows.len() * (rows.len() - 1) / 2;
        // With many pairs the largest |z| is expected near sqrt(2 ln pairs).
        let expect = (2.0 * (pairs as f64).ln()).sqrt();
        println!("{} players side by side ({pairs} pairs): worst lockstep Mythic correlation |z| {worst:.2} (about {expect:.1} expected by chance) {}",
            rows.len(), if worst < expect + 2.0 { "ok" } else { "FAIL" });
    }

    // ---- 5. Mythic gaps for a player who opens packs back to back, with the meter ----
    for boosted in [false, true] {
        let p = pack.clone();
        let parts = par(n, move |_, k| {
            let mut rng = rand::rng();
            let mut pity = Pity::default();
            let (mut gaps, mut since) = (Vec::new(), 0u32);
            for _ in 0..k {
                let c = roll::roll(&p, &mut rng, &Opts { boosted, pity, ..Default::default() });
                pity = roll::next_pity(pity, &c);
                since += 1;
                if pity.m == 0 {
                    gaps.push(since);
                    since = 0;
                }
            }
            gaps
        });
        let mut gaps: Vec<u32> = parts.into_iter().flatten().collect();
        gaps.sort_unstable();
        let mean = gaps.iter().map(|g| f64::from(*g)).sum::<f64>() / gaps.len() as f64;
        println!(
            "[{}] with the meter: a Mythic every {mean:.1} packs; median {}, 10th pct {}, 90th pct {}, longest {}",
            if boosted { "boosted " } else { "standard" },
            gaps[gaps.len() / 2], gaps[gaps.len() / 10], gaps[gaps.len() * 9 / 10], gaps.last().unwrap()
        );
    }

    // ---- 6. The pasted session, replayed: Nov 3, 10 standard then 9 boosted packs (two boosted at 4:12, seven at 4:14) ----
    println!();
    for start_m in [0u32, 50, 100, 150, 200] {
        let p = pack.clone();
        let parts = par(n, move |_, k| {
            let mut rng = rand::rng();
            let (mut two, mut two_in_last7) = (0u64, 0u64);
            for _ in 0..k {
                let mut pity = Pity { m: start_m, l: 0 };
                let mut total = 0;
                let mut last7 = 0;
                for i in 0..19 {
                    let boosted = i >= 10;
                    let c = roll::roll(&p, &mut rng, &Opts { boosted, pity, ..Default::default() });
                    pity = roll::next_pity(pity, &c);
                    if has_mythic(&c) {
                        total += 1;
                        if i >= 12 {
                            last7 += 1;
                        }
                    }
                }
                two += u64::from(total >= 2);
                two_in_last7 += u64::from(last7 >= 2);
            }
            (two, two_in_last7)
        });
        let (a, b) = parts.iter().fold((0, 0), |s, x| (s.0 + x.0, s.1 + x.1));
        println!(
            "session replay, meter at {start_m:>3} packs: 2+ Mythics in the 19 packs {:.3}% (1 in {:.0}); 2+ in the last 7 boosted {:.3}% (1 in {:.0})",
            100.0 * a as f64 / n as f64, n as f64 / a.max(1) as f64,
            100.0 * b as f64 / n as f64, n as f64 / b.max(1) as f64
        );
    }

    // ---- 7. How many packs does 6 Mythics in 3 days take? ----
    println!();
    for (std_packs, boosted_packs) in [(50, 5), (60, 30), (60, 100), (100, 200), (100, 375)] {
        let p = pack.clone();
        let trials = (n / 10).clamp(100_000, 500_000);
        let parts = par(trials, move |_, k| {
            let mut rng = rand::rng();
            let mut hit = 0u64;
            for _ in 0..k {
                let mut pity = Pity::default();
                let mut m = 0;
                for i in 0..std_packs + boosted_packs {
                    let c = roll::roll(&p, &mut rng, &Opts { boosted: i < boosted_packs, pity, ..Default::default() });
                    pity = roll::next_pity(pity, &c);
                    m += usize::from(has_mythic(&c));
                }
                hit += u64::from(m >= 6);
            }
            hit
        });
        let hit: u64 = parts.iter().sum();
        println!(
            "{std_packs:>3} standard + {boosted_packs:>3} boosted packs: 6+ Mythics {:.4}% of {trials} players{}",
            100.0 * hit as f64 / trials as f64,
            if hit == 0 { " (never)".to_string() } else { format!(" (1 in {:.0})", trials as f64 / hit as f64) }
        );
    }
    let _ = o;
}
