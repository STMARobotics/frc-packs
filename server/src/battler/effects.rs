//! Card effects as data (Battler spec §5.6): every robot, part and lore effect is a list of [`Effect`]s built from a
//! fixed set of operations, conditions and scopes. Nothing here runs code typed into the admin form, and the text a
//! player reads is generated from the same data the engine runs ([`describe`]), so the two can't disagree.

use serde::{Deserialize, Serialize};

/// The five base part tags, and the subtypes allowed under each (spec §5.2). A part has exactly one base tag and at
/// most one subtype from its base's list.
pub const TAGS: &[(&str, &[&str])] = &[
    ("HARDWARE", &["BOLT", "NUT", "WASHER"]),
    ("TOOLS", &["HEX_KEY", "WRENCH", "DRILL"]),
    ("MECHANICAL", &["BELT", "PULLEY", "CHAIN", "GEAR", "SPROCKET"]),
    ("WHEELS", &["COMPLIANT", "STEALTH", "TRACTION", "STAR"]),
    ("ELECTRICAL", &["MOTOR", "SYSTEMCORE", "SENSOR", "VISION"]),
];

pub fn is_tag(t: &str) -> bool {
    TAGS.iter().any(|(b, subs)| *b == t || subs.contains(&t))
}

/// A match phase, or all three.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "UPPERCASE")]
pub enum Phase {
    Auto,
    Tele,
    End,
    All,
}

impl Phase {
    pub fn covers(self, p: Phase) -> bool {
        self == p || self == Phase::All
    }
    fn word(self) -> &'static str {
        match self {
            Phase::Auto => "Auto",
            Phase::Tele => "Tele",
            Phase::End => "End",
            Phase::All => "Auto, Tele and End",
        }
    }
}

/// Which RP chance an effect changes: one slot, or whichever the robot's driver station uses.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "UPPERCASE")]
pub enum RpSlot {
    Rp1,
    Rp2,
    Rp3,
    Station,
}

/// Which robots an effect reaches, seen from its source (the robot the effect is on, or the robot a part is attached
/// to; for lore, the player who played it).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "UPPERCASE")]
pub enum Scope {
    /// The robot itself (a part: the robot it's attached to). Not allowed on lore.
    #[serde(rename = "SELF")]
    Itself,
    /// Every robot on the source's alliance, itself included.
    Allies,
    /// Every robot on the other alliance.
    Enemies,
    /// All six robots on the field.
    Field,
}

/// What an effect does to each robot it reaches.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "op", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Op {
    /// +value points in a phase (negative takes points away).
    AddPhaseFlat { phase: Phase, value: i32 },
    /// +value percent in a phase. Percent bonuses add up, then apply once.
    AddPhasePct { phase: Phase, value: i32 },
    /// Multiplies a phase (200 = double). When several apply, their bonuses above 1x add: 2x and 2x make 3x.
    AddPhaseMultiplier { phase: Phase, percent: i32 },
    /// +value percentage points to an RP chance.
    AddRpPp { rp: RpSlot, value: i32 },
    /// +value points in a phase for each attached part carrying the tag.
    PerPartTag { tag: String, phase: Phase, value: i32 },
}

/// A test on the robot an effect reaches (or, with `of: SOURCE`, on the source robot).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "if", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Cond {
    /// Has at least `min` attached parts carrying the tag (base or subtype).
    HasPartTag {
        tag: String,
        #[serde(default = "one")]
        min: u8,
        #[serde(default)]
        of: Of,
    },
    /// Is in this driver station.
    Station {
        station: u8,
        #[serde(default)]
        of: Of,
    },
    /// Is (or isn't) its player's Alliance Captain.
    Captain {
        #[serde(default = "yes")]
        is: bool,
        #[serde(default)]
        of: Of,
    },
    /// At least one lore card is active this round.
    LoreActive,
}

fn one() -> u8 {
    1
}
fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum Of {
    #[default]
    Target,
    Source,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Effect {
    #[serde(flatten)]
    pub op: Op,
    pub scope: Scope,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub when: Vec<Cond>,
    /// Percent chance, rolled once per robot reached; none = always.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chance: Option<u8>,
}

/// What kind of card an effect list belongs to, for the rules that differ.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Owner {
    Robot,
    Part,
    Lore,
}

