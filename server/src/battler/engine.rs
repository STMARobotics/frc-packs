//! Resolves one round (Battler spec §3.4, §3.5, §5.6). Pure: the same robots, cards and seed always give the same
//! result, and nothing here touches the database or the clock.
//!
//! Pipeline: collect every active effect (robot effects, then parts, then lore, each in instance order), roll any
//! chances, then per robot and phase: base + flat points, times (100% + percent bonuses), times (100% + multiplier
//! bonuses), rounded half up and floored at zero; sum by alliance. Then one RP roll per robot at its station's chance
//! (plus RP bonuses, clamped to 0..100). A defender gives up Tele and subtracts its DEF from the opposing
//! station's base Tele before effects.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

use super::effects::{Cond, Effect, Of, Op, Phase, RpSlot, Scope};

pub const ENGINE_VERSION: u32 = 5;
const LIMELIGHT: &str = "P-2026-021";

pub const PHASES: [Phase; 3] = [Phase::Auto, Phase::Tele, Phase::End];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RobotMode {
    #[default]
    Scoring,
    Defending,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Stats {
    pub auto: f64,
    pub tele: f64,
    pub end: f64,
    /// DPR subtracted from the opposing station's Tele when this robot defends.
    #[serde(default)]
    pub def: Option<f64>,
    pub rp: [f64; 3],
}

impl Stats {
    pub fn phase(&self, p: Phase) -> f64 {
        match p {
            Phase::Auto => self.auto,
            Phase::Tele => self.tele,
            Phase::End => self.end,
            Phase::All => self.auto + self.tele + self.end,
        }
    }

    pub fn base_points(&self) -> [i32; 3] {
        PHASES.map(|phase| half_up(self.phase(phase)))
    }
}

/// A part attached to a robot this round.
#[derive(Clone, Debug)]
pub struct FieldPart {
    pub inst: u32,
    pub card: String,
    pub name: String,
    pub tags: Vec<String>,
    pub effects: Vec<Effect>,
}

/// One of the six robots on the field.
#[derive(Clone, Debug)]
pub struct FieldRobot {
    pub inst: u32,
    /// Its team number (0 for a stand-in robot).
    pub team: i32,
    pub name: String,
    /// 0 or 1: whose alliance it's on this round.
    pub side: usize,
    pub captain: bool,
    pub station: u8,
    pub mode: RobotMode,
    pub stats: Stats,
    pub effects: Vec<Effect>,
    pub parts: Vec<FieldPart>,
}

impl FieldRobot {
    fn tag_count(&self, tag: &str) -> u8 {
        self.parts.iter().filter(|p| p.tags.iter().any(|t| t == tag)).count() as u8
    }

    fn has_ability(&self, op: Op) -> bool {
        self.effects.iter().any(|e| e.op == op)
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

/// One visible robot ability activation, with its source and all successful targets.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Activation {
    pub source: u32,
    pub targets: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<Phase>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RobotScore {
    pub inst: u32,
    pub side: usize,
    pub station: u8,
    #[serde(default)]
    pub mode: RobotMode,
    /// Raw ratings and final points for Auto, Tele, End.
    pub base: [f64; 3],
    pub points: [i32; 3],
    /// The RP chance it rolled at, the roll (0..99) and whether it earned the RP.
    pub rp_chance: f64,
    pub rp_roll: f64,
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
    #[serde(default)]
    pub activations: Vec<Activation>,
}

#[derive(Default, Clone, Copy)]
struct Acc {
    flat: i32,
    pct: i32,
    mult: i32,
    /// Disabled: the phase scores nothing.
    off: bool,
}

struct Source<'a> {
    name: &'a str,
    /// The robot the effect is on or attached to; None for lore.
    robot: Option<usize>,
    side: usize,
    effects: &'a [Effect],
}

fn cond_ok(
    c: &Cond,
    target: &FieldRobot,
    src: &Source<'_>,
    robots: &[FieldRobot],
    lore_active: bool,
    unfavored: [bool; 2],
) -> bool {
    let source = src.robot.map(|i| &robots[i]);
    let pick = |of: &Of| match of {
        Of::Target => Some(target),
        Of::Source => source,
    };
    match c {
        Cond::HasPartTag { tag, min, of } => pick(of).is_some_and(|r| r.tag_count(tag) >= *min),
        Cond::Station { station, of } => pick(of).is_some_and(|r| r.station == *station),
        Cond::Captain { is, of } => pick(of).is_some_and(|r| r.captain == *is),
        Cond::LoreActive => lore_active,
        Cond::Across => source.is_some_and(|s| s.side != target.side && s.station == target.station),
        Cond::AlliedWith { team } => {
            robots.iter().any(|r| r.side == target.side && r.inst != target.inst && r.team == *team)
        }
        Cond::Unfavored => unfavored[src.side],
        Cond::HighestTele => robots.iter().all(|r| r.side != target.side || r.stats.tele <= target.stats.tele),
        Cond::Team { team, of } => pick(of).is_some_and(|r| r.team == *team),
    }
}

fn half_up(value: f64) -> i32 {
    (value + 0.5).floor() as i32
}

/// Resolves a round. `seed` decides every chance roll; the same inputs and seed give the same result.
pub fn resolve(robots: &[FieldRobot], lores: &[FieldLore], seed: u64) -> RoundResult {
    let mut scores = [0; 2];
    for robot in robots {
        scores[robot.side] += robot.stats.base_points().into_iter().map(|points| points.max(0)).sum::<i32>();
    }
    resolve_with_prediction(robots, lores, seed, [scores[0] < scores[1], scores[1] < scores[0]])
}

pub fn resolve_with_prediction(
    field: &[FieldRobot],
    lores: &[FieldLore],
    seed: u64,
    unfavored: [bool; 2],
) -> RoundResult {
    let mut rng = StdRng::seed_from_u64(seed);
    let lore_active = !lores.is_empty();
    let n = field.len();
    let mut acc = vec![[Acc::default(); 3]; n];
    let mut rp_pp = vec![[0i32; 4]; n];
    let mut rp_pct = vec![0; n];
    let mut events = Vec::new();
    let mut activations = Vec::new();

    // Sources in a fixed order: robot effects, then parts, then lore, each by instance id.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by_key(|&i| field[i].inst);

    // Copy only a part actually attached in the pit. The copy exists for this resolution, including tag checks.
    let mut robots = field.to_vec();
    let mut next_part = field.iter().flat_map(|r| &r.parts).map(|p| p.inst).max().unwrap_or_default();
    for &i in &order {
        let r = &field[i];
        if !r.has_ability(Op::CopyPartnerLimelight) {
            continue;
        }
        if let Some(part) = order
            .iter()
            .filter(|&&j| j != i && field[j].side == r.side)
            .flat_map(|&j| &field[j].parts)
            .filter(|p| p.card == LIMELIGHT)
            .min_by_key(|p| p.inst)
        {
            next_part += 1;
            robots[i].parts.push(FieldPart { inst: next_part, ..part.clone() });
            activations.push(Activation { source: r.inst, targets: vec![r.inst], phase: None });
            events.push(Event {
                source: r.name.clone(),
                target: r.inst,
                text: "Gained a Limelight for this match.".into(),
            });
        }
    }

    let mut ratings: Vec<_> = robots.iter().map(|r| r.stats).collect();
    let immune_to_enemy: Vec<_> = robots.iter().map(|r| r.has_ability(Op::ImmuneToEnemyEffects)).collect();
    for &i in &order {
        let r = &robots[i];
        let src = Source { name: &r.name, robot: Some(i), side: r.side, effects: &r.effects };
        for e in src.effects {
            if let Op::BoostAllRatings { value } = e.op
                && e.when.iter().all(|c| cond_ok(c, r, &src, &robots, lore_active, unfavored))
            {
                let s = &mut ratings[i];
                let factor = 1.0 + f64::from(value) / 100.0;
                s.auto *= factor;
                s.tele *= factor;
                s.end *= factor;
                s.def = s.def.map(|def| def * factor);
                s.rp = s.rp.map(|rp| rp * factor);
                activations.push(Activation { source: r.inst, targets: vec![r.inst], phase: None });
                events.push(Event {
                    source: r.name.clone(),
                    target: r.inst,
                    text: format!("{value:+}% to all ratings"),
                });
            }
        }
    }
    let mut immunity_shown = vec![false; n];
    for &i in &order {
        let r = &robots[i];
        for e in &r.effects {
            let text = match e.op {
                Op::StealRandomRating => {
                    let targets: Vec<_> = order.iter().copied().filter(|&j| robots[j].side != r.side).collect();
                    if targets.is_empty() {
                        continue;
                    }
                    let j = targets[rng.random_range(0..targets.len())];
                    let stat = rng.random_range(0..4);
                    if immune_to_enemy[j] {
                        if !std::mem::replace(&mut immunity_shown[j], true) {
                            activations.push(Activation {
                                source: robots[j].inst,
                                targets: vec![robots[j].inst],
                                phase: None,
                            });
                        }
                        events.push(Event {
                            source: r.name.clone(),
                            target: robots[j].inst,
                            text: "Blocked the rating steal.".into(),
                        });
                        continue;
                    }
                    let (name, victim) = match stat {
                        0 => ("AUTO", &mut ratings[j].auto),
                        1 => ("TELE", &mut ratings[j].tele),
                        2 => ("END", &mut ratings[j].end),
                        _ => ("DEF", ratings[j].def.get_or_insert(0.0)),
                    };
                    let amount = victim.max(0.0) * 0.05;
                    *victim -= amount;
                    match stat {
                        0 => ratings[i].auto += amount,
                        1 => ratings[i].tele += amount,
                        2 => ratings[i].end += amount,
                        _ if amount != 0.0 => *ratings[i].def.get_or_insert(0.0) += amount,
                        _ => {}
                    }
                    if amount > 0.0 {
                        activations.push(Activation { source: r.inst, targets: vec![robots[j].inst], phase: None });
                    }
                    format!("Stole {amount:.2} {name} from {}.", robots[j].name)
                }
                Op::RandomAuto => {
                    let pct = [50, -20, 0][rng.random_range(0..3)];
                    acc[i][0].pct += pct;
                    activations.push(Activation { source: r.inst, targets: vec![r.inst], phase: Some(Phase::Auto) });
                    if pct == 0 { "Rolled no AUTO change.".into() } else { format!("Rolled {pct:+}% AUTO.") }
                }
                Op::ExtendHopper => {
                    for (k, phase) in PHASES.iter().enumerate() {
                        if rng.random_bool(0.5) {
                            acc[i][k].mult += 10;
                            activations.push(Activation { source: r.inst, targets: vec![r.inst], phase: Some(*phase) });
                            events.push(Event {
                                source: r.name.clone(),
                                target: r.inst,
                                text: format!("Extended the hopper for +10% {} scoring.", phase_word(*phase)),
                            });
                        }
                    }
                    continue;
                }
                _ => continue,
            };
            events.push(Event { source: r.name.clone(), target: r.inst, text });
        }
    }

    let mut sources: Vec<Source> = Vec::new();
    for &i in &order {
        sources.push(Source {
            name: &robots[i].name,
            robot: Some(i),
            side: robots[i].side,
            effects: &robots[i].effects,
        });
    }
    let mut parts: Vec<(usize, &FieldPart)> =
        order.iter().flat_map(|&i| robots[i].parts.iter().map(move |p| (i, p))).collect();
    parts.sort_by_key(|(_, p)| p.inst);
    for (i, p) in &parts {
        sources.push(Source { name: &p.name, robot: Some(*i), side: robots[*i].side, effects: &p.effects });
    }
    let mut lore_sorted: Vec<&FieldLore> = lores.iter().collect();
    lore_sorted.sort_by_key(|l| l.inst);
    for l in &lore_sorted {
        sources.push(Source { name: &l.name, robot: None, side: l.side, effects: &l.effects });
    }

    for (source_index, src) in sources.iter().enumerate() {
        for e in src.effects {
            if e.op.is_robot_ability() {
                continue;
            }
            let mut ability_targets = Vec::new();
            for &t in &order {
                let target = &robots[t];
                let reached = match e.scope {
                    Scope::Itself => src.robot == Some(t),
                    Scope::Allies => target.side == src.side,
                    Scope::Partners => target.side == src.side && src.robot != Some(t),
                    Scope::Enemies => target.side != src.side,
                    Scope::Field => true,
                };
                if !reached || !e.when.iter().all(|c| cond_ok(c, target, src, &robots, lore_active, unfavored)) {
                    continue;
                }
                if target.side != src.side && immune_to_enemy[t] {
                    if !std::mem::replace(&mut immunity_shown[t], true) {
                        activations.push(Activation { source: target.inst, targets: vec![target.inst], phase: None });
                    }
                    events.push(Event {
                        source: src.name.to_string(),
                        target: target.inst,
                        text: format!("{} is immune to opposing effects.", target.name),
                    });
                    continue;
                }
                if let Some(chance) = e.chance {
                    let roll: i32 = rng.random_range(0..100);
                    let hit = roll < i32::from(chance);
                    events.push(Event {
                        source: src.name.to_string(),
                        target: target.inst,
                        text: format!(
                            "{}% chance on {}: rolled {roll}, {}",
                            chance,
                            target.name,
                            if hit { "hit" } else { "missed" }
                        ),
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
                    Op::AddRpPct { value } => {
                        rp_pct[t] += value;
                        format!("{} {value:+}% to all RP chances", target.name)
                    }
                    Op::PerPartTag { tag, phase, value } => {
                        let c = i32::from(target.tag_count(tag));
                        let v = value * c;
                        apply(*phase, &|a| a.flat += v);
                        format!("{} {:+} {} ({c} {tag})", target.name, v, phase_word(*phase))
                    }
                    Op::DisablePhase { phase } => {
                        apply(*phase, &|a| a.off = true);
                        format!("{} scores no {}", target.name, phase_word(*phase))
                    }
                    _ => unreachable!("robot abilities resolve before ordinary effects"),
                };
                events.push(Event { source: src.name.to_string(), target: target.inst, text });
                if source_index < n && !matches!(&e.op, Op::PerPartTag { tag, .. } if target.tag_count(tag) == 0) {
                    ability_targets.push(target.inst);
                }
            }
            if !ability_targets.is_empty() {
                activations.push(Activation {
                    source: robots[order[source_index]].inst,
                    targets: ability_targets,
                    phase: None,
                });
            }
        }
    }

    let mut scores = Vec::with_capacity(n);
    let mut phase_totals = [[0i32; 3]; 2];
    for &i in &order {
        let r = &robots[i];
        let base = PHASES.map(|phase| r.stats.phase(phase));
        let defending = r.mode == RobotMode::Defending;
        let mut reduction = 0.0;
        if !defending
            && let Some((j, opponent)) = robots.iter().enumerate().find(|(_, opponent)| {
                opponent.side != r.side && opponent.station == r.station && opponent.mode == RobotMode::Defending
            })
            && let Some(def) = ratings[j].def.filter(|def| *def != 0.0)
        {
            if r.has_ability(Op::ImmuneToDefense) {
                activations.push(Activation { source: r.inst, targets: vec![r.inst], phase: Some(Phase::Tele) });
                events.push(Event {
                    source: r.name.clone(),
                    target: r.inst,
                    text: "Ignored the opposing defender.".into(),
                });
            } else {
                reduction = def;
                events.push(Event {
                    source: opponent.name.clone(),
                    target: r.inst,
                    text: format!("{} {:+} base TELE (defense)", r.name, -def),
                });
            }
        }
        let mut points = [0; 3];
        for (k, phase) in PHASES.iter().enumerate() {
            let a = acc[i][k];
            if a.off || (*phase == Phase::Tele && defending) {
                continue;
            }
            let rating = ratings[i].phase(*phase) - if *phase == Phase::Tele { reduction } else { 0.0 };
            let v = (rating + f64::from(a.flat)) * f64::from((100 + a.pct).max(0)) * f64::from(100 + a.mult);
            points[k] = half_up(v / 10_000.0).max(0);
            phase_totals[r.side][k] += points[k];
        }
        scores.push(RobotScore {
            inst: r.inst,
            side: r.side,
            station: r.station,
            mode: r.mode,
            base,
            points,
            rp_chance: 0.0,
            rp_roll: 0.0,
            rp_hit: false,
        });
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
        let chance = (ratings[i].rp[slot] * (1.0 + f64::from(rp_pct[i]) / 100.0)
            + f64::from(rp_pp[i][slot] + rp_pp[i][3]))
        .clamp(0.0, 100.0);
        let roll =
            if chance.fract() == 0.0 { f64::from(rng.random_range(0..100)) } else { rng.random_range(0.0..100.0) };
        let hit = roll < chance;
        if hit {
            bonus_rp[r.side] += 1;
        }
        let s = &mut scores[k];
        s.rp_chance = chance;
        s.rp_roll = roll;
        s.rp_hit = hit;
    }
    RoundResult { robots: scores, phase_totals, totals, winner, match_rp, bonus_rp, events, activations }
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
        FieldRobot {
            inst,
            team: 0,
            name: format!("R{inst}"),
            side,
            captain: inst.is_multiple_of(3),
            station,
            mode: RobotMode::Scoring,
            stats,
            effects: vec![],
            parts: vec![],
        }
    }

    fn st(auto: i32, tele: i32, end: i32, rp: [i32; 3]) -> Stats {
        Stats { auto: f64::from(auto), tele: f64::from(tele), end: f64::from(end), def: None, rp: rp.map(f64::from) }
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

    fn with_shipped_abilities(teams: [i32; 6]) -> (Vec<FieldRobot>, super::super::content::Content) {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../data");
        let content = super::super::content::Content::load(&dir).unwrap();
        let mut robots = field();
        for (robot, team) in robots.iter_mut().zip(teams) {
            robot.team = team;
            robot.effects = content.shipped_effects.get(&team).cloned().unwrap_or_default();
            robot.stats = Stats { auto: 100.0, tele: 200.0, end: 40.0, def: Some(40.0), rp: [40.0; 3] };
        }
        (robots, content)
    }

    #[test]
    fn shipped_partner_bonuses_apply_to_the_correct_robots() {
        let (mut f, _) = with_shipped_abilities([27, 4414, 2481, 1114, 2056, 0]);
        f[5].mode = RobotMode::Defending;
        let mut partner_hits = [false; 2];
        let mut different_rolls = false;
        for seed in 0..32 {
            let r = resolve(&f, &[], seed);
            assert_eq!(r.robots[0].points, [100, 200, 40]);
            assert_eq!(r.robots[0].rp_chance, 44.0);
            assert_eq!(r.robots[1].rp_chance, 40.0);
            assert_eq!(r.robots[2].rp_chance, 44.0);
            assert_eq!(r.robots[2].points[0], 110);
            assert_eq!(r.robots[2].points[2], 44);
            let hit = [r.robots[1].points[1] == 220, r.robots[2].points[1] == 194];
            different_rolls |= hit[0] != hit[1];
            for i in 0..2 {
                partner_hits[i] |= hit[i];
            }
            for s in &r.robots[3..5] {
                assert_eq!(s.points, [105, 210, 42]);
                assert_eq!(s.rp_chance, 42.0);
            }
        }
        assert_eq!(partner_hits, [true, true]);
        assert!(different_rolls);
        let r = resolve(&f, &[], 0);
        let high_tide: Vec<_> = r.activations.iter().filter(|a| a.source == 1).collect();
        assert_eq!(high_tide, [&Activation { source: 1, targets: vec![0, 2], phase: None }]);
        f[0].stats.tele = 201.0;
        f[4].mode = RobotMode::Defending;
        let r = resolve(&f, &[], 0);
        assert_eq!(r.robots[2].points[0], 100, "a stronger partner removes the bonus");
        assert!([158, 174].contains(&r.robots[1].points[1]), "boosted DEF applies across the station");
        f[4].team = 0;
        assert_eq!(resolve(&f, &[], 0).robots[3].points, [100, 200, 40]);
    }

    #[test]
    fn shipped_immunities_and_prediction_use_the_right_sources() {
        let (mut f, _) = with_shipped_abilities([125, 4946, 1323, 0, 0, 0]);
        f[3].mode = RobotMode::Defending;
        f[3].effects = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":-20,"scope":"ENEMIES"}]"#);
        f[4].parts.push(FieldPart {
            inst: 40,
            card: "test".into(),
            name: "Opposing part".into(),
            tags: vec![],
            effects: fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":-10,"scope":"ENEMIES"}]"#),
        });
        let lores = [
            FieldLore {
                inst: 50,
                name: "Opposing Lore".into(),
                side: 1,
                effects: fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":-30,"scope":"FIELD"}]"#),
            },
            FieldLore {
                inst: 51,
                name: "Friendly Lore".into(),
                side: 0,
                effects: fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"END","value":5,"scope":"ALLIES"}]"#),
            },
        ];
        let favored = resolve_with_prediction(&f, &lores, 0, [false, true]);
        let underdog = resolve_with_prediction(&f, &lores, 0, [true, false]);
        assert_eq!(underdog.robots[0].points, [40, 200, 45]);
        assert_eq!(underdog.robots[1].points, [100, 200, 45]);
        assert_eq!(underdog.robots[5].points[0], 60);
        assert_eq!(favored.robots[5].points[0], 70);
        assert_eq!(underdog.robots[4].points, favored.robots[4].points);
        assert!(underdog.activations.contains(&Activation { source: 0, targets: vec![0], phase: Some(Phase::Tele) }));
        assert_eq!(underdog.activations.iter().filter(|a| a.source == 1).count(), 1);
        assert!(underdog.activations.contains(&Activation { source: 2, targets: vec![5], phase: None }));
        assert!(favored.activations.iter().all(|a| a.source != 2));
    }

    #[test]
    fn orbit_copies_only_an_alliance_partners_limelight() {
        let (mut f, content) = with_shipped_abilities([1690, 0, 0, 0, 0, 0]);
        let light = content.support(LIMELIGHT).unwrap();
        let part = FieldPart {
            inst: 42,
            card: light.id.clone(),
            name: light.name.clone(),
            tags: light.tags.clone(),
            effects: light.effects.clone(),
        };
        f[3].parts.push(part.clone());
        assert_eq!(resolve(&f, &[], 0).robots[0].points[0], 100);
        f[1].parts.push(part.clone());
        f[2].parts.push(FieldPart { inst: 43, ..part });
        assert_eq!(resolve(&f, &[], 0).robots[0].points[0], 122);
        assert!(f[0].parts.is_empty(), "the copy is temporary");
    }

    #[test]
    fn shipped_random_abilities_are_seeded_and_cover_their_outcomes() {
        let (mut f, _) = with_shipped_abilities([254, 1678, 2910, 0, 0, 0]);
        f[0].mode = RobotMode::Defending;
        let mut auto = std::collections::BTreeSet::new();
        let mut hopper = std::collections::BTreeSet::new();
        let mut stolen = std::collections::BTreeSet::new();
        for seed in 0..100 {
            let r = resolve(&f, &[], seed);
            assert_eq!(r, resolve(&f, &[], seed));
            auto.insert(r.robots[2].points[0]);
            hopper.insert(r.robots[1].points);
            let event = r.events.iter().find(|e| e.target == 0 && e.text.starts_with("Stole")).unwrap();
            let stat = event.text.split_whitespace().nth(2).unwrap();
            stolen.insert(stat.to_owned());
            match stat {
                "AUTO" => {
                    assert_eq!(r.robots[0].points[0], 105);
                    assert_eq!(r.robots[3..].iter().map(|s| s.points[0]).sum::<i32>(), 295);
                }
                "END" => {
                    assert_eq!(r.robots[0].points[2], 42);
                    assert_eq!(r.robots[3..].iter().map(|s| s.points[2]).sum::<i32>(), 118);
                }
                "DEF" => assert_eq!(r.robots[3].points[1], 158),
                _ => assert!(r.robots[3..].iter().any(|s| s.points[1] == 190 || s.points[1] == 150)),
            }
        }
        assert_eq!(auto.into_iter().collect::<Vec<_>>(), [80, 100, 150]);
        assert_eq!(hopper.len(), 8);
        assert_eq!(stolen.len(), 4);
    }

    fn fx(json: &str) -> Vec<Effect> {
        serde_json::from_str(json).unwrap()
    }

    fn auto_of(r: &RoundResult, inst: u32) -> i32 {
        r.robots.iter().find(|s| s.inst == inst).unwrap().points[0]
    }

    #[test]
    fn across_reaches_only_the_robot_in_the_same_station_on_the_other_side() {
        let mut f = field();
        f[0].effects =
            fx(r#"[{"op":"ADD_PHASE_PCT","phase":"AUTO","value":-50,"scope":"ENEMIES","when":[{"if":"ACROSS"}]}]"#);
        let r = resolve(&f, &[], 1);
        assert_eq!(auto_of(&r, 3), 10, "station 1 across from it: halved");
        assert_eq!((auto_of(&r, 4), auto_of(&r, 5)), (10, 10), "the other two are untouched");
    }

    #[test]
    fn defending_trades_tele_for_a_reduction_to_the_opposing_stations_base() {
        let mut f = field();
        f[0].mode = RobotMode::Defending;
        f[0].stats.def = Some(25.4);
        f[0].effects = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"TELE","value":10,"scope":"SELF"}]"#);
        f[3].effects = fx(r#"[{"op":"ADD_PHASE_PCT","phase":"TELE","value":100,"scope":"SELF"}]"#);
        let r = resolve(&f, &[], 1);
        assert_eq!(r.robots[0].points, [30, 0, 18]);
        assert_eq!(r.robots[3].points, [20, 49, 10]);
        assert_eq!(r.robots[3].base[1], 50.0);
        assert!(r.robots[3].rp_hit);
        assert_eq!((r.robots[4].points[1], r.robots[5].points[1]), (20, 20));
        assert_eq!(r.phase_totals, [[50, 40, 28], [40, 89, 20]]);
        assert!(r.events.iter().any(|e| e.source == "R0" && e.target == 3 && e.text.contains("defense")));
    }

    #[test]
    fn opposing_defenders_both_score_zero_tele_and_defense_cannot_make_tele_negative() {
        let mut f = field();
        f[0].mode = RobotMode::Defending;
        f[0].stats.def = Some(100.0);
        assert_eq!(resolve(&f, &[], 1).robots[3].points[1], 0);
        f[3].mode = RobotMode::Defending;
        f[3].stats.def = Some(25.0);
        let r = resolve(&f, &[], 1);
        assert_eq!(r.robots[0].points, [30, 0, 18]);
        assert_eq!(r.robots[3].points, [20, 0, 10]);
    }

    #[test]
    fn a_disabled_phase_scores_nothing_whatever_else_applies() {
        let mut f = field();
        f[4].team = 6800;
        f[0].effects =
            fx(r#"[{"op":"DISABLE_PHASE","phase":"AUTO","scope":"ENEMIES","when":[{"if":"TEAM","team":6800}]}]"#);
        f[3].effects = fx(r#"[{"op":"ADD_PHASE_PCT","phase":"AUTO","value":200,"scope":"ALLIES"}]"#);
        let r = resolve(&f, &[], 1);
        assert_eq!(auto_of(&r, 4), 0, "team 6800 scores no Auto, even with its ally's +200%");
        assert_eq!(auto_of(&r, 5), 30, "its other ally still gets the bonus");
        assert!(r.robots.iter().find(|s| s.inst == 4).unwrap().points[1] > 0, "Tele still counts");
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
        assert_eq!(s.rp_chance, 0.0);
        assert!(!s.rp_hit);
    }

    #[test]
    fn match13_ratings_keep_precision_until_scoring() {
        let mut f = field();
        f[0].stats.auto = 10.49;
        f[0].stats.def = Some(192.1234);
        f[0].stats.rp[0] = 92.86;
        f[0].effects = fx(r#"[{"op":"ADD_PHASE_PCT","phase":"AUTO","value":100,"scope":"SELF"}]"#);
        let score = &resolve(&f, &[], 1).robots[0];
        assert_eq!(score.base, [10.49, 72.0, 18.0]);
        assert_eq!(score.points, [21, 72, 18]);
        assert_eq!(score.rp_chance, 92.86);
        assert_eq!(score.rp_hit, score.rp_roll < 92.86);
    }

    #[test]
    fn tie_gives_one_rp_each() {
        let f: Vec<FieldRobot> =
            (0..6).map(|i| robot(i, (i / 3) as usize, (i % 3 + 1) as u8, st(10, 10, 10, [0, 0, 0]))).collect();
        let r = resolve(&f, &[], 3);
        assert_eq!(r.winner, None);
        assert_eq!(r.match_rp, [1, 1]);
    }

    #[test]
    fn parts_flat_pct_and_per_tag_stack_in_order() {
        let mut f = field();
        f[1].parts.push(FieldPart {
            card: "test-part".into(),
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
            assert!(s.points[1] == half_up(base) || s.points[1] == half_up(base * 2.0));
        }
    }

    #[test]
    fn conditions_and_scopes() {
        let mut f = field();
        // Captain (inst 0) gives its alliance +10 Auto, only while it's the captain.
        f[0].effects = fx(
            r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":10,"scope":"ALLIES","when":[{"if":"CAPTAIN","of":"SOURCE"}]}]"#,
        );
        // A robot with +5 RP2 only in station 2.
        f[4].effects =
            fx(r#"[{"op":"ADD_RP_PP","rp":"RP2","value":-100,"scope":"SELF","when":[{"if":"STATION","station":2}]}]"#);
        let r = resolve(&f, &[], 9);
        assert_eq!(r.robots[0].points[0], 40);
        assert_eq!(r.robots[1].points[0], 20);
        assert_eq!(r.robots[3].points[0], 20, "the other alliance isn't reached");
        assert_eq!(r.robots[4].rp_chance, 0.0);
    }

    #[test]
    fn scores_never_go_negative() {
        let mut f = field();
        f[1].effects = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"ALL","value":-100,"scope":"SELF"}]"#);
        let r = resolve(&f, &[], 1);
        assert_eq!(r.robots[1].points, [0, 0, 0]);
    }

    #[test]
    fn every_robot_scores_all_three_base_phases_without_effects() {
        let f = field();
        for seed in 0..100 {
            let r = resolve(&f, &[], seed);
            for score in &r.robots {
                let stats = f.iter().find(|r| r.inst == score.inst).unwrap().stats;
                assert_eq!(score.base, [stats.auto, stats.tele, stats.end]);
                assert_eq!(score.points, stats.base_points());
            }
        }
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
        assert_eq!(half_up(0.5), 1);
        assert_eq!(half_up(1.5), 2);
        assert_eq!(half_up(1.4), 1);
    }
}
