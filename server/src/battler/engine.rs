//! Resolves one round (Battler spec §3.4, §3.5, §5.6). Pure: the same robots, cards and seed always give the same
//! result, and nothing here touches the database or the clock.
//!
//! Pipeline: collect every active effect (robot effects, then parts, then lore, each in instance order), roll any
//! chances, then per robot and phase: base + flat points, times (100% + percent bonuses), times (100% + multiplier
//! bonuses), rounded half up and floored at zero; sum by alliance. Then one RP roll per robot at its station's chance
//! (plus RP bonuses, clamped to 0..100).

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

use super::effects::{Cond, Effect, Of, Op, Phase, RpSlot, Scope};

pub const ENGINE_VERSION: u32 = 1;

pub const PHASES: [Phase; 3] = [Phase::Auto, Phase::Tele, Phase::End];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Stats {
    pub auto: i32,
    pub tele: i32,
    pub end: i32,
    pub rp: [i32; 3],
}

impl Stats {
    pub fn phase(&self, p: Phase) -> i32 {
        match p {
            Phase::Auto => self.auto,
            Phase::Tele => self.tele,
            Phase::End => self.end,
            Phase::All => self.auto + self.tele + self.end,
        }
    }
}

/// A part attached to a robot this round.
#[derive(Clone, Debug)]
pub struct FieldPart {
    pub inst: u32,
    pub name: String,
    pub tags: Vec<String>,
    pub effects: Vec<Effect>,
}

/// One of the six robots on the field.
#[derive(Clone, Debug)]
pub struct FieldRobot {
    pub inst: u32,
    pub name: String,
    /// 0 or 1: whose alliance it's on this round.
    pub side: usize,
    pub captain: bool,
    pub station: u8,
    pub stats: Stats,
    pub effects: Vec<Effect>,
    pub parts: Vec<FieldPart>,
}

impl FieldRobot {
    fn tag_count(&self, tag: &str) -> u8 {
        self.parts.iter().filter(|p| p.tags.iter().any(|t| t == tag)).count() as u8
    }
}

#[derive(Clone, Debug)]
pub struct FieldLore {
    pub inst: u32,
    pub name: String,
    pub side: usize,
    pub effects: Vec<Effect>,
}

/// One thing that happened, for the round log (public once the round resolves).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Event {
    /// The card that caused it.
    pub source: String,
    /// The robot it affected (instance).
    pub target: u32,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RobotScore {
    pub inst: u32,
    pub side: usize,
    pub station: u8,
    /// Base and final points for Auto, Tele, End.
    pub base: [i32; 3],
    pub points: [i32; 3],
    /// The RP chance it rolled at, the roll (0..99) and whether it earned the RP.
    pub rp_chance: i32,
    pub rp_roll: i32,
    pub rp_hit: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RoundResult {
    pub robots: Vec<RobotScore>,
    /// Alliance points per phase: [side][phase].
    pub phase_totals: [[i32; 3]; 2],
    pub totals: [i32; 2],
    /// 0 or 1, or None for a tie.
    pub winner: Option<usize>,
    /// RP from the result (3/0 or 1/1) and from robot rolls.
    pub match_rp: [i32; 2],
    pub bonus_rp: [i32; 2],
    pub events: Vec<Event>,
}

#[derive(Default, Clone, Copy)]
struct Acc {
    flat: i32,
    pct: i32,
    mult: i32,
}

struct Source<'a> {
    name: &'a str,
    /// The robot the effect is on or attached to; None for lore.
    robot: Option<usize>,
    side: usize,
    effects: &'a [Effect],
}

fn cond_ok(c: &Cond, target: &FieldRobot, source: Option<&FieldRobot>, lore_active: bool) -> bool {
    let pick = |of: &Of| match of {
        Of::Target => Some(target),
        Of::Source => source,
    };
    match c {
        Cond::HasPartTag { tag, min, of } => pick(of).is_some_and(|r| r.tag_count(tag) >= *min),
        Cond::Station { station, of } => pick(of).is_some_and(|r| r.station == *station),
        Cond::Captain { is, of } => pick(of).is_some_and(|r| r.captain == *is),
        Cond::LoreActive => lore_active,
    }
}

fn half_up(num: i64, den: i64) -> i32 {
    // Rounds num/den half up (toward +infinity on .5), like Math.round.
    let q = (2 * num + den).div_euclid(2 * den);
    q as i32
}

