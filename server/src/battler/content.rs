//! The Battler's cards: robot ratings from the frozen pack recipe and Part/Lore cards from the season's support file.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use super::effects::{self, Effect, Owner};
use super::engine::Stats;

pub const SEASON: i32 = 2026;
pub const PACK: &str = "cmp26";

/// The bonus RPs, in slot order. Always RP1, RP2 and RP3 (#134): each season's own names (2026's Energized,
/// Supercharged and Traversal) don't fit cards from other seasons.
pub fn rp_names(_season: i32) -> [&'static str; 3] {
    ["RP1", "RP2", "RP3"]
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
    #[serde(default)]
    pub avatar: bool,
    pub stats: Stats,
    /// An older recipe did not contain imported ratings for this robot.
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
    #[serde(default)]
    region: String,
    #[serde(default)]
    loc: String,
    tier: String,
    #[serde(default)]
    photo: bool,
    #[serde(default)]
    avatar: bool,
    bt: Option<Stats>,
}

#[derive(Deserialize)]
struct Recipe {
    teams: Vec<RecipeTeam>,
}

#[derive(Deserialize)]
struct SupportFile {
    cards: Vec<Support>,
    /// Names for shipped effects, by team number (shown on the card).
    #[serde(default)]
    robot_effect_names: HashMap<String, String>,
    /// Robots' real effects, by team number, shipped with the game (an admin-published one replaces it).
    #[serde(default)]
    robot_effects: HashMap<String, Vec<Effect>>,
    /// Example robot effects for testing only, by team number (used when the admin hasn't written one).
    #[serde(default)]
    test_robot_effects: HashMap<String, Vec<Effect>>,
}

pub struct Content {
    pub robots: Vec<Robot>,
    pub by_team: HashMap<i32, usize>,
    pub support: Vec<Support>,
    pub support_by_id: HashMap<String, usize>,
    /// Effects shipped with the game (`robot_effects`), and examples marked as tests (`test_robot_effects`).
    pub shipped_effects: HashMap<i32, Vec<Effect>>,
    pub shipped_names: HashMap<i32, String>,
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

/// Synthetic stats for admin effect simulations and tests.
pub fn test_stats(team: i32, epa: Option<f64>) -> Stats {
    let epa = epa.filter(|e| e.is_finite() && *e > 0.0).unwrap_or(60.0);
    let n = epa / 3.0;
    let auto = 0.22 + 0.08 * wobble(team, 1);
    let end = 0.16 + 0.08 * wobble(team, 2);
    let tele = 1.0 - auto - end;
    let strength = (epa / 370.0).clamp(0.0, 1.0);
    let rp = |salt| (12.0 + 60.0 * strength + 30.0 * wobble(team, salt)).round().clamp(3.0, 92.0);
    Stats {
        auto: (n * auto).round(),
        tele: (n * tele).round(),
        end: (n * end).round(),
        def: None,
        rp: [rp(3), rp(4), rp(5)],
    }
}

impl Content {
    pub fn load(data_dir: &Path) -> anyhow::Result<Content> {
        let rpath = data_dir.join("packs").join(format!("{PACK}.json"));
        let recipe: Recipe = serde_json::from_str(
            &std::fs::read_to_string(&rpath).with_context(|| format!("reading {}", rpath.display()))?,
        )?;
        let robots: Vec<Robot> = recipe
            .teams
            .into_iter()
            .map(|t| {
                let test = t.bt.is_none();
                let stats = t.bt.unwrap_or_default();
                Robot {
                    id: format!("R-{SEASON}-{}", t.num),
                    team: t.num,
                    name: t.name,
                    season: SEASON,
                    region: if t.region.is_empty() { t.loc } else { t.region },
                    tier: t.tier,
                    photo: t.photo,
                    avatar: t.avatar,
                    stats,
                    test_stats: test,
                }
            })
            .collect();
        let by_team = robots.iter().enumerate().map(|(i, r)| (r.team, i)).collect();

        let spath = data_dir.join("battler").join(format!("support-{SEASON}.json"));
        let file: SupportFile = serde_json::from_str(
            &std::fs::read_to_string(&spath).with_context(|| format!("reading {}", spath.display()))?,
        )
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
        let by_team_fx = |map: HashMap<String, Vec<Effect>>, what: &str| -> anyhow::Result<HashMap<i32, Vec<Effect>>> {
            let mut out = HashMap::new();
            for (team, fx) in map {
                let team: i32 = team.parse().with_context(|| format!("{what} for team {team}"))?;
                effects::validate(&fx, Owner::Robot).map_err(|e| anyhow::anyhow!("{what} for {team}: {e}"))?;
                out.insert(team, fx);
            }
            Ok(out)
        };
        let shipped_effects = by_team_fx(file.robot_effects, "effect")?;
        let mut shipped_names = HashMap::new();
        for (team, name) in file.robot_effect_names {
            let team: i32 = team.parse().with_context(|| format!("effect name for team {team}"))?;
            anyhow::ensure!(shipped_effects.contains_key(&team), "effect name for {team}, which has no shipped effect");
            shipped_names.insert(team, name);
        }
        let test_effects = by_team_fx(file.test_robot_effects, "test effect")?;
        Ok(Content { robots, by_team, support, support_by_id, shipped_effects, shipped_names, test_effects })
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
        assert!(c.robot(4414).unwrap().avatar);
        let parts = c.support.iter().filter(|s| s.kind == Kind::Part).count();
        let lore = c.support.iter().filter(|s| s.kind == Kind::Lore).count();
        assert!(parts >= 15 && lore >= 5, "{parts} parts, {lore} lore");
        assert!(c.support.iter().all(|s| !s.text.is_empty()));
    }

    #[test]
    fn test_stats_are_on_the_spec_scale() {
        let top = test_stats(4414, Some(368.0));
        assert!((90.0..=150.0).contains(&(top.auto + top.tele + top.end)), "{top:?}");
        assert!(top.tele > top.auto && top.tele > top.end);
        assert_eq!(test_stats(4414, Some(368.0)), top, "stable");
        assert!(top.rp.iter().all(|r| (3.0..=92.0).contains(r)));
    }
}
