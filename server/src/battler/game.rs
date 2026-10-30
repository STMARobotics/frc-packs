//! One Battler game as a state machine: OPEN -> DECKS -> SCHEDULE -> (PIT -> RESULTS) x 5 -> FINAL. Pure: the
//! server reads the game, calls one of these with the current time, and writes it back on condition nobody else changed
//! it first. Every shuffle and roll comes from the game's secret seed, so a refresh or a retry never re-rolls anything.
//! The seed's hash is shown from the start and the seed itself once the game is over, so players can check nothing was
//! changed along the way.

use rand::SeedableRng;
use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::content::{Kind, Robot, Support};
use super::effects::{Effect, Owner, describe};
use super::engine::{self, FieldLore, FieldPart, FieldRobot, RoundResult, Stats};

pub const ROUNDS: u8 = 5;
pub const DECK_ROBOTS: usize = 10;
pub const SUPPORT_CARDS: usize = 15;
pub const DRAW: usize = 3;
pub const MAX_COPIES: usize = 3;
/// How long the lobby waits for a second player, players get to pick decks, to finish the pit, and to look at results.
pub const OPEN_MS: i64 = 30 * 60_000;
pub const DECKS_MS: i64 = 5 * 60_000;
pub const PIT_MS: i64 = 5 * 60_000;
pub const RESULTS_MS: i64 = 2 * 60_000;
/// Both players review the schedule and ready up before any support cards are drawn.
pub const SCHEDULE_MS: i64 = 2 * 60_000;
/// Time for each draft pick; missing it picks the first robot offered.
pub const DRAFT_MS: i64 = 45_000;
/// Extra time on the first pick, for the pre-game intro both players watch.
pub const INTRO_MS: i64 = 8_000;
/// Robots each player drafts into their pool, and how many are offered at a time.
pub const POOL_SIZE: usize = 10;
pub const OFFER: usize = 3;
/// Misses of the draft timer that cancel the game.
pub const DRAFT_MISSES: u8 = 2;

/// Missing this many pit deadlines forfeits the game.
pub const STRIKES: u8 = 2;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    Open,
    Decks,
    Schedule,
    /// Stored games from before schedules; upgraded on the next request.
    Draft,
    Pit,
    Results,
    Final,
    Cancelled,
}

impl Status {
    pub fn over(self) -> bool {
        matches!(self, Status::Final | Status::Cancelled)
    }
}