/// Checks an effect list against the rules a published card must meet. Returns what's wrong, if anything.
pub fn validate(effects: &[Effect], owner: Owner) -> Result<(), String> {
    if effects.is_empty() {
        return Err("a card needs at least one effect".into());
    }
    if effects.len() > 3 {
        return Err("at most three effects per card".into());
    }
    for e in effects {
        if owner == Owner::Lore && e.scope == Scope::Itself {
            return Err("lore isn't attached to a robot, so it can't target SELF".into());
        }
        if let Some(c) = e.chance
            && !(1..=99).contains(&c)
        {
            return Err("a chance must be 1 to 99 percent (leave it out for always)".into());
        }
        match &e.op {
            Op::AddPhaseFlat { value, .. } | Op::PerPartTag { value, .. } if !(-100..=100).contains(value) => {
                return Err("points must be between -100 and 100".into());
            }
            Op::AddPhasePct { value, .. } if !(-90..=300).contains(value) => {
                return Err("a percent bonus must be between -90 and 300".into());
            }
            Op::AddPhaseMultiplier { percent, .. } if !(110..=400).contains(percent) => {
                return Err("a multiplier must be between 110% and 400%".into());
            }
            Op::AddRpPp { value, .. } if !(-100..=100).contains(value) => {
                return Err("RP points must be between -100 and 100".into());
            }
            Op::PerPartTag { tag, .. } if !is_tag(tag) => return Err(format!("unknown part tag {tag}")),
            _ => {}
        }
        for c in &e.when {
            if owner == Owner::Lore
                && matches!(
                    c,
                    Cond::HasPartTag { of: Of::Source, .. } | Cond::Station { of: Of::Source, .. } | Cond::Captain { of: Of::Source, .. }
                )
            {
                return Err("lore has no source robot".into());
            }
            match c {
                Cond::HasPartTag { tag, min, .. } => {
                    if !is_tag(tag) {
                        return Err(format!("unknown part tag {tag}"));
                    }
                    if !(1..=6).contains(min) {
                        return Err("a part count must be 1 to 6".into());
                    }
                }
                Cond::Station { station, .. } if !(1..=3).contains(station) => {
                    return Err("driver stations are 1, 2 and 3".into());
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// The rules text for an effect list, generated from the data (so it always says what the engine does).
pub fn describe(effects: &[Effect], owner: Owner) -> String {
    effects.iter().map(|e| describe_one(e, owner)).collect::<Vec<_>>().join(" ")
}

fn signed(v: i32) -> String {
    if v >= 0 { format!("+{v}") } else { v.to_string() }
}

fn tag_word(t: &str) -> String {
    t.replace('_', " ")
}

fn describe_one(e: &Effect, owner: Owner) -> String {
    let who = match (e.scope, owner) {
        (Scope::Itself, Owner::Part) => "The robot it's attached to",
        (Scope::Itself, _) => "This robot",
        (Scope::Allies, Owner::Lore) => "Your robots",
        (Scope::Allies, _) => "Robots on this alliance",
        (Scope::Enemies, _) => "Opposing robots",
        (Scope::Field, _) => "Every robot on the field",
    };
    let plural = matches!(e.scope, Scope::Allies | Scope::Enemies);
    let what = match &e.op {
        Op::AddPhaseFlat { phase, value } => format!("{} {}", signed(*value), phase.word()),
        Op::AddPhasePct { phase, value } => format!("{}% {}", signed(*value), phase.word()),
        Op::AddPhaseMultiplier { phase, percent } => match percent {
            200 => format!("double {}", phase.word()),
            300 => format!("triple {}", phase.word()),
            p => format!("{}x {}", format_mult(*p), phase.word()),
        },
        Op::AddRpPp { rp, value } => match rp {
            RpSlot::Station => format!("{} to its station's RP chance", signed(*value)),
            RpSlot::Rp1 => format!("{} RP1 chance", signed(*value)),
            RpSlot::Rp2 => format!("{} RP2 chance", signed(*value)),
            RpSlot::Rp3 => format!("{} RP3 chance", signed(*value)),
        },
        Op::PerPartTag { tag, phase, value } => {
            format!("{} {} for each {} part attached", signed(*value), phase.word(), tag_word(tag))
        }
    };
    let mult = matches!(e.op, Op::AddPhaseMultiplier { .. });
    let mut s = match (e.chance, mult) {
        (Some(c), true) => format!("{who}: {c}% chance to {what}"),
        (Some(c), false) => format!("{who}: {c}% chance of {what}"),
        (None, true) => format!("{who}: {what}"),
        (None, false) => format!("{who} {} {what}", if plural { "get" } else { "gets" }),
    };
    let conds: Vec<String> = e.when.iter().map(|c| describe_cond(c, owner)).collect();
    if !conds.is_empty() {
        s.push_str(" if ");
        s.push_str(&conds.join(" and "));
    }
    s.push('.');
    s
}

fn format_mult(p: i32) -> String {
    let whole = p / 100;
    let frac = p % 100;
    if frac == 0 { whole.to_string() } else { format!("{whole}.{}", format!("{frac:02}").trim_end_matches('0')) }
}

fn describe_cond(c: &Cond, owner: Owner) -> String {
    let subj = |of: &Of| match (of, owner) {
        (Of::Source, Owner::Part) => "the robot it's attached to",
        (Of::Source, _) => "this robot",
        (Of::Target, _) => "it",
    };
    match c {
        Cond::HasPartTag { tag, min, of } => {
            let has = if subj(of) == "it" { "it has".to_string() } else { format!("{} has", subj(of)) };
            if *min == 1 {
                format!("{has} a {} part", tag_word(tag))
            } else {
                format!("{has} {min}+ {} parts", tag_word(tag))
            }
        }
        Cond::Station { station, of } => {
            let s = subj(of);
            if s == "it" { format!("it's in Station {station}") } else { format!("{s} is in Station {station}") }
        }
        Cond::Captain { is, of } => {
            let s = subj(of);
            match (s == "it", is) {
                (true, true) => "it's the Captain".into(),
                (true, false) => "it isn't the Captain".into(),
                (false, true) => format!("{s} is the Captain"),
                (false, false) => format!("{s} isn't the Captain"),
            }
        }
        Cond::LoreActive => "a lore card is active".into(),
    }
}

/// Checks a part's tags: exactly one base tag, then at most one subtype that belongs to it.
pub fn validate_tags(tags: &[String]) -> Result<(), String> {
    let Some(base) = tags.first() else { return Err("a part needs a base tag".into()) };
    let Some((_, subs)) = TAGS.iter().find(|(b, _)| b == base) else {
        return Err(format!("{base} isn't a base tag (HARDWARE, TOOLS, MECHANICAL, WHEELS, ELECTRICAL)"));
    };
    match tags.len() {
        1 => Ok(()),
        2 if subs.contains(&tags[1].as_str()) => Ok(()),
        2 => Err(format!("{} isn't a subtype of {base}", tags[1])),
        _ => Err("a part has one or two tags, never more".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(json: &str) -> Vec<Effect> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn text_matches_the_spec_examples() {
        let e = fx(r#"[{"op":"PER_PART_TAG","tag":"MECHANICAL","phase":"TELE","value":8,"scope":"SELF"}]"#);
        assert_eq!(describe(&e, Owner::Robot), "This robot gets +8 Tele for each MECHANICAL part attached.");
        let e = fx(r#"[{"op":"ADD_RP_PP","rp":"RP2","value":5,"scope":"SELF","when":[{"if":"STATION","station":2}]}]"#);
        assert_eq!(describe(&e, Owner::Robot), "This robot gets +5 RP2 chance if it's in Station 2.");
        let e = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":10,"scope":"SELF","when":[{"if":"HAS_PART_TAG","tag":"VISION"}]}]"#);
        assert_eq!(describe(&e, Owner::Robot), "This robot gets +10 Auto if it has a VISION part.");
        let e = fx(r#"[{"op":"ADD_PHASE_MULTIPLIER","phase":"TELE","percent":200,"scope":"FIELD","chance":50}]"#);
        assert_eq!(describe(&e, Owner::Lore), "Every robot on the field: 50% chance to double Tele.");
        let e = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":10,"scope":"ALLIES","when":[{"if":"CAPTAIN","of":"SOURCE"}]}]"#);
        assert_eq!(describe(&e, Owner::Robot), "Robots on this alliance get +10 Auto if this robot is the Captain.");
    }

    #[test]
    fn validation_rejects_bad_cards() {
        let lore_self = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":10,"scope":"SELF"}]"#);
        assert!(validate(&lore_self, Owner::Lore).is_err());
        assert!(validate(&lore_self, Owner::Robot).is_ok());
        assert!(validate(&[], Owner::Robot).is_err());
        let bad_tag = fx(r#"[{"op":"PER_PART_TAG","tag":"LASER","phase":"TELE","value":5,"scope":"SELF"}]"#);
        assert!(validate(&bad_tag, Owner::Part).is_err());
        let sure = fx(r#"[{"op":"ADD_PHASE_FLAT","phase":"AUTO","value":10,"scope":"SELF","chance":100}]"#);
        assert!(validate(&sure, Owner::Part).is_err());
    }

    #[test]
    fn tags_follow_the_one_base_one_subtype_rule() {
        let t = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(validate_tags(&t(&["ELECTRICAL", "VISION"])).is_ok());
        assert!(validate_tags(&t(&["MECHANICAL"])).is_ok());
        assert!(validate_tags(&t(&[])).is_err());
        assert!(validate_tags(&t(&["ELECTRICAL", "VISION", "MOTOR"])).is_err());
        assert!(validate_tags(&t(&["ELECTRICAL", "MECHANICAL"])).is_err());
        assert!(validate_tags(&t(&["VISION"])).is_err());
        assert!(validate_tags(&t(&["MECHANICAL", "VISION"])).is_err());
    }
}
