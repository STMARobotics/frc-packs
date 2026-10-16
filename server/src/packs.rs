//! Pack recipes: everything about a pack lives in a data file (data/packs/<id>.json), built by tools/build_packs.py.
//! Adding a pack means adding a recipe, not code.

use std::collections::{BTreeMap, HashMap};
use std::ops::Deref;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

use crate::db::{Db, get_n, get_s};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Mythic,
    Legendary,
    Rare,
    Uncommon,
    Common,
}

impl Tier {
    /// Best first.
    pub const ORDER: [Tier; 5] = [Tier::Mythic, Tier::Legendary, Tier::Rare, Tier::Uncommon, Tier::Common];

    /// 0 for Mythic up to 4 for Common.
    pub fn rank(self) -> usize {
        Tier::ORDER.iter().position(|t| *t == self).unwrap()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Mythic => "mythic",
            Tier::Legendary => "legendary",
            Tier::Rare => "rare",
            Tier::Uncommon => "uncommon",
            Tier::Common => "common",
        }
    }

    pub fn parse(s: &str) -> Option<Tier> {
        Tier::ORDER.into_iter().find(|t| t.as_str() == s)
    }

    /// Parts for scrapping one extra copy. A boosted pack costs about five packs' worth of scrapped duplicates.
    pub fn scrap_parts(self) -> i32 {
        match self {
            Tier::Common => 5,
            Tier::Uncommon => 12,
            Tier::Rare => 40,
            Tier::Legendary => 150,
            Tier::Mythic => 600,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Odds {
    /// Per card in slots 1 to 4.
    pub slots: HashMap<Tier, f64>,
    /// The last slot when it isn't a Mythic or a guaranteed Legendary.
    pub last: HashMap<Tier, f64>,
    pub mythic_base: f64,
    pub demo_mythic: f64,
    /// The Mythic chance climbs after `soft` packs without one and reaches 100% at `hard`.
    pub soft: u32,
    pub hard: u32,
    /// Legendary or better at least every `leg_every` packs.
    pub leg_every: u32,
    /// A boosted pack (crafted from parts). Recipes can set their own; otherwise `Boost::default()`.
    #[serde(default)]
    pub boosted: Boost,
}

/// Odds for a boosted pack: better slots, a better last card, and a multiplied Mythic chance. The pity meters still
/// count and still guarantee as usual.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Boost {
    pub slots: HashMap<Tier, f64>,
    pub last: HashMap<Tier, f64>,
    pub mythic_mult: f64,
}

impl Default for Boost {
    fn default() -> Boost {
        Boost {
            slots: HashMap::from([
                (Tier::Common, 0.40),
                (Tier::Uncommon, 0.35),
                (Tier::Rare, 0.20),
                (Tier::Legendary, 0.05),
            ]),
            last: HashMap::from([(Tier::Rare, 0.60), (Tier::Legendary, 0.40)]),
            mythic_mult: 4.0,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Team {
    pub num: i32,
    pub name: String,
    pub div: String,
    pub tier: Tier,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub claimable: bool,
    pub odds: Odds,
    pub teams: Vec<Team>,
}

#[derive(Debug)]
pub struct Pack {
    pub recipe: Recipe,
    pub pools: HashMap<Tier, Vec<i32>>,
    pub divisions: BTreeMap<String, Vec<i32>>,
    pub team_div: HashMap<i32, String>,
    pub team_tier: HashMap<i32, Tier>,
}

impl Pack {
    pub fn new(recipe: Recipe) -> anyhow::Result<Pack> {
        let mut pools: HashMap<Tier, Vec<i32>> = HashMap::new();
        let mut divisions: BTreeMap<String, Vec<i32>> = BTreeMap::new();
        let mut team_div = HashMap::new();
        let mut team_tier = HashMap::new();
        for t in &recipe.teams {
            if team_tier.insert(t.num, t.tier).is_some() {
                bail!("pack {}: team {} is listed twice", recipe.id, t.num);
            }
            pools.entry(t.tier).or_default().push(t.num);
            divisions.entry(t.div.clone()).or_default().push(t.num);
            team_div.insert(t.num, t.div.clone());
        }
        for tier in Tier::ORDER {
            if pools.get(&tier).is_none_or(|p| p.len() < 5) {
                bail!("pack {}: needs at least 5 {} teams", recipe.id, tier.as_str());
            }
        }
        let o = &recipe.odds;
        for (name, w) in [
            ("slots", &o.slots),
            ("last", &o.last),
            ("boosted slots", &o.boosted.slots),
            ("boosted last", &o.boosted.last),
        ] {
            let sum: f64 = w.values().sum();
            if (sum - 1.0).abs() > 1e-9 {
                bail!("pack {}: {name} odds add up to {sum}, not 1", recipe.id);
            }
        }
        if o.soft >= o.hard || o.leg_every == 0 {
            bail!("pack {}: bad pity settings", recipe.id);
        }
        Ok(Pack { recipe, pools, divisions, team_div, team_tier })
    }

    pub fn id(&self) -> &str {
        &self.recipe.id
    }
}

#[derive(Debug)]
pub struct Catalog {
    pub packs: Vec<Pack>,
}

impl Catalog {
    pub fn load(dir: &Path) -> anyhow::Result<Catalog> {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .with_context(|| format!("reading {}", dir.display()))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        let mut packs = Vec::new();
        for f in files {
            let text = std::fs::read_to_string(&f).with_context(|| format!("reading {}", f.display()))?;
            let recipe: Recipe = serde_json::from_str(&text).with_context(|| format!("parsing {}", f.display()))?;
            packs.push(Pack::new(recipe)?);
        }
        if packs.is_empty() {
            bail!("no pack recipes in {}", dir.display());
        }
        if packs.iter().filter(|p| p.recipe.claimable).count() != 1 {
            bail!("exactly one pack must be claimable (the free pack)");
        }
        Ok(Catalog { packs })
    }

    /// The same catalog with some teams' rarities changed (team number to rarity, for the first pack that lists the
    /// team). Fails when the result doesn't leave every rarity enough teams to fill a pack.
    pub fn with_overrides(&self, overrides: &Overrides) -> anyhow::Result<Catalog> {
        let mut packs = Vec::new();
        for p in &self.packs {
            let mut recipe = p.recipe.clone();
            for t in &mut recipe.teams {
                if let Some(tier) = overrides.get(&t.num) {
                    t.tier = *tier;
                }
            }
            packs.push(Pack::new(recipe)?);
        }
        Ok(Catalog { packs })
    }

    pub fn get(&self, id: &str) -> Option<&Pack> {
        self.packs.iter().find(|p| p.id() == id)
    }

    /// The pack that free claims and new accounts receive.
    pub fn claimable(&self) -> &Pack {
        self.packs.iter().find(|p| p.recipe.claimable).unwrap()
    }
}

/// Rarity changes the admin made on top of the recipe files: team number to rarity.
pub type Overrides = BTreeMap<i32, Tier>;

/// The rarity changes and their version, as saved in the settings item.
pub fn read_overrides(settings: &crate::db::Item) -> (Overrides, i64) {
    let map: BTreeMap<String, Tier> =
        get_s(settings, "tier_overrides").and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    (
        map.into_iter().filter_map(|(k, v)| k.parse().ok().map(|n| (n, v))).collect(),
        get_n(settings, "tiers_ver").unwrap_or(0),
    )
}

/// A pack looked up in the catalog that was current when asked. It keeps that catalog alive, so a request sees one
/// consistent set of rarities even if the admin changes them partway through.
pub struct PackRef {
    cat: Arc<Catalog>,
    idx: usize,
}

impl Deref for PackRef {
    type Target = Pack;
    fn deref(&self) -> &Pack {
        &self.cat.packs[self.idx]
    }
}

impl PackRef {
    pub fn new(cat: Arc<Catalog>, id: &str) -> Option<PackRef> {
        let idx = cat.packs.iter().position(|p| p.id() == id)?;
        Some(PackRef { cat, idx })
    }
}

struct Current {
    cat: Arc<Catalog>,
    ver: i64,
    overrides: Overrides,
    checked: Instant,
}

/// The catalog the game runs on: the recipe files plus the admin's rarity changes. Every server instance re-reads the
/// saved changes at most every few seconds, so a change shows up everywhere almost at once without a deploy.
pub struct Live {
    base: Catalog,
    cur: RwLock<Current>,
}

const REFRESH: Duration = Duration::from_secs(3);

impl Live {
    pub fn new(base: Catalog) -> Live {
        let cat = Arc::new(base.with_overrides(&Overrides::new()).expect("the recipe files are valid"));
        Live {
            base,
            cur: RwLock::new(Current { cat, ver: 0, overrides: Overrides::new(), checked: Instant::now() - REFRESH }),
        }
    }

    /// The recipe files alone, before any admin changes.
    pub fn base(&self) -> &Catalog {
        &self.base
    }

    /// The current catalog, its version and the changes it holds.
    pub async fn get(&self, db: &Db) -> (Arc<Catalog>, i64, Overrides) {
        let due = {
            let c = self.cur.read().unwrap();
            c.checked.elapsed() >= REFRESH
        };
        if due {
            match crate::model::settings_item(db).await {
                Ok(item) => self.adopt(read_overrides(&item)),
                Err(e) => tracing::warn!("couldn't check for rarity changes: {e}"),
            }
        }
        let c = self.cur.read().unwrap();
        (c.cat.clone(), c.ver, c.overrides.clone())
    }

    /// Switches to these changes right away (the admin just saved them, or they were read from the database).
    pub fn adopt(&self, (overrides, ver): (Overrides, i64)) {
        let mut c = self.cur.write().unwrap();
        c.checked = Instant::now();
        if ver == c.ver && overrides == c.overrides {
            return;
        }
        match self.base.with_overrides(&overrides) {
            Ok(cat) => {
                c.cat = Arc::new(cat);
                c.ver = ver;
                c.overrides = overrides;
            }
            Err(e) => tracing::error!("saved rarity changes don't fit the packs, ignoring them: {e:#}"),
        }
    }
}