/// Resolves a round. `seed` decides every chance roll; the same inputs and seed give the same result.
pub fn resolve(robots: &[FieldRobot], lores: &[FieldLore], seed: u64) -> RoundResult {
    let mut rng = StdRng::seed_from_u64(seed);
    let lore_active = !lores.is_empty();
    let n = robots.len();
    let mut acc = vec![[Acc::default(); 3]; n];
    let mut rp_pp = vec![[0i32; 4]; n];
    let mut events = Vec::new();

    // Sources in a fixed order: robot effects, then parts, then lore, each by instance id.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&i| robots[i].inst);
    let mut sources: Vec<Source> = Vec::new();
    for &i in &order {
        sources.push(Source { name: &robots[i].name, robot: Some(i), side: robots[i].side, effects: &robots[i].effects });
    }
    let mut parts: Vec<(usize, &FieldPart)> = order.iter().flat_map(|&i| robots[i].parts.iter().map(move |p| (i, p))).collect();
    parts.sort_by_key(|(_, p)| p.inst);
    for (i, p) in &parts {
        sources.push(Source { name: &p.name, robot: Some(*i), side: robots[*i].side, effects: &p.effects });
    }
    let mut lore_sorted: Vec<&FieldLore> = lores.iter().collect();
    lore_sorted.sort_by_key(|l| l.inst);
    for l in &lore_sorted {
        sources.push(Source { name: &l.name, robot: None, side: l.side, effects: &l.effects });
    }

    for src in &sources {
        let source_robot = src.robot.map(|i| &robots[i]);
        for e in src.effects {
            for &t in &order {
                let target = &robots[t];
                let reached = match e.scope {
                    Scope::Itself => src.robot == Some(t),
                    Scope::Allies => target.side == src.side,
                    Scope::Enemies => target.side != src.side,
                    Scope::Field => true,
                };
                if !reached || !e.when.iter().all(|c| cond_ok(c, target, source_robot, lore_active)) {
                    continue;
                }
                if let Some(chance) = e.chance {
                    let roll: i32 = rng.random_range(0..100);
                    let hit = roll < i32::from(chance);
                    events.push(Event {
                        source: src.name.to_string(),
                        target: target.inst,
                        text: format!("{}% chance on {}: rolled {roll}, {}", chance, target.name, if hit { "hit" } else { "missed" }),
                    });
                    if !hit {
                        continue;
                    }
                }
                let mut apply = |phase: Phase, f: &dyn Fn(&mut Acc)| {
                    for (k, p) in PHASES.iter().enumerate() {
                        if phase.covers(*p) {
                            f(&mut acc[t][k]);
                        }
                    }
                };
                let text = match &e.op {
                    Op::AddPhaseFlat { phase, value } => {
                        apply(*phase, &|a| a.flat += value);
                        format!("{} {:+} {}", target.name, value, phase_word(*phase))
                    }
                    Op::AddPhasePct { phase, value } => {
                        apply(*phase, &|a| a.pct += value);
                        format!("{} {:+}% {}", target.name, value, phase_word(*phase))
                    }
                    Op::AddPhaseMultiplier { phase, percent } => {
                        let bonus = percent - 100;
                        apply(*phase, &|a| a.mult += bonus);
                        format!("{} {}x {}", target.name, *percent as f32 / 100.0, phase_word(*phase))
                    }
                    Op::AddRpPp { rp, value } => {
                        let k = match rp {
                            RpSlot::Rp1 => 0,
                            RpSlot::Rp2 => 1,
                            RpSlot::Rp3 => 2,
                            RpSlot::Station => 3,
                        };
                        rp_pp[t][k] += value;
                        format!("{} {:+} RP chance", target.name, value)
                    }
                    Op::PerPartTag { tag, phase, value } => {
                        let c = i32::from(target.tag_count(tag));
                        let v = value * c;
                        apply(*phase, &|a| a.flat += v);
                        format!("{} {:+} {} ({c} {tag})", target.name, v, phase_word(*phase))
                    }
                };
                events.push(Event { source: src.name.to_string(), target: target.inst, text });
            }
        }
    }

    let mut scores = Vec::with_capacity(n);
    let mut phase_totals = [[0i32; 3]; 2];
    for &i in &order {
        let r = &robots[i];
        let mut base = [0; 3];
        let mut points = [0; 3];
        for (k, p) in PHASES.iter().enumerate() {
            let a = acc[i][k];
            base[k] = r.stats.phase(*p);
            let v = i64::from(base[k] + a.flat) * i64::from((100 + a.pct).max(0)) * i64::from(100 + a.mult);
            points[k] = half_up(v, 10_000).max(0);
            phase_totals[r.side][k] += points[k];
        }
        scores.push(RobotScore { inst: r.inst, side: r.side, station: r.station, base, points, rp_chance: 0, rp_roll: 0, rp_hit: false });
    }
    let totals: [i32; 2] = [phase_totals[0].iter().sum(), phase_totals[1].iter().sum()];
    let winner = match totals[0].cmp(&totals[1]) {
        std::cmp::Ordering::Greater => Some(0),
        std::cmp::Ordering::Less => Some(1),
        std::cmp::Ordering::Equal => None,
    };
    let match_rp = match winner {
        Some(0) => [3, 0],
        Some(_) => [0, 3],
        None => [1, 1],
    };

    // One RP roll per robot, at its station's chance, in a fixed order (side, then instance).
    let mut bonus_rp = [0; 2];
    let mut roll_order: Vec<usize> = (0..scores.len()).collect();
    roll_order.sort_by_key(|&k| (scores[k].side, scores[k].inst));
    for k in roll_order {
        let i = order[k];
        let r = &robots[i];
        let slot = usize::from(r.station.clamp(1, 3) - 1);
        let chance = (r.stats.rp[slot] + rp_pp[i][slot] + rp_pp[i][3]).clamp(0, 100);
        let roll: i32 = rng.random_range(0..100);
        let hit = roll < chance;
        if hit {
            bonus_rp[r.side] += 1;
        }
        let s = &mut scores[k];
        s.rp_chance = chance;
        s.rp_roll = roll;
        s.rp_hit = hit;
    }
    RoundResult { robots: scores, phase_totals, totals, winner, match_rp, bonus_rp, events }
}