/// How a waiting game finds its second player.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Listed for anyone to join (games from before Quick Play).
    #[default]
    Open,
    /// In the Quick Play queue: the next player looking for a game takes it.
    Quick,
    /// Hosted for someone in particular: never listed, and only someone with its code can see or join it.
    Private,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RobotInst {
    pub inst: u32,
    pub card: String,
    pub team: i32,
    pub name: String,
    pub region: String,
    pub tier: String,
    pub photo: bool,
    pub stats: Stats,
    pub test_stats: bool,
    pub effects: Vec<Effect>,
    pub effect_text: String,
    /// The effect is one of the test examples, not an admin-published one.
    pub effect_test: bool,
    /// Whose deck it came from.
    pub from: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SupportInst {
    pub inst: u32,
    pub owner: usize,
    pub card: String,
    pub kind: Kind,
    pub name: String,
    pub tags: Vec<String>,
    pub effects: Vec<Effect>,
    pub text: String,
}

/// A robot as a deck brings it into a game: the card plus its effect at the moment the game starts.
#[derive(Clone, Debug)]
pub struct RobotPick {
    pub robot: Robot,
    pub effects: Vec<Effect>,
    pub effect_test: bool,
}

/// A validated, owned deck, frozen into the game when both players have picked.
#[derive(Clone, Debug)]
pub struct DeckPick {
    pub deck_id: String,
    pub captain: RobotPick,
    pub robots: Vec<RobotPick>,
    pub support: Vec<Support>,
}

/// What a player is setting up in the pit. Private until both lock.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Plan {
    /// (part instance, robot instance)
    pub attach: Vec<(u32, u32)>,
    pub lore: Option<u32>,
    /// The two robots from your pool that go out with your Captain this round.
    #[serde(default)]
    pub partners: [u32; 2],
    /// The robot in driver station 1, 2 and 3.
    pub stations: [u32; 3],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Seat {
    pub uid: Uuid,
    pub name: String,
    pub elo: i32,
    pub deck_id: Option<String>,
    pub captain: u32,
    /// This player's own deck robots (public), not counting the Captain.
    #[serde(default)]
    pub pool: Vec<u32>,
    #[serde(default)]
    pub draft_misses: u8,
    /// Support cards not drawn yet, top first (private).
    pub pile: Vec<u32>,
    pub hand: Vec<u32>,
    pub plan: Plan,
    pub locked: bool,
    pub acked: bool,
    pub rp: i32,
    pub points: i32,
    pub strikes: u8,
}

impl Seat {
    pub fn new(uid: Uuid, name: String, elo: i32) -> Seat {
        Seat {
            uid,
            name,
            elo,
            deck_id: None,
            captain: 0,
            pool: vec![],
            draft_misses: 0,
            pile: vec![],
            hand: vec![],
            plan: Plan::default(),
            locked: false,
            acked: false,
            rp: 0,
            points: 0,
            strikes: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RoundLog {
    pub round: u8,
    pub stations: [[u32; 3]; 2],
    pub attach: [Vec<(u32, u32)>; 2],
    pub lore: [Option<u32>; 2],
    pub result: RoundResult,
    /// Seats that were locked automatically when the pit timer ran out.
    #[serde(default)]
    pub auto_locked: [bool; 2],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Outcome {
    pub winner: Option<usize>,
    /// "complete", "forfeit" or "timeout".
    pub reason: String,
    pub rp: [i32; 2],
    pub points: [i32; 2],
    pub elo_before: [i32; 2],
    pub elo_after: [i32; 2],
}

/// A fixed match: each side's captain and two partners from that side's own deck.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ScheduledMatch {
    pub round: u8,
    pub alliances: [[u32; 3]; 2],
    pub prediction: Prediction,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Prediction {
    /// Base robot points, before effects, support cards or station choices.
    pub scores: [i32; 2],
    /// Complementary win estimates, in seat order (0..1). These are not live Statbotics probabilities.
    pub win_chance: [f64; 2],
    pub test_stats: bool,
}

/// A Statbotics-style logistic score-margin estimate, adapted to the Battler's stat scale.
/// The spread is 20% of the mean alliance score; it is a game estimate, not a calibrated FRC model.
fn predict(scores: [i32; 2], test_stats: bool) -> Prediction {
    let spread = ((f64::from(scores[0]) + f64::from(scores[1])) * 0.1).max(1.0);
    let margin = (f64::from(scores[0]) - f64::from(scores[1])) / spread;
    let first = 1.0 / (1.0 + 10f64.powf(-margin));
    Prediction { scores, win_chance: [first, 1.0 - first], test_stats }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Game {
    pub id: String,
    pub created_at: i64,
    pub status: Status,
    pub rev: u64,
    pub seats: [Option<Seat>; 2],
    /// Picked decks waiting for the other player (not shown to anyone).
    #[serde(default)]
    pub picks: [Option<PickSnap>; 2],
    pub robots: Vec<RobotInst>,
    pub support: Vec<SupportInst>,
    /// The shuffled robots still to be drafted, top first (private except the current offer).
    pub pool: Vec<u32>,
    /// The robots on offer to whoever drafts next (public): the top of `pool`.
    #[serde(default)]
    pub offer: Vec<u32>,
    /// Picks made so far, and who picked first.
    #[serde(default)]
    pub draft_turn: u8,
    #[serde(default)]
    pub draft_first: usize,
    pub round: u8,
    /// This round's robots per side: captain first.
    pub alliances: [[u32; 3]; 2],
    #[serde(default)]
    pub schedule: Vec<ScheduledMatch>,
    pub rounds: Vec<RoundLog>,
    pub seed: u64,
    pub seed_hash: String,
    pub deadline: i64,
    pub outcome: Option<Outcome>,
    pub engine: u32,
    /// The latest quick-chat emotes (newest last). They don't change the game, so they don't bump `rev`.
    #[serde(default)]
    pub emotes: Vec<Emote>,
    #[serde(default)]
    pub emote_seq: u64,
    #[serde(default)]
    pub mode: Mode,
    /// A private game's invite code (empty for the others).
    #[serde(default)]
    pub code: String,
    /// A wager on the match (see crate::wagers): none, stakes on the table (the match waits for them to be agreed or
    /// called off), or locked in escrow.
    #[serde(default)]
    pub wager: Wager,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Wager {
    #[default]
    None,
    Open,
    Locked,
}

/// The quick-chat emotes a player can send during a game.
pub const EMOTES: &[&str] = &["gg", "nice", "oops", "wow", "thinking", "hello"];
/// At most one emote per player this often.
pub const EMOTE_GAP_MS: i64 = 2_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Emote {
    pub side: usize,
    pub id: String,
    pub at: i64,
    pub n: u64,
}

/// A deck pick as stored until the game starts.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PickSnap {
    pub deck_id: String,
    pub robots: Vec<RobotSnap>,
    pub support: Vec<Support>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RobotSnap {
    pub robot: Robot,
    pub effects: Vec<Effect>,
    pub effect_test: bool,
}

/// Why an action was refused (the site shows these).
pub type Refusal = &'static str;

pub fn seed_hash(seed: u64) -> String {
    hex::encode(Sha256::digest(seed.to_le_bytes()))
}

/// The seed for one round's rolls, from the game seed (so rounds don't share rolls).
fn round_seed(seed: u64, round: u8) -> u64 {
    let d = Sha256::digest([seed.to_le_bytes().as_slice(), &[round]].concat());
    u64::from_le_bytes(d[..8].try_into().unwrap())
}

impl Game {
    pub fn new(id: String, host: Seat, seed: u64, now: i64) -> Game {
        Game {
            id,
            created_at: now,
            status: Status::Open,
            rev: 1,
            seats: [Some(host), None],
            picks: [None, None],
            robots: vec![],
            support: vec![],
            pool: vec![],
            offer: vec![],
            draft_turn: 0,
            draft_first: 0,
            round: 0,
            alliances: [[0; 3]; 2],
            schedule: vec![],
            rounds: vec![],
            seed,
            seed_hash: seed_hash(seed),
            deadline: now + OPEN_MS,
            outcome: None,
            engine: engine::ENGINE_VERSION,
            emotes: vec![],
            emote_seq: 0,
            mode: Mode::Open,
            code: String::new(),
            wager: Wager::None,
        }
    }

    pub fn seat(&self, side: usize) -> &Seat {
        self.seats[side].as_ref().expect("both seats are filled after OPEN")
    }

    fn seat_mut(&mut self, side: usize) -> &mut Seat {
        self.seats[side].as_mut().expect("both seats are filled after OPEN")
    }

    /// Which side a player sits on.
    pub fn side_of(&self, uid: Uuid) -> Option<usize> {
        self.seats.iter().position(|s| s.as_ref().is_some_and(|s| s.uid == uid))
    }

    pub fn robot(&self, inst: u32) -> Option<&RobotInst> {
        self.robots.iter().find(|r| r.inst == inst)
    }

    pub fn card(&self, inst: u32) -> Option<&SupportInst> {
        self.support.iter().find(|c| c.inst == inst)
    }

    fn bump(&mut self) {
        self.rev += 1;
    }

    pub fn join(&mut self, guest: Seat, now: i64) -> Result<(), Refusal> {
        if self.status != Status::Open {
            return Err("game_full");
        }
        if self.seats[0].as_ref().is_some_and(|h| h.uid == guest.uid) {
            return Err("own_game");
        }
        self.seats[1] = Some(guest);
        self.status = Status::Decks;
        self.deadline = now + DECKS_MS;
        self.bump();
        Ok(())
    }

    /// The host leaves before anyone joins.
    pub fn cancel(&mut self, side: usize) -> Result<(), Refusal> {
        if self.status != Status::Open || side != 0 {
            return Err("cant_cancel");
        }
        self.status = Status::Cancelled;
        self.bump();
        Ok(())
    }

    pub fn pick_deck(&mut self, side: usize, pick: DeckPick, now: i64) -> Result<(), Refusal> {
        if self.status != Status::Decks {
            return Err("not_picking");
        }
        if self.picks[side].is_some() {
            return Err("already_picked");
        }
        let snap = |p: RobotPick| RobotSnap { robot: p.robot, effects: p.effects, effect_test: p.effect_test };
        let mut robots = vec![snap(pick.captain)];
        robots.extend(pick.robots.into_iter().map(snap));
        self.seat_mut(side).deck_id = Some(pick.deck_id.clone());
        self.picks[side] = Some(PickSnap { deck_id: pick.deck_id, robots, support: pick.support });
        self.bump();
        self.start_if_ready(now);
        Ok(())
    }

    /// Starts once both decks are picked, unless a wager is still being agreed.
    fn start_if_ready(&mut self, now: i64) {
        if self.status == Status::Decks && self.picks.iter().all(Option::is_some) && self.wager != Wager::Open {
            self.start(now);
        }
    }

    /// Stakes went on the table (`open`) or came off it. Only in a private match, before it starts.
    pub fn set_wager(&mut self, open: bool, now: i64) -> Result<(), Refusal> {
        if self.mode != Mode::Private || self.status != Status::Decks || self.wager == Wager::Locked {
            return Err("no_wager_here");
        }
        self.wager = if open { Wager::Open } else { Wager::None };
        self.bump();
        self.start_if_ready(now);
        Ok(())
    }

    /// Both players agreed and the stakes are in escrow.
    pub fn lock_wager(&mut self, now: i64) -> Result<(), Refusal> {
        if self.status != Status::Decks || self.wager != Wager::Open {
            return Err("no_wager_here");
        }
        self.wager = Wager::Locked;
        self.bump();
        self.start_if_ready(now);
        Ok(())
    }

    /// Robots (by team) in the deck a player picked, for a pink slip.
    pub fn deck_teams(&self, side: usize) -> Option<Vec<i32>> {
        self.picks[side].as_ref().map(|p| p.robots.iter().map(|r| r.robot.team).collect())
    }

    /// Both decks are in: freeze them, shuffle support decks, then schedule each player's own robots.
    fn start(&mut self, now: i64) {
        let mut rng = StdRng::seed_from_u64(self.seed);
        let mut next = 1u32;
        let picks = [self.picks[0].take().unwrap(), self.picks[1].take().unwrap()];
        for (side, p) in picks.iter().enumerate() {
            for (k, r) in p.robots.iter().enumerate() {
                let inst = next;
                next += 1;
                self.robots.push(RobotInst {
                    inst,
                    card: r.robot.id.clone(),
                    team: r.robot.team,
                    name: r.robot.name.clone(),
                    region: r.robot.region.clone(),
                    tier: r.robot.tier.clone(),
                    photo: r.robot.photo,
                    stats: r.robot.stats,
                    test_stats: r.robot.test_stats,
                    effect_text: if r.effects.is_empty() { String::new() } else { describe(&r.effects, Owner::Robot) },
                    effects: r.effects.clone(),
                    effect_test: r.effect_test,
                    from: side,
                });
                if k == 0 {
                    self.seat_mut(side).captain = inst;
                }
            }
        }
        for side in 0..2 {
            self.alliances[side] = [self.seat(side).captain, 0, 0];
        }
        let mut inst = 1000u32;
        for (side, p) in picks.iter().enumerate() {
            let mut pile = vec![];
            for c in &p.support {
                self.support.push(SupportInst {
                    inst,
                    owner: side,
                    card: c.id.clone(),
                    kind: c.kind.clone(),
                    name: c.name.clone(),
                    tags: c.tags.clone(),
                    effects: c.effects.clone(),
                    text: c.text.clone(),
                });
                pile.push(inst);
                inst += 1;
            }
            pile.shuffle(&mut rng);
            self.seat_mut(side).pile = pile;
        }
        self.schedule_matches(now);
    }

    fn schedule_matches(&mut self, now: i64) {
        // A separate seeded stream fixes the schedule independently of support shuffling and match rolls.
        let mut rng = StdRng::seed_from_u64(self.seed ^ 0x5C4E_D01E);
        for side in 0..2 {
            let captain = self.seat(side).captain;
            let mut own: Vec<u32> =
                self.robots.iter().filter(|r| r.from == side && r.inst != captain).map(|r| r.inst).collect();
            own.shuffle(&mut rng);
            let seat = self.seat_mut(side);
            seat.pool = own;
            seat.acked = false;
            seat.locked = false;
        }
        self.schedule = (0..ROUNDS)
            .map(|round| {
                let alliances = std::array::from_fn(|side| {
                    let seat = self.seat(side);
                    let at = usize::from(round) * 2;
                    [seat.captain, seat.pool[at], seat.pool[at + 1]]
                });
                let scores = alliances.map(|a| {
                    a.iter()
                        .map(|i| {
                            let s = self.robot(*i).expect("scheduled robot").stats;
                            s.auto.max(0) + s.tele.max(0) + s.end.max(0)
                        })
                        .sum()
                });
                let test_stats = alliances.iter().flatten().any(|i| self.robot(*i).unwrap().test_stats);
                ScheduledMatch { round: round + 1, alliances, prediction: predict(scores, test_stats) }
            })
            .collect();
        self.pool.clear();
        self.offer.clear();
        self.draft_turn = 0;
        self.status = Status::Schedule;
        self.deadline = now + SCHEDULE_MS;
        self.bump();
    }

    /// Whose turn it is to draft.
    pub fn draft_side(&self) -> usize {
        (self.draft_first + usize::from(self.draft_turn)) % 2
    }

    pub fn draft_pick(&mut self, _side: usize, _robot: u32, _now: i64) -> Result<(), Refusal> {
        Err("no_drafting")
    }

    /// Legacy games keep their previous partners, filling any empty slots from their pool.
    fn default_partners(&self, side: usize) -> [u32; 2] {
        let seat = self.seat(side);
        let mut chosen: Vec<u32> = seat.plan.partners.iter().copied().filter(|i| seat.pool.contains(i)).collect();
        for &inst in &seat.pool {
            if chosen.len() == 2 {
                break;
            }
            if !chosen.contains(&inst) {
                chosen.push(inst);
            }
        }
        [chosen[0], chosen[1]]
    }

    fn deal(&mut self, now: i64) {
        self.round += 1;
        for side in 0..2 {
            let [a, b] = if let Some(m) = self.schedule.get(usize::from(self.round - 1)) {
                [m.alliances[side][1], m.alliances[side][2]]
            } else {
                self.default_partners(side) // Preserve the partner pools of games already in progress.
            };
            let captain = self.seat(side).captain;
            self.alliances[side] = [captain, a, b];
            let seat = self.seat_mut(side);
            for _ in 0..DRAW {
                if !seat.pile.is_empty() {
                    let c = seat.pile.remove(0);
                    seat.hand.push(c);
                }
            }
            seat.plan = Plan { attach: vec![], lore: None, partners: [a, b], stations: [captain, a, b] };
            seat.locked = false;
            seat.acked = false;
        }
        self.status = Status::Pit;
        self.deadline = now + PIT_MS;
        self.bump();
    }

    fn pit_check(&self, side: usize) -> Result<(), Refusal> {
        if self.status != Status::Pit {
            return Err("not_pit");
        }
        if self.seat(side).locked {
            return Err("locked");
        }
        Ok(())
    }

    /// Attaches a part from your hand to one of your three robots (moving it if it was on another).
    pub fn attach(&mut self, side: usize, part: u32, robot: u32) -> Result<(), Refusal> {
        self.pit_check(side)?;
        let seat = self.seat(side);
        if !seat.hand.contains(&part) || self.card(part).is_none_or(|c| c.kind != Kind::Part) {
            return Err("not_in_hand");
        }
        if !self.alliances[side].contains(&robot) {
            return Err("not_your_robot");
        }
        let seat = self.seat_mut(side);
        seat.plan.attach.retain(|(p, _)| *p != part);
        seat.plan.attach.push((part, robot));
        self.bump();
        Ok(())
    }

    pub fn detach(&mut self, side: usize, part: u32) -> Result<(), Refusal> {
        self.pit_check(side)?;
        let seat = self.seat_mut(side);
        let before = seat.plan.attach.len();
        seat.plan.attach.retain(|(p, _)| *p != part);
        if seat.plan.attach.len() == before {
            return Err("not_attached");
        }
        self.bump();
        Ok(())
    }

    /// Picks this round's lore card from your hand, or none. One per player per round.
    pub fn set_lore(&mut self, side: usize, lore: Option<u32>) -> Result<(), Refusal> {
        self.pit_check(side)?;
        if let Some(l) = lore
            && (!self.seat(side).hand.contains(&l) || self.card(l).is_none_or(|c| c.kind != Kind::Lore))
        {
            return Err("not_in_hand");
        }
        self.seat_mut(side).plan.lore = lore;
        self.bump();
        Ok(())
    }

    /// Chooses the two robots from your pool that go out with your Captain this round (legacy games only).
    /// Changing partners puts everyone back in station order and takes parts off any robot that's no longer on the field.
    pub fn set_partners(&mut self, side: usize, partners: [u32; 2]) -> Result<(), Refusal> {
        self.pit_check(side)?;
        if !self.schedule.is_empty() {
            return Err("scheduled_partners");
        }
        if partners[0] == partners[1] {
            return Err("bad_partners");
        }
        for p in partners {
            if !self.seat(side).pool.contains(&p) {
                return Err("not_in_pool");
            }
        }
        let captain = self.seat(side).captain;
        let seat = self.seat_mut(side);
        seat.plan.partners = partners;
        seat.plan.stations = [captain, partners[0], partners[1]];
        let field = [captain, partners[0], partners[1]];
        seat.plan.attach.retain(|(_, r)| field.contains(r));
        self.alliances[side] = field;
        self.bump();
        Ok(())
    }

    /// Puts your three robots in driver stations 1, 2 and 3 (each robot once).
    pub fn set_stations(&mut self, side: usize, stations: [u32; 3]) -> Result<(), Refusal> {
        self.pit_check(side)?;
        let mut a = self.alliances[side];
        let mut b = stations;
        a.sort_unstable();
        b.sort_unstable();
        if a != b {
            return Err("bad_stations");
        }
        self.seat_mut(side).plan.stations = stations;
        self.bump();
        Ok(())
    }

    pub fn lock(&mut self, side: usize, now: i64) -> Result<(), Refusal> {
        self.pit_check(side)?;
        self.seat_mut(side).locked = true;
        self.bump();
        if self.seat(1 - side).locked {
            self.resolve(now, [false, false]);
        }
        Ok(())
    }

    /// Both alliances are locked: reveal and score the round.
    fn resolve(&mut self, now: i64, auto_locked: [bool; 2]) {
        self.engine = engine::ENGINE_VERSION;
        let mut field = vec![];
        let mut lores = vec![];
        for side in 0..2 {
            let seat = self.seat(side).clone();
            for (k, &inst) in seat.plan.stations.iter().enumerate() {
                let r = self.robot(inst).expect("robot in game");
                let parts = seat
                    .plan
                    .attach
                    .iter()
                    .filter(|(_, rb)| *rb == inst)
                    .filter_map(|(p, _)| self.card(*p))
                    .map(|c| FieldPart {
                        inst: c.inst,
                        name: c.name.clone(),
                        tags: c.tags.clone(),
                        effects: c.effects.clone(),
                    })
                    .collect();
                let captain = inst == seat.captain;
                field.push(FieldRobot {
                    inst,
                    name: format!("{} {}", r.team, r.name),
                    side,
                    captain,
                    station: k as u8 + 1,
                    stats: r.stats,
                    effects: r.effects.clone(),
                    parts,
                });
            }
            if let Some(l) = seat.plan.lore.and_then(|l| self.card(l)) {
                lores.push(FieldLore { inst: l.inst, name: l.name.clone(), side, effects: l.effects.clone() });
            }
        }
        let result = engine::resolve(&field, &lores, round_seed(self.seed, self.round));
        let log = RoundLog {
            round: self.round,
            stations: [self.seat(0).plan.stations, self.seat(1).plan.stations],
            attach: [self.seat(0).plan.attach.clone(), self.seat(1).plan.attach.clone()],
            lore: [self.seat(0).plan.lore, self.seat(1).plan.lore],
            result: result.clone(),
            auto_locked,
        };
        for side in 0..2 {
            let seat = self.seat_mut(side);
            seat.rp += result.match_rp[side] + result.bonus_rp[side];
            seat.points += result.totals[side];
            // Played parts and lore are used up for this game (never taken from the FRC Packs collection).
            let used: Vec<u32> = seat.plan.attach.iter().map(|(p, _)| *p).chain(seat.plan.lore).collect();
            seat.hand.retain(|c| !used.contains(c));
            seat.acked = false;
        }
        self.rounds.push(log);
        self.status = Status::Results;
        self.deadline = now + RESULTS_MS;
        self.bump();
    }

    /// Ready after reviewing the schedule or results. Both players must acknowledge before moving on.
    pub fn ack(&mut self, side: usize, now: i64) -> Result<(), Refusal> {
        if !matches!(self.status, Status::Schedule | Status::Results) {
            return Err("not_results");
        }
        if self.seat(side).acked {
            return Ok(());
        }
        self.seat_mut(side).acked = true;
        self.bump();
        if self.seat(1 - side).acked {
            self.advance(now);
        }
        Ok(())
    }

    fn advance(&mut self, now: i64) {
        if self.round >= ROUNDS {
            self.finish(None, "complete");
        } else {
            self.deal(now);
        }
    }

    /// Sends a quick-chat emote (only while both players are in the game).
    pub fn emote(&mut self, side: usize, id: &str, now: i64) -> Result<(), Refusal> {
        if self.status.over() || self.status == Status::Open {
            return Err("game_over");
        }
        if !EMOTES.contains(&id) {
            return Err("bad_emote");
        }
        if self.emotes.iter().any(|e| e.side == side && now - e.at < EMOTE_GAP_MS) {
            return Err("too_fast");
        }
        self.emote_seq += 1;
        self.emotes.push(Emote { side, id: id.to_string(), at: now, n: self.emote_seq });
        if self.emotes.len() > 6 {
            self.emotes.remove(0);
        }
        Ok(())
    }

    pub fn forfeit(&mut self, side: usize) -> Result<(), Refusal> {
        match self.status {
            Status::Decks | Status::Draft => {
                // The schedule hasn't been shown yet: call it off, no rating change.
                self.status = Status::Cancelled;
                self.bump();
                Ok(())
            }
            Status::Schedule | Status::Pit | Status::Results => {
                self.finish(Some(1 - side), "forfeit");
                Ok(())
            }
            _ => Err("cant_forfeit"),
        }
    }

    /// Ends the game. `winner_by` forces a winner (forfeits); otherwise most RP wins, then most points, else a draw.
    /// Ratings are filled in by the caller ([`Game::rate`]) in the same write.
    fn finish(&mut self, winner_by: Option<usize>, reason: &str) {
        let rp = [self.seat(0).rp, self.seat(1).rp];
        let points = [self.seat(0).points, self.seat(1).points];
        let winner = winner_by.or_else(|| match rp[0].cmp(&rp[1]).then(points[0].cmp(&points[1])) {
            std::cmp::Ordering::Greater => Some(0),
            std::cmp::Ordering::Less => Some(1),
            std::cmp::Ordering::Equal => None,
        });
        let before = [self.seat(0).elo, self.seat(1).elo];
        self.outcome =
            Some(Outcome { winner, reason: reason.into(), rp, points, elo_before: before, elo_after: before });
        self.status = Status::Final;
        self.deadline = 0;
        self.bump();
    }

    /// Works out the new ratings from the ratings the players have right now (once, when the game ends).
    pub fn rate(&mut self, current: [i32; 2]) -> [i32; 2] {
        let o = self.outcome.as_mut().expect("rated after finishing");
        let score = |side: usize| match o.winner {
            Some(w) if w == side => 1.0,
            Some(_) => 0.0,
            None => 0.5,
        };
        let after = [engine::elo(current[0], current[1], score(0)), engine::elo(current[1], current[0], score(1))];
        o.elo_before = current;
        o.elo_after = after;
        after
    }

    /// Applies any deadline that has passed. Returns whether anything changed.
    pub fn tick(&mut self, now: i64) -> bool {
        // No picks are needed for an unplayed legacy draft. Restore deck ownership and show its new schedule.
        if self.status == Status::Draft {
            self.schedule_matches(now);
            return true;
        }
        if self.status.over() || self.deadline == 0 || now < self.deadline {
            return false;
        }
        match self.status {
            Status::Open | Status::Decks => {
                self.status = Status::Cancelled;
                self.bump();
            }
            Status::Schedule => match (self.seat(0).acked, self.seat(1).acked) {
                (true, false) => self.finish(Some(0), "timeout"),
                (false, true) => self.finish(Some(1), "timeout"),
                _ => {
                    // Neither player readied up: no winner can be identified.
                    self.status = Status::Cancelled;
                    self.bump();
                }
            },
            Status::Draft => unreachable!("legacy drafts migrated above"),
            Status::Pit => {
                let late: Vec<usize> = (0..2).filter(|&s| !self.seat(s).locked).collect();
                for &s in &late {
                    self.seat_mut(s).strikes += 1;
                }
                let out: Vec<usize> = late.iter().copied().filter(|&s| self.seat(s).strikes >= STRIKES).collect();
                match out.as_slice() {
                    [] => {
                        let mut auto = [false; 2];
                        for &s in &late {
                            self.seat_mut(s).locked = true;
                            auto[s] = true;
                        }
                        self.resolve(now, auto);
                    }
                    [s] => self.finish(Some(1 - *s), "timeout"),
                    _ => {
                        // Both walked away: nobody wins, no rating change.
                        self.status = Status::Cancelled;
                        self.bump();
                    }
                }
            }
            Status::Results => {
                for s in 0..2 {
                    self.seat_mut(s).acked = true;
                }
                self.advance(now);
            }
            Status::Final | Status::Cancelled => return false,
        }
        true
    }
}

// ---------- what each player may see ----------

#[derive(Serialize)]
pub struct SeatView {
    pub name: String,
    pub elo: i32,
    pub picked: bool,
    pub locked: bool,
    pub acked: bool,
    pub rp: i32,
    pub points: i32,
    pub hand_count: usize,
    pub pile_count: usize,
    pub strikes: u8,
    /// During the pit: how many parts this player has put down (face down: not which cards, not on which robots).
    pub parts_down: usize,
    /// During the pit: whether they've put a lore card down (not which).
    pub lore_down: bool,
    /// The robots from this player's deck (public).
    pub pool: Vec<u32>,
}

#[derive(Serialize)]
pub struct MeView {
    pub side: usize,
    pub hand: Vec<u32>,
    pub plan: Plan,
}

#[derive(Serialize)]
pub struct GameView<'a> {
    pub id: &'a str,
    pub rev: u64,
    pub status: Status,
    pub round: u8,
    pub rounds_total: u8,
    pub deadline: i64,
    pub seats: Vec<Option<SeatView>>,
    pub me: Option<MeView>,
    /// Each side's Captain and scheduled partners. Legacy games may hide the opponent's partners in the pit.
    pub alliances: [[u32; 3]; 2],
    pub schedule: &'a [ScheduledMatch],
    pub pool_left: usize,
    /// The draft: robots on offer, picks made, whose pick it is.
    pub offer: &'a [u32],
    pub draft_turn: u8,
    pub draft_total: usize,
    pub draft_side: Option<usize>,
    /// Every robot this player may see: captains, both pools, the current offer, and revealed alliances.
    pub robots: Vec<&'a RobotInst>,
    /// Every support card this player may see: their own, and the opponent's once played.
    pub support: Vec<&'a SupportInst>,
    pub rounds: &'a [RoundLog],
    pub seed_hash: &'a str,
    /// Shown once the game is over, to check every shuffle and roll against `seed_hash`.
    pub seed: Option<String>,
    pub outcome: Option<&'a Outcome>,
    pub engine: u32,
    pub emotes: &'a [Emote],
    pub emote_seq: u64,
    pub mode: Mode,
    pub wager: Wager,
    /// A private game's invite code, for its players.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'a str>,
    /// The server's clock (ms) when this view was made, so timers line up with the server's (set by the API).
    pub now: i64,
}

impl Game {
    /// The game as `viewer` may see it: the opponent's hand, draw pile, pending pit plan and the undealt Alliance Deck
    /// stay hidden.
    pub fn view(&self, viewer: Option<usize>) -> GameView<'_> {
        let started = !self.robots.is_empty();
        let pit = self.status == Status::Pit;
        let seats = self
            .seats
            .iter()
            .map(|s| {
                s.as_ref().map(|s| SeatView {
                    name: s.name.clone(),
                    elo: s.elo,
                    picked: s.deck_id.is_some(),
                    locked: s.locked,
                    acked: s.acked,
                    rp: s.rp,
                    points: s.points,
                    // Cards already put down in the pit have left the hand, as far as anyone watching can tell.
                    hand_count: s.hand.len()
                        - if pit { s.plan.attach.len() + usize::from(s.plan.lore.is_some()) } else { 0 },
                    pile_count: s.pile.len(),
                    strikes: s.strikes,
                    parts_down: if pit { s.plan.attach.len() } else { 0 },
                    lore_down: pit && s.plan.lore.is_some(),
                    pool: s.pool.clone(),
                })
            })
            .collect();
        let me = viewer.and_then(|v| self.seats[v].as_ref().map(|s| (v, s))).map(|(v, s)| MeView {
            side: v,
            hand: s.hand.clone(),
            plan: s.plan.clone(),
        });
        // In the pit each player's partners are hidden from the other until both lock.
        let mut alliances = self.alliances;
        if pit && self.schedule.is_empty() {
            for (side, a) in alliances.iter_mut().enumerate() {
                if viewer != Some(side) {
                    a[1] = 0;
                    a[2] = 0;
                }
            }
        }
        let mut seen: Vec<u32> = vec![];
        if started {
            for s in self.seats.iter().flatten() {
                seen.push(s.captain);
            }
            for a in &alliances {
                seen.extend(a.iter().copied().filter(|i| *i != 0));
            }
            for s in self.seats.iter().flatten() {
                seen.extend(s.pool.iter().copied());
            }
            seen.extend(self.offer.iter().copied());
            for log in &self.rounds {
                seen.extend(log.stations.iter().flatten().copied());
            }
        }
        let over = self.status.over();
        let robots = self.robots.iter().filter(|r| over || seen.contains(&r.inst)).collect();
        let played: Vec<u32> = self
            .rounds
            .iter()
            .flat_map(|r| r.attach.iter().flatten().map(|(p, _)| *p).chain(r.lore.iter().flatten().copied()))
            .collect();
        let support = self.support.iter().filter(|c| Some(c.owner) == viewer || played.contains(&c.inst)).collect();
        GameView {
            id: &self.id,
            rev: self.rev,
            status: self.status,
            round: self.round,
            rounds_total: ROUNDS,
            deadline: self.deadline,
            seats,
            me,
            alliances,
            schedule: &self.schedule,
            pool_left: self.pool.len(),
            offer: &self.offer,
            draft_turn: self.draft_turn,
            draft_total: 2 * POOL_SIZE,
            draft_side: (self.status == Status::Draft).then(|| self.draft_side()),
            robots,
            support,
            rounds: &self.rounds,
            seed_hash: &self.seed_hash,
            seed: over.then(|| self.seed.to_string()),
            outcome: self.outcome.as_ref(),
            engine: self.engine,
            emotes: &self.emotes,
            emote_seq: self.emote_seq,
            mode: self.mode,
            wager: self.wager,
            // Only the players see the invite code (someone joining already has it).
            code: (viewer.is_some() && !self.code.is_empty()).then_some(self.code.as_str()),
            now: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::battler::content::test_stats;

    fn robot(team: i32) -> RobotPick {
        RobotPick {
            robot: Robot {
                id: format!("R-2026-{team}"),
                team,
                name: format!("Team {team}"),
                season: 2026,
                region: "Minnesota".into(),
                tier: "common".into(),
                photo: false,
                stats: test_stats(team, Some(120.0)),
                test_stats: true,
            },
            effects: vec![],
            effect_test: false,
        }
    }

    fn part(i: usize) -> Support {
        Support {
            id: format!("P-{i}"),
            kind: if i.is_multiple_of(5) { Kind::Lore } else { Kind::Part },
            name: format!("Card {i}"),
            season: 2026,
            tags: if i.is_multiple_of(5) { vec![] } else { vec!["MECHANICAL".into()] },
            effects: serde_json::from_str(r#"[{"op":"ADD_PHASE_FLAT","phase":"TELE","value":5,"scope":"ALLIES"}]"#)
                .unwrap(),
            text: String::new(),
            flavor: String::new(),
            draft: true,
        }
    }

    fn deck(base: i32) -> DeckPick {
        DeckPick {
            deck_id: format!("d{base}"),
            captain: robot(base),
            robots: (1..=10).map(|i| robot(base + i)).collect(),
            support: (0..15).map(part).collect(),
        }
    }

    fn started() -> (Game, Uuid, Uuid) {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut g = Game::new("g1".into(), Seat::new(a, "alice".into(), 1000), 12345, 0);
        g.join(Seat::new(b, "bob".into(), 1000), 1).unwrap();
        g.pick_deck(0, deck(100), 2).unwrap();
        g.pick_deck(1, deck(200), 3).unwrap();
        (g, a, b)
    }

    fn in_pit() -> (Game, Uuid, Uuid) {
        let (mut g, a, b) = started();
        g.ack(0, 5).unwrap();
        g.ack(1, 5).unwrap();
        (g, a, b)
    }

    #[test]
    fn schedule_uses_each_own_robot_once_and_waits_for_both_players() {
        let (mut g, _, _) = started();
        assert_eq!(g.status, Status::Schedule);
        assert_eq!(g.round, 0);
        assert_eq!(g.schedule.len(), usize::from(ROUNDS));
        assert!(g.offer.is_empty() && g.pool.is_empty());
        assert!(g.seat(0).hand.is_empty() && g.seat(1).hand.is_empty());
        assert_eq!(g.draft_pick(0, 2, 5), Err("no_drafting"));
        assert_eq!(g.lock(0, 5), Err("not_pit"));
        for side in 0..2 {
            let mut partners = vec![];
            for m in &g.schedule {
                assert_eq!(m.alliances[side][0], g.seat(side).captain);
                for i in m.alliances[side] {
                    assert_eq!(g.robot(i).unwrap().from, side, "robots never cross deck ownership");
                }
                partners.extend_from_slice(&m.alliances[side][1..]);
            }
            partners.sort_unstable();
            partners.dedup();
            assert_eq!(partners.len(), DECK_ROBOTS, "every non-captain plays exactly once");
            let mut pool = g.seat(side).pool.clone();
            pool.sort_unstable();
            assert_eq!(partners, pool);
        }
        let schedule = g.schedule.clone();
        let restored: Game = serde_json::from_value(serde_json::to_value(&g).unwrap()).unwrap();
        assert_eq!(restored.schedule, schedule, "refreshes and persistence keep the schedule");
        assert_eq!(g.view(Some(0)).schedule, g.view(Some(1)).schedule);
        g.ack(1, 5).unwrap();
        g.ack(1, 6).unwrap();
        assert_eq!(g.status, Status::Schedule, "one player cannot start the match");
        g.ack(0, 7).unwrap();
        assert_eq!(g.status, Status::Pit);
        assert_eq!(g.alliances, schedule[0].alliances);
        assert_eq!(g.seat(0).hand.len(), DRAW);
    }

    #[test]
    fn leaving_the_schedule_is_a_loss_even_before_readying_up() {
        for loser in 0..2 {
            for ready in [false, true] {
                let (mut g, _, _) = started();
                if ready {
                    g.ack(loser, 5).unwrap();
                }
                g.forfeit(loser).unwrap();
                assert_eq!(g.status, Status::Final);
                let outcome = g.outcome.as_ref().unwrap();
                assert_eq!(outcome.winner, Some(1 - loser));
                assert_eq!(outcome.reason, "forfeit");
                let after = g.rate([1000, 1000]);
                assert_eq!(after[loser], 984);
                assert_eq!(after[1 - loser], 1016);
                assert!(g.rounds.is_empty(), "a loss can be recorded before match 1");
                assert_eq!(g.forfeit(loser), Err("cant_forfeit"));
            }
        }
    }

    #[test]
    fn missing_schedule_readiness_loses_to_the_ready_player() {
        for ready in 0..2 {
            let (mut g, _, _) = started();
            g.ack(ready, 5).unwrap();
            assert!(!g.tick(g.deadline - 1));
            assert!(g.tick(g.deadline));
            assert_eq!(g.status, Status::Final);
            let outcome = g.outcome.as_ref().unwrap();
            assert_eq!(outcome.winner, Some(ready));
            assert_eq!(outcome.reason, "timeout");
        }
    }

    #[test]
    fn a_schedule_with_neither_player_ready_is_called_off() {
        let (mut g, _, _) = started();
        assert!(!g.tick(g.deadline - 1));
        assert!(g.tick(g.deadline));
        assert_eq!(g.status, Status::Cancelled);
        assert!(g.outcome.is_none());
    }

    #[test]
    fn predictions_are_symmetric_finite_and_follow_alliance_strength() {
        assert_eq!(predict([100, 100], false).win_chance, [0.5, 0.5]);
        assert_eq!(predict([0, 0], true).win_chance, [0.5, 0.5]);
        let stronger = predict([300, 200], false);
        let swapped = predict([200, 300], false);
        assert!(stronger.win_chance[0] > 0.5);
        assert!((stronger.win_chance[0] - swapped.win_chance[1]).abs() < 1e-12);
        for scores in [[0, 1], [i32::MAX, 0], [100, 100], [0, 0]] {
            let p = predict(scores, false);
            assert!(p.win_chance.iter().all(|p| p.is_finite() && (0.0..=1.0).contains(p)));
            assert!((p.win_chance.iter().sum::<f64>() - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn legacy_unplayed_drafts_restore_ownership_and_get_a_schedule() {
        let (mut g, _, _) = started();
        g.status = Status::Draft;
        g.schedule.clear();
        let foreign = g.seat(1).pool[0];
        g.seat_mut(0).pool = vec![foreign];
        assert!(g.tick(4));
        assert_eq!(g.status, Status::Schedule);
        assert!(g.seat(0).pool.iter().all(|i| g.robot(*i).unwrap().from == 0));
        assert_eq!(g.schedule.len(), 5);
    }

    #[test]
    fn a_full_game_runs_five_rounds_at_full_base_stats() {
        let (mut g, _, _) = in_pit();
        assert_eq!(g.status, Status::Pit);
        for round in 1..=ROUNDS {
            assert_eq!(g.round, round);
            assert_eq!(
                g.alliances,
                g.schedule[usize::from(round - 1)].alliances,
                "every round fields its scheduled robots"
            );
            for side in 0..2 {
                assert_eq!(g.alliances[side][0], g.seat(side).captain, "the captain plays every round");
            }
            g.lock(0, 10).unwrap();
            g.lock(1, 11).unwrap();
            assert_eq!(g.status, Status::Results);
            for score in &g.rounds.last().unwrap().result.robots {
                let stats = g.robot(score.inst).unwrap().stats;
                assert_eq!(score.base, [stats.auto, stats.tele, stats.end]);
                assert_eq!(score.points, score.base, "all phases score fully when no effects are played");
            }
            g.ack(0, 12).unwrap();
            g.ack(1, 13).unwrap();
        }
        assert_eq!(g.status, Status::Final);
        let o = g.outcome.as_ref().unwrap();
        assert_eq!(o.rp, [g.seat(0).rp, g.seat(1).rp]);
        assert!(g.seat(0).rp >= 0 && g.rounds.len() == 5);
    }

    #[test]
    fn scheduled_partners_cannot_be_changed_but_stations_can() {
        let (mut g, _, _) = in_pit();
        let pool = g.seat(0).pool.clone();
        let out: Vec<u32> = pool.iter().copied().filter(|i| !g.alliances[0].contains(i)).collect();
        assert_eq!(g.set_partners(0, [out[0], out[0]]), Err("scheduled_partners"));
        assert_eq!(g.set_partners(0, [out[0], g.seat(1).pool[0]]), Err("scheduled_partners"));
        let part = *g.seat(0).hand.iter().find(|c| g.card(**c).unwrap().kind == Kind::Part).unwrap();
        let old = g.alliances[0][1];
        g.attach(0, part, old).unwrap();
        assert_eq!(g.set_partners(0, [out[0], out[1]]), Err("scheduled_partners"));
        assert_eq!(g.seat(0).plan.attach, vec![(part, old)], "a rejected swap changes nothing");
        let [c, a, b] = g.alliances[0];
        g.set_stations(0, [b, c, a]).unwrap();
        assert_eq!(g.seat(0).plan.stations, [b, c, a]);
        assert_eq!(g.set_stations(0, [c, a, out[0]]), Err("bad_stations"));
        g.lock(0, 5).unwrap();
        assert_eq!(g.set_partners(0, [out[0], out[2]]), Err("locked"));
    }

    #[test]
    fn old_robot_state_is_ignored_when_resuming_an_existing_game() {
        let (mut fresh, _, _) = in_pit();
        let mut stored = serde_json::to_value(&fresh).unwrap();
        stored["engine"] = 1.into();
        for r in stored["robots"].as_array_mut().unwrap() {
            r["battery"] = 0.into();
            r["broken"] = 1.into();
        }
        let mut resumed: Game = serde_json::from_value(stored).unwrap();
        for g in [&mut fresh, &mut resumed] {
            g.lock(0, 5).unwrap();
            g.lock(1, 5).unwrap();
            assert_eq!(g.engine, engine::ENGINE_VERSION);
        }
        assert_eq!(fresh.rounds[0].result, resumed.rounds[0].result);
    }

    #[test]
    fn the_next_pair_comes_from_the_schedule() {
        let (mut g, _, _) = in_pit();
        let [a, b] = g.seat(0).plan.partners;
        g.lock(0, 10).unwrap();
        g.lock(1, 10).unwrap();
        g.ack(0, 11).unwrap();
        g.ack(1, 11).unwrap();
        assert_eq!(g.alliances, g.schedule[1].alliances);
        assert!(!g.alliances[0].contains(&a) && !g.alliances[0].contains(&b));
    }

    #[test]
    fn three_cards_a_round_and_unplayed_ones_stay() {
        let (mut g, _, _) = in_pit();
        assert_eq!(g.seat(0).hand.len(), 3);
        let part = *g.seat(0).hand.iter().find(|c| g.card(**c).unwrap().kind == Kind::Part).unwrap();
        let robot = g.alliances[0][1];
        g.attach(0, part, robot).unwrap();
        g.lock(0, 10).unwrap();
        g.lock(1, 10).unwrap();
        assert_eq!(g.seat(0).hand.len(), 2, "the attached part is used up");
        assert_eq!(g.seat(1).hand.len(), 3, "nothing played, nothing lost");
        g.ack(0, 11).unwrap();
        g.ack(1, 11).unwrap();
        assert_eq!(g.seat(0).hand.len(), 5);
        assert_eq!(g.seat(1).hand.len(), 6);
        assert!(!g.seat(0).hand.contains(&part), "a used part can't come back");
    }

    #[test]
    fn pit_rules_are_enforced() {
        let (mut g, _, _) = in_pit();
        let theirs = g.seat(1).hand[0];
        let my_robot = g.alliances[0][0];
        assert_eq!(g.attach(0, theirs, my_robot), Err("not_in_hand"));
        let mine = *g.seat(0).hand.iter().find(|c| g.card(**c).unwrap().kind == Kind::Part).unwrap();
        assert_eq!(g.attach(0, mine, g.alliances[1][0]), Err("not_your_robot"));
        let a = g.alliances[0];
        assert_eq!(g.set_stations(0, [a[0], a[0], a[1]]), Err("bad_stations"));
        g.set_stations(0, [a[2], a[0], a[1]]).unwrap();
        g.lock(0, 5).unwrap();
        assert_eq!(g.set_stations(0, a), Err("locked"), "locked means frozen");
    }

    #[test]
    fn only_one_lore_and_only_lore() {
        let (mut g, _, _) = in_pit();
        let hand = g.seat(0).hand.clone();
        let part = hand.iter().copied().find(|c| g.card(*c).unwrap().kind == Kind::Part).unwrap();
        assert_eq!(g.set_lore(0, Some(part)), Err("not_in_hand"));
        // The lore slot holds one card; picking another replaces it.
        g.set_lore(0, None).unwrap();
        assert_eq!(g.seat(0).plan.lore, None);
    }

    #[test]
    fn the_opponents_secrets_stay_hidden() {
        let (mut g, _, _) = in_pit();
        let mine = g.seat(0).hand[0];
        if g.card(mine).unwrap().kind == Kind::Part {
            g.attach(0, mine, g.alliances[0][0]).unwrap();
        }
        let v = serde_json::to_value(g.view(Some(1))).unwrap();
        let me = &v["me"];
        assert_eq!(me["side"], 1);
        assert!(me["plan"]["attach"].as_array().unwrap().is_empty(), "bob sees his own plan, not alice's");
        let visible: Vec<u64> = v["support"].as_array().unwrap().iter().map(|c| c["inst"].as_u64().unwrap()).collect();
        assert!(!visible.contains(&u64::from(mine)), "alice's hand isn't visible to bob");
        assert!(v["seed"].is_null(), "the seed stays secret until the end");
        assert!(v.get("pool").is_none());
        // Scheduled identities are public; support hands, station choices and the seed stay private.
        assert_eq!(v["alliances"][0][1], g.alliances[0][1]);
        assert_eq!(v["alliances"][0][2], g.alliances[0][2]);
        assert_ne!(v["alliances"][0][0], 0);
        assert_ne!(v["alliances"][1][1], 0, "bob sees his own");
        let alice_partner = g.alliances[0][1];
        let shown: Vec<u64> = v["robots"].as_array().unwrap().iter().map(|r| r["inst"].as_u64().unwrap()).collect();
        assert!(shown.contains(&u64::from(alice_partner)), "pools are public, so her robots are known");
    }

    #[test]
    fn missing_the_pit_deadline_auto_locks_then_forfeits() {
        let (mut g, _, _) = in_pit();
        g.lock(0, 10).unwrap();
        g.deadline = 1_000;
        assert!(g.tick(1_100));
        assert_eq!(g.status, Status::Results);
        assert!(g.rounds[0].auto_locked[1]);
        assert_eq!(g.seat(1).strikes, 1);
        assert!(g.tick(1_100 + RESULTS_MS));
        assert_eq!(g.status, Status::Pit);
        let t = 1_200 + RESULTS_MS;
        g.lock(0, t).unwrap();
        assert!(g.tick(t + 10 * PIT_MS));
        assert_eq!(g.status, Status::Final);
        let o = g.outcome.as_ref().unwrap();
        assert_eq!(o.winner, Some(0));
        assert_eq!(o.reason, "timeout");
    }

    #[test]
    fn placements_show_a_count_not_the_cards_and_emotes_are_limited() {
        let (mut g, _, _) = in_pit();
        let part = *g.seat(0).hand.iter().find(|c| g.card(**c).unwrap().kind == Kind::Part).unwrap();
        let robot = g.alliances[0][2];
        g.attach(0, part, robot).unwrap();
        let v = serde_json::to_value(g.view(Some(1))).unwrap();
        assert_eq!(v["seats"][0]["parts_down"], 1, "bob sees that a card went down, nothing more");
        assert_eq!(v["seats"][0]["hand_count"], 2, "and alice's hand shrink");
        let shown: Vec<u64> = v["support"].as_array().unwrap().iter().map(|c| c["inst"].as_u64().unwrap()).collect();
        assert!(!shown.contains(&u64::from(part)), "but not which card");
        let rev = g.rev;
        g.emote(1, "gg", 100).unwrap();
        assert_eq!(g.emote(1, "nice", 900), Err("too_fast"));
        assert_eq!(g.emote(0, "lol", 900), Err("bad_emote"));
        g.emote(1, "nice", 2_200).unwrap();
        assert_eq!(g.rev, rev, "emotes don't change the game");
        assert_eq!(g.emote_seq, 2);
    }

    #[test]
    fn joining_rules() {
        let a = Uuid::new_v4();
        let mut g = Game::new("g".into(), Seat::new(a, "a".into(), 1000), 1, 0);
        assert_eq!(g.join(Seat::new(a, "a".into(), 1000), 1), Err("own_game"));
        g.join(Seat::new(Uuid::new_v4(), "b".into(), 1000), 1).unwrap();
        assert_eq!(g.join(Seat::new(Uuid::new_v4(), "c".into(), 1000), 2), Err("game_full"));
    }

    #[test]
    fn ratings_change_once_by_the_spec_formula() {
        let (mut g, _, _) = in_pit();
        g.forfeit(1).unwrap();
        let after = g.rate([1000, 1000]);
        assert_eq!(after, [1016, 984]);
        assert_eq!(g.outcome.as_ref().unwrap().winner, Some(0));
        assert_eq!(g.forfeit(1), Err("cant_forfeit"), "a finished game can't end again");
    }

    #[test]
    fn same_seed_same_game() {
        let (mut a, _, _) = in_pit();
        let (mut b, _, _) = in_pit();
        assert_eq!(a.schedule, b.schedule);
        assert_eq!(a.seat(0).pool, b.seat(0).pool);
        a.lock(0, 1).unwrap();
        a.lock(1, 1).unwrap();
        b.lock(0, 1).unwrap();
        b.lock(1, 1).unwrap();
        assert_eq!(a.rounds[0].result, b.rounds[0].result);
        assert_eq!(seed_hash(a.seed), a.seed_hash);
    }

    #[test]
    fn identical_team_numbers_in_both_decks_still_keep_separate_owners() {
        let mut g = Game::new("same-teams".into(), Seat::new(Uuid::new_v4(), "a".into(), 1000), 72, 0);
        g.join(Seat::new(Uuid::new_v4(), "b".into(), 1000), 1).unwrap();
        g.pick_deck(0, deck(100), 2).unwrap();
        g.pick_deck(1, deck(100), 3).unwrap();
        for m in &g.schedule {
            for side in 0..2 {
                for inst in m.alliances[side] {
                    assert_eq!(g.robot(inst).unwrap().from, side);
                    assert!(!m.alliances[1 - side].contains(&inst));
                }
            }
        }
        let old = g.schedule.clone();
        g.seed += 1;
        g.schedule_matches(4);
        assert_ne!(g.schedule, old, "another seed produces another schedule");
    }
}
