//! The Battler's cards: robots from the pack recipe (with their imported stats, or clearly marked test stats until
//! Statbotics comes back), and the Part and Lore cards from data/battler/support-<season>.json.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use super::effects::{self, Effect, Owner};
use super::engine::Stats;

pub const SEASON: i32 = 2026;
pub const PACK: &str = "cmp26";

/// The season's bonus RPs, in slot order (spec §4.3).
pub fn rp_names(season: i32) -> [&'static str; 3] {
    match season {
        2025 => ["Auto", "Coral", "Barge"],
        _ => ["Energized", "Supercharged", "Traversal"],
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Robot {
    /// Canonical card id, e.g. "R-2026-4414": the same team in another season is another card.
    pub id: String,
    pub team: i32,
    pub name: String,
    pub season: i32,
    pub region: String,
    pub tier: String,
    pub photo: bool,
    pub stats: Stats,
    /// The stats are placeholders (made from Champs EPA) until the Statbotics import runs.
    pub test_stats: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Kind {
    Part,
    Lore,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Support {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub season: i32,
    #[serde(default)]
    pub tags: Vec<String>,
    pub effects: Vec<Effect>,
    /// Generated from `effects`, never typed by hand.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub flavor: String,
    /// Still a draft (balance not approved yet).
    #[serde(default)]
    pub draft: bool,
}

#[derive(Deserialize)]
struct RecipeTeam {
    num: i32,
    name: String,
    epa: Option<f64>,
    #[serde(default)]
    region: String,
    #[serde(default)]
    loc: String,
    tier: String,
    #[serde(default)]
    photo: bool,
    bt: Option<Bt>,
}

#[derive(Deserialize)]
struct Bt {
    auto: i32,
    tele: i32,
    end: i32,
    rp: [i32; 3],
}

#[derive(Deserialize)]
struct Recipe {
    teams: Vec<RecipeTeam>,
}

#[derive(Deserialize)]
struct SupportFile {
    cards: Vec<Support>,
    /// Example robot effects for testing only, by team number (used when the admin hasn't written one).
    #[serde(default)]
    test_robot_effects: HashMap<String, Vec<Effect>>,
}

pub struct Content {
    pub robots: Vec<Robot>,
    pub by_team: HashMap<i32, usize>,
    pub support: Vec<Support>,
    pub support_by_id: HashMap<String, usize>,
    pub test_effects: HashMap<i32, Vec<Effect>>,
}

/// Small, stable variation per team for test stats (so every robot isn't the same shape).
fn wobble(team: i32, salt: i32) -> f64 {
    let mut x = (team as u32).wrapping_mul(2_654_435_761).wrapping_add((salt as u32).wrapping_mul(40_503));
    x ^= x >> 13;
    x = x.wrapping_mul(1_274_126_177);
    x ^= x >> 16;
    f64::from(x % 1000) / 1000.0 - 0.5
}

/// Placeholder stats from Champs EPA, on the same scale as the spec's example (a top robot about 30 / 72 / 18).
pub fn test_stats(team: i32, epa: Option<f64>) -> Stats {
    let epa = epa.filter(|e| e.is_finite() && *e > 0.0).unwrap_or(60.0);
    let n = epa / 3.0;
    let auto = 0.22 + 0.08 * wobble(team, 1);
    let end = 0.16 + 0.08 * wobble(team, 2);
    let tele = 1.0 - auto - end;
    let strength = (epa / 370.0).clamp(0.0, 1.0);
    let rp = |salt| ((12.0 + 60.0 * strength + 30.0 * wobble(team, salt)).round() as i32).clamp(3, 92);
    Stats {
        auto: (n * auto).round() as i32,
        tele: (n * tele).round() as i32,
        end: (n * end).round() as i32,
        rp: [rp(3), rp(4), rp(5)],
    }
}

impl Content {
    pub fn load(data_dir: &Path) -> anyhow::Result<Content> {
        let rpath = data_dir.join("packs").join(format!("{PACK}.json"));
        let recipe: Recipe =
            serde_json::from_str(&std::fs::read_to_string(&rpath).with_context(|| format!("reading {}", rpath.display()))?)?;
        let robots: Vec<Robot> = recipe
            .teams
            .into_iter()
            .map(|t| {
                let (stats, test) = match t.bt {
                    Some(b) => (Stats { auto: b.auto, tele: b.tele, end: b.end, rp: b.rp }, false),
                    None => (test_stats(t.num, t.epa), true),
                };
                Robot {
                    id: format!("R-{SEASON}-{}", t.num),
                    team: t.num,
                    name: t.name,
                    season: SEASON,
                    region: if t.region.is_empty() { t.loc } else { t.region },
                    tier: t.tier,
                    photo: t.photo,
                    stats,
                    test_stats: test,
                }
            })
            .collect();
        let by_team = robots.iter().enumerate().map(|(i, r)| (r.team, i)).collect();

        let spath = data_dir.join("battler").join(format!("support-{SEASON}.json"));
        let file: SupportFile =
            serde_json::from_str(&std::fs::read_to_string(&spath).with_context(|| format!("reading {}", spath.display()))?)
                .with_context(|| format!("parsing {}", spath.display()))?;
        let mut support = file.cards;
        for c in &mut support {
            let owner = if c.kind == Kind::Part { Owner::Part } else { Owner::Lore };
            effects::validate(&c.effects, owner).map_err(|e| anyhow::anyhow!("{}: {e}", c.id))?;
            if c.kind == Kind::Part {
                effects::validate_tags(&c.tags).map_err(|e| anyhow::anyhow!("{}: {e}", c.id))?;
            } else if !c.tags.is_empty() {
                anyhow::bail!("{}: lore cards have no part tags", c.id);
            }
            c.text = effects::describe(&c.effects, owner);
        }
        let support_by_id = support.iter().enumerate().map(|(i, c)| (c.id.clone(), i)).collect();
        let mut test_effects = HashMap::new();
        for (team, fx) in file.test_robot_effects {
            let team: i32 = team.parse().with_context(|| format!("test effect for team {team}"))?;
            effects::validate(&fx, Owner::Robot).map_err(|e| anyhow::anyhow!("test effect for {team}: {e}"))?;
            test_effects.insert(team, fx);
        }
        Ok(Content { robots, by_team, support, support_by_id, test_effects })
    }

    pub fn robot(&self, team: i32) -> Option<&Robot> {
        self.by_team.get(&team).map(|&i| &self.robots[i])
    }

    pub fn support(&self, id: &str) -> Option<&Support> {
        self.support_by_id.get(id).map(|&i| &self.support[i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_cards_load_and_validate() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data");
        let c = Content::load(&dir).expect("cards load");
        assert!(c.robots.len() > 500);
        let parts = c.support.iter().filter(|s| s.kind == Kind::Part).count();
        let lore = c.support.iter().filter(|s| s.kind == Kind::Lore).count();
        assert!(parts >= 15 && lore >= 5, "{parts} parts, {lore} lore");
        assert!(c.support.iter().all(|s| !s.text.is_empty()));
    }

    #[test]
    fn test_stats_are_on_the_spec_scale() {
        let top = test_stats(4414, Some(368.0));
        assert!((90..=150).contains(&(top.auto + top.tele + top.end)), "{top:?}");
        assert!(top.tele > top.auto && top.tele > top.end);
        assert_eq!(test_stats(4414, Some(368.0)), top, "stable");
        assert!(top.rp.iter().all(|r| (3..=92).contains(r)));
    }
}