fn phase_word(p: Phase) -> &'static str {
    match p {
        Phase::Auto => "Auto",
        Phase::Tele => "Tele",
        Phase::End => "End",
        Phase::All => "all phases",
    }
}

/// Elo after a game (spec §8.2): K = 32, `score` 1 / 0.5 / 0 for a win, draw or loss.
pub fn elo(mine: i32, theirs: i32, score: f64) -> i32 {
    let expected = 1.0 / (1.0 + 10f64.powf(f64::from(theirs - mine) / 400.0));
    (f64::from(mine) + 32.0 * (score - expected)).round() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn robot(inst: u32, side: usize, station: u8, stats: Stats) -> FieldRobot {
        FieldRobot { inst, name: format!("R{inst}"), side, captain: inst % 3 == 0, station, stats, effects: vec![], parts: vec![] }
    }

    fn st(auto: i32, tele: i32, end: i32, rp: [i32; 3]) -> Stats {
        Stats { auto, tele, end, rp }
    }

    fn field() -> Vec<FieldRobot> {
        vec![
            robot(0, 0, 1, st(30, 72, 18, [0, 0, 0])),
            robot(1, 0, 2, st(10, 20, 5, [0, 0, 0])),
            robot(2, 0, 3, st(10, 20, 5, [0, 0, 0])),
            robot(3, 1, 1, st(20, 50, 10, [100, 0, 0])),
            robot(4, 1, 2, st(10, 20, 5, [0, 100, 0])),
            robot(5, 1, 3, st(10, 20, 5, [0, 0, 100])),
        ]
    }

    fn fx(json: &str) -> Vec<Effect> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn scores_sum_by_alliance_and_award_rp() {
        let r = resolve(&field(), &[], 1);
        assert_eq!(r.totals, [190, 150]);
        assert_eq!(r.winner, Some(0));
        assert_eq!(r.match_rp, [3, 0]);
        // 0% never hits, 100% always does: side 1's three robots each earn one.
        assert_eq!(r.bonus_rp, [0, 3]);
    }

    #[test]
    fn one_rp_roll_at_the_station_chance() {
        let mut f = field();
        f[3].station = 2; // RP1 100%, RP2 0%: in station 2 it rolls 0%
        let r = resolve(&f, &[], 7);
        let s = r.robots.iter().find(|s| s.inst == 3).unwrap();
        assert_eq!(s.rp_chance, 0);
        assert!(!s.rp_hit);
    }

    #[test]
    fn tie_gives_one_rp_each() {
        let f: Vec<FieldRobot> = (0..6).map(|i| robot(i, (i / 3) as usize, (i % 3 + 1) as u8, st(10, 10, 10, [0, 0, 0]))).collect();
        let r = resolve(&f, &[], 3);
        assert_eq!(r.winner, None);
        assert_eq!(r.match_rp, [1, 1]);
    }

    #[test]
    fn parts_flat_pct_and_per_tag_stack_in_order() {
        let mut f = field();
        f[1].parts.push(FieldPart {
            inst: 100,
            name: "Gearbox".into(),
            tags: vec!["MECHANICAL".into(), "GEAR".into()],
            effects: fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"TELE","value":10,"scope":"SELF"},{"op":"ADD_PHASE_PCT","phase":"TELE","value":50,"scope":"SELF"}]"#),
        });
        f[1].effects = fx(r#"[{"op":"PER_PART_TAG","tag":"MECHANICAL","phase":"TELE","value":8,"scope":"SELF"}]"#);
        let r = resolve(&f, &[], 1);
        let s = r.robots.iter().find(|s| s.inst == 1).unwrap();
        // (20 + 10 + 8) * 1.5 = 57
        assert_eq!(s.points[1], 57);
    }

    #[test]
    fn multipliers_add_their_bonuses() {
        let mut f = field();
        let dbl = fx(r#"[{"op":"ADD_PHASE_MULTIPLIER","phase":"TELE","percent":200,"scope":"FIELD"}]"#);
        let lores = vec![
            FieldLore { inst: 200, name: "A".into(), side: 0, effects: dbl.clone() },
            FieldLore { inst: 201, name: "B".into(), side: 1, effects: dbl },
        ];
        f.truncate(6);
        let r = resolve(&f, &lores, 1);
        // 2x + 2x = 3x, not 4x.
        assert_eq!(r.robots[0].points[1], 72 * 3);
        // Lore reaches both alliances.
        assert_eq!(r.robots[3].points[1], 150);
    }

    #[test]
    fn chance_rolls_once_per_robot_and_are_seeded() {
        let lore = vec![FieldLore {
            inst: 200,
            name: "Laser Engraved Breadstick".into(),
            side: 0,
            effects: fx(r#"[{"op":"ADD_PHASE_MULTIPLIER","phase":"TELE","percent":200,"scope":"FIELD","chance":50}]"#),
        }];
        let a = resolve(&field(), &lore, 42);
        let b = resolve(&field(), &lore, 42);
        assert_eq!(a, b, "same seed, same result");
        let rolls = a.events.iter().filter(|e| e.text.contains("50% chance")).count();
        assert_eq!(rolls, 6, "one roll per robot on the field");
        for s in &a.robots {
            let base = s.base[1];
            assert!(s.points[1] == base || s.points[1] == base * 2);
        }
    }

    #[test]
    fn conditions_and_scopes() {
        let mut f = field();
        // Captain (inst 0) gives its alliance +10 Auto, only while it's the captain.
        f[0].effects = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":10,"scope":"ALLIES","when":[{"if":"CAPTAIN","of":"SOURCE"}]}]"#);
        // A robot with +5 RP2 only in station 2.
        f[4].effects = fx(r#"[{"op":"ADD_RP_PP","rp":"RP2","value":-100,"scope":"SELF","when":[{"if":"STATION","station":2}]}]"#);
        let r = resolve(&f, &[], 9);
        assert_eq!(r.robots[0].points[0], 40);
        assert_eq!(r.robots[1].points[0], 20);
        assert_eq!(r.robots[3].points[0], 20, "the other alliance isn't reached");
        assert_eq!(r.robots[4].rp_chance, 0);
    }

    #[test]
    fn scores_never_go_negative() {
        let mut f = field();
        f[1].effects = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"ALL","value":-100,"scope":"SELF"}]"#);
        let r = resolve(&f, &[], 1);
        assert_eq!(r.robots[1].points, [0, 0, 0]);
    }

    #[test]
    fn elo_matches_the_spec_formula() {
        assert_eq!(elo(1000, 1000, 1.0), 1016);
        assert_eq!(elo(1000, 1000, 0.0), 984);
        assert_eq!(elo(1000, 1000, 0.5), 1000);
        assert_eq!(elo(1200, 1000, 1.0), 1208);
    }

    #[test]
    fn rounding_is_half_up() {
        assert_eq!(half_up(5, 10), 1);
        assert_eq!(half_up(15, 10), 2);
        assert_eq!(half_up(14, 10), 1);
    }
}
